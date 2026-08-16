// make-latest-json.mjs — 生成 Tauri updater 发布清单 latest.json
//
// 从构建产物读取版本与签名，输出到 bundle/macos/latest.json
// 用法：node scripts/make-latest-json.mjs [--owner <gh-owner>] [--repo <gh-repo>]
// 发布时把 latest.json 与 *.app.tar.gz、*.sig 一并上传到 GitHub Releases（或静态服务器）。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'macos')

const ownerIdx = process.argv.indexOf('--owner')
const owner = (ownerIdx > 0 ? process.argv[ownerIdx + 1] : undefined) || process.env.GH_OWNER || 'OWNER'
const repo = process.env.GH_REPO || 'dsh-desktop'

const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf-8'))
const version = conf.version
const product = conf.productName

// 目标平台 key（Tauri updater 格式：<os>-<arch>）
const os = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform]
const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch]
const platformKey = `${os}-${arch}`

const sigPath = join(BUNDLE, `${product}.app.tar.gz.sig`)
const tarball = `${product}.app.tar.gz`
// GitHub 会把资产名中的空格规范化为点，下载 URL 必须用规范化后的名字
const tarballGhName = tarball.replace(/ /g, '.')
if (!existsSync(sigPath)) {
  console.error(`未找到签名文件: ${sigPath}\n请先运行 ./scripts/build.sh 构建。`)
  process.exit(1)
}
const signature = readFileSync(sigPath, 'utf-8').trim()

const latest = {
  version,
  notes: `DSH Desktop v${version} 自动更新`,
  pub_date: new Date().toISOString(),
  platforms: {
    [platformKey]: {
      signature,
      url: `https://github.com/${owner}/${repo}/releases/download/v${version}/${tarballGhName}`,
    },
  },
}

const out = join(BUNDLE, 'latest.json')
writeFileSync(out, JSON.stringify(latest, null, 2) + '\n')
console.log(`已生成: ${out}`)
console.log(`  version=${version}  platform=${platformKey}  url=${latest.platforms[platformKey].url}`)
