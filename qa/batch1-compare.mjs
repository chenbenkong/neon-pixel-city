#!/usr/bin/env node
/**
 * batch1-compare.mjs —— 生成 dpr2.0 vs dpr1.5 的并排对比图（供肉眼验收）
 * 输出 shots/dpr-compare-screen.png（屏幕观感并排）与 shots/dpr-compare-zoom.png（6×/8× 放大并排）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, '..', 'shots');

function crc32(buf) {
  let c, table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4, out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4] : 0, b = prev ? prev[x] : 0, c = (prev && x >= 4) ? prev[x - 4] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
      cur[x] = v;
    }
  }
  return { w, h, data: out };
}

const L = (t, n) => decodePng(readFileSync(join(SHOTS, `dpr${t}-${n}.png`)));

/** 横向并排 + 4px 分隔线 + 标签条 */
function sideBySide(imgs, gap, labelH) {
  const W = imgs.reduce((a, i) => a + i.w, 0) + gap * (imgs.length - 1);
  const H = Math.max(...imgs.map((i) => i.h)) + labelH;
  const out = Buffer.alloc(W * H * 4, 255);
  for (let i = 0; i < out.length; i += 4) { out[i] = 12; out[i + 1] = 6; out[i + 2] = 24; }
  let ox = 0;
  for (const im of imgs) {
    for (let y = 0; y < im.h; y++) {
      im.data.copy(out, ((y + labelH) * W + ox) * 4, y * im.w * 4, (y + 1) * im.w * 4);
    }
    ox += im.w + gap;
  }
  // 标签：把文字画成简单的 5×7 位图块（避免引入字体依赖）
  const drawText = (str, x0, y0, rgb) => {
    // 仅支持 0-9 A-Z 与少量符号，用 3×5 迷你字模
    const F = {
      0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111',
      4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001001010010',
      8: '111101111101111', 9: '111101111001111',
      D: '110101101101110', P: '110101110100100', R: '110101110101101',
      '.': '000000000000010', ' ': '000000000000000', '=': '000111000111000',
      '-': '000000111000000', ':': '000010000010000', '/': '001001010100100',
    };
    let cx = x0;
    for (const ch of str) {
      const bits = F[ch] || F[' '];
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 3; c++) {
          if (bits[r * 3 + c] === '1') {
            for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
              const px = cx + c * 2 + sx, py = y0 + r * 2 + sy;
              if (px < W && py < H) { const o = (py * W + px) * 4; out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; }
            }
          }
        }
      }
      cx += 8;
    }
  };
  const labels = imgs.map((i) => i.label || '');
  let lx = 6;
  for (let i = 0; i < imgs.length; i++) {
    drawText(labels[i], lx, Math.floor((labelH - 10) / 2), [41, 240, 255]);
    lx += imgs[i].w + gap;
  }
  return { w: W, h: H, data: out };
}

const a = L('2', 'screen'), b = L('15', 'screen');
const cmp = sideBySide([
  { ...a, label: 'DPR 2.0' },
  { ...b, label: 'DPR 1.5' },
], 6, 18);
writeFileSync(join(SHOTS, 'dpr-compare-screen.png'), encodePng(cmp.w, cmp.h, cmp.data));
console.log('dpr-compare-screen.png', cmp.w + 'x' + cmp.h);

// 放大图：6× 与 8× 各一组并排
for (const z of ['zoom6', 'zoom8']) {
  const za = L('2', z), zb = L('15', z);
  const c = sideBySide([{ ...za, label: 'DPR 2.0' }, { ...zb, label: 'DPR 1.5' }], 6, 18);
  writeFileSync(join(SHOTS, `dpr-compare-${z}.png`), encodePng(c.w, c.h, c.data));
  console.log(`dpr-compare-${z}.png`, c.w + 'x' + c.h);
}

// 差异热力图：把 |A-B| 放大 16 倍，肉眼直接看出差异落在哪里
const W = a.w, H = a.h;
const diff = Buffer.alloc(W * H * 4, 255);
let maxD = 0;
for (let i = 0; i < W * H; i++) {
  let d = 0;
  for (let cch = 0; cch < 3; cch++) d = Math.max(d, Math.abs(a.data[i * 4 + cch] - b.data[i * 4 + cch]));
  if (d > maxD) maxD = d;
  const v = Math.min(255, d * 16);
  diff[i * 4] = v; diff[i * 4 + 1] = Math.min(255, v * 0.3); diff[i * 4 + 2] = 0; diff[i * 4 + 3] = 255;
}
writeFileSync(join(SHOTS, 'dpr-compare-diffmap.png'), encodePng(W, H, diff));
console.log('dpr-compare-diffmap.png', W + 'x' + H, 'maxDiff', maxD, '（×16 放大）');
