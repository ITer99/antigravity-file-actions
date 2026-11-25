# Antigravity File Actions

> 为 **Antigravity IDE (Windows 10/11)** 右侧原生 AI Agent 对话窗口提供与 OpenAI Codex Desktop 一致的本地文件右键操作菜单。

当 AI Agent 回复中包含本地文件路径或可点击的文件链接时，直接在对话区域对该链接/路径点击**鼠标右键**，即可弹出上下文操作菜单：

- **使用系统默认程序打开**：调用 Windows Shell 默认关联程序打开目标文件。
- **在 Windows 资源管理器中显示**：打开 Windows Explorer 并自动高亮选中目标文件。
- **复制文件绝对路径**：将规范化后的 Windows 绝对路径写入系统剪贴板。

---

## 一、功能特性

1. **原生 AI 对话窗口直接右键**
   - **文件胶囊链接（FilePill）**：支持 Antigravity 原生 `[data-uri="file:///..."]` 胶囊组件与 Markdown 本地文件链接。
   - **反引号内联代码路径**：支持 `` `G:\workspace\Project\README.md` `` 等内联代码路径（悬停自动预解析并显示可交互下划线提示）。
   - **纯文本路径**：支持对话正文中未包裹反引号的 Windows 绝对路径或 `file:///` 路径。
   - **同时兼容文件树与编辑器标签页**：在左侧 Explorer 文件树及编辑器标题栏右键菜单中也提供相同操作。

2. **完整的 Windows 路径解析能力**
   - 支持 **Windows 绝对路径**（`G:\workspace\...`、`C:/Users/...`）、**UNC 路径**（`\\server\share\...`）与 **工作区相对路径**（`src/index.ts`、`./package.json`）。
   - 支持包含**中文、空格、括号、`%`、`#`** 等特殊字符的路径。
   - 自动剥离 `#L10-L20`、`:10:5`、`(10,5)` 等行号/列号后缀，精准定位底层文件。

3. **严格的作用域与安全边界**
   - **零干扰**：仅在识别到本地文件链接/路径时弹出菜单；在普通对话文本、`http/https` 网页链接、输入框或多行代码块上右键时，保持 Antigravity 原生右键行为。
   - **可执行文件安全确认**：对 `.exe`、`.bat`、`.cmd`、`.ps1`、`.vbs`、`.js`、`.msi`、`.reg` 等可执行文件或脚本，选择「使用系统默认程序打开」前强制弹出模态安全确认框，未经确认绝不执行。
   - **外部进程环境隔离**：调用 Windows 默认程序时自动剥离 `ELECTRON_*`（如 `ELECTRON_RUN_AS_NODE`）、`VSCODE_*`、`ANTIGRAVITY_*` 等宿主环境变量，彻底解决 Typora、Obsidian、MarkText、VS Code 等基于 Electron 的默认关联程序无法拉起的问题。

4. **版本更新友好与一键恢复**
   - 扩展激活时自动检测并维护渲染层与内置 `agy` Webview 代理注入（兼容 `/` 与 `/c/<conversationId>` 等全部会话路由）。
   - 修改前自动创建 `.afa-backup` 原始备份，并自动重算同步 `product.json` 的 SHA-256 `checksums`，避免触发 IDE 完整性警告。
   - 提供命令面板一键安装/更新与一键卸载恢复命令。

---

## 二、安装方法

### 方式 1：直接安装 Release 中的 `.vsix`（推荐）

1. 从 GitHub Releases 下载最新的 `antigravity-file-actions-0.2.1.vsix`。
2. 在 PowerShell 中执行以下命令安装到 Antigravity IDE：

```powershell
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension .\antigravity-file-actions-0.2.1.vsix --force
```

3. 打开或切换到 Antigravity IDE，按 `Ctrl+Shift+P` 执行 `Developer: Reload Window`（重新加载窗口）即可生效。

### 方式 2：从源码打包安装

```powershell
git clone https://github.com/ITer99/antigravity-file-actions.git
cd antigravity-file-actions
npx.cmd --yes @vscode/vsce package --allow-missing-repository
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension .\antigravity-file-actions-0.2.1.vsix --force
```

---

## 三、命令面板命令

按 `Ctrl+Shift+P` 可随时调用以下管理或操作命令：

