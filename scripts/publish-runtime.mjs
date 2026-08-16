// publish-runtime.mjs — 发布 dsh 运行时更新包（只更新 dsh 依赖树，不动客户端壳）
//
// 产物：
//   bundle/runtime/runtime-dsh-<platform>-<version>.tar.gz   ← 运行时包（顶层 dsh/）
//   bundle/runtime/runtime-dsh-<platform>-<version>.tar.gz.sig ← minisign 签名
//   bundle/runtime/runtime-manifest.json                     ← 更新清单（上传到 GitHub Releases 资产）
//
// 用法：
//   node scripts/publish-runtime.mjs                # 打包 + 签名 + 生成清单（不上传）
//   node scripts/publish-runtime.mjs --upload      # 额外上传到 GitHub Releases（需 gh 或 token）
//   --version <v> 可覆盖版本号（默认取内置 @deepseek-ai/dsh 版本）

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = join(ROOT, 'src-tauri', 'runtime')
const OUT_DIR = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'runtime')
const KEY_PATH = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || join(process.env.HOME || '', '.tauri', 'dsh-desktop.key')
const KEY_PASSWORD = process.env.DSH_UPDATE_KEY_PASSWORD || 'dsh-desktop-update-2026'

const PLATFORM = {
  darwin: 'darwin', win32: 'windows', linux: 'linux',
}[process.platform]
const ARCH = { arm64: 'aarch64', x64: 'x86_64' }[process.arch]
const TRIPLE = `${PLATFORM}-${ARCH}`

// ---------- 版本 ----------
const vIdx = process.argv.indexOf('--version')
let version = vIdx > 0 ? process.argv[vIdx + 1] : undefined
if (!version) {
  const pkg = JSON.parse(readFileSync(join(RUNTIME, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf-8'))
  version = pkg.version
}
console.log(`[publish-runtime] 平台=${TRIPLE} 版本=${version}`)

// ---------- 1. 打包 dsh 依赖树 ----------
if (!existsSync(join(RUNTIME, 'dsh', 'node_modules'))) {
  console.error('未找到运行时 dsh，请先运行: node scripts/prepare-runtime.mjs')
  process.exit(1)
}
mkdirSync(OUT_DIR, { recursive: true })
const tarball = join(OUT_DIR, `runtime-dsh-${TRIPLE}-${version}.tar.gz`)
console.log('[publish-runtime] 打包 dsh 依赖树…')
execSync(`tar -czf "${tarball}" dsh`, { cwd: RUNTIME, stdio: 'inherit' })
console.log(`[publish-runtime] 已生成: ${tarball}`)

// ---------- 2. 签名 ----------
const sigFile = `${tarball}.sig`
console.log('[publish-runtime] 签名…')
import { execFileSync } from 'node:child_process'
const keyContent = readFileSync(KEY_PATH, 'utf-8')
const tauriCli = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
execFileSync(
  process.execPath,
  [tauriCli, 'signer', 'sign', '-k', keyContent, '-p', KEY_PASSWORD, tarball],
  { stdio: 'inherit' },
)
if (!existsSync(sigFile)) {
  console.error('签名失败')
  process.exit(1)
}

// ---------- 3. 生成清单 ----------
// tauri signer 的 .sig 是「4 行明文整体再 base64」的单行；minisign from_string 需要解码后的明文
const sigRaw = readFileSync(sigFile, 'utf-8').trim()
const signature = Buffer.from(sigRaw, 'base64').toString('utf-8')
const owner = process.env.GH_OWNER || 'VictoriaGitHub'
const repo = process.env.GH_REPO || 'dsh-desktop'
const manifest = {
  version,
  minShellVersion: '0.1.0',
  url: `https://github.com/${owner}/${repo}/releases/download/runtime-v${version}/runtime-dsh-${TRIPLE}-${version}.tar.gz`,
  signature,
}
const manifestFile = join(OUT_DIR, 'runtime-manifest.json')
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
console.log(`[publish-runtime] 清单: ${manifestFile}`)
console.log(JSON.stringify(manifest, null, 2))

// ---------- 4. 上传（可选） ----------
if (process.argv.includes('--upload')) {
  const token = process.env.GH_TOKEN || readFileSync('/tmp/gh-token.txt', 'utf-8').trim()
  const tag = `runtime-v${version}`
  console.log(`[publish-runtime] 创建 Release ${tag}…`)
  const create = execSync(
    `curl -s -X POST https://api.github.com/repos/${owner}/${repo}/releases -H "Authorization: token ${token}" -H "Content-Type: application/json" -d '{"tag_name":"${tag}","name":"${tag}","body":"DSH 运行时 v${version}（dsh 依赖树独立更新）","draft":false,"prerelease":false}'`,
    { encoding: 'utf-8' },
  )
  const releaseId = JSON.parse(create).id
  for (const [file, name] of [
    [tarball, `runtime-dsh-${TRIPLE}-${version}.tar.gz`],
    [sigFile, `runtime-dsh-${TRIPLE}-${version}.tar.gz.sig`],
    [manifestFile, 'runtime-manifest.json'],
  ]) {
    const fn = name.replace(/ /g, '.')
    console.log(`[publish-runtime] 上传 ${fn}…`)
    execSync(
      `curl -s -X POST -H "Authorization: token ${token}" -H "Content-Type: application/octet-stream" --data-binary @"${file}" "https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(fn)}"`,
      { stdio: 'inherit' },
    )
  }
  console.log(`[publish-runtime] 完成: https://github.com/${owner}/${repo}/releases/tag/${tag}`)
}

console.log('[publish-runtime] 完成。上传 runtime-manifest.json 到 GitHub Releases 资产即可生效。')
