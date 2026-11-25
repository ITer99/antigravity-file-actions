'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const BRIDGE_PORTS = [49821, 49822, 49823];
const PATCH_START_MARKER = '/* __ANTIGRAVITY_FILE_ACTIONS_START__ */';
const PATCH_END_MARKER = '/* __ANTIGRAVITY_FILE_ACTIONS_END__ */';
const PATCH_VERSION_MARKER = '/* __AFA_PATCH_V3__ */';
const INJECT_FILENAME = 'antigravity-file-actions-inject.js';

const DANGEROUS_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.jse',
  '.wsf', '.msi', '.scr', '.hta', '.com', '.pif', '.reg', '.msc', '.jar'
]);

const registeredWorkspaces = new Set();
let bridgeServer = null;
const bridgeDiagnostics = {
  bootCount: 0,
  lastBoot: null,
  lastContextMenu: null
};

// -----------------------------------------------------------------------------
// 1. Path Normalization & Workspace Resolution
// -----------------------------------------------------------------------------
function stripLineAndColSuffix(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  // Preserve full path if it literally exists on disk with # in filename
  try {
    if (/^[a-zA-Z]:[\\/]/.test(s) && fs.existsSync(s)) return s;
  } catch (_) { }
  s = s.replace(/#(?:L?\d+(?:[-:–]L?\d+)?|\d+)$/i, '');
  s = s.replace(/\?[^\\/\r\n]+$/, '');
  const match = /^(.*?)((?::\d+){1,2})$/.exec(s);
  if (match && match[1].length > 2) {
    s = match[1];
  }
  const parenMatch = /^(.*?\.[a-zA-Z0-9]{1,10})\(\d+(?:,\s*\d+)?\)$/.exec(s);
  if (parenMatch) {
    s = parenMatch[1];
  }
  return s.trim();
}

function getAllWorkspaceRoots(extraHints = []) {
  const roots = [];
  const addRoot = (p) => {
    if (!p || typeof p !== 'string') return;
    const norm = path.win32.normalize(p.trim());
    if (norm && !roots.some(r => r.toLowerCase() === norm.toLowerCase())) {
      roots.push(norm);
    }
  };

  for (const h of extraHints) addRoot(h);
  for (const folder of (vscode.workspace.workspaceFolders || [])) {
    if (folder?.uri?.fsPath) addRoot(folder.uri.fsPath);
  }
  for (const reg of registeredWorkspaces) addRoot(reg);

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor?.document?.uri?.scheme === 'file') {
    addRoot(path.dirname(activeEditor.document.uri.fsPath));
  }
  return roots;
}

function resolveToWindowsPath(rawInput, extraHints = []) {
  if (typeof rawInput !== 'string') return undefined;
  let s = rawInput.trim();
  if (!s) return undefined;

  s = s.replace(/^`+|`+$/g, '').replace(/^['"]+|['"]+$/g, '').trim();
  const md = /^\[[^\]]*\]\(([^)]+)\)$/.exec(s);
  if (md) s = md[1].trim().replace(/^<|>$/g, '');

  if (/^file:\/\//i.test(s)) {
    const strippedUri = s.replace(/#(?:L?\d+(?:[-:–]L?\d+)?|\d+)$/i, '');
    let p = strippedUri.replace(/^file:\/\/\/?/i, '');
    try {
      p = decodeURIComponent(p);
    } catch (_) {
      p = p.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
        try { return decodeURIComponent(m); } catch (__) { return m; }
      });
    }
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    s = p;
  }

  s = stripLineAndColSuffix(s);
  if (!s) return undefined;

  // Absolute Windows drive path or UNC path
  if (/^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s)) {
    let norm = path.win32.normalize(s);
    if (/^[a-z]:\\/.test(norm)) {
      norm = norm[0].toUpperCase() + norm.slice(1);
    }
    return norm;
  }

  // Relative path resolution against known workspace roots
  const roots = getAllWorkspaceRoots(extraHints);
  for (const root of roots) {
    const candidate = path.win32.resolve(root, s);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { }
  }

  // Also check 1st-level subdirectories of workspace roots for bare/sub-project paths
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const candidate = path.win32.resolve(root, entry.name, s);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch (_) { }
  }

  if (roots.length > 0) {
    return path.win32.resolve(roots[0], s);
  }
  return path.win32.normalize(s);
}

