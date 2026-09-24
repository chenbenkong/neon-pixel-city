import { clamp, easeOutCubic, easeInCubic, makeCanvas } from './util.js';
import { PIXEL_FONT } from './data.js';

const GLYPHS = Array.from('01ABCDEF霓虹赛博城市数据未来电子梦龍夜#%');
const T_SWAP = 1.0, T_END = 2.35;

export class Transition {
  constructor(canvas) {
    this.c = canvas;
    this.x = canvas.getContext('2d');
    this.active = false;
    this.sn = makeCanvas(480, 270);
    this.ch = [makeCanvas(480, 270), makeCanvas(480, 270), makeCanvas(480, 270)];
    this.resize();
  }

  resize() {
    this.W = this.c.width = window.innerWidth;
    this.H = this.c.height = window.innerHeight;
    const sw = Math.min(640, this.W), sh = Math.round((sw * this.H) / this.W);
    for (const cv of [this.sn, ...this.ch]) { cv.width = sw; cv.height = sh; }
  }

  play({ source, origin, to, title, sub, onSwap, onDone }) {
    this.source = source;
    this.to = to;
    this.title = title;
    this.sub = sub;
    this.onSwap = onSwap;
    this.onDone = onDone;
    this.t = 0;
    this.swapped = false;
    const W = this.W, H = this.H;
    const size = Math.max(36, Math.round(Math.min(W, H) / 16));
    this.size = size;
    const cols = Math.ceil(W / size), rows = Math.ceil(H / size);
    const [ox, oy] = origin;
    const maxD = Math.hypot(W, H);
    const maxC = Math.hypot(W / 2, H / 2);
    this.cells = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const cx = i * size + size / 2, cy = j * size + size / 2;
      this.cells.push({
        x: i * size, y: j * size, i, j,
        din: (Math.hypot(cx - ox, cy - oy) / maxD) * 0.5 + Math.random() * 0.1,
        dout: (Math.hypot(cx - W / 2, cy - H / 2) / maxC) * 0.55 + Math.random() * 0.1,
        g: GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
        r: Math.random(),
      });
    }
    this.hue = to === '3d' ? 185 : 315;
    this.active = true;
    this.c.style.display = 'block';
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const t = this.t, x = this.x, W = this.W, H = this.H;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalCompositeOperation = 'source-over';
    x.globalAlpha = 1;
    x.clearRect(0, 0, W, H);

