// 从坤坤精灵图生成应用图标（无第三方依赖，纯 node）
// 用法：node scripts/make-icon.mjs <spritesheet.png> [输出目录]
// 输出：icon-source.png（1024×1024，供 tauri icon 生成全套）+ tray.png（32×32）

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INPUT = process.argv[2] || '/tmp/sheet.png'
const OUT_DIR = process.argv[3] || join(ROOT, 'src-tauri', 'icons')

// ---------- PNG 解码 ----------
function decodePNG(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG')
  let off = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  let channels
  if (colorType === 6) channels = 4
  else if (colorType === 2) channels = 3
  else if (colorType === 0) channels = 1
  else if (colorType === 4) channels = 2
  else throw new Error(`unsupported color type ${colorType}`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      switch (f) {
        case 0: break
        case 1: v = (v + a) & 0xff; break
        case 2: v = (v + b) & 0xff; break
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          v = (v + pr) & 0xff
          break
        }
      }
      cur[x] = v
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { width, height, channels, pixels: out }
}

// ---------- PNG 编码（RGBA） ----------
const CRC_TABLE = (() => {
  const t = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function encodePNG(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---------- 主流程 ----------
const sheet = decodePNG(readFileSync(INPUT))
console.log(`sheet: ${sheet.width}x${sheet.height} channels=${sheet.channels}`)

// 精灵图契约：8 列 × 9 行，每格 192×208
const FW = 192, FH = 208
if (sheet.width !== FW * 8 || sheet.height !== FH * 9) {
  console.warn(`warn: 精灵图尺寸 ${sheet.width}x${sheet.height} 不符合 8x9 契约，仍按左上角 192x208 裁剪`)
}
const src = { w: FW, h: FH }

// 采样：目标画布 size×size，帧按比例居中（最近邻，保留像素风）
function render(size) {
  const out = Buffer.alloc(size * size * 4)
  const scale = size / FH
  const dw = Math.round(FW * scale)
  const dh = size
  const offx = Math.round((size - dw) / 2)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const di = (y * size + x) * 4
      if (y < dh && x >= offx && x < offx + dw) {
        const sx = Math.min(src.w - 1, Math.floor(((x - offx) / dw) * src.w))
        const sy = Math.min(src.h - 1, Math.floor((y / dh) * src.h))
        const si = (sy * sheet.width + sx) * sheet.channels
        out[di] = sheet.pixels[si]
        out[di + 1] = sheet.pixels[si + 1]
        out[di + 2] = sheet.pixels[si + 2]
        out[di + 3] = sheet.channels === 4 ? sheet.pixels[si + 3] : 255
      } else {
        out[di + 3] = 0 // 透明
      }
    }
  }
  return out
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'icon-source.png'), encodePNG(1024, 1024, render(1024)))
writeFileSync(join(OUT_DIR, 'tray.png'), encodePNG(32, 32, render(32)))
writeFileSync(join(OUT_DIR, 'tray.rgba'), render(32)) // raw RGBA，供 Rust include_bytes 直接构造 Image
console.log('generated:')
console.log('  ' + join(OUT_DIR, 'icon-source.png'))
console.log('  ' + join(OUT_DIR, 'tray.png'))
console.log('  ' + join(OUT_DIR, 'tray.rgba'))
