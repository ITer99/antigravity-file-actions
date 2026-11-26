(function () {
  'use strict';

  if (window.__ANTIGRAVITY_FILE_ACTIONS_INJECTED__) return;
  window.__ANTIGRAVITY_FILE_ACTIONS_INJECTED__ = true;

  const INITIAL_SEARCH = typeof window !== 'undefined' && window.location ? (window.location.search || '') : '';
  const BRIDGE_PORTS = [49821, 49822, 49823];
  let activePort = BRIDGE_PORTS[0];

  const IS_MAC = typeof window !== 'undefined' && (
    window.__AFA_PLATFORM__ === 'darwin' ||
    /Mac|iPhone|iPad|iPod/i.test((typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '')
  );

  const DANGEROUS_EXTS = new Set([
    '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.jse',
    '.wsf', '.msi', '.scr', '.hta', '.com', '.pif', '.reg', '.msc', '.jar',
    '.app', '.command', '.sh', '.zsh', '.bash', '.csh', '.pkg', '.dmg',
    '.workflow', '.scpt', '.applescript', '.tool', '.action', '.osax'
  ]);

  const NON_FILE_SCHEMES = new Set([
    'http', 'https', 'mailto', 'ftp', 'ws', 'wss', 'data', 'blob',
    'javascript', 'about', 'command', 'vscode', 'antigravity', 'antigravity-ide',
    'conversation', 'customization', 'sidecar', 'recipe', 'terminal',
    'ai-context-provider', 'browserpage', 'slashcommand', 'rule',
    'mcpresource', 'mcpprompt', 'knowledge', 'domelement', 'consolelog',
    'browsertext', 'browsercodeblock', 'useractivity', 'slack', 'github',
    'repository', 'cci', 'repositorypath', 'jira', 'label', 'icon'
  ]);

  const CODE_FALSE_POSITIVES = new Set([
    'console.log', 'console.error', 'console.warn', 'console.info', 'console.debug',
    'window.location', 'window.vscode', 'window.document', 'document.body',
    'document.createelement', 'object.keys', 'object.values', 'object.entries',
    'object.assign', 'json.parse', 'json.stringify', 'promise.all', 'promise.resolve',
    'math.max', 'math.min', 'math.floor', 'math.round', 'array.from', 'array.isarray',
    'process.env', 'process.platform', 'process.cwd', 'module.exports', 'exports.default',
    'vscode.window', 'vscode.workspace', 'vscode.commands', 'vscode.uri', 'vscode.env',
    'event.target', 'event.preventdefault', 'event.stoppropagation', 'e.target',
    'e.preventdefault', 'e.stoppropagation', 'req.body', 'res.json', 'res.status'
  ]);

  const COMMON_FILE_EXTS = new Set([
    '.md', '.txt', '.json', '.jsonc', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs',
    '.php', '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte', '.astro',
    '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.xml', '.svg',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.docx',
    '.xlsx', '.pptx', '.csv', '.tsv', '.sql', '.sh', '.bash', '.zsh', '.ps1',
    '.bat', '.cmd', '.vbs', '.exe', '.msi', '.zip', '.tar', '.gz', '.7z', '.rar',
    '.vsix', '.log', '.lock', '.gitignore', '.npmrc', '.editorconfig', '.dockerfile',
    '.mp3', '.wav', '.mp4', '.mov', '.webm', '.srt', '.vtt', '.ass'
  ]);

  const KNOWN_BARE_FILENAMES = new Set([
    'dockerfile', 'makefile', 'license', 'readme', 'changelog', 'authors',
    'notice', 'gemfile', 'rakefile', 'procfile', 'vagrantfile', 'cmakelists.txt'
  ]);

  // ---------------------------------------------------------------------------
  // 1. Workspace Discovery in Renderer
  // ---------------------------------------------------------------------------
  function safeDecodeUriPath(str) {
    if (!str) return '';
    try {
      return decodeURIComponent(str);
    } catch (_) {
      return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
        try {
          return decodeURIComponent(match);
        } catch (__) {
          return match;
        }
      });
    }
  }

  function uriToLocalPath(uriStr) {
    if (!uriStr || typeof uriStr !== 'string') return '';
    let s = uriStr.trim();
    if (!/^file:\/\//i.test(s) && !/^vscode-remote:\/\//i.test(s)) {
      if (/^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s)) return normalizeWinPath(s);
      if (s.startsWith('/') || s.startsWith('~/') || s === '~') return normalizePosixPath(s);
      return s;
    }
    let p = s.replace(/^(?:file|vscode-remote):\/\/(?:localhost)?/i, '');
    p = safeDecodeUriPath(p);
    if (/^\/[a-zA-Z]:/.test(p)) {
      return normalizeWinPath(p.slice(1));
    }
    if (/^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p)) {
      return normalizeWinPath(p);
    }
    if (!p.startsWith('/')) p = '/' + p;
    return normalizePosixPath(p);
  }

  function normalizePosixPath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return '';
    let s = inputPath.trim().replace(/\/+/g, '/');
    if (!s) return '';
    const isHome = s === '~' || s.startsWith('~/');
    const isAbs = s.startsWith('/');
    const parts = s.split('/');
    const stack = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part || part === '.') continue;
      if (i === 0 && isHome && part === '~') {
        stack.push('~');
        continue;
      }
      if (part === '..') {
        if (stack.length > 0 && !(stack.length === 1 && stack[0] === '~')) {
          stack.pop();
        }
      } else {
        stack.push(part);
      }
    }
    if (isAbs) return '/' + stack.join('/');
    if (isHome) return stack.length > 0 ? stack.join('/') : '~';
    return stack.join('/') || '.';
  }

  function normalizeWinPath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return '';
    let s = inputPath.trim().replace(/\//g, '\\');
    if (/^[a-z]:\\/.test(s)) {
      s = s[0].toUpperCase() + s.slice(1);
    }
    // Resolve . and .. segments cleanly
    const isUnc = s.startsWith('\\\\');
    const prefix = isUnc ? '\\\\' : '';
    const parts = s.split(/\\+/);
    const stack = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part || part === '.') continue;
      if (part === '..') {
        if (stack.length > 1 || (stack.length === 1 && !/^[a-zA-Z]:$/.test(stack[0]))) {
          stack.pop();
        }
      } else {
        stack.push(part);
      }
    }
    let out = prefix + stack.join('\\');
    if (/^[a-zA-Z]:$/.test(out)) out += '\\';
    return out;
  }

  function isAbsoluteLocalRoot(p) {
    return Boolean(p && (/^[a-zA-Z]:\\/.test(p) || /^\\\\/.test(p) || p.startsWith('/')));
  }

  function getWindowWorkspaceHints() {
    const hints = [];
    const addHintUri = (rawUri) => {
      if (!rawUri || typeof rawUri !== 'string') return;
      const p = uriToLocalPath(rawUri);
      if (isAbsoluteLocalRoot(p) && !hints.includes(p)) {
        hints.push(p);
      }
    };
    try {
      if (typeof window.__AFA_WORKSPACE_URI__ === 'string' && window.__AFA_WORKSPACE_URI__) {
        addHintUri(window.__AFA_WORKSPACE_URI__);
      }
      const curWs = new URLSearchParams(window.location.search || '').get('workspaceUri');
      if (curWs) addHintUri(curWs);
      const initWs = new URLSearchParams(INITIAL_SEARCH).get('workspaceUri');
      if (initWs) addHintUri(initWs);
    } catch (_) { }
    try {
      const cfg = window.vscode?.context?.configuration?.();
      if (cfg) {
        if (cfg.folderUri) {
          const u = typeof cfg.folderUri === 'string'
            ? cfg.folderUri
            : (cfg.folderUri.external || cfg.folderUri.fsPath || cfg.folderUri.path || '');
          const p = u ? uriToLocalPath(u) : '';
          if (isAbsoluteLocalRoot(p) && !hints.includes(p)) hints.push(p);
        }
        if (cfg.workspace && cfg.workspace.configPath) {
          const u = cfg.workspace.configPath.external || cfg.workspace.configPath.fsPath || cfg.workspace.configPath.path || '';
          const p = u ? uriToLocalPath(u) : '';
          if (isAbsoluteLocalRoot(p)) {
            const lastSep = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
            if (lastSep > 0) {
              const dir = p.slice(0, lastSep);
              if (isAbsoluteLocalRoot(dir) && !hints.includes(dir)) hints.push(dir);
            }
          }
        }
      }
    } catch (_) { }
    return hints;
  }

  // ---------------------------------------------------------------------------
  // 2. Path Parsing & Classification
  // ---------------------------------------------------------------------------
  const POSIX_KNOWN_ROOT_RE = /^\/(?:Users|Volumes|Applications|Library|System|opt|usr|etc|var|tmp|private|home|mnt|srv|root|workspace)(?:\/|$)/;

  function isLikelyPosixAbsPath(s, sourceType) {
    if (!s || !s.startsWith('/') || s.startsWith('//')) return false;
    if (/[<>:"|?*]/.test(s)) return false;
    if (POSIX_KNOWN_ROOT_RE.test(s)) return s.length > 1;
    const segments = s.split('/').filter(Boolean);
    if (segments.length === 0) return false;
    if (sourceType === 'data-uri' || sourceType === 'anchor') {
      return segments.length >= 2 || (segments.length === 1 && (COMMON_FILE_EXTS.has(getExtension(segments[0])) || KNOWN_BARE_FILENAMES.has(segments[0].toLowerCase())));
    }
    if (sourceType === 'code' && segments.length >= 2) {
      const lastSeg = segments[segments.length - 1];
      const ext = getExtension(lastSeg);
      return Boolean(COMMON_FILE_EXTS.has(ext) || KNOWN_BARE_FILENAMES.has(lastSeg.toLowerCase()));
    }
    return false;
  }

  function stripLineAndColSuffix(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let s = raw.trim();
    // Strip #L10-L20 or #L10 or #10:5
    s = s.replace(/#(?:L?\d+(?:[-:–]L?\d+)?|\d+)$/i, '');
    // Strip ?query
    s = s.replace(/\?[^\\/\r\n]+$/, '');
    // Strip trailing :line:col or :line (protect drive letter C:)
    const match = /^(.*?)((?::\d+){1,2})$/.exec(s);
    if (match && match[1].length > 2) {
      s = match[1];
    }
    // Strip trailing (line, col) e.g. file.ts(10,5)
    const parenMatch = /^(.*?\.[a-zA-Z0-9]{1,10})\(\d+(?:,\s*\d+)?\)$/.exec(s);
    if (parenMatch) {
      s = parenMatch[1];
    }
    return s.trim();
  }

  function cleanRawInput(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let s = raw.trim();
    s = s.replace(/^`+|`+$/g, '').replace(/^['"]+|['"]+$/g, '').trim();
    const md = /^\[[^\]]*\]\(([^)]+)\)$/.exec(s);
    if (md) s = md[1].trim().replace(/^<|>$/g, '');
    return s;
  }

  function getExtension(filePath) {
    if (!filePath) return '';
    const base = filePath.split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return '';
    return base.slice(dot).toLowerCase();
  }

  function isDangerousFile(filePath) {
    return DANGEROUS_EXTS.has(getExtension(filePath));
  }

  /**
   * Determines whether a candidate string from DOM is a local file path.
   * Returns { kind: 'file-uri' | 'win-abs' | 'posix-abs' | 'rel-path' | 'bare-file', rawPath, normalizedPath } or null.
   */
  function parseLocalPathCandidate(rawInput, sourceType) {
    const cleaned = cleanRawInput(rawInput);
    if (!cleaned || cleaned.length > 1024 || /[\r\n\0]/.test(cleaned)) return null;

    // Check scheme if present
    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
    if (schemeMatch) {
      const scheme = schemeMatch[1].toLowerCase();
      if (scheme.length === 1 && /^[a-zA-Z]:[\\/]/.test(cleaned)) {
        // Windows drive letter like G:\ or C:/
      } else if (scheme === 'file' || scheme === 'vscode-remote') {
        const stripped = stripLineAndColSuffix(cleaned);
        const localPath = uriToLocalPath(stripped);
        if (!localPath || !(/^(?:[a-zA-Z]:\\|\\\\|\/)/.test(localPath))) return null;
        return {
          kind: 'file-uri',
          rawPath: cleaned,
          normalizedPath: localPath,
          isAbsolute: true
        };
      } else if (NON_FILE_SCHEMES.has(scheme) || cleaned.includes('://')) {
        return null;
      }
    }

    const stripped = stripLineAndColSuffix(cleaned);
    if (!stripped) return null;

    // 1. Windows Absolute Path (e.g. G:\workspace\ITer-Motion-Studio\README.md or C:/Users/Li Jie/test.md)
    if (/^[a-zA-Z]:[\\/]/.test(stripped)) {
      const afterDrive = stripped.slice(2);
      if (/[<>:"|?*]/.test(afterDrive)) return null;
      const winPath = normalizeWinPath(stripped);
      return {
        kind: 'win-abs',
        rawPath: stripped,
        normalizedPath: winPath,
        isAbsolute: true
      };
    }

    // 2. UNC path \\server\share\file
    if (/^\\\\[^\\/:*?"<>|\r\n]+\\[^\\/:*?"<>|\r\n]+/.test(stripped)) {
      return {
        kind: 'win-abs',
        rawPath: stripped,
        normalizedPath: normalizeWinPath(stripped),
        isAbsolute: true
      };
    }

    // 2b. Home shorthand path ~/...
    if (/^~\/[^\s"'<>|?*`]+$/.test(stripped)) {
      return {
        kind: 'posix-abs',
        rawPath: stripped,
        normalizedPath: normalizePosixPath(stripped),
        isAbsolute: true
      };
    }

    // 2c. macOS / POSIX Absolute Path (/Users/..., /Volumes/..., etc.)
    if (isLikelyPosixAbsPath(stripped, sourceType)) {
      return {
        kind: 'posix-abs',
        rawPath: stripped,
        normalizedPath: normalizePosixPath(stripped),
        isAbsolute: true
      };
    }

    // For strict sources (like plain text cursor lookup), require absolute path or file:// URI
    if (sourceType === 'plain-text') {
      return null;
    }

    // Reject strings with illegal filename characters
    if (/[<>:"|?*]/.test(stripped)) return null;
    if (CODE_FALSE_POSITIVES.has(stripped.toLowerCase())) return null;

    // 3. Relative path containing directory separator (/ or \)
    if (/[\\/]/.test(stripped) && !stripped.startsWith('//')) {
      // Avoid shell flags or division expressions like "a / b" or "/allow-missing"
      if (/\s[\\/]\s/.test(stripped) || /^\/[a-zA-Z0-9_-]+$/.test(stripped)) return null;
      const segments = stripped.split(/[\\/]+/).filter(Boolean);
      if (segments.length === 0) return null;
      const lastSeg = segments[segments.length - 1];
      const ext = getExtension(lastSeg);
      const isExplicitRel = stripped.startsWith('./') || stripped.startsWith('.\\') || stripped.startsWith('../') || stripped.startsWith('..\\');
      if (isExplicitRel || COMMON_FILE_EXTS.has(ext) || KNOWN_BARE_FILENAMES.has(lastSeg.toLowerCase()) || sourceType === 'data-uri' || sourceType === 'anchor') {
        const hints = getWindowWorkspaceHints();
        let fallbackAbs = stripped;
        if (hints.length > 0) {
          fallbackAbs = hints[0].startsWith('/')
            ? normalizePosixPath(hints[0] + '/' + stripped.replace(/\\/g, '/'))
            : normalizeWinPath(hints[0] + '\\' + stripped);
        }
        return {
          kind: 'rel-path',
          rawPath: stripped,
          normalizedPath: fallbackAbs,
          isAbsolute: false
        };
      }
    }

    // 4. Bare filename (e.g. README.md, package.json, extension.js)
    if (!/\s/.test(stripped) && /^[\w\u4e00-\u9fa5.@()-]+$/.test(stripped)) {
      const ext = getExtension(stripped);
      const lower = stripped.toLowerCase();
      // Reject version numbers like v0.1.0 or 127.0.0.1
      if (/^v?\d+(?:\.\d+)+$/i.test(stripped)) return null;
      // Reject camelCase.method patterns unless ext is a known file extension and not .log on console.log
      if (COMMON_FILE_EXTS.has(ext) || KNOWN_BARE_FILENAMES.has(lower)) {
        const hints = getWindowWorkspaceHints();
        let fallbackAbs = stripped;
        if (hints.length > 0) {
          fallbackAbs = hints[0].startsWith('/')
            ? normalizePosixPath(hints[0] + '/' + stripped)
            : normalizeWinPath(hints[0] + '\\' + stripped);
        }
        return {
          kind: 'bare-file',
          rawPath: stripped,
          normalizedPath: fallbackAbs,
          isAbsolute: false
        };
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // 3. Agent Chat Context Detection & DOM Target Extraction
  // ---------------------------------------------------------------------------
  function isInAgentChatArea(target) {
    if (!(target instanceof Element)) return false;

    // Never trigger on our own UI, Monaco editor, xterm terminal, or left Explorer tree
    if (target.closest('#afa-context-menu, #afa-confirm-modal, #afa-toast-container')) return false;
    if (target.closest('.monaco-editor, .xterm, .explorer-folders-view')) return false;

    const sidebar = target.closest('[id="workbench.parts.sidebar"]');
    if (sidebar && !target.closest('[id*="antigravity"]')) return false;

    // Do not intercept inside editable inputs unless right-clicking a FilePill [data-uri]
    if (target.closest('input, textarea, [contenteditable="true"]') && !target.closest('[data-uri]')) {
      return false;
    }

    // Match Agent Chat surfaces (including #jetski-frame webview iframe and workbench views)
    if (window.__APP_CONFIG__?.productName === 'antigravity') return true;
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') return true;
    if (window.location.pathname.includes('workbench-jetski-agent.html')) return true;
    if (target.closest('[id="workbench.parts.auxiliarybar"], .part.auxiliarybar')) return true;
    if (target.closest('[id*="antigravity.panel"], [id*="antigravity.agent"]')) return true;
    if (target.closest('[data-markdown-root], .md-divider-spacing, .context-scope-mention, [data-quotable-inline="true"], [data-uri]')) return true;

    return false;
  }

  function extractPathAtPoint(clientX, clientY) {
    if (typeof document.caretRangeFromPoint !== 'function') return null;
    let range;
    try {
      range = document.caretRangeFromPoint(clientX, clientY);
    } catch (_) {
      return null;
    }
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const textNode = range.startContainer;
    const text = textNode.textContent || '';
    const offset = range.startOffset;
    if (!text.trim()) return null;

    // Verify mouse is actually within the text node's bounding box
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(textNode);
    const rects = Array.from(nodeRange.getClientRects());
    const insideRect = rects.some(r =>
      clientX >= r.left - 4 && clientX <= r.right + 4 &&
      clientY >= r.top - 4 && clientY <= r.bottom + 4
    );
    if (!insideRect) return null;

    // Match file:///..., Windows absolute path G:\..., macOS/POSIX known roots, or ~/... around offset
    const patterns = [
      /file:\/\/\/[^\s"'<>()`]+/gi,
      /[a-zA-Z]:[\\/][^\s"'<>|?*`]+/g,
      /\/(?:Users|Volumes|Applications|Library|System|opt|usr|etc|var|tmp|private|home|mnt|srv|root|workspace)\/[^\s"'<>|?*`]+/g,
      /~\/[^\s"'<>|?*`]+/g
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const start = m.index;
        let matched = m[0];
        // Trim trailing punctuation like ), ., ;, ，, 。
        matched = matched.replace(/[.,;，。、！）\]>]+$/, '');
        const end = start + matched.length;
        if (offset >= start && offset <= end) {
          return parseLocalPathCandidate(matched, 'plain-text');
        }
      }
    }
    return null;
  }

  function findFileTargetFromEvent(event) {
    const rawTarget = event.target;
    const target = rawTarget instanceof Element
      ? rawTarget
      : (rawTarget && rawTarget.parentElement instanceof Element ? rawTarget.parentElement : null);
    if (!target) return null;
    if (!isInAgentChatArea(target)) return null;

    // 1. Check Antigravity FilePill ([data-uri])
    const pill = target.closest('[data-uri]');
    if (pill) {
      const dataUri = pill.getAttribute('data-uri') || '';
      const titleAttr = pill.getAttribute('title') || '';
      const parsedUri = parseLocalPathCandidate(dataUri, 'data-uri');
      if (parsedUri) return { ...parsedUri, element: pill };
      const parsedTitle = parseLocalPathCandidate(titleAttr, 'data-uri');
      if (parsedTitle) return { ...parsedTitle, element: pill };
      return null;
    }

    // 2. Check standard <a href="...">
    const anchor = target.closest('a[href]');
    if (anchor) {
      const href = anchor.getAttribute('href') || '';
      const parsedHref = parseLocalPathCandidate(href, 'anchor');
      if (parsedHref) return { ...parsedHref, element: anchor };
      const textCand = parseLocalPathCandidate(anchor.textContent || '', 'anchor');
      if (textCand && textCand.isAbsolute) return { ...textCand, element: anchor };
      return null;
    }

    // 3. Check inline <code> (or single-line <pre><code>)
    const codeEl = target.closest('code');
    if (codeEl) {
      if (codeEl.dataset.afaExists === 'false') return null;
      if (codeEl.dataset.afaResolvedPath && codeEl.dataset.afaExists === 'true') {
        return {
          kind: 'cached-code',
          rawPath: (codeEl.textContent || '').trim(),
          normalizedPath: codeEl.dataset.afaResolvedPath,
          isAbsolute: true,
          element: codeEl
        };
      }
      const inPre = Boolean(codeEl.closest('pre'));
      const rawCode = (codeEl.textContent || '').trim();
      if (!inPre || !rawCode.includes('\n')) {
        const parsedCode = parseLocalPathCandidate(rawCode, 'code');
        if (parsedCode) {
          if (!parsedCode.isAbsolute) {
            const syncRes = resolveViaBridgeSync(parsedCode.rawPath);
            if (syncRes && syncRes.ok) {
              if (!syncRes.exists && parsedCode.kind === 'bare-file') {
                codeEl.dataset.afaExists = 'false';
                return null;
              }
              if (syncRes.resolvedPath) {
                parsedCode.normalizedPath = syncRes.resolvedPath;
              }
            }
          }
          return { ...parsedCode, element: codeEl };
        }
      }
      const pointCand = extractPathAtPoint(event.clientX, event.clientY);
      if (pointCand) return { ...pointCand, element: codeEl };
      return null;
    }

    // 4. Check active text selection if it is a file path
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const selText = sel.toString().trim();
      const parsedSel = parseLocalPathCandidate(selText, 'plain-text');
      if (parsedSel) return { ...parsedSel, element: target };
    }

    // 5. Check plain text node directly under cursor inside Markdown output
    if (target.closest('[data-markdown-root], .md-divider-spacing')) {
      const pointCand = extractPathAtPoint(event.clientX, event.clientY);
      if (pointCand) return { ...pointCand, element: target };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // 4. Bridge Communication (Same-Origin Proxy + Loopback Sync & Async)
  // ---------------------------------------------------------------------------
  function getBridgeUrls(endpoint) {
    const urls = [];
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      const sameOriginPath = endpoint === '/resolve'
        ? '/__afa_resolve__'
        : (endpoint === '/ping' ? '/__afa_ping__' : '/__afa_action__');
      urls.push(`${window.location.origin}${sameOriginPath}`);
    }
    for (const port of [activePort, ...BRIDGE_PORTS.filter(p => p !== activePort)]) {
      urls.push(`http://127.0.0.1:${port}${endpoint}`);
    }
    return urls;
  }

  function resolveViaBridgeSync(rawPath) {
    const hints = getWindowWorkspaceHints();
    const payload = JSON.stringify({ rawPath, workspaceHints: hints });
    for (const url of getBridgeUrls('/resolve')) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(payload);
        if (xhr.status === 200) {
          return JSON.parse(xhr.responseText);
        }
      } catch (_) { }
    }
    return null;
  }

  async function callBridgeAsync(endpoint, payload) {
    const hints = getWindowWorkspaceHints();
    const body = JSON.stringify({ ...payload, workspaceHints: hints });
    for (const url of getBridgeUrls(endpoint)) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body
        });
        if (resp.ok) {
          return await resp.json();
        }
      } catch (_) { }
    }
    return null;
  }

  // Hover pre-resolution on inline <code> inside AI chat
  window.addEventListener('mouseover', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const codeEl = target.closest('[data-markdown-root] code:not(pre code), .md-divider-spacing code:not(pre code)');
    if (!codeEl || codeEl.dataset.afaChecked === 'true') return;
    codeEl.dataset.afaChecked = 'true';

    const rawText = (codeEl.textContent || '').trim();
    const cand = parseLocalPathCandidate(rawText, 'code');
    if (!cand) {
      codeEl.dataset.afaExists = 'false';
      return;
    }
    if (cand.isAbsolute) {
      codeEl.dataset.afaResolvedPath = cand.normalizedPath;
      codeEl.dataset.afaExists = 'true';
      codeEl.dataset.afaFileLink = 'true';
    }
    callBridgeAsync('/resolve', { rawPath: cand.rawPath }).then((res) => {
      if (!res || !res.ok) return;
      if (res.resolvedPath) {
        codeEl.dataset.afaResolvedPath = res.resolvedPath;
      }
      if (cand.isAbsolute || res.exists) {
        codeEl.dataset.afaExists = 'true';
        codeEl.dataset.afaFileLink = 'true';
      } else {
        codeEl.dataset.afaExists = 'false';
        delete codeEl.dataset.afaFileLink;
      }
    });
  }, true);

  // ---------------------------------------------------------------------------
  // 5. Styles, Toast, Confirmation Modal & Context Menu UI (Trusted-Types Safe)
  // ---------------------------------------------------------------------------
  function ensureStyles() {
    if (document.getElementById('afa-injected-styles')) return;
    const style = document.createElement('style');
    style.id = 'afa-injected-styles';
    style.textContent = `
      [data-markdown-root] code[data-afa-file-link="true"],
      .md-divider-spacing code[data-afa-file-link="true"] {
        cursor: pointer;
        text-decoration: underline;
        text-decoration-color: rgba(120, 160, 255, 0.45);
        text-underline-offset: 3px;
        transition: background-color 120ms ease, text-decoration-color 120ms ease;
      }
      [data-markdown-root] code[data-afa-file-link="true"]:hover,
      .md-divider-spacing code[data-afa-file-link="true"]:hover {
        text-decoration-color: rgba(120, 160, 255, 0.9);
      }
      #afa-context-menu {
        position: fixed;
        z-index: 2147483640;
        min-width: 224px;
        max-width: 340px;
        padding: 4px;
        border-radius: 10px;
        background: var(--card, var(--vscode-menu-background, #1e1e22));
        color: var(--foreground, var(--vscode-menu-foreground, #e4e4e7));
        border: 1px solid var(--border, var(--vscode-menu-border, rgba(255, 255, 255, 0.12)));
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.42), 0 2px 8px rgba(0, 0, 0, 0.25);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
        font-size: 13px;
        line-height: 1.4;
        user-select: none;
        backdrop-filter: blur(12px);
        animation: afaMenuFadeIn 110ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes afaMenuFadeIn {
        from { opacity: 0; transform: scale(0.96); }
        to { opacity: 1; transform: scale(1); }
      }
      .afa-menu-header {
        padding: 5px 10px 4px;
        font-size: 11px;
        color: var(--muted-foreground, var(--vscode-descriptionForeground, #8e8e93));
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        border-bottom: 1px solid var(--border, var(--vscode-menu-separatorBackground, rgba(255, 255, 255, 0.08)));
        margin-bottom: 3px;
        font-family: var(--vscode-editor-font-family, Consolas, monospace);
      }
      .afa-menu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 10px;
        border: none;
        background: transparent;
        color: inherit;
        font-size: 13px;
        text-align: left;
        border-radius: 6px;
        cursor: pointer;
        outline: none;
        box-sizing: border-box;
        transition: background-color 80ms ease, color 80ms ease;
      }
      .afa-menu-item:hover,
      .afa-menu-item:focus,
      .afa-menu-item.afa-active {
        background: var(--secondary, var(--vscode-menu-selectionBackground, rgba(255, 255, 255, 0.1)));
        color: var(--foreground, var(--vscode-menu-selectionForeground, #ffffff));
      }
      .afa-menu-icon {
        width: 15px;
        height: 15px;
        flex-shrink: 0;
        opacity: 0.85;
      }
      .afa-menu-sep {
        height: 1px;
        margin: 3px 4px;
        background: var(--border, var(--vscode-menu-separatorBackground, rgba(255, 255, 255, 0.08)));
      }
      #afa-toast-container {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483645;
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: none;
      }
      .afa-toast {
        pointer-events: auto;
        max-width: 380px;
        padding: 8px 12px;
        border-radius: 8px;
        background: var(--card, var(--vscode-notifications-background, #252529));
        color: var(--foreground, var(--vscode-notifications-foreground, #f2f2f7));
        border: 1px solid var(--border, var(--vscode-notifications-border, rgba(255, 255, 255, 0.14)));
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        font-size: 12.5px;
        line-height: 1.4;
        word-break: break-all;
        animation: afaMenuFadeIn 140ms ease-out;
      }
      .afa-toast-error {
        border-color: rgba(239, 68, 68, 0.55);
      }
      #afa-confirm-modal {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .afa-modal-card {
        width: 100%;
        max-width: 400px;
        padding: 16px;
        border-radius: 12px;
        background: var(--card, var(--vscode-editorWidget-background, #1e1e22));
        color: var(--foreground, var(--vscode-editorWidget-foreground, #e4e4e7));
        border: 1px solid var(--border, var(--vscode-widget-border, rgba(255, 255, 255, 0.15)));
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
        font-size: 13px;
      }
      .afa-modal-title {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 8px;
      }
      .afa-modal-desc {
        color: var(--muted-foreground, #a1a1aa);
        line-height: 1.5;
        word-break: break-all;
        margin-bottom: 14px;
      }
      .afa-modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .afa-btn {
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 12.5px;
        cursor: pointer;
        border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
        background: transparent;
        color: inherit;
      }
      .afa-btn-danger {
        background: #dc2626;
        border-color: #dc2626;
        color: #ffffff;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createSvgIcon(paths) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', 'afa-menu-icon');
    for (const d of paths) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  function showToast(message, isError) {
    ensureStyles();
    let container = document.getElementById('afa-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'afa-toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'afa-toast' + (isError ? ' afa-toast-error' : '');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 2800);
  }

  function showDangerousFileConfirm(filePath) {
    ensureStyles();
    return new Promise((resolve) => {
      const existing = document.getElementById('afa-confirm-modal');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'afa-confirm-modal';

      const card = document.createElement('div');
      card.className = 'afa-modal-card';

      const title = document.createElement('div');
      title.className = 'afa-modal-title';
      title.textContent = '安全确认：可执行文件或脚本';

      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      const desc = document.createElement('div');
      desc.className = 'afa-modal-desc';
      desc.textContent = `打开 "${fileName}" 可能会直接运行程序或脚本。\n路径：${filePath}\n确定要继续使用系统默认程序打开吗？`;

      const actions = document.createElement('div');
      actions.className = 'afa-modal-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'afa-btn';
      cancelBtn.textContent = '取消';

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'afa-btn afa-btn-danger';
      confirmBtn.textContent = '继续打开';

      const cleanup = (result) => {
        overlay.remove();
        resolve(result);
      };

      cancelBtn.addEventListener('click', () => cleanup(false));
      confirmBtn.addEventListener('click', () => cleanup(true));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) cleanup(false);
      });

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      card.appendChild(title);
      card.appendChild(desc);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      cancelBtn.focus();
    });
  }

  // ---------------------------------------------------------------------------
  // 6. Action Execution
  // ---------------------------------------------------------------------------
  async function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) { }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { }
    ta.remove();
    return ok;
  }

  async function executeFileAction(action, targetInfo) {
    // 1. Resolve authoritative path via bridge first
    let resolvedPath = targetInfo.normalizedPath || targetInfo.rawPath;
    const res = await callBridgeAsync('/resolve', { rawPath: targetInfo.rawPath });
    if (res && res.ok && res.resolvedPath) {
      resolvedPath = res.resolvedPath;
    }

    if (action === 'copyPath') {
      await copyTextToClipboard(resolvedPath);
      await callBridgeAsync('/action', { action: 'copyPath', rawPath: resolvedPath });
      showToast(`已复制绝对路径：${resolvedPath}`, false);
      return;
    }

    let confirmed = false;
    if (action === 'open' && isDangerousFile(resolvedPath)) {
      confirmed = await showDangerousFileConfirm(resolvedPath);
      if (!confirmed) return;
    }

    const actionRes = await callBridgeAsync('/action', {
      action,
      rawPath: targetInfo.rawPath,
      resolvedPath,
      confirmed
    });

    if (!actionRes) {
      // Fallback to VS Code URI handler via hidden anchor click (does not navigate workbench frame)
      const uri = `antigravity-ide://local-dev.antigravity-file-actions/action?action=${encodeURIComponent(action)}&path=${encodeURIComponent(resolvedPath)}&confirmed=${confirmed ? '1' : '0'}`;
      const a = document.createElement('a');
      a.href = uri;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }

    if (!actionRes.ok) {
      if (actionRes.cancelled) return;
      showToast(actionRes.error || `操作失败：${resolvedPath}`, true);
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Context Menu Lifecycle
  // ---------------------------------------------------------------------------
  let currentMenu = null;

  function closeContextMenu() {
    if (currentMenu) {
      currentMenu.remove();
      currentMenu = null;
    }
  }

  function showFileContextMenu(x, y, targetInfo) {
    ensureStyles();
    closeContextMenu();

    const menu = document.createElement('div');
    menu.id = 'afa-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('data-afa-target-path', targetInfo.normalizedPath || targetInfo.rawPath);
    for (const evtName of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'contextmenu']) {
      menu.addEventListener(evtName, (e) => {
        if (evtName === 'contextmenu') e.preventDefault();
        e.stopPropagation();
      });
    }

    // Header showing file basename
    const displayPath = targetInfo.normalizedPath || targetInfo.rawPath;
    const fileName = displayPath.split(/[\\/]/).pop() || displayPath;
    const header = document.createElement('div');
    header.className = 'afa-menu-header';
    header.textContent = fileName;
    header.title = displayPath;
    menu.appendChild(header);

    const itemsConfig = [
      {
        id: 'open',
        label: '使用系统默认程序打开',
        iconPaths: ['M7 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9', 'M10 2h4v4', 'M14 2 7.5 8.5']
      },
      {
        id: 'reveal',
        label: IS_MAC ? '在访达中显示' : '在 Windows 资源管理器中显示',
        iconPaths: ['M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-8Z']
      },
      { type: 'separator' },
      {
        id: 'copyPath',
        label: '复制文件绝对路径',
        iconPaths: ['M5.5 5.5h7a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 4 13V7a1.5 1.5 0 0 1 1.5-1.5Z', 'M3 10.5H2.5A1.5 1.5 0 0 1 1 9V3a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 10 3v.5']
      }
    ];

    const buttons = [];
    for (const item of itemsConfig) {
      if (item.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'afa-menu-sep';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'afa-menu-item';
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('data-afa-action', item.id);
      btn.appendChild(createSvgIcon(item.iconPaths));

      const span = document.createElement('span');
      span.textContent = item.label;
      btn.appendChild(span);

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
        executeFileAction(item.id, targetInfo);
      });

      menu.appendChild(btn);
      buttons.push(btn);
    }

    document.body.appendChild(menu);
    currentMenu = menu;

    // Position within viewport bounds
    const rect = menu.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - rect.width - 8);
    const maxY = Math.max(8, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.min(Math.max(8, x), maxX)}px`;
    menu.style.top = `${Math.min(Math.max(8, y), maxY)}px`;

    // Async update header tooltip if relative path resolves to full path
    if (!targetInfo.isAbsolute) {
      callBridgeAsync('/resolve', { rawPath: targetInfo.rawPath }).then((res) => {
        if (res && res.ok && res.resolvedPath) {
          targetInfo.normalizedPath = res.resolvedPath;
          header.title = res.resolvedPath;
          menu.setAttribute('data-afa-target-path', res.resolvedPath);
        }
      });
    }
  }

  // Global capture listener for contextmenu
  window.addEventListener('contextmenu', (event) => {
    const targetInfo = findFileTargetFromEvent(event);
    if (!targetInfo) {
      closeContextMenu();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    showFileContextMenu(event.clientX, event.clientY, targetInfo);
    callBridgeAsync('/ping', {
      event: 'contextmenu',
      href: window.location.href,
      kind: targetInfo.kind,
      rawPath: targetInfo.rawPath,
      normalizedPath: targetInfo.normalizedPath
    });
  }, true);

  // Report injection boot to bridge for diagnostics & workspace registration
  callBridgeAsync('/ping', {
    event: 'boot',
    href: window.location.href
  });

  // Dismiss menu on outside interactions
  window.addEventListener('mousedown', (event) => {
    if (currentMenu && !currentMenu.contains(event.target)) {
      closeContextMenu();
    }
  }, true);

  window.addEventListener('keydown', (event) => {
    if (!currentMenu) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeContextMenu();
    }
  }, true);

  window.addEventListener('blur', closeContextMenu);
  window.addEventListener('scroll', closeContextMenu, true);
})();