function inspectPathStatus(rawInput, extraHints = []) {
  const resolvedPath = resolveToWindowsPath(rawInput, extraHints);
  if (!resolvedPath) {
    return { ok: false, exists: false, resolvedPath: '' };
  }
  let exists = false;
  let isDirectory = false;
  try {
    const stat = fs.statSync(resolvedPath);
    exists = true;
    isDirectory = stat.isDirectory();
  } catch (_) { }
  const ext = path.extname(resolvedPath).toLowerCase();
  const isDangerous = DANGEROUS_EXTS.has(ext);
  return {
    ok: true,
    exists,
    isDirectory,
    isDangerous,
    resolvedPath
  };
}

// -----------------------------------------------------------------------------
// 2. OS File Operations (Windows 10/11)
// -----------------------------------------------------------------------------
const STRIPPED_ENV_EXACT = new Set([
  'CHROME_CRASHPAD_PIPE_NAME',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_SYSTEM_CA',
  'NODE_CHANNEL_FD',
  'NODE_CHANNEL_SERIALIZATION_MODE',
  'ORIGINAL_XDG_CURRENT_DESKTOP'
]);

const STRIPPED_ENV_PREFIXES = [
  'ELECTRON_',
  'VSCODE_',
  'ANTIGRAVITY_'
];

function buildCleanExternalEnv(baseEnv = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (STRIPPED_ENV_EXACT.has(upper)) continue;
    if (STRIPPED_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))) continue;
    clean[key] = value;
  }
  return clean;
}

function execPowerShellEncoded(psScript) {
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true, env: buildCleanExternalEnv() },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        const detail = (stderr || '').trim();
        reject(detail ? new Error(detail) : error);
      }
    );
  });
}

async function defaultOpen(file, options = {}) {
  if (process.platform !== 'win32') {
    throw new Error('当前插件仅支持 Windows 10/11。');
  }
  const normalized = path.win32.normalize(file);
  const ext = path.extname(normalized).toLowerCase();

  if (DANGEROUS_EXTS.has(ext) && !options.confirmed) {
    const response = await vscode.window.showWarningMessage(
      `打开 ${path.basename(normalized)} 可能执行程序或脚本。确定要运行吗？`,
      { modal: true },
      '继续打开'
    );
    if (response !== '继续打开') {
      const err = new Error('用户已取消打开可执行文件');
      err.cancelled = true;
      throw err;
    }
  }

  const escaped = normalized.replace(/'/g, "''");
  const workDir = path.dirname(normalized).replace(/'/g, "''");
  const ps = [
    `$ErrorActionPreference = 'Stop'`,
    `$psi = New-Object System.Diagnostics.ProcessStartInfo`,
    `$psi.FileName = '${escaped}'`,
    `$psi.WorkingDirectory = '${workDir}'`,
    `$psi.UseShellExecute = $true`,
    `[System.Diagnostics.Process]::Start($psi) | Out-Null`
  ].join('; ');
  await execPowerShellEncoded(ps);
}

async function revealInExplorer(file) {
  if (process.platform !== 'win32') {
    throw new Error('当前插件仅支持 Windows 10/11。');
  }
  const normalized = path.win32.normalize(file);
  const stat = await fs.promises.stat(normalized);

  // Prefer VS Code / Electron native shell.showItemInFolder (SHOpenFolderAndSelectItems)
  if (!stat.isDirectory()) {
    try {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(normalized));
      return;
    } catch (_) { }
  }

  // Fallback to explorer.exe /select,"<path>" with verbatim quoting
  await new Promise((resolve, reject) => {
    const args = stat.isDirectory() ? [`"${normalized}"`] : [`/select,"${normalized}"`];
    const child = spawn('explorer.exe', args, {
      windowsVerbatimArguments: true,
      windowsHide: false,
      env: buildCleanExternalEnv()
    });
    child.on('error', reject);
    child.on('close', () => {
      // explorer.exe normally exits with code 1 after delegating to the shell
      resolve();
    });
  });
}

async function copyAbsolutePath(file) {
  const normalized = path.win32.normalize(file);
  await vscode.env.clipboard.writeText(normalized);
}

// -----------------------------------------------------------------------------
// 3. Local Loopback Bridge Server (127.0.0.1)
// -----------------------------------------------------------------------------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 65536) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

async function handleBridgeRequest(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'antigravity-file-actions',
      workspaces: getAllWorkspaceRoots(),
      diagnostics: bridgeDiagnostics
    });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const hints = Array.isArray(body.workspaceHints) ? body.workspaceHints : [];
    for (const h of hints) {
      if (typeof h === 'string' && h.trim()) registeredWorkspaces.add(path.win32.normalize(h.trim()));
    }

    if (req.url === '/register-workspace') {
      sendJson(res, 200, { ok: true, workspaces: getAllWorkspaceRoots() });
      return;
    }

    if (req.url === '/ping') {
      const now = new Date().toISOString();
      if (body.event === 'boot') {
        bridgeDiagnostics.bootCount++;
        bridgeDiagnostics.lastBoot = { time: now, href: body.href || '', workspaces: getAllWorkspaceRoots() };
      } else if (body.event === 'contextmenu') {
        bridgeDiagnostics.lastContextMenu = {
          time: now,
          href: body.href || '',
          kind: body.kind || '',
          rawPath: body.rawPath || '',
          normalizedPath: body.normalizedPath || ''
        };
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.url === '/resolve') {
      const info = inspectPathStatus(body.rawPath || '', hints);
      sendJson(res, 200, info);
      return;
    }

    if (req.url === '/action') {
      const action = body.action;
      const status = inspectPathStatus(body.rawPath || body.resolvedPath || '', hints);
      if (!status.ok || !status.resolvedPath) {
        sendJson(res, 200, { ok: false, error: '无法解析有效的文件路径' });
        return;
      }

      if (action === 'copyPath') {
        await copyAbsolutePath(status.resolvedPath);
        sendJson(res, 200, { ok: true, resolvedPath: status.resolvedPath });
        return;
      }

      if (!status.exists) {
        const msg = `文件不存在：${status.resolvedPath}`;
        vscode.window.showErrorMessage(msg);
        sendJson(res, 200, { ok: false, error: msg, resolvedPath: status.resolvedPath });
        return;
      }

      if (action === 'open') {
        await defaultOpen(status.resolvedPath, { confirmed: Boolean(body.confirmed) });
        sendJson(res, 200, { ok: true, resolvedPath: status.resolvedPath });
        return;
      }

      if (action === 'reveal') {
        await revealInExplorer(status.resolvedPath);
        sendJson(res, 200, { ok: true, resolvedPath: status.resolvedPath });
        return;
      }

      sendJson(res, 400, { ok: false, error: `未知操作: ${action}` });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not Found' });
  } catch (err) {
    if (err && err.cancelled) {
      sendJson(res, 200, { ok: false, cancelled: true });
      return;
    }
    sendJson(res, 200, { ok: false, error: err ? err.message : String(err) });
  }
}

