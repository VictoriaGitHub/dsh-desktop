# DSH Desktop

将 DeepSeek Harness（DSH）Web 界面封装为**跨平台原生桌面客户端**（Tauri v2），体验对标 Codex 桌面应用：

- 🖥️ 原生窗口（macOS / Windows / Linux），非浏览器标签页
- 📦 **完全自包含**：App 内置 Node.js 运行时 + dsh 全部依赖，**用户无需安装任何东西**
- ⚙️ 智能后端管理：探测端口已有实例直接复用；没有则用内置运行时自动拉起
- 🔄 **自动更新**（tauri-plugin-updater + 签名）：托盘「检查更新」即可升级
- 🍎 托盘常驻：关闭窗口 = 隐藏到托盘；托盘菜单「显示/隐藏」「检查更新」「退出」
- ⌨️ 原生快捷键：`Cmd+W` 隐藏、`Cmd+M` 最小化、`Cmd+H` 隐藏应用、`Cmd+Q` 退出
- 🧹 退出应用自动清理自启的后端进程（独立进程组整组终止；复用外部实例则不动它）
- 🏀 应用图标取自坤坤精灵图（粉丝二创，仅供个人使用）

## 架构

```
DSH Desktop (Tauri shell, Rust)
 ├─ 启动时探测 127.0.0.1:3080（可用 DSH_PORT 改端口）──有服务──▶ 直接复用
 │        │
 │        └─无服务──▶ 用 App 内置运行时启动：
 │                       Contents/Resources/runtime/bin/node
 │                       Contents/Resources/runtime/dsh/…/lib/bin.js web --port 3080
 │                        │   （独立进程组；日志 → ~/.dsh-desktop/backend.log）
 │                        └─▶ 轮询端口就绪（最长 60s）→ WebView 导航到 GUI
 ├─ 托盘/菜单/快捷键；信号处理器（SIGTERM/SIGINT → 优雅退出）
 └─ 退出时：kill 自己拉起的后端子进程组；updater 检查更新（托盘菜单触发）
```

- 桌面壳：Rust + Tauri v2（系统原生 WebView：macOS WKWebView / Windows WebView2 / Linux WebKitGTK）
- 后端：内置 Node（官方二进制，与平台匹配）+ `@deepseek-ai/dsh` 依赖树（构建时按平台裁剪）
- 回退：若 App 内运行时缺失，仍可用外部 `dsh`（`DSH_BIN` → npx 缓存 → PATH）

## 自包含运行时

`scripts/prepare-runtime.mjs` 在构建前生成 `src-tauri/runtime/`（打进 App 的 `Resources/runtime/`）：

```bash
node scripts/prepare-runtime.mjs        # 下载官方 Node + 拷贝/裁剪 dsh 依赖
node scripts/prepare-runtime.mjs --force   # 强制重新生成
```

- Node 二进制：官方 `nodejs.org` 预编译包（当前 v23.11.0，可用 `RUNTIME_NODE_VERSION` 覆盖）
- dsh 依赖：优先复用本机 `~/.npm/_npx` 缓存，否则 `npm install`
- 裁剪：只保留当前平台的原生模块（node-pty / sharp / libvips 等）+ 常用语法高亮语言，删除 source map / 类型定义 / 测试 / 文档
- 产物体积：macOS arm64 约 **268MB**（Node 112MB + 依赖 156MB），dmg 压缩后约 **67MB**

## 环境要求（仅构建时需要）

| 平台 | 要求 |
| --- | --- |
| 通用 | Node.js ≥ 18、pnpm、Rust 工具链（rustc/cargo） |
| macOS | Xcode Command Line Tools（`xcode-select --install`） |
| Windows | WebView2 Runtime（Win10/11 通常自带）；构建需在 Windows 上进行 |
| Linux | `libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、`libayatana-appindicator3-dev` 等（见下文） |

> 用户运行 App 时**不需要**任何上述环境。

## 开发 / 构建

```bash
pnpm install                  # 安装 @tauri-apps/cli
node scripts/prepare-runtime.mjs   # 准备自包含运行时（首次）
./scripts/build.sh            # 构建 + 更新签名（等价 pnpm tauri build，自动带签名 env）
pnpm tauri dev                # 开发模式（本机快速调试，需已装 dsh）
```

产物位置：`src-tauri/target/release/bundle/`

| 产物 | 说明 |
| --- | --- |
| `macos/DSH Desktop.app` | 可直接运行的 App（自包含，261MB） |
| `dmg/DSH Desktop_*.dmg` | 安装包（约 67MB） |
| `macos/DSH Desktop.app.tar.gz` + `.sig` | 自动更新包 + 签名 |
| `macos/latest.json` | 更新清单（`scripts/make-latest-json.mjs` 生成） |

### 跨平台构建

Tauri 交叉编译受系统 WebView 限制，**推荐在各目标平台原生构建**（CI 可用 GitHub Actions）：

```bash
# macOS（本机）
pnpm build:mac        # aarch64-apple-darwin（Apple Silicon）

