import { makeCanvas, rgba, shade } from './util.js';
import { PIXEL_FONT } from './data.js';

// 3x5 pixel font
const TINY = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
  9: '111101111001110', '-': '000000111000000', '.': '000000000000010', '/': '001001010100100', ':': '000010000010000',
  '+': '000010111010000', '!': '010010010000010', '%': '101001010100101', '#': '101111101111101', '>': '100010001010100',
};

export function drawTiny(ctx, text, x, y, color, s = 1) {
  ctx.fillStyle = color;
  let cx = x | 0;
  y |= 0;
  for (const ch of String(text).toUpperCase()) {
    const g = TINY[ch];
    if (g) for (let i = 0; i < 15; i++) if (g.charCodeAt(i) === 49) ctx.fillRect(cx + (i % 3) * s, y + ((i / 3) | 0) * s, s, s);
    cx += 4 * s;
  }
}
export const tinyWidth = (t, s = 1) => String(t).length * 4 * s - s;

function threshold(c) {
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const a = d.data;
  for (let i = 3; i < a.length; i += 4) a[i] = a[i] > 100 ? 255 : 0;
  ctx.putImageData(d, 0, 0);
  return c;
}

export function pixelText(text, color, size = 12) {
  const m = makeCanvas(4, 4).getContext('2d');
  m.font = `${size}px ${PIXEL_FONT}`;
  const w = Math.ceil(m.measureText(text).width) + 1;
  const c = makeCanvas(w, size + 2);
  const ctx = c.getContext('2d');
  ctx.font = `${size}px ${PIXEL_FONT}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
  return threshold(c);
}

const signCache = new Map();
export function neonSign(text, color, vertical = false, size = 12) {
  const key = text + color + vertical + size;
  if (signCache.has(key)) return signCache.get(key);
  const chars = Array.from(text);
  const core = shade(color, 0.55);
  let glyphs, tw, th;
  if (vertical) {
    glyphs = chars.map((ch) => pixelText(ch, core, size));
    tw = size;
    th = chars.length * (size + 1) - 1;
  } else {
    glyphs = [pixelText(text, core, size)];
    tw = glyphs[0].width;
    th = size;
  }
  const w = tw + 8, h = th + 7;
  const c = makeCanvas(w, h);
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(8,3,18,0.92)';
  x.fillRect(0, 0, w, h);
  x.fillStyle = color;
  x.fillRect(0, 0, w, 1); x.fillRect(0, h - 1, w, 1); x.fillRect(0, 0, 1, h); x.fillRect(w - 1, 0, 1, h);
  x.fillStyle = rgba(color, 0.35);
  x.fillRect(2, 2, w - 4, 1); x.fillRect(2, h - 3, w - 4, 1);
  if (vertical) glyphs.forEach((g, i) => x.drawImage(g, 4 + ((size - g.width) >> 1), 4 + i * (size + 1)));
  else x.drawImage(glyphs[0], 4, 4);
  signCache.set(key, c);
  return c;
}

export function pline(ctx, x0, y0, x1, y1, w = 1) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let n = 0; n < 400; n++) {
    ctx.fillRect(x0, y0, w, w);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

export function pcircle(ctx, cx, cy, r) {
  for (let y = -r; y <= r; y++) {
    const hw = Math.floor(Math.sqrt(r * r - y * y + r * 0.8));
    ctx.fillRect(Math.round(cx - hw), Math.round(cy + y), hw * 2 + 1, 1);
  }
}