| 命令名称 | Command ID | 说明 |
| :--- | :--- | :--- |
| `文件操作: 使用系统默认程序打开` | `antigravityFileActions.open` | 使用系统默认关联程序打开指定路径 |
| `文件操作: 在 Windows 资源管理器中显示` | `antigravityFileActions.reveal` | 在 Windows Explorer 中打开并选中文件 |
| `文件操作: 复制文件绝对路径` | `antigravityFileActions.copyPath` | 复制规范化后的 Windows 绝对路径 |
| `文件操作: 安装/更新 AI 对话窗口右键菜单补丁` | `antigravityFileActions.installPatch` | 手动安装或修复 AI 对话窗口右键菜单注入（IDE 更新后可使用） |
| `文件操作: 卸载 AI 对话窗口右键菜单补丁（恢复原始文件）` | `antigravityFileActions.uninstallPatch` | 一键卸载注入并从 `.afa-backup` 恢复原始文件与校验和 |

---

## 四、技术架构

Antigravity IDE 右侧 AI 对话面板采用三层隔离架构：
1. **外层 Workbench**：`out/vs/code/electron-browser/workbench/workbench.html` (`workbench.js` / `jetskiAgent.js`)
2. **中层 VS Code Webview (`antigravity.panel`)**：由内置扩展 `extensions/agy` 创建，运行 `bridge.js`
3. **内层对话渲染帧 (`#jetski-frame`)**：加载本地 `agy.exe --hub` 提供的对话 Web 应用（`/` 或 `/c/<conversationId>`）

本插件采用 **VSIX 扩展宿主桥接 + 渲染层轻量同源注入** 混合方案：
- **[extension.js](./extension.js)**：
  - 在 Extension Host 启动本地回环桥接服务（`127.0.0.1:49821`，支持 `49822/49823` 多窗口回退与工作区注册），提供 `/resolve` 路径解析与 `/action` 系统级文件操作（`.NET ProcessStartInfo` `UseShellExecute` 与 `revealFileInOS` / `explorer.exe /select`）。
  - 为内置 `extensions/agy/vscode/extension.js` 提供透明同源代理，将 [renderer-inject.js](./renderer-inject.js) 注入 `#jetski-frame` 的所有 HTML 路由与 `/main.js`，同时将 `/__afa_resolve__` 与 `/__afa_action__` 同源转发至扩展宿主桥接服务。
- **[renderer-inject.js](./renderer-inject.js)**：
  - 遵循 Chromium **Trusted Types** 安全策略（零 `innerHTML`，纯 `document.createElement` / `createElementNS` 构建 UI）。
  - 在 `window` 捕获阶段（Capture Phase）拦截本地文件目标上的 `contextmenu` 事件，阻止冒泡触发默认的 `剪切 / 复制 / 粘贴` 菜单，渲染原生质感的自定义右键菜单、危险可执行文件确认弹窗与 Toast 提示。

---

## 五、目录结构

```text
antigravity-file-actions/
├── extension.js          # VS Code 扩展主入口、本地回环服务、Windows 文件操作与补丁管理
├── renderer-inject.js    # AI 对话窗口渲染层捕获、路径识别与自定义右键菜单 UI
├── package.json          # 扩展清单与命令/菜单配置
├── LICENSE               # MIT 许可证
└── README.md             # 项目说明文档
```

## 六、更新日志

### v0.2.1
- **修复 Markdown 等文件使用 Electron 默认程序打开无效的问题**：调用系统默认程序与资源管理器时自动清理 `ELECTRON_RUN_AS_NODE`、`ELECTRON_*`、`VSCODE_*`、`ANTIGRAVITY_*` 等宿主环境变量，修复 Typora、Obsidian、MarkText、VS Code 等 Electron 应用以 Node.js 模式异常退出的问题。
- **完善错误反馈**：系统默认程序调用启用 PowerShell `$ErrorActionPreference = 'Stop'` 并透出 `stderr` 报错信息。

### v0.2.0
- 首次发布：支持 Antigravity IDE 右侧原生 AI Agent 对话窗口本地文件链接/路径右键菜单（使用系统默认程序打开、在 Windows 资源管理器中显示、复制文件绝对路径）。

---

## 七、许可证

[MIT](./LICENSE)
