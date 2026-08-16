// prepare-runtime.mjs — 为 DSH Desktop 准备自包含运行时（Node + dsh 依赖）
//
// 产物（src-tauri/runtime/，构建时由 tauri.conf.json 的 resources 打进 App）：
//   runtime/
//   ├── bin/node                  # 官方 Node 可执行文件（当前平台）
//   └── dsh/                      # @deepseek-ai/dsh 及其依赖（按当前平台裁剪）
//       ├── node_modules/…
//       └── lib/bin.js            # dsh 入口
//
// 用法：node scripts/prepare-runtime.mjs [--force]
// 平台：darwin-arm64 / darwin-x64 / win32-x64 / linux-x64（由 process.platform/arch 推断）

import { mkdirSync, rmSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src-tauri', 'runtime')
const NODE_VERSION = process.env.RUNTIME_NODE_VERSION || 'v23.11.0'
const IS_WIN = process.platform === 'win32'

// ---------- 平台映射 ----------
const NODE_PLATFORM = {
  darwin: 'darwin', win32: 'win32', linux: 'linux',
}[process.platform]
const NODE_ARCH = { arm64: 'arm64', x64: 'x64' }[process.arch]
if (!NODE_PLATFORM || !NODE_ARCH) {
  console.error(`不支持的平台: ${process.platform}/${process.arch}`)
  process.exit(1)
}
const TRIPLE = `${NODE_PLATFORM}-${NODE_ARCH}`
console.log(`[runtime] 目标平台: ${TRIPLE}，Node ${NODE_VERSION}`)

// ---------- 1. Node 官方二进制 ----------
const NODE_DIR = join(ROOT, 'src-tauri', '.runtime-cache', `node-${NODE_VERSION}-${TRIPLE}`)
const NODE_BIN = join(OUT, 'bin', IS_WIN ? 'node.exe' : 'node')

function ensureNode() {
  if (existsSync(NODE_BIN) && !process.argv.includes('--force')) {
    console.log('[runtime] Node 已就绪，跳过下载')
    return
  }
  const url = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${TRIPLE}.tar.gz`
  const tarball = join(ROOT, 'src-tauri', '.runtime-cache', `node-${NODE_VERSION}-${TRIPLE}.tar.gz`)
  mkdirSync(dirname(tarball), { recursive: true })
  if (!existsSync(tarball)) {
    console.log(`[runtime] 下载 Node: ${url}`)
    execSync(`curl -L --fail --progress-bar "${url}" -o "${tarball}"`, { stdio: 'inherit' })
  }
  rmSync(NODE_DIR, { recursive: true, force: true })
  mkdirSync(NODE_DIR, { recursive: true })
  console.log('[runtime] 解压 Node…')
  execSync(`tar -xzf "${tarball}" -C "${NODE_DIR}" --strip-components=1`, { stdio: 'inherit' })
  const src = join(NODE_DIR, 'bin', IS_WIN ? 'node.exe' : 'node')
  mkdirSync(dirname(NODE_BIN), { recursive: true })
  cpSync(src, NODE_BIN)
  if (!IS_WIN) execSync(`chmod +x "${NODE_BIN}"`)
  console.log(`[runtime] Node -> ${NODE_BIN}`)
}

// ---------- 2. dsh 依赖 ----------
const DSH_DIR = join(OUT, 'dsh')
const DSH_PKG = '@deepseek-ai/dsh'

// 依赖来源：优先本机 npx 缓存（快、确定），否则 npm install
function findNpxDsh() {
  const home = process.env.HOME || process.env.USERPROFILE
  const npx = join(home, '.npm', '_npx')
  if (!existsSync(npx)) return null
  let best = null
  for (const entry of readdirSync(npx)) {
    const cand = join(npx, entry, 'node_modules', DSH_PKG)
    if (existsSync(cand)) {
      const t = statSync(cand).mtimeMs
      if (!best || t > best.mtime) best = { path: cand, mtime: t, root: join(npx, entry, 'node_modules') }
    }
  }
  return best
}

function prunePlatform(dir) {
  // 通用规则：prebuilds 目录只保留当前平台；@img/sharp-<平台> 只保留当前平台包
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (!statSync(p).isDirectory()) continue
    if (entry === 'prebuilds') {
      for (const pre of readdirSync(p)) {
        if (!pre.includes(TRIPLE) && pre !== 'package.json') {
          rmSync(join(p, pre), { recursive: true, force: true })
          console.log(`[runtime] 裁剪 prebuild: ${join(p, pre)}`)
        }
      }
    } else if (entry.startsWith('@')) {
      // scope 目录（如 @img）：递归内部，按平台包裁剪
      prunePlatform(p)
    } else if (entry.startsWith('sharp-')) {
      // sharp 平台包（sharp-<triple> 与 sharp-libvips-<triple>）：只保留当前平台
      // （sharp-libvips-* 是 libvips 动态库，误删会导致 sharp 加载失败）
      if (!entry.endsWith(`-${TRIPLE}`)) {
        rmSync(p, { recursive: true, force: true })
        console.log(`[runtime] 裁剪 sharp 平台包: ${entry}`)
      }
    } else if (entry !== 'node_modules') {
      prunePlatform(p)
    }
  }
}

function ensureDsh() {
  if (existsSync(join(DSH_DIR, 'lib', 'bin.js')) && !process.argv.includes('--force')) {
    console.log('[runtime] dsh 已就绪，跳过拷贝')
    return
  }
  rmSync(DSH_DIR, { recursive: true, force: true })
  mkdirSync(DSH_DIR, { recursive: true })

  const npxDsh = findNpxDsh()
  if (npxDsh) {
    console.log(`[runtime] 从 npx 缓存拷贝 dsh: ${npxDsh.path}`)
    // dsh 包本体
    cpSync(npxDsh.path, join(DSH_DIR, 'node_modules', DSH_PKG), { recursive: true })
    // 依赖（扁平 node_modules 里除 dsh 本体外的全部）
    const nm = npxDsh.root
    for (const entry of readdirSync(nm)) {
      if (entry === '@deepseek-ai') {
        const scopeSrc = join(nm, '@deepseek-ai')
        const scopeDst = join(DSH_DIR, 'node_modules', '@deepseek-ai')
        mkdirSync(scopeDst, { recursive: true })
        for (const sub of readdirSync(scopeSrc)) {
          if (sub === 'dsh') continue
          cpSync(join(scopeSrc, sub), join(scopeDst, sub), { recursive: true })
        }
      } else if (!entry.startsWith('.') && entry !== 'dsh' && !entry.includes('@deepseek-ai')) {
        cpSync(join(nm, entry), join(DSH_DIR, 'node_modules', entry), { recursive: true })
      }
    }
  } else {
    console.log('[runtime] npx 缓存未找到 dsh，改用 npm install（需网络）')
    execSync(`npm install --omit=dev --prefix "${DSH_DIR}" "${DSH_PKG}"`, { stdio: 'inherit' })
  }
  prunePlatform(join(DSH_DIR, 'node_modules'))
  console.log('[runtime] dsh 就绪')
}

// ---------- 3. 体积裁剪（安全项） ----------
// 只删运行时不需要的：source map / 类型定义 / 文档 / 测试 / 示例。
// 保留：LICENSE（合规）、.ts/.tsx 源码（dsh web 可能运行时编译）、所有 .js/.json/.node/.wasm。
const SHRINK_DIRS = new Set([
  'test', 'tests', '__tests__', '__test__', 'testdata', 'fixtures',
  'benchmark', 'bench', 'benchmarks',
  'examples', 'example', 'demo', 'demos', 'samples',
  '.github', '.git', '.vscode', 'coverage',
])
const SHRINK_FILE_RE = [
  /\.map$/,                    // source map
  /\.d\.ts$/,                  // 类型定义
  /\.(test|spec)\.(js|mjs|cjs)$/,
  /^readme/i, /^changelog/i, /^notice/i, /^authors/i, /^security/i, /^contributing/i,
  /^\.npmignore$/, /^\.gitignore$/, /^\.editorconfig$/, /^\.prettierrc/i, /^\.eslintrc/i,
  /^tsconfig\.json$/, /^jsconfig\.json$/, /^babel\.config/i,
]

let shrunkBytes = 0
function shrinkNodeModules(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const entry of entries) {
    const p = join(dir, entry)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      if (SHRINK_DIRS.has(entry)) {
        shrunkBytes += dirSize(p)
        rmSync(p, { recursive: true, force: true })
        console.log(`[runtime] 裁剪目录: ${p}`)
      } else {
        shrinkNodeModules(p)
      }
    } else if (st.isFile()) {
      if (SHRINK_FILE_RE.some((re) => re.test(entry))) {
        shrunkBytes += st.size
        rmSync(p, { force: true })
      }
    }
  }
}
function dirSize(dir) {
  let total = 0
  let entries
  try { entries = readdirSync(dir) } catch { return 0 }
  for (const e of entries) {
    const p = join(dir, e)
    try {
      const st = statSync(p)
      total += st.isDirectory() ? dirSize(p) : st.size
    } catch { /* ignore */ }
  }
  return total
}

function shrink() {
  console.log('[runtime] 裁剪体积…')
  shrinkNodeModules(join(DSH_DIR, 'node_modules'))
  shrunkBytes += pruneShikijsLangs()
  console.log(`[runtime] 裁剪释放: ${(shrunkBytes / 1048576).toFixed(1)}MB`)
}

// 语法高亮只保留常用语言（@shikijs/langs 按语言拆文件，懒加载）
const KEEP_LANGS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'json', 'jsonc', 'css', 'html', 'python',
  'bash', 'sh', 'sql', 'yaml', 'yml', 'markdown', 'md', 'diff',
  'vue', 'svelte', 'xml', 'toml', 'dockerfile', 'java', 'go', 'rust',
  'c', 'cpp', 'ruby', 'kotlin',
])
function pruneShikijsLangs() {
  const langsDir = join(DSH_DIR, 'node_modules', '@shikijs', 'langs', 'dist')
  if (!existsSync(langsDir)) return 0
  let removed = 0
  for (const f of readdirSync(langsDir)) {
    const m = f.match(/^(.*)\.(mjs|d\.mts)$/)
    if (!m) continue
    const name = m[1]
    if (f.endsWith('.d.mts') || !KEEP_LANGS.has(name)) {
      removed += statSync(join(langsDir, f)).size
      rmSync(join(langsDir, f), { force: true })
    }
  }
  console.log(`[runtime] 裁剪 shikijs 语言: ${(removed / 1048576).toFixed(1)}MB`)
  return removed
}

// ---------- 4. 汇总 ----------
mkdirSync(OUT, { recursive: true })
ensureNode()
ensureDsh()
shrink()
// 目录大小（跨平台，避免依赖 du）
function dirSizeOf(dir) {
  let total = 0
  try {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      total += statSync(p).isDirectory() ? dirSizeOf(p) : statSync(p).size
    }
  } catch { /* ignore */ }
  return total
}
console.log(`\n[runtime] 完成: ${OUT} (${(dirSizeOf(OUT) / 1048576).toFixed(0)}MB)`)