# Windows（在 Windows 机器/CI 上）
rustup target add x86_64-pc-windows-msvc
pnpm build:win

# Linux（在 Linux 机器/CI 上，先装系统依赖）
rustup target add x86_64-unknown-linux-gnu
pnpm build:linux
```

Linux 系统依赖（Debian/Ubuntu）：

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## 发布更新（updater）

1. **更新签名密钥**（已生成于 `~/.tauri/dsh-desktop.key`，密码 `dsh-desktop-update-2026`）：
   - 私钥用于签名更新包（`scripts/build.sh` 自动读取，可用 `DSH_UPDATE_KEY_PASSWORD` 覆盖）
   - 公钥已固化在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
   - ⚠️ **私钥和密码务必妥善保存**，丢失后无法再签发更新
2. **发布**：把 `DSH Desktop.app.tar.gz`、`DSH Desktop.app.tar.gz.sig`、`latest.json` 上传到 GitHub Releases（tag `v<版本>`）或任意静态服务器
3. **更新源**：`tauri.conf.json` 的 `plugins.updater.endpoints` 指向清单地址（默认 GitHub Releases 模板，替换 `OWNER`）
4. 用户在托盘菜单点「检查更新…」→ 发现新版本 → 下载安装 → 重启生效

> 修改 `latest.json` 中 `url` 时，`signature` 必须与对应 `.tar.gz.sig` 一致（每次构建签名都不同）。

## 配置

| 项 | 说明 |
| --- | --- |
| `DSH_PORT` 环境变量 | 后端端口，默认 `3080`（与现有实例冲突时改） |
| `DSH_BIN` 环境变量 | 强制使用外部 dsh 可执行文件（一般不需要，内置优先） |
| `RUNTIME_NODE_VERSION` | 构建时覆盖 Node 版本（`prepare-runtime.mjs`） |
| `GH_OWNER` / `--owner` | 生成 latest.json 时替换 GitHub 用户名 |
| 日志 | `~/.dsh-desktop/backend.log` |

## 快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Cmd+W` / 关闭按钮 | 隐藏到托盘（后端继续运行） |
| `Cmd+M` | 最小化 |
| `Cmd+H` | 隐藏应用 |
| `Cmd+Q` | 退出应用（并清理自启的后端进程） |
| `Cmd+C / Cmd+V / Cmd+X / Cmd+A` | WebView 内复制 / 粘贴 / 剪切 / 全选 |

## macOS 信任 / 签名 / 公证

本地构建的 App 为 ad-hoc 签名，Gatekeeper 对网络传输过的应用会提示「无法验证开发者」。缓解与正式方案见上文「macOS 信任」说明：

```bash
# 本机自用：去掉 quarantine 标记
xattr -dr com.apple.quarantine "/Applications/DSH Desktop.app"
# 或首次打开：右键 → 打开 →「打开」；macOS 13+：系统设置 → 隐私与安全性 →「仍要打开」
```

正式分发需 Apple Developer Program（$99/年）的 Developer ID 证书 + 公证：在 `tauri.conf.json` 的 `bundle.macOS` 配置 `signingIdentity` / `providerShortName` / `entitlements`（已提供 `entitlements.plist`），并设置 `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` 后构建（Tauri 自动签名 + 公证 + 装订）。

## 数据持久化

所有数据保存在 `$DSH_HOME`（默认 `~/.dsh/`），与浏览器访问完全一致，**与桌面壳无关**：

| 数据 | 位置 |
| --- | --- |
| 密钥 / 凭据 | `~/.dsh/.credentials.yaml`（0600） |
| 设置（模型选择等） | `~/.dsh/settings.yaml` |
| 会话（工作内容） | `~/.dsh/sessions/` |
| 存储域 | `~/.dsh/storages/` |

重启 App / 电脑均不丢失。桌面 App 退出时会终止自启的后端进程，但数据已实时落盘，下次启动自动恢复。

## 常见问题

- **首次启动慢**：内置运行时首次解压/加载 + dsh web 启动，约数秒；后端就绪后自动进入 GUI。
- **启动失败/超时**：查看 `~/.dsh-desktop/backend.log`。
- **「检查更新」提示失败**：`endpoints` 未指向真实发布渠道，或 `latest.json` 尚未发布（见「发布更新」）。
- **改端口**：`DSH_PORT=3081` 启动；复用与自启逻辑自动适配。

## License

代码 MIT。图标素材来自坤坤粉丝二创精灵图（见 `dsh-kun-like-pet` 仓库版权声明），仅供个人学习交流。