    if (t < T_SWAP) this.drawGlitch(clamp(t / 0.7, 0, 1));
    if (!this.swapped && t >= T_SWAP) {
      this.swapped = true;
      this.onSwap && this.onSwap();
    }
    this.drawCells(t);
    if (t > T_SWAP && t < T_SWAP + 0.3) {
      const k = (t - T_SWAP) / 0.3;
      x.fillStyle = `rgba(255,255,255,${(1 - k) * (1 - k) * 0.7})`;
      x.fillRect(0, 0, W, H);
    }
    if (t > T_SWAP - 0.06 && t < T_SWAP + 0.7) this.drawTitle(t - (T_SWAP - 0.06));
    if (t > T_SWAP + 0.2) this.drawShock(t - T_SWAP - 0.2);
    if (t >= T_END) {
      this.active = false;
      x.clearRect(0, 0, W, H);
      this.c.style.display = 'none';
      this.onDone && this.onDone();
    }
  }

  drawGlitch(e) {
    const x = this.x, W = this.W, H = this.H, sn = this.sn;
    const sx = sn.getContext('2d');
    sx.imageSmoothingEnabled = false;
    sx.drawImage(this.source(), 0, 0, sn.width, sn.height);
    const cols = ['#ff0000', '#00ff00', '#0000ff'];
    this.ch.forEach((cv, i) => {
      const c = cv.getContext('2d');
      c.globalCompositeOperation = 'copy';
      c.drawImage(sn, 0, 0);
      c.globalCompositeOperation = 'multiply';
      c.fillStyle = cols[i];
      c.fillRect(0, 0, cv.width, cv.height);
    });
    x.imageSmoothingEnabled = false;
    x.fillStyle = '#000';
    x.fillRect(0, 0, W, H);
    x.globalCompositeOperation = 'lighter';
    const dx = easeInCubic(e) * 46 + Math.random() * 6 * e;
    const zoom = 1 + easeInCubic(e) * 0.08;
    const zw = W * zoom, zh = H * zoom, zx = (W - zw) / 2, zy = (H - zh) / 2;
    x.drawImage(this.ch[0], zx - dx, zy, zw, zh);
    x.drawImage(this.ch[1], zx, zy + dx * 0.2, zw, zh);
    x.drawImage(this.ch[2], zx + dx, zy, zw, zh);
    x.globalCompositeOperation = 'source-over';
    const n = Math.floor(3 + e * 22);
    for (let i = 0; i < n; i++) {
      const y = Math.random() * H, h = 2 + Math.random() * (10 + e * 50);
      const off = (Math.random() - 0.5) * (30 + e * 260);
      x.drawImage(this.c, 0, y, W, h, off, y, W, h);
    }
    for (let i = 0; i < Math.floor(e * 14); i++) {
      x.fillStyle = Math.random() < 0.5 ? 'rgba(255,43,214,0.7)' : 'rgba(41,240,255,0.7)';
      x.fillRect(Math.random() * W, Math.random() * H, 20 + Math.random() * 200, 2 + Math.random() * 12);
    }
    x.fillStyle = `rgba(0,0,0,${0.25 * e})`;
    for (let y = 0; y < H; y += 3) x.fillRect(0, y, W, 1);
  }

  drawCells(t) {
    const x = this.x, s = this.size;
    x.font = `${Math.round(s * 0.5)}px ${PIXEL_FONT}`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    for (const c of this.cells) {
      let p;
      if (t < T_SWAP + 0.2) p = easeOutCubic(clamp((t - 0.22 - c.din) / 0.22, 0, 1));
      else p = 1 - easeInCubic(clamp((t - T_SWAP - 0.2 - c.dout) / 0.26, 0, 1));
      if (p <= 0) continue;
      const hue = this.hue + Math.sin(c.i * 0.3 + c.j * 0.2 + t * 4) * 40 + (c.r - 0.5) * 30;
      const out = t > T_SWAP + 0.2;
      const light = out ? 50 + (1 - p) * 30 : 12 + p * 14 + (Math.sin(t * 10 + c.r * 30) > 0.8 ? 30 : 0);
      const w = Math.ceil(s * p), off = (s - w) / 2;
      x.fillStyle = `hsl(${hue},100%,${light}%)`;
      x.fillRect(Math.floor(c.x + off), Math.floor(c.y + off), w, w);
      if (p > 0.55) {
        x.fillStyle = `hsla(${hue},100%,70%,0.9)`;
        x.fillRect(Math.floor(c.x + off), Math.floor(c.y + off), w, 2);
        if ((c.r * 10 + t * 8) % 3 < 1.6 || out) {
          x.fillStyle = `hsla(${hue + 40},100%,${out ? 95 : 72}%,${out ? p : 0.85})`;
          x.fillText(c.g, c.x + s / 2, c.y + s / 2 + 1);
        }
        if (Math.random() < 0.02) c.g = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
    }
  }

  drawTitle(k) {
    const x = this.x, W = this.W, H = this.H;
    const a = clamp(k / 0.1, 0, 1) * clamp((0.7 - k) / 0.15, 0, 1);
    if (a <= 0) return;
    const fs = Math.round(clamp(W * 0.045, 22, 64));
    x.save();
    x.globalAlpha = a;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = 'rgba(5,2,12,0.75)';
    const bw = Math.min(W * 0.9, fs * 16), bh = fs * 3.4;
    x.fillRect((W - bw) / 2, H / 2 - bh / 2, bw, bh);
    x.fillStyle = `hsl(${this.hue},100%,60%)`;
    x.fillRect((W - bw) / 2, H / 2 - bh / 2, bw, 3);
    x.fillRect((W - bw) / 2, H / 2 + bh / 2 - 3, bw, 3);
    x.font = `${fs}px "PressStart2P", monospace`;
    x.globalCompositeOperation = 'lighter';
    const j = (Math.random() - 0.5) * 8 * (1 - k);
    x.fillStyle = '#ff0040'; x.fillText(this.title, W / 2 - 4 + j, H / 2 - fs * 0.45);
    x.fillStyle = '#00ffd0'; x.fillText(this.title, W / 2 + 4 - j, H / 2 - fs * 0.45);
    x.fillStyle = '#5a6bff'; x.fillText(this.title, W / 2, H / 2 - fs * 0.45 + 2);
    x.globalCompositeOperation = 'source-over';
    x.fillStyle = '#ffffff';
    x.fillText(this.title, W / 2, H / 2 - fs * 0.45);
    x.font = `${Math.round(fs * 0.62)}px ${PIXEL_FONT}`;
    const n = Math.floor(clamp(k / 0.35, 0, 1) * Array.from(this.sub).length);
    x.fillStyle = `hsl(${this.hue},100%,75%)`;
    x.fillText(Array.from(this.sub).slice(0, n).join('') + (n < Array.from(this.sub).length ? '█' : ''), W / 2, H / 2 + fs * 0.75);
    x.restore();
  }

  drawShock(k) {
    const x = this.x, W = this.W, H = this.H;
    const R = Math.hypot(W, H) * 0.6;
    for (let n = 0; n < 2; n++) {
      const kk = clamp((k - n * 0.12) / 0.9, 0, 1);
      if (kk <= 0 || kk >= 1) continue;
      const r = easeOutCubic(kk) * R;
      const lw = (1 - kk) * 40 + 2;
      x.globalCompositeOperation = 'lighter';
      const cols = n ? ['rgba(255,43,214,', 'rgba(41,240,255,'] : ['rgba(41,240,255,', 'rgba(255,43,214,'];
      x.lineWidth = lw;
      x.strokeStyle = cols[0] + (1 - kk) * 0.8 + ')';
      x.beginPath(); x.arc(W / 2 - 3, H / 2, r, 0, Math.PI * 2); x.stroke();
      x.strokeStyle = cols[1] + (1 - kk) * 0.8 + ')';
      x.beginPath(); x.arc(W / 2 + 3, H / 2, r * 0.985, 0, Math.PI * 2); x.stroke();
      x.globalCompositeOperation = 'source-over';
    }
    const sy = easeOutCubic(clamp(k / 0.8, 0, 1)) * (H + 40) - 20;
    const g = x.createLinearGradient(0, sy - 30, 0, sy + 30);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(200,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, sy - 30, W, 60);
  }
}