function registerWorkspacesWithExistingBridge(port) {
  const roots = getAllWorkspaceRoots();
  const payload = JSON.stringify({ workspaceHints: roots });
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/register-workspace',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, () => { });
  req.on('error', () => { });
  req.write(payload);
  req.end();
}

function startBridgeServer(context) {
  let portIdx = 0;

  const tryListen = () => {
    if (portIdx >= BRIDGE_PORTS.length) return;
    const port = BRIDGE_PORTS[portIdx];
    const srv = http.createServer((req, res) => {
      handleBridgeRequest(req, res);
    });

    srv.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        // Register our workspace folders with the primary window's bridge server
        registerWorkspacesWithExistingBridge(BRIDGE_PORTS[0]);
        portIdx++;
        tryListen();
      }
    });

    srv.listen(port, '127.0.0.1', () => {
      bridgeServer = srv;
      if (port !== BRIDGE_PORTS[0]) {
        registerWorkspacesWithExistingBridge(BRIDGE_PORTS[0]);
      }
    });
  };

  tryListen();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      registerWorkspacesWithExistingBridge(BRIDGE_PORTS[0]);
    }),
    {
      dispose() {
        if (bridgeServer) {
          try { bridgeServer.close(); } catch (_) { }
          bridgeServer = null;
        }
      }
    }
  );
}

