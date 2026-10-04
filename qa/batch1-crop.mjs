#!/usr/bin/env node
/**
 * batch1-crop.mjs —— 从「屏幕观感」PNG（缩到 CSS 尺寸后的最终画面）裁同一区域，
 * 1:1 取出并放大 3 倍做并排对比。这是主理人验收条件「肉眼无可见劣化」的直接证据：
 * 看的不是内部缓冲，而是浏览器合成器输出后玩家真正看到的像素。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, '..', 'shots');

/* ---- PNG 编解码（无第三方依赖） ---- */
let T = null;
function crc32(buf) {
  if (!T) { T = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c; } }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ T[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const stride = w * 4, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function decodePng(buf) {
  let pos = 8, w = 0, h = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
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
    const f = raw[rp++], line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride), prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
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

/** 最近邻放大 k 倍 */
function zoom(img, x0, y0, cw, ch, k) {
  const W = cw * k, H = ch * k, out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = y0 + Math.floor(y / k);
    for (let x = 0; x < W; x++) {
      const sx = x0 + Math.floor(x / k);
      const s = (sy * img.w + sx) * 4, d = (y * W + x) * 4;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = 255;
    }
  }
  return { w: W, h: H, data: out };
}

/** 标签条：3×5 迷你字模 */
const F = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
  '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001001010010',
  '8': '111101111101111', '9': '111101111001111',
  'D': '110101101101110', 'P': '110101110100100', 'R': '110101110101101',
  '.': '000000000000010', ' ': '000000000000000', '-': '000000111000000',
};
function label(out, W, H, str, x0, y0, rgb) {
  let cx = x0;
  for (const ch of str) {
    const bits = F[ch] || F[' '];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
      if (bits[r * 3 + c] !== '1') continue;
      for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
        const px = cx + c * 2 + sx, py = y0 + r * 2 + sy;
        if (px < W && py < H) { const o = (py * W + px) * 4; out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255; }
      }
    }
    cx += 8;
  }
}

function stack(top, bottom, capH) {
  const W = Math.max(top.w, bottom.w), H = top.h + bottom.h + capH;
  const out = Buffer.alloc(W * H * 4, 255);
  for (let i = 0; i < W * H; i++) { out[i * 4] = 12; out[i * 4 + 1] = 6; out[i * 4 + 2] = 24; out[i * 4 + 3] = 255; }
  const put = (im, oy) => { for (let y = 0; y < im.h; y++) im.data.copy(out, ((y + oy) * W) * 4, y * im.w * 4, (y + 1) * im.w * 4); };
  put(top, capH); put(bottom, capH + top.h);
  label(out, W, H, 'DPR 2.0', 6, 4, [41, 240, 255]);
  label(out, W, H, 'DPR 1.5', 6, capH + top.h + 4, [41, 240, 255]);
  return { w: W, h: H, data: out };
}

const a = L('2', 'screen'), b = L('15', 'screen');
// 三块代表性区域：霓虹招牌密集区 / 远景天际线 + 天空渐变 / 近景街道 + 湿地反射
const regions = [
  { name: 'a-neon', x: 120, y: 200, w: 200, h: 120, k: 3 },
  { name: 'b-skyline', x: 620, y: 60, w: 200, h: 120, k: 3 },
  { name: 'c-street', x: 380, y: 380, w: 200, h: 120, k: 3 },
];
for (const r of regions) {
  const za = zoom(a, r.x, r.y, r.w, r.h, r.k);
  const zb = zoom(b, r.x, r.y, r.w, r.h, r.k);
  const s = stack(za, zb, 16);
  writeFileSync(join(SHOTS, `dpr-crop-${r.name}.png`), encodePng(s.w, s.h, s.data));
  console.log(`dpr-crop-${r.name}.png`, s.w + 'x' + s.h, `（区域 ${r.w}×${r.h} @1:1，放大 ${r.k}×）`);
}