// -----------------------------------------------------------------------------
// 4. Renderer Patch Installer & Product Checksum Updater
// -----------------------------------------------------------------------------
function computeVscodeChecksum(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

function getPatchPaths(appRoot) {
  const resolvedRoot = appRoot || vscode.env.appRoot;
  const workbenchDir = path.join(resolvedRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench');
  const agyVscodeExtPath = path.join(resolvedRoot, 'extensions', 'agy', 'vscode', 'extension.js');
  return {
    appRoot: resolvedRoot,
    productJsonPath: path.join(resolvedRoot, 'product.json'),
    workbenchDir,
    injectDestPath: path.join(workbenchDir, INJECT_FILENAME),
    agyVscodeExtPath,
    targets: [
      {
        checksumKey: 'vs/code/electron-browser/workbench/workbench.js',
        filePath: path.join(workbenchDir, 'workbench.js')
      },
      {
        checksumKey: 'vs/code/electron-browser/workbench/jetskiAgent.js',
        filePath: path.join(workbenchDir, 'jetskiAgent.js')
      }
    ]
  };
}

function buildAgyHubProxyPatchSnippet() {
  return `
${PATCH_START_MARKER}
${PATCH_VERSION_MARKER}
;(function() {
  if (globalThis.__afaWrapHubUrl) return;
  const http = require("http");
  const net = require("net");
  const fs = require("fs");
  const path = require("path");

  const BRIDGE_PORTS = [49821, 49822, 49823];
  const injectFilePath = path.join(__dirname, "../../../out/vs/code/electron-browser/workbench/${INJECT_FILENAME}");
  let upstreamHost = "127.0.0.1";
  let upstreamPort = 2728;
  let proxyPort = 0;
  let lastWorkspaceUri = "";

  function forwardToBridge(endpoint, req, res) {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const bodyBuf = Buffer.concat(chunks);
      let idx = 0;
      const tryNextPort = () => {
        if (idx >= BRIDGE_PORTS.length) {
          res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Antigravity File Actions bridge unavailable" }));
          return;
        }
        const port = BRIDGE_PORTS[idx++];
        const bReq = http.request({
          hostname: "127.0.0.1",
          port,
          path: endpoint,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": bodyBuf.length
          }
        }, (bRes) => {
          res.writeHead(bRes.statusCode || 200, bRes.headers);
          bRes.pipe(res);
        });
        bReq.on("error", () => tryNextPort());
        bReq.write(bodyBuf);
        bReq.end();
      };
      tryNextPort();
    });
  }

  const proxyServer = http.createServer((req, res) => {
    const rawUrl = req.url || "/";
    try {
      const parsedReqUrl = new URL(rawUrl, "http://127.0.0.1");
      const wsParam = parsedReqUrl.searchParams.get("workspaceUri");
      if (wsParam) lastWorkspaceUri = wsParam;
    } catch (_) {}

    if (rawUrl.startsWith("/__antigravity_file_actions_inject__.js")) {
      try {
        let code = fs.readFileSync(injectFilePath, "utf8");
        if (lastWorkspaceUri) {
          code = "window.__AFA_WORKSPACE_URI__ = " + JSON.stringify(lastWorkspaceUri) + ";\\n" + code;
        }
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate"
        });
        res.end(code, "utf8");
      } catch (e) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
      return;
    }

    if (rawUrl === "/__afa_resolve__") {
      forwardToBridge("/resolve", req, res);
      return;
    }
    if (rawUrl === "/__afa_action__") {
      forwardToBridge("/action", req, res);
      return;
    }
    if (rawUrl === "/__afa_ping__") {
      forwardToBridge("/ping", req, res);
      return;
    }

    const pathname = rawUrl.split("?")[0];
    const isMainJs = req.method === "GET" && pathname === "/main.js";
    const isHtmlCandidate = req.method === "GET" && (
      !/\\.(?:css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|map|json|wasm)$/i.test(pathname) ||
      pathname.endsWith(".html")
    );
    const outHeaders = { ...req.headers, host: upstreamHost + ":" + upstreamPort };
    if (proxyPort) {
      const proxyHost = "127.0.0.1:" + proxyPort;
      const upHost = upstreamHost + ":" + upstreamPort;
      if (typeof outHeaders.origin === "string") outHeaders.origin = outHeaders.origin.replace(proxyHost, upHost);
      if (typeof outHeaders.referer === "string") outHeaders.referer = outHeaders.referer.replace(proxyHost, upHost);
    }
    if (isHtmlCandidate || isMainJs) {
      outHeaders["accept-encoding"] = "identity";
      delete outHeaders["if-none-match"];
      delete outHeaders["if-modified-since"];
    }

    const upReq = http.request({
      hostname: upstreamHost,
      port: upstreamPort,
      path: rawUrl,
      method: req.method,
      headers: outHeaders
    }, (upRes) => {
      const ct = String(upRes.headers["content-type"] || "");
      if (isHtmlCandidate && ct.includes("text/html")) {
        const chunks = [];
        upRes.on("data", c => chunks.push(c));
        upRes.on("end", () => {
          let html = Buffer.concat(chunks).toString("utf8");
          const wsScript = lastWorkspaceUri
            ? "<script>window.__AFA_WORKSPACE_URI__ = " + JSON.stringify(lastWorkspaceUri) + ";</script>"
            : "";
          const scriptTag = wsScript + '<script src="/__antigravity_file_actions_inject__.js"></script>';
          if (!html.includes("__antigravity_file_actions_inject__.js")) {
            if (html.includes("</body>")) {
              html = html.replace("</body>", scriptTag + "</body>");
            } else {
              html += scriptTag;
            }
          }
          const respHeaders = { ...upRes.headers };
          delete respHeaders["content-length"];
          delete respHeaders["content-encoding"];
          delete respHeaders["transfer-encoding"];
          delete respHeaders["etag"];
          respHeaders["cache-control"] = "no-store, no-cache, must-revalidate";
          res.writeHead(upRes.statusCode || 200, respHeaders);
          res.end(html, "utf8");
        });
        return;
      }
      if (isMainJs && ct.includes("javascript")) {
        const chunks = [];
        upRes.on("data", c => chunks.push(c));
        upRes.on("end", () => {
          let js = Buffer.concat(chunks).toString("utf8");
          try {
            const injectCode = fs.readFileSync(injectFilePath, "utf8");
            const wsInit = lastWorkspaceUri
              ? "\\nwindow.__AFA_WORKSPACE_URI__ = " + JSON.stringify(lastWorkspaceUri) + ";\\n"
              : "\\n";
            js += wsInit + injectCode + "\\n";
          } catch (_) {}
          const respHeaders = { ...upRes.headers };
          delete respHeaders["content-length"];
          delete respHeaders["content-encoding"];
          delete respHeaders["transfer-encoding"];
          delete respHeaders["etag"];
          respHeaders["cache-control"] = "no-store, no-cache, must-revalidate";
          res.writeHead(upRes.statusCode || 200, respHeaders);
          res.end(js, "utf8");
        });
        return;
      }
      res.writeHead(upRes.statusCode || 200, upRes.headers);
      upRes.pipe(res);
    });

    upReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
      }
      res.end("Upstream proxy error: " + err.message);
    });

    req.pipe(upReq);
  });

  proxyServer.on("upgrade", (req, clientSocket, head) => {
    const upstreamSocket = net.connect(upstreamPort, upstreamHost, () => {
      const proxyHost = "127.0.0.1:" + proxyPort;
      const upHost = upstreamHost + ":" + upstreamPort;
      let rawReq = req.method + " " + req.url + " HTTP/" + req.httpVersion + "\\r\\n";
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        let v = req.rawHeaders[i + 1];
        if (/^host$/i.test(k)) v = upHost;
        else if (/^(origin|referer)$/i.test(k) && proxyPort) v = v.replace(proxyHost, upHost);
        rawReq += k + ": " + v + "\\r\\n";
      }
      rawReq += "\\r\\n";
      upstreamSocket.write(rawReq);
      if (head && head.length > 0) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    clientSocket.on("error", () => { try { upstreamSocket.destroy(); } catch (_) {} });
    upstreamSocket.on("error", () => { try { clientSocket.destroy(); } catch (_) {} });
  });

  proxyServer.on("error", () => {});
  const proxyReadyPromise = new Promise((resolve) => {
    proxyServer.listen(0, "127.0.0.1", () => {
      const addr = proxyServer.address();
      if (addr && typeof addr === "object") {
        proxyPort = addr.port;
      }
      resolve(proxyPort);
    });
  });

  globalThis.__afaWrapHubUrl = function(rawUrl) {
    try {
      const u = new URL(rawUrl);
      if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) {
        const portNum = Number(u.port) || 80;
        if (portNum !== proxyPort) {
          upstreamHost = u.hostname;
          upstreamPort = portNum;
        }
        if (proxyPort > 0) {
          u.hostname = "127.0.0.1";
          u.port = String(proxyPort);
          return u.toString();
        }
      }
    } catch (_) {}
    return rawUrl;
  };

  globalThis.__afaWrapHubUrlAsync = async function(rawUrl) {
    if (!proxyPort) {
      try { await proxyReadyPromise; } catch (_) {}
    }
    return globalThis.__afaWrapHubUrl(rawUrl).replace(/\\/$/, "");
  };
})();
${PATCH_END_MARKER}
`;
}

function isPatchInstalledAndCurrent(extensionPath, appRoot) {
  try {
    const paths = getPatchPaths(appRoot);
    if (!fs.existsSync(paths.injectDestPath)) return false;
    const srcContent = fs.readFileSync(path.join(extensionPath, 'renderer-inject.js'), 'utf8');
    const destContent = fs.readFileSync(paths.injectDestPath, 'utf8');
    if (srcContent !== destContent) return false;

    for (const t of paths.targets) {
      if (!fs.existsSync(t.filePath)) continue;
      const content = fs.readFileSync(t.filePath, 'utf8');
      if (!content.includes(PATCH_START_MARKER)) return false;
    }

    if (fs.existsSync(paths.agyVscodeExtPath)) {
      const agyContent = fs.readFileSync(paths.agyVscodeExtPath, 'utf8');
      if (!agyContent.includes(PATCH_START_MARKER) || !agyContent.includes(PATCH_VERSION_MARKER)) {
        return false;
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

function installRendererPatch(extensionPath, appRoot) {
  const paths = getPatchPaths(appRoot);
  const injectSourcePath = path.join(extensionPath, 'renderer-inject.js');
  if (!fs.existsSync(injectSourcePath)) {
    throw new Error(`找不到注入脚本源文件: ${injectSourcePath}`);
  }
  if (!fs.existsSync(paths.workbenchDir)) {
    throw new Error(`找不到 Antigravity IDE 渲染层目录: ${paths.workbenchDir}`);
  }

  // 1. Copy renderer-inject.js into workbench directory
  fs.copyFileSync(injectSourcePath, paths.injectDestPath);

  // 2. Patch workbench.js and jetskiAgent.js
  const patchSnippet = `\n${PATCH_START_MARKER}\nimport("./${INJECT_FILENAME}").catch(err=>console.error("[AntigravityFileActions]",err));\n${PATCH_END_MARKER}\n`;
  const blockRegex = new RegExp(`\\n?\\/\\* __ANTIGRAVITY_FILE_ACTIONS_START__ \\*\\/[\\s\\S]*?\\/\\* __ANTIGRAVITY_FILE_ACTIONS_END__ \\*\\/\\n?`, 'g');

  for (const t of paths.targets) {
    if (!fs.existsSync(t.filePath)) continue;
    const backupPath = `${t.filePath}.afa-backup`;
    let content = fs.readFileSync(t.filePath, 'utf8');

    if (!fs.existsSync(backupPath) && !content.includes(PATCH_START_MARKER)) {
      fs.writeFileSync(backupPath, content, 'utf8');
    }

    content = content.replace(blockRegex, '');

    const smIndex = content.lastIndexOf('//# sourceMappingURL=');
    if (smIndex !== -1) {
      content = content.slice(0, smIndex) + patchSnippet + content.slice(smIndex);
    } else {
      content += patchSnippet;
    }
    fs.writeFileSync(t.filePath, content, 'utf8');
  }

  // 3. Patch extensions/agy/vscode/extension.js to proxy #jetski-frame HTML and inject renderer-inject.js
  if (fs.existsSync(paths.agyVscodeExtPath)) {
    const agyBackup = `${paths.agyVscodeExtPath}.afa-backup`;
    let agyContent = fs.readFileSync(paths.agyVscodeExtPath, 'utf8');
    if (!fs.existsSync(agyBackup) && !agyContent.includes(PATCH_START_MARKER)) {
      fs.writeFileSync(agyBackup, agyContent, 'utf8');
    } else if (fs.existsSync(agyBackup)) {
      agyContent = fs.readFileSync(agyBackup, 'utf8');
    }

    const origPs = 'async function PS(a,b){var c=f.asyncContextStart(),d=c();c=c(1);try{return{effectiveUrl:c(await d(n.env.asExternalUri(n.Uri.parse(a)))).toString().replace(/\\/$/,""),humanReadable:b}}finally{d()}}';
    const hookedPs = 'async function PS(a,b){var c=f.asyncContextStart(),d=c();c=c(1);try{var __eff=c(await d(n.env.asExternalUri(n.Uri.parse(a)))).toString().replace(/\\/$/,"");if(typeof globalThis.__afaWrapHubUrlAsync==="function")__eff=c(await d(globalThis.__afaWrapHubUrlAsync(__eff)));return{effectiveUrl:__eff,humanReadable:b}}finally{d()}}';
    agyContent = agyContent.replace(origPs, hookedPs);

    const origValidate = 'validateServerUrl(a){try{let b=new URL(a);if(b.protocol!=="http:"&&b.protocol!=="https:")throw Error("Protocol must be HTTP or HTTPS");return a.endsWith("/")?a:`${a}/`}catch(b){throw Error(`Invalid server URL: ${a}`);}}';
    const hookedValidate = 'validateServerUrl(a){try{let b=new URL(a);if(b.protocol!=="http:"&&b.protocol!=="https:")throw Error("Protocol must be HTTP or HTTPS");var __u=a.endsWith("/")?a:`${a}/`;return typeof globalThis.__afaWrapHubUrl==="function"?globalThis.__afaWrapHubUrl(__u):__u}catch(b){throw Error(`Invalid server URL: ${a}`);}}';
    agyContent = agyContent.replace(origValidate, hookedValidate);

    const origServerChanged = 'type:"serverChanged",origin:(new URL(p)).origin';
    const hookedServerChanged = 'type:"serverChanged",origin:(new URL(typeof globalThis.__afaWrapHubUrl==="function"?globalThis.__afaWrapHubUrl(p):p)).origin';
    agyContent = agyContent.replace(origServerChanged, hookedServerChanged);

    const proxySnippet = buildAgyHubProxyPatchSnippet();
    const smIdx = agyContent.lastIndexOf('//# sourceMappingURL=');
    if (smIdx !== -1) {
      agyContent = agyContent.slice(0, smIdx) + proxySnippet + '\n' + agyContent.slice(smIdx);
    } else {
      agyContent += '\n' + proxySnippet;
    }
    fs.writeFileSync(paths.agyVscodeExtPath, agyContent, 'utf8');
  }

  // 4. Synchronize SHA-256 checksums in product.json
  if (fs.existsSync(paths.productJsonPath)) {
    const productBackup = `${paths.productJsonPath}.afa-backup`;
    const rawProduct = fs.readFileSync(paths.productJsonPath, 'utf8');
    if (!fs.existsSync(productBackup)) {
      fs.writeFileSync(productBackup, rawProduct, 'utf8');
    }
    const product = JSON.parse(rawProduct);
    if (product.checksums) {
      for (const t of paths.targets) {
        if (fs.existsSync(t.filePath) && t.checksumKey in product.checksums) {
          product.checksums[t.checksumKey] = computeVscodeChecksum(t.filePath);
        }
      }
      fs.writeFileSync(paths.productJsonPath, JSON.stringify(product, null, '\t'), 'utf8');
    }
  }

  return paths;
}

function uninstallRendererPatch(appRoot) {
  const paths = getPatchPaths(appRoot);

  if (fs.existsSync(paths.injectDestPath)) {
    try { fs.unlinkSync(paths.injectDestPath); } catch (_) { }
  }

  const blockRegex = new RegExp(`\\n?\\/\\* __ANTIGRAVITY_FILE_ACTIONS_START__ \\*\\/[\\s\\S]*?\\/\\* __ANTIGRAVITY_FILE_ACTIONS_END__ \\*\\/\\n?`, 'g');
  for (const t of paths.targets) {
    if (!fs.existsSync(t.filePath)) continue;
    const backupPath = `${t.filePath}.afa-backup`;
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, t.filePath);
    } else {
      const content = fs.readFileSync(t.filePath, 'utf8').replace(blockRegex, '');
      fs.writeFileSync(t.filePath, content, 'utf8');
    }
  }

  if (fs.existsSync(paths.agyVscodeExtPath)) {
    const agyBackup = `${paths.agyVscodeExtPath}.afa-backup`;
    if (fs.existsSync(agyBackup)) {
      fs.copyFileSync(agyBackup, paths.agyVscodeExtPath);
    }
  }

  if (fs.existsSync(paths.productJsonPath)) {
    const rawProduct = fs.readFileSync(paths.productJsonPath, 'utf8');
    const product = JSON.parse(rawProduct);
    if (product.checksums) {
      for (const t of paths.targets) {
        if (fs.existsSync(t.filePath) && t.checksumKey in product.checksums) {
          product.checksums[t.checksumKey] = computeVscodeChecksum(t.filePath);
        }
      }
      fs.writeFileSync(paths.productJsonPath, JSON.stringify(product, null, '\t'), 'utf8');
    }
  }

  return paths;
}

// -----------------------------------------------------------------------------
// 5. VS Code Command & Extension Activation
// -----------------------------------------------------------------------------
async function promptOrGetPath(uri) {
  if (uri instanceof vscode.Uri && uri.scheme === 'file') return uri.fsPath;
  if (typeof uri === 'string' && uri.trim()) return resolveToWindowsPath(uri);

  const active = vscode.window.activeTextEditor;
  const copied = await vscode.env.clipboard.readText();
  const suggested = copied.length < 2048 ? copied.trim() : '';
  const entered = await vscode.window.showInputBox({
    title: '文件操作：输入文件路径（支持从 AI 对话复制）',
    prompt: '支持 Windows 绝对路径与工作区相对路径。',
    value: suggested && !suggested.includes('\n') ? suggested : (active ? active.document.uri.fsPath : ''),
    ignoreFocusOut: true
  });
  return entered === undefined ? undefined : resolveToWindowsPath(entered);
}

async function validatedPath(uri) {
  const file = await promptOrGetPath(uri);
  if (!file) return undefined;
  try {
    await fs.promises.access(file, fs.constants.F_OK);
    return file;
  } catch (_) {
    vscode.window.showErrorMessage(`文件不存在：${file}`);
    return undefined;
  }
}

function activate(context) {
  // 1. Start local loopback bridge for renderer context menu
  startBridgeServer(context);

  // 2. Auto-ensure renderer patch is installed and up to date
  try {
    if (!isPatchInstalledAndCurrent(context.extensionPath)) {
      installRendererPatch(context.extensionPath);
      vscode.window.showInformationMessage(
        'Antigravity File Actions：已启用/更新 AI 对话窗口右键菜单支持，重载窗口后生效。',
        '立即重载窗口'
      ).then((choice) => {
        if (choice === '立即重载窗口') {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      });
    }
  } catch (err) {
    console.warn('[AntigravityFileActions] Auto patch check warning:', err);
  }

  // 3. Register URI handler fallback (antigravity-ide://local-dev.antigravity-file-actions/action?...)
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        try {
          const params = new URLSearchParams(uri.query || '');
          const action = params.get('action') || '';
          const rawPath = params.get('path') || '';
          const confirmed = params.get('confirmed') === '1';
          const status = inspectPathStatus(rawPath);
          if (!status.ok || !status.resolvedPath) return;

          if (action === 'copyPath') {
            await copyAbsolutePath(status.resolvedPath);
            return;
          }
          if (!status.exists) {
            vscode.window.showErrorMessage(`文件不存在：${status.resolvedPath}`);
            return;
          }
          if (action === 'open') {
            await defaultOpen(status.resolvedPath, { confirmed });
          } else if (action === 'reveal') {
            await revealInExplorer(status.resolvedPath);
          }
        } catch (err) {
          if (!err?.cancelled) {
            vscode.window.showErrorMessage(`文件操作失败：${err.message}`);
          }
        }
      }
    })
  );

  // 4. Register commands
  const fileCommands = [
    ['antigravityFileActions.open', (file) => defaultOpen(file)],
    ['antigravityFileActions.reveal', (file) => revealInExplorer(file)],
    ['antigravityFileActions.copyPath', (file) => copyAbsolutePath(file)]
  ];

  for (const [name, handler] of fileCommands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(name, async (uri) => {
        try {
          if (name === 'antigravityFileActions.copyPath') {
            const file = await promptOrGetPath(uri);
            if (file) await handler(file);
            return;
          }
          const file = await validatedPath(uri);
          if (file) await handler(file);
        } catch (error) {
          if (!error?.cancelled) {
            vscode.window.showErrorMessage(`文件操作失败：${error.message}`);
          }
        }
      })
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityFileActions.installPatch', async () => {
      try {
        installRendererPatch(context.extensionPath);
        const choice = await vscode.window.showInformationMessage(
          'AI 对话窗口右键菜单补丁已安装/更新成功！请重载窗口使其生效。',
          '立即重载窗口'
        );
        if (choice === '立即重载窗口') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } catch (error) {
        vscode.window.showErrorMessage(`安装对话右键菜单补丁失败：${error.message}`);
      }
    }),
    vscode.commands.registerCommand('antigravityFileActions.uninstallPatch', async () => {
      try {
        uninstallRendererPatch();
        const choice = await vscode.window.showInformationMessage(
          'AI 对话窗口右键菜单补丁已卸载，原始文件与校验和已恢复。请重载窗口。',
          '立即重载窗口'
        );
        if (choice === '立即重载窗口') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } catch (error) {
        vscode.window.showErrorMessage(`卸载对话右键菜单补丁失败：${error.message}`);
      }
    })
  );
}

function deactivate() {
  if (bridgeServer) {
    try { bridgeServer.close(); } catch (_) { }
    bridgeServer = null;
  }
}

module.exports = {
  activate,
  deactivate,
  installRendererPatch,
  uninstallRendererPatch,
  resolveToWindowsPath,
  inspectPathStatus,
  buildCleanExternalEnv,
  defaultOpen
};
