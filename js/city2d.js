import { hash, rng, clamp, lerp, pick, mixHex, rgba, shade, makeCanvas, smooth, easeOutCubic } from './util.js';
import { districtAt, SHOPS, VERTICAL_WORDS, BIG_WORDS, ADS, PIXEL_FONT } from './data.js';
import { drawTiny, tinyWidth, neonSign, pixelText, pline, pcircle } from './pixel.js';

const DISTRICT_LEN = 2600;
const STREET_SLOT = 184;
const LAYERS = [
  { id: 0, f: 0.05, slot: 240, minH: 150, maxH: 240, kind: 'mega', haze: 0.55 },
  { id: 1, f: 0.13, slot: 58, minH: 95, maxH: 195, kind: 'far', haze: 0.42 },
  { id: 2, f: 0.28, slot: 86, minH: 80, maxH: 170, kind: 'mid', haze: 0.3 },
  { id: 3, f: 0.55, slot: 126, minH: 96, maxH: 200, kind: 'near', haze: 0.2 },
];
const TRAIN_F = 0.42;

const flick = (seed, t) => {
  const burst = Math.sin(t * 0.6 + seed * 40) > (seed < 0.15 ? 0.2 : 0.93);
  if (!burst) return 1;
  return hash(Math.floor(t * 18), (seed * 1e6) | 0) < 0.45 ? 0.12 : 1;
};

export class City2D {
  constructor(canvas, audio) {
    this.canvas = canvas;
    this.audio = audio;
    this.ctx = canvas.getContext('2d');
    this.lo = makeCanvas(480, 270);
    this.l = this.lo.getContext('2d');
    this.glow = makeCanvas(120, 68);
    this.gctx = this.glow.getContext('2d');
    this.glow2 = makeCanvas(60, 34);
    this.g2ctx = this.glow2.getContext('2d');
    this.pc = makeCanvas(44, 44);
    this.pctx = this.pc.getContext('2d');
    this.ghosts = Array.from({ length: 5 }, () => ({ c: makeCanvas(44, 44), x: 0, y: 0, face: 1, a: 0 }));
    this.ghostTimer = 0;
    this.ghostIdx = 0;
    this.cache = new Map();
    this.time = 0;
    this.player = { x: 40, y: 0, vx: 0, vy: 0, face: 1, ground: true, phase: 0, squash: 0, run: false, airT: 0 };
    this.cam = { x: 0 };
    this.npcs = [];
    this.cars = [];
    this.lanes = [
      { f: 0.2, y: 0.3, s: 0.55, v: 70 },
      { f: 0.34, y: 0.4, s: 0.75, v: 95 },
      { f: 0.62, y: 0.5, s: 1, v: 130 },
    ];
    this.roadCars = [];
    this.nextRoadCar = 4;
    this.splashes = [];
    this.steam = [];
    this.ripples = [];
    this.flash = 0;
    this.bolt = null;
    this.nextLightning = 7 + Math.random() * 8;
    this.train = { x: 0, active: false, next: 5, len: 320, dir: 1 };
    this.intro = 1;
    this.shock = null;
    this.tag = { a: 0, shop: null };
    this.clouds = this.makeClouds();
    this.vendCache = new Map();
    this.resize();
    this.cam.x = this.player.x - this.W * 0.45;
  }

  // ---------------- setup ----------------
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    let H = 270, W = Math.round((H * w) / h);
    if (W < 300) { W = 300; H = Math.round((W * h) / w); }
    if (W > 780) { W = 780; H = Math.max(200, Math.round((W * h) / w)); }
    this.W = W; this.H = H;
    this.lo.width = W; this.lo.height = H;
    this.glow.width = Math.ceil(W / 4); this.glow.height = Math.ceil(H / 4);
    this.glow2.width = Math.ceil(W / 10); this.glow2.height = Math.ceil(H / 10);
    this.GROUND = H - 58;
    this.FEET = this.GROUND + 8;
    this.ROAD = H - 43;
    if (this.player.ground) this.player.y = this.FEET;
    const make = (n, fast) => Array.from({ length: n }, () => this.newDrop(fast, true));
    this.backRain = make(Math.round(W * 0.42), false);
    this.frontRain = make(Math.round(W * 0.2), true);
    this.stars = Array.from({ length: 70 }, (_, i) => ({ x: hash(i, 1) * W, y: hash(i, 2) * H * 0.45, p: hash(i, 3) * 6.28, b: hash(i, 4) }));
  }

  newDrop(fast, anywhere) {
    const H = this.H || 270, W = this.W || 480;
    return {
      x: Math.random() * (W + 60) - 30,
      y: anywhere ? Math.random() * H : -Math.random() * 40,
      l: fast ? 9 + Math.random() * 7 : 4 + Math.random() * 4,
      s: fast ? 380 + Math.random() * 120 : 210 + Math.random() * 90,
      stop: this.FEET - 4 + Math.random() * (H - this.FEET + 8),
    };
  }

  makeClouds() {
    const bands = [];
    for (let b = 0; b < 2; b++) {
      const w = 640, h = 34;
      const c = makeCanvas(w, h), x = c.getContext('2d');
      for (let i = 0; i < w; i++) {
        const t = (i / w) * Math.PI * 2;
        const th = 8 + Math.sin(t * 3 + b) * 5 + Math.sin(t * 7 + b * 2) * 3 + Math.sin(t * 13) * 2 + hash(i, b) * 2;
        const top = Math.round(h / 2 - th / 2);
        for (let y = 0; y < th; y++) {
          const k = y / th;
          x.fillStyle = k > 0.62 ? 'rgba(255,170,230,0.55)' : k > 0.3 ? 'rgba(160,110,200,0.42)' : 'rgba(90,60,140,0.3)';
          x.fillRect(i, top + y, 1, 1);
        }
      }
      bands.push(c);
    }
    return bands;
  }

  palette(x) {
    const f = x / DISTRICT_LEN, i = Math.floor(f), t = f - i;
    const A = districtAt(i), B = districtAt(i + 1);
    const k = smooth(clamp((t - 0.78) / 0.22, 0, 1));
    return {
      i, A,
      sky: A.sky.map((c, j) => mixHex(c, B.sky[j], k)),
      haze: mixHex(A.haze, B.haze, k),
      a: mixHex(A.a, B.a, k), b: mixHex(A.b, B.b, k), c: mixHex(A.c, B.c, k),
    };
  }

  // ---------------- procedural buildings ----------------
  getB(L, i) {
    const key = L.id * 1e7 + i;
    let b = this.cache.get(key);
    if (b) return b;
    const r = rng(hash(i, L.id * 7 + 3));
    const D = districtAt(Math.floor((i * L.slot) / L.f / DISTRICT_LEN));
    b = L.kind === 'mega' ? this.genMega(L, r, D) : L.kind === 'far' ? this.genFar(L, r, D) : L.kind === 'mid' ? this.genMid(L, r, D) : this.genNear(L, r, D);
    this.cache.set(key, b);
    if (this.cache.size > 420) this.cache.delete(this.cache.keys().next().value);
    return b;
  }

  litColor(r, D) {
    const v = r();
    return v < 0.4 ? '#ffd9a0' : v < 0.6 ? D.a : v < 0.8 ? D.b : v < 0.9 ? D.c : '#e8f4ff';
  }

  genMega(L, r, D) {
    const w = Math.round(L.slot * (0.3 + r() * 0.3)), h = Math.round(lerp(L.minH, L.maxH, r()));
    const off = Math.round((L.slot - w) * r()), pad = 4, padTop = 44;
    const img = makeCanvas(w + pad * 2, h + padTop), c = img.getContext('2d');
    const col = mixHex(D.body, D.haze, 0.42);
    c.fillStyle = col;
    const t1 = Math.round(h * 0.22), t2 = Math.round(h * 0.1);
    c.fillRect(pad, padTop + t1, w, h - t1);
    c.fillRect(pad + Math.round(w * 0.14), padTop + t2, Math.round(w * 0.72), t1 - t2 + 1);
    c.fillRect(pad + Math.round(w * 0.3), padTop, Math.round(w * 0.4), t2 + 1);
    const sx = pad + (w >> 1), sh = 12 + Math.round(r() * 30);
    c.fillRect(sx - 1, padTop - sh, 2, sh);
    c.fillStyle = shade(col, 0.12);
    c.fillRect(pad, padTop + t1, 1, h - t1);
    const strips = 1 + Math.floor(r() * 3);
    for (let s = 0; s < strips; s++) {
      const xx = pad + 3 + Math.round(r() * (w - 6));
      c.fillStyle = rgba(r() < 0.5 ? D.a : D.b, 0.45);
      c.fillRect(xx, padTop + t1 + 4, 1, h - t1 - 4);
    }
    for (let y = padTop + t1 + 3; y < padTop + h; y += 4)
      for (let x = pad + 2; x < pad + w - 1; x += 3) if (r() < 0.1) { c.fillStyle = rgba(this.litColor(r, D), 0.35); c.fillRect(x, y, 1, 1); }
    return { img, off, w, h, pad, padTop, dyn: [{ t: 'beacon', x: w >> 1, y: -sh, seed: r() }] };
  }

  genFar(L, r, D) {
    const w = Math.round(L.slot * (0.55 + r() * 0.45)), h = Math.round(lerp(L.minH, L.maxH, Math.pow(r(), 0.9)));
    const off = Math.round((L.slot - w) * r()), pad = 2, padTop = 18;
    const img = makeCanvas(w + pad * 2, h + padTop), c = img.getContext('2d');
    const col = mixHex(D.body, D.haze, 0.28);
    c.fillStyle = col;
    c.fillRect(pad, padTop, w, h);
    if (r() < 0.5) c.fillRect(pad + 3, padTop - 4, w - 6, 4);
    const ah = 4 + Math.round(r() * 12), ax = pad + 2 + Math.round(r() * (w - 4));
    c.fillRect(ax, padTop - ah, 1, ah);
    const lit = 0.08 + r() * 0.2;
    for (let y = padTop + 3; y < padTop + h; y += 4)
      for (let x = pad + 2; x < pad + w - 1; x += 3) if (r() < lit) { c.fillStyle = rgba(this.litColor(r, D), 0.7); c.fillRect(x, y, 1, 1); }
    c.fillStyle = rgba(D.a, 0.25);
    c.fillRect(pad, padTop, 1, h);
    const dyn = [];
    if (r() < 0.45) dyn.push({ t: 'beacon', x: ax - pad, y: -ah, seed: r() });
    return { img, off, w, h, pad, padTop, dyn };
  }

  glyphSign(r, color, rows) {
    const w = 5, h = rows * 4 + 3;
    const c = makeCanvas(w, h), x = c.getContext('2d');
    x.fillStyle = 'rgba(6,2,14,0.9)';
    x.fillRect(0, 0, w, h);
    x.fillStyle = shade(color, 0.4);
    for (let i = 0; i < rows; i++)
      for (let p = 0; p < 9; p++) if (r() < 0.55) x.fillRect(1 + (p % 3), 2 + i * 4 + ((p / 3) | 0), 1, 1);
    x.fillStyle = color;
    x.fillRect(0, 0, w, 1); x.fillRect(0, h - 1, w, 1);
    return c;
  }

  genMid(L, r, D) {
    const w = Math.round(L.slot * (0.5 + r() * 0.45)), h = Math.round(lerp(L.minH, L.maxH, r()));
    const off = Math.round((L.slot - w) * r()), pad = 8, padTop = 26;
    const img = makeCanvas(w + pad * 2, h + padTop), c = img.getContext('2d');
    const col = mixHex(D.body, D.haze, 0.14);
    c.fillStyle = col;
    c.fillRect(pad, padTop, w, h);
    const style = r();
    if (style < 0.35) {
      c.fillRect(pad + 4, padTop - 8, w - 8, 8);
      c.fillRect(pad + 9, padTop - 14, w - 18, 6);
    } else if (style < 0.6) {
      c.fillRect(pad + 5, padTop - 7, 6, 5);
      c.fillRect(pad + 5, padTop - 2, 1, 2); c.fillRect(pad + 10, padTop - 2, 1, 2);
    }
    const ax = pad + Math.round(r() * w), ah = 6 + Math.round(r() * 14);
    c.fillRect(ax, padTop - ah - (style < 0.35 ? 14 : 0), 1, ah);
    c.fillStyle = shade(col, 0.12);
    c.fillRect(pad, padTop, 1, h);
    c.fillStyle = shade(col, -0.35);
    c.fillRect(pad + w - 1, padTop, 1, h);
    const lit = 0.1 + r() * 0.3, banded = r() < 0.3;
    for (let y = padTop + 4, row = 0; y < padTop + h - 2; y += 5, row++)
      for (let x = pad + 3; x < pad + w - 3; x += 4) {
        const on = banded ? row % 3 === 0 && r() < 0.8 : r() < lit;
        c.fillStyle = on ? rgba(this.litColor(r, D), 0.85) : rgba('#000000', 0.25);
        c.fillRect(x, y, 2, 2);
      }
    const dyn = [];
    if (r() < 0.5) {
      const color = pick(r, [D.a, D.b, D.c]);
      dyn.push({ t: 'img', img: this.glyphSign(r, color, 3 + Math.floor(r() * 4)), x: r() < 0.5 ? -3 : w - 2, y: 6 + Math.round(r() * 30), seed: r(), color });
    }
    if (r() < 0.3) dyn.push({ t: 'strip', x: 0, y: 3 + Math.round(r() * h * 0.5), w, color: pick(r, [D.a, D.b]), seed: r() });
    if (r() < 0.4) dyn.push({ t: 'beacon', x: ax - pad, y: -ah - (style < 0.35 ? 14 : 0), seed: r() });
    return { img, off, w, h, pad, padTop, dyn };
  }

  genNear(L, r, D) {
    const w = Math.round(L.slot * (0.58 + r() * 0.36)), h = Math.round(lerp(L.minH, L.maxH, r()));
    const off = Math.round((L.slot - w) * r()), pad = 18, padTop = 46;
    const img = makeCanvas(w + pad * 2, h + padTop), c = img.getContext('2d');
    const col = shade(D.body, 0.0);
    c.fillStyle = col;
    c.fillRect(pad, padTop, w, h);
    c.fillStyle = shade(col, 0.1);
    c.fillRect(pad - 1, padTop - 2, w + 2, 2);
    for (let y = padTop + 12; y < padTop + h; y += 12) { c.fillStyle = shade(col, -0.3); c.fillRect(pad, y, w, 1); }
    const lit = 0.18 + r() * 0.3;
    for (let y = padTop + 4; y < padTop + h - 6; y += 12)
      for (let x = pad + 4; x < pad + w - 6; x += 8) {
        if (r() < lit) {
          const lc = this.litColor(r, D);
          c.fillStyle = rgba(lc, 0.75); c.fillRect(x, y, 4, 6);
          c.fillStyle = rgba('#ffffff', 0.5); c.fillRect(x, y, 4, 1);
          if (r() < 0.4) { c.fillStyle = rgba('#000000', 0.45); c.fillRect(x, y + 2, 4, 1); c.fillRect(x, y + 4, 4, 1); }
        } else {
          c.fillStyle = rgba('#05020c', 0.6); c.fillRect(x, y, 4, 6);
          c.fillStyle = rgba(D.b, 0.08); c.fillRect(x, y, 1, 6);
        }
        if (r() < 0.07) { c.fillStyle = '#3a3550'; c.fillRect(x - 1, y + 7, 6, 3); c.fillStyle = '#1b1828'; c.fillRect(x, y + 8, 2, 1); }
      }
    if (r() < 0.6) { c.fillStyle = shade(col, -0.4); const px = pad + 2 + Math.round(r() * (w - 4)); c.fillRect(px, padTop, 1, h); }
    c.fillStyle = rgba(D.a, 0.55); c.fillRect(pad, padTop, 1, h);
    c.fillStyle = rgba(D.b, 0.3); c.fillRect(pad + w - 1, padTop, 1, h);
    // roof
    const ax = pad + 4 + Math.round(r() * (w - 8)), ah = 10 + Math.round(r() * 20);
    c.fillStyle = shade(col, -0.2);
    c.fillRect(ax, padTop - ah, 1, ah);
    c.fillRect(ax - 2, padTop - ah + 4, 5, 1);
    if (r() < 0.5) {
      const tx = pad + 4 + Math.round(r() * (w - 20));
      c.fillStyle = shade(col, -0.1);
      c.fillRect(tx, padTop - 12, 10, 8);
      c.fillRect(tx + 1, padTop - 4, 1, 2); c.fillRect(tx + 8, padTop - 4, 1, 2);
      c.fillStyle = shade(col, 0.15); c.fillRect(tx, padTop - 12, 10, 1);
    }
    const dyn = [];
    const colors = [D.a, D.b, D.c];
    if (r() < 0.75) {
      const word = pick(r, VERTICAL_WORDS), color = pick(r, colors);
      const img2 = neonSign(word, color, true);
      const left = r() < 0.5;
      dyn.push({ t: 'sign', img: img2, x: left ? -img2.width + 6 : w - 6, y: 8 + Math.round(r() * Math.max(4, h * 0.35)), seed: r(), color, bracket: left ? 1 : -1 });
    }
    if (r() < 0.5 && w > 60) dyn.push({ t: 'ad', x: ((w - 56) >> 1) + Math.round((r() - 0.5) * 6), y: 14 + Math.round(r() * 26), ad: Math.floor(r() * ADS.length), seed: r() });
    if (r() < 0.32) {
      const word = pick(r, BIG_WORDS), color = pick(r, colors);
      const t = pixelText(word, shade(color, 0.5));
      dyn.push({ t: 'roof', img: t, x: ((w - t.width) >> 1), y: -t.height - 6, seed: r(), color });
    }
    if (r() < 0.5) dyn.push({ t: 'beacon', x: ax - pad, y: -ah, seed: r() });
    if (r() < 0.13) dyn.push({ t: 'koi', x: w >> 1, y: -36 - Math.round(r() * 20), seed: r(), color: pick(r, [D.b, D.a]) });
    return { img, off, w, h, pad, padTop, dyn };
  }

  getStreet(i) {
    const key = 9e7 + i;
    let b = this.cache.get(key);
    if (b) return b;
    b = this.genStreet(i);
    this.cache.set(key, b);
    return b;
  }

  genStreet(i) {
    const r = rng(hash(i, 9191));
    const D = districtAt(Math.floor((i * STREET_SLOT) / DISTRICT_LEN));
    const colors = [D.a, D.b, D.c];
    const props = [];
    if (r() < 0.6) props.push({ t: 'lamp', x: 4 });
    if (r() < 0.17) {
      props.push({ t: 'dumpster', x: 40 + Math.round(r() * 60) });
      if (r() < 0.7) props.push({ t: 'steam', x: 30 + Math.round(r() * 120) });
      if (r() < 0.5) props.push({ t: 'cat', x: 60 + Math.round(r() * 70) });
      return { alley: true, D, props, lanterns: r() < 0.8, lanternY: 30 + Math.round(r() * 30), seed: r(), sign: neonSign(pick(r, VERTICAL_WORDS), pick(r, colors), true), signX: 80 + Math.round(r() * 40) };
    }
    const gap = r() < 0.45 ? 10 + Math.round(r() * 22) : 0;
    const fw = STREET_SLOT - gap, h = 78 + Math.round(r() * 62);
    const x0 = Math.round(gap * r());
    const shop = pick(r, SHOPS);
    const pad = 16, padTop = 10;
    const img = makeCanvas(fw + pad * 2, h + padTop), c = img.getContext('2d');
    const col = shade(D.body, 0.02 + r() * 0.07);
    c.fillStyle = col;
    c.fillRect(pad, padTop, fw, h);
    // texture
    for (let n = 0; n < fw * h * 0.02; n++) {
      c.fillStyle = r() < 0.5 ? rgba('#000000', 0.18) : rgba('#ffffff', 0.04);
      c.fillRect(pad + Math.round(r() * fw), padTop + Math.round(r() * h), 1 + Math.round(r()), 1);
    }
    c.fillStyle = shade(col, 0.18);
    c.fillRect(pad - 2, padTop, fw + 4, 3);
    c.fillStyle = shade(col, -0.35);
    c.fillRect(pad - 2, padTop + 3, fw + 4, 1);
    const shopTop = h - 40;
    // upper floors
    for (let y = 10; y < shopTop - 16; y += 22) {
      c.fillStyle = shade(col, -0.25);
      c.fillRect(pad, padTop + y + 17, fw, 1);
      for (let x = 8; x < fw - 16; x += 20) {
        const on = r() < 0.5;
        const wx = pad + x, wy = padTop + y;
        c.fillStyle = shade(col, -0.45);
        c.fillRect(wx - 1, wy - 1, 13, 15);
        if (on) {
          const lc = r() < 0.6 ? '#ffc98a' : pick(r, colors);
          const gr = c.createLinearGradient(0, wy, 0, wy + 13);
          gr.addColorStop(0, shade(lc, 0.3)); gr.addColorStop(1, shade(lc, -0.35));
          c.fillStyle = gr; c.fillRect(wx, wy, 11, 13);
          if (r() < 0.5) { c.fillStyle = rgba('#000000', 0.35); for (let k = 1; k < 13; k += 2) c.fillRect(wx, wy + k, 11, 1); }
          if (r() < 0.4) { c.fillStyle = rgba('#0a0512', 0.85); c.fillRect(wx + 3 + Math.round(r() * 4), wy + 5, 3, 8); c.fillRect(wx + 4 + Math.round(r() * 3), wy + 3, 2, 2); }
        } else {
          c.fillStyle = '#0a0716'; c.fillRect(wx, wy, 11, 13);
          c.fillStyle = rgba(D.b, 0.12); c.fillRect(wx + 1, wy + 1, 2, 11);
        }
        c.fillStyle = shade(col, 0.2); c.fillRect(wx - 1, wy + 13, 13, 1);
        if (r() < 0.22) { c.fillStyle = '#4a4560'; c.fillRect(wx + 1, wy + 15, 9, 5); c.fillStyle = '#26223a'; c.fillRect(wx + 3, wy + 16, 4, 3); c.fillStyle = '#6a6585'; c.fillRect(wx + 1, wy + 15, 9, 1); }
      }
    }
    if (r() < 0.5) { c.fillStyle = shade(col, -0.4); const px = pad + fw - 4 - Math.round(r() * 6); c.fillRect(px, padTop, 2, h); c.fillStyle = shade(col, 0.1); c.fillRect(px, padTop, 1, h); }
    // shopfront
    const doorX = 10 + Math.round(r() * (fw - 36));
    const gy = padTop + shopTop + 8;
    const glassGr = c.createLinearGradient(0, gy, 0, padTop + h);
    glassGr.addColorStop(0, shade(shop.interior, -0.15));
    glassGr.addColorStop(0.5, shade(shop.interior, -0.45));
    glassGr.addColorStop(1, shade(shop.interior, -0.75));
    c.fillStyle = '#07040e';
    c.fillRect(pad + 4, gy - 1, fw - 8, h - shopTop - 7);
    c.fillStyle = glassGr;
    c.fillRect(pad + 5, gy, fw - 10, h - shopTop - 8);
    // interior props
    c.fillStyle = rgba('#000000', 0.45);
    for (let x = pad + 8; x < pad + fw - 10; x += 14 + Math.round(r() * 10)) c.fillRect(x, gy + 10 + Math.round(r() * 6), 8 + Math.round(r() * 6), 30);
    c.fillStyle = rgba('#ffffff', 0.7);
    for (let x = pad + 12; x < pad + fw - 10; x += 18) c.fillRect(x, gy + 2, 2, 1);
    for (let k = 0; k < 3; k++) {
      if (r() < 0.6) {
        const px = pad + 10 + Math.round(r() * (fw - 24));
        c.fillStyle = '#05020a';
        c.fillRect(px, gy + 12, 4, 20); c.fillRect(px, gy + 8, 4, 4);
      }
    }
    c.fillStyle = rgba('#ffffff', 0.12);
    for (let k = 0; k < 3; k++) { const sx = pad + 10 + Math.round(r() * (fw - 30)); pline(c, sx, gy + 30, sx + 10, gy + 2); }
    // door
    c.fillStyle = '#05020b';
    c.fillRect(pad + doorX, gy + 2, 14, h - shopTop - 10);
    c.fillStyle = rgba(shop.interior, 0.6);
    c.fillRect(pad + doorX + 6, gy + 3, 2, h - shopTop - 11);
    // awning
    const awC = pick(r, colors), striped = r() < 0.55;
    for (let x = 0; x < fw - 4; x++) {
      c.fillStyle = striped ? ((x >> 2) % 2 ? shade(awC, -0.2) : '#1a0f24') : shade(awC, -0.35);
      c.fillRect(pad + 2 + x, gy - 7, 1, 5);
      if (x % 4 < 2) c.fillRect(pad + 2 + x, gy - 2, 1, 1);
    }
    c.fillStyle = shade(awC, 0.2);
    c.fillRect(pad + 2, gy - 7, fw - 4, 1);
    // sign board
    const main = neonSign(shop.sign, pick(r, colors), false);
    const signX = Math.round((fw - main.width) / 2 + (r() - 0.5) * 20);
    const signY = shopTop - 12 - main.height + 4;
    c.fillStyle = '#0a0612';
    c.fillRect(pad + signX - 3, padTop + signY - 2, main.width + 6, main.height + 4);
    const dyn = [{ t: 'sign', img: main, x: signX, y: signY, seed: r() }];
    const enc = pick(r, colors);
    dyn.push({ t: 'tiny', text: shop.en, x: Math.round((fw - tinyWidth(shop.en)) / 2), y: shopTop + 1, color: shade(enc, 0.3), seed: r() });
    if (r() < 0.7) {
      const vs = neonSign(pick(r, VERTICAL_WORDS), pick(r, colors), true);
      const side = r() < 0.5;
      dyn.push({ t: 'sign', img: vs, x: side ? fw - 4 : -vs.width + 4, y: 8 + Math.round(r() * Math.max(2, shopTop - vs.height - 14)), seed: r(), bracket: side ? -1 : 1 });
    }
    if (r() < 0.4) dyn.push({ t: 'outline', w: fw, color: pick(r, colors), seed: r() });
    if (r() < 0.5) props.push({ t: 'vend', x: x0 + doorX + 22 + Math.round(r() * 20), color: pick(r, colors) });
    if (r() < 0.25) props.push({ t: 'steam', x: 20 + Math.round(r() * 140) });
    if (r() < 0.35) props.push({ t: 'trash', x: x0 + doorX + (r() < 0.5 ? -14 : 18) });
    return { alley: false, D, img, x0, fw, h, pad, padTop, dyn, props, shop, doorX, interior: shop.interior };
  }

  // ---------------- lifecycle ----------------
  enter() {
    this.intro = 0;
    if (!this.entered) { this.entered = true; this.player.x = 40; this.npcs = []; this.steam = []; }
    this.player.y = this.FEET - 170;
    this.player.vy = 0;
    this.player.ground = false;
    this.player.airT = 0;
    this.cam.x = this.player.x - this.W * 0.45;
    this.introDrop = true;
  }

  getInfo() {
    const p = this.palette(this.player.x);
    const d = districtAt(Math.floor(this.player.x / DISTRICT_LEN));
    return {
      zh: d.zh, en: d.en, color: p.a,
      tele: [`POS ${String(Math.round(this.player.x / 8)).padStart(5, '0')} M`, `SPD ${String(Math.round(Math.abs(this.player.vx) / 8 * 3.6)).padStart(3, '0')} KM/H`, `RAIN 87%`],
    };
  }

  // ---------------- update ----------------
  update(dt, input) {
    this.time += dt;
    const t = this.time;
    const p = this.player;
    if (this.intro < 1) this.intro = Math.min(1, this.intro + dt / 1.9);

    const left = input.down('KeyA', 'ArrowLeft') || input.joy.x < -0.3;
    const right = input.down('KeyD', 'ArrowRight') || input.joy.x > 0.3;
    p.run = input.down('ShiftLeft', 'ShiftRight') || input.btn.boost || Math.abs(input.joy.x) > 0.92;
    const dir = (right ? 1 : 0) - (left ? 1 : 0);
    const target = dir * (p.run ? 150 : 62);
    const acc = p.ground ? 9 : 3;
    p.vx += (target - p.vx) * Math.min(1, acc * dt);
    if (dir) p.face = dir;
    if ((input.hit('Space', 'KeyW', 'ArrowUp') || input.touchJump) && p.ground) {
      p.vy = -235; p.ground = false; p.airT = 0;
      this.audio.jump();
      this.spawnSplash(p.x, this.FEET, 5, 1);
    }
    p.x += p.vx * dt;
    if (!p.ground) {
      p.airT += dt;
      p.vy += 720 * dt;
      p.y += p.vy * dt;
      if (p.y >= this.FEET) {
        const hard = p.vy > 420;
        p.y = this.FEET; p.ground = true;
        p.squash = hard ? 1 : 0.5;
        this.spawnSplash(p.x, this.FEET, hard ? 22 : 8, hard ? 2 : 1);
        this.audio.land(hard ? 2 : 0.6);
        if (hard) this.shock = { x: p.x, t: 0 };
        p.vy = 0;
      }
    }
    p.squash = Math.max(0, p.squash - dt * 3);
    const speed = Math.abs(p.vx);
    if (p.ground && speed > 5) {
      const prev = Math.floor(p.phase / Math.PI);
      p.phase += dt * speed * (p.run ? 0.1 : 0.16);
      if (Math.floor(p.phase / Math.PI) !== prev) { this.audio.step2d(); if (Math.random() < 0.6) this.spawnSplash(p.x - p.face * 2, this.FEET, 2, 0.5); }
    } else if (p.ground) p.phase = lerp(p.phase, Math.round(p.phase / Math.PI) * Math.PI, dt * 8);
    if (this.shock) { this.shock.t += dt; if (this.shock.t > 0.8) this.shock = null; }

    // camera
    const tx = p.x - this.W * 0.5 + p.face * this.W * 0.1 + p.vx * 0.35;
    this.cam.x += (tx - this.cam.x) * Math.min(1, dt * 3.2);

    // ghosts (sandevistan afterimages)
    this.ghostTimer -= dt;
    for (const g of this.ghosts) g.a = Math.max(0, g.a - dt * 2.4);
    if (p.run && speed > 90 && this.ghostTimer <= 0) {
      this.ghostTimer = 0.05;
      this.drawPlayerSprite();
      const g = this.ghosts[this.ghostIdx++ % this.ghosts.length];
      const gc = g.c.getContext('2d');
      gc.clearRect(0, 0, 44, 44);
      gc.globalCompositeOperation = 'source-over';
      gc.drawImage(this.pc, 0, 0);
      gc.globalCompositeOperation = 'source-in';
      gc.fillStyle = this.ghostIdx % 2 ? '#29f0ff' : '#ff2bd6';
      gc.fillRect(0, 0, 44, 44);
      g.x = p.x; g.y = p.y; g.face = p.face; g.a = 0.55;
    }

    this.updateNPCs(dt);
    this.updateCars(dt);
    this.updateRain(dt);
    this.updateParticles(dt);

    // lightning
    this.nextLightning -= dt;
    if (this.nextLightning <= 0) {
      this.nextLightning = 14 + Math.random() * 22;
      this.flash = 1;
      const bx = this.W * (0.15 + Math.random() * 0.7);
      const pts = [[bx, 0]];
      let x = bx, y = 0;
      while (y < this.H * 0.45) { y += 6 + Math.random() * 10; x += (Math.random() - 0.5) * 16; pts.push([x, y]); }
      this.bolt = { pts, t: 0.22 };
      this.audio.thunder(0.5 + Math.random());
    }
    this.flash = Math.max(0, this.flash - dt * 2.2);
    if (this.bolt) { this.bolt.t -= dt; if (this.bolt.t <= 0) this.bolt = null; }

    // train
    const tr = this.train;
    if (!tr.active) {
      tr.next -= dt;
      if (tr.next <= 0) {
        tr.active = true;
        tr.dir = Math.random() < 0.5 ? 1 : -1;
        const ox = this.cam.x * TRAIN_F;
        tr.x = tr.dir > 0 ? ox - tr.len - 20 : ox + this.W + 20;
        this.audio.whoosh(0.14, 3.2);
      }
    } else {
      tr.x += tr.dir * 190 * dt;
      const ox = this.cam.x * TRAIN_F;
      if ((tr.dir > 0 && tr.x > ox + this.W + 40) || (tr.dir < 0 && tr.x + tr.len < ox - 40)) { tr.active = false; tr.next = 16 + Math.random() * 18; }
    }

    // shop tag
    const si = Math.floor(p.x / STREET_SLOT);
    const s = this.getStreet(si);
    let near = null;
    if (!s.alley) {
      const dx = si * STREET_SLOT + s.x0 + s.doorX + 7;
      if (Math.abs(p.x - dx) < 22) near = { shop: s.shop, x: dx, color: s.D.a };
    }
    if (near) { this.tag.shop = near; this.tag.a = Math.min(1, this.tag.a + dt * 4); }
    else this.tag.a = Math.max(0, this.tag.a - dt * 4);
  }

  updateNPCs(dt) {
    const L = this.cam.x - 160, R = this.cam.x + this.W + 160;
    this.npcs = this.npcs.filter((n) => n.x > L - 200 && n.x < R + 200);
    while (this.npcs.length < Math.round(this.W / 45)) {
      const init = this.npcs.length < 3 && this.time < 1;
      const side = Math.random() < 0.5;
      const x = init ? this.cam.x + Math.random() * this.W : side ? L - Math.random() * 60 : R + Math.random() * 60;
      const dir = side ? 1 : -1;
      const idle = Math.random() < 0.18;
      this.npcs.push({
        x, dir: init ? (Math.random() < 0.5 ? 1 : -1) : dir, sp: idle ? 0 : 16 + Math.random() * 22, phase: Math.random() * 6,
        h: 19 + Math.floor(Math.random() * 6), depth: Math.floor(Math.random() * 5) - 2,
        coat: pick(Math.random, ['#23203a', '#2a1b33', '#1b2638', '#302236', '#1a1a24', '#3a2a22']),
        umb: Math.random() < 0.55 ? pick(Math.random, ['#29f0ff', '#ff2bd6', '#ffd166', '#39ff6a', '#ff3860', '#c04dff', '#ffffff']) : null,
        phone: idle && Math.random() < 0.8, idle,
      });
    }
    for (const n of this.npcs) {
      n.x += n.dir * n.sp * dt;
      n.phase += dt * n.sp * 0.2;
    }
    this.npcs.sort((a, b) => a.depth - b.depth);
  }

  updateCars(dt) {
    const lanes = this.lanes;
    for (let li = 0; li < lanes.length; li++) {
      const ln = lanes[li];
      if (Math.random() < dt * (0.5 + li * 0.2)) {
        const dir = Math.random() < 0.5 ? 1 : -1;
        const ox = this.cam.x * ln.f;
        this.cars.push({ li, dir, x: dir > 0 ? ox - 40 : ox + this.W + 40, v: ln.v * (0.7 + Math.random() * 0.6), yo: (Math.random() - 0.5) * 16, col: pick(Math.random, ['#29f0ff', '#ff2bd6', '#ffd166', '#ffffff']) });
      }
    }
    for (const c of this.cars) c.x += c.dir * c.v * dt;
    this.cars = this.cars.filter((c) => { const ox = this.cam.x * lanes[c.li].f; return c.x > ox - 80 && c.x < ox + this.W + 80; });

    this.nextRoadCar -= dt;
    if (this.nextRoadCar <= 0) {
      this.nextRoadCar = 5 + Math.random() * 9;
      const dir = Math.random() < 0.5 ? 1 : -1;
      this.roadCars.push({ dir, x: dir > 0 ? this.cam.x * 1.15 - 120 : this.cam.x * 1.15 + this.W + 120, v: 340 + Math.random() * 160, col: pick(Math.random, ['#ff2bd6', '#29f0ff', '#ffb020']), sounded: false });
    }
    for (const c of this.roadCars) {
      c.x += c.dir * c.v * dt;
      const sx = c.x - this.cam.x * 1.15;
      if (!c.sounded && sx > -this.W * 0.6 && sx < this.W * 1.6) { c.sounded = true; this.audio.whoosh(0.22, 1.4); }
    }
    this.roadCars = this.roadCars.filter((c) => { const sx = c.x - this.cam.x * 1.15; return sx > -400 && sx < this.W + 400; });
  }

  updateRain(dt) {
    const H = this.H;
    for (const d of this.backRain) {
      d.y += d.s * dt; d.x += d.s * 0.16 * dt;
      if (d.y > H) Object.assign(d, this.newDrop(false, false));
    }
    for (const d of this.frontRain) {
      d.y += d.s * dt; d.x += d.s * 0.2 * dt;
      if (d.y > d.stop) {
        if (Math.random() < 0.5) {
          const wx = d.x + this.cam.x;
          if (d.y > this.ROAD) this.ripples.push({ x: wx, y: d.y, t: 0 });
          else this.spawnSplash(wx, d.y, 2, 0.5);
        }
        Object.assign(d, this.newDrop(true, false));
      }
    }
  }

  spawnSplash(x, y, n, power) {
    for (let i = 0; i < n; i++) this.splashes.push({ x, y, vx: (Math.random() - 0.5) * 70 * power, vy: -(30 + Math.random() * 70) * power, t: 0, life: 0.3 + Math.random() * 0.3 });
  }

  updateParticles(dt) {
    for (const s of this.splashes) { s.t += dt; s.vy += 400 * dt; s.x += s.vx * dt; s.y += s.vy * dt; }
    this.splashes = this.splashes.filter((s) => s.t < s.life);
    for (const r of this.ripples) r.t += dt;
    this.ripples = this.ripples.filter((r) => r.t < 0.5);
    for (const s of this.steam) { s.t += dt; s.y -= s.v * dt; s.x += Math.sin(s.t * 2 + s.seed) * 6 * dt + 4 * dt; s.r += dt * 4; }
    this.steam = this.steam.filter((s) => s.t < s.life);
    if (this.steam.length > 220) this.steam.splice(0, this.steam.length - 220);
  }

  // ---------------- render ----------------
  render() {
    const l = this.l, W = this.W, H = this.H, t = this.time;
    const pal = this.palette(this.cam.x + W / 2);
    this.pal = pal;
    const beat = this.audio.getBeat();
    this.beat = beat;
    l.imageSmoothingEnabled = false;
    l.globalCompositeOperation = 'source-over';
    l.globalAlpha = 1;

    // sky
    const sg = l.createLinearGradient(0, 0, 0, this.GROUND);
    sg.addColorStop(0, pal.sky[0]);
    sg.addColorStop(0.55, pal.sky[1]);
    sg.addColorStop(1, pal.sky[2]);
    l.fillStyle = sg;
    l.fillRect(0, 0, W, H);
    for (const s of this.stars) {
      const a = 0.25 + 0.5 * s.b * (0.5 + 0.5 * Math.sin(t * 1.5 + s.p));
      l.fillStyle = `rgba(255,240,255,${a})`;
      l.fillRect((((Math.round(s.x - this.cam.x * 0.004)) % W) + W) % W, Math.round(s.y), 1, 1);
    }
    if (this.flash > 0) { l.fillStyle = `rgba(210,190,255,${this.flash * 0.45})`; l.fillRect(0, 0, W, this.GROUND); }
    this.drawMoon(pal);
    this.drawClouds(0, 0.1, 0.012, 0.55);
    this.drawSearchlights(pal);
    if (this.bolt) {
      l.fillStyle = '#f4ecff';
      const pts = this.bolt.pts;
      for (let i = 1; i < pts.length; i++) pline(l, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }

    const intro = this.intro;
    const io = (k) => { const e = easeOutCubic(clamp(intro * 1.35 - k * 0.09, 0, 1)); return Math.round((1 - e) * (70 + k * 36)); };

    for (let k = 0; k < LAYERS.length; k++) {
      const L = LAYERS[k];
      this.drawLayer(L, io(k));
      if (k === 1) this.drawClouds(1, 0.24, 0.03, 0.35);
      if (k === 1 || k === 2) this.drawCars(k === 1 ? [0] : [1]);
      if (k === 2) this.drawTrain(io(2.5));
      this.hazeOver(pal.haze, L.haze);
      if (k === 2) this.drawRain(this.backRain, 'rgba(180,190,255,0.22)', 0.16);
      if (k === 3) this.drawCars([2]);
    }
    this.drawStreet(io(4), pal);
    this.drawReflection();
    this.drawRoad(pal);
    this.drawRain(this.frontRain, 'rgba(200,215,255,0.42)', 0.2);
    for (const s of this.splashes) {
      l.fillStyle = `rgba(200,220,255,${0.7 * (1 - s.t / s.life)})`;
      l.fillRect(Math.round(s.x - this.cam.x), Math.round(s.y), 1, 1);
    }
    if (this.flash > 0) { l.fillStyle = `rgba(200,190,255,${this.flash * 0.12})`; l.fillRect(0, 0, W, H); }
    this.drawTag();
    // intro flash from sky
    if (intro < 1) {
      const a = Math.max(0, 1 - intro * 2.2);
      l.fillStyle = `rgba(10,4,24,${a})`;
      l.fillRect(0, 0, W, H);
    }
    this.composite();
  }

  hazeOver(color, a) {
    const l = this.l;
    const g = l.createLinearGradient(0, this.GROUND - 190, 0, this.GROUND + 4);
    g.addColorStop(0, rgba(color, 0));
    g.addColorStop(1, rgba(color, a));
    l.fillStyle = g;
    l.fillRect(0, 0, this.W, this.GROUND + 4);
    l.fillStyle = rgba(color, a * 0.18);
    l.fillRect(0, 0, this.W, this.GROUND + 4);
  }

  drawMoon(pal) {
    const l = this.l, W = this.W;
    const cx = Math.round(W * 0.76), cy = Math.round(this.H * 0.17), r = 20;
    const halo = l.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 4.5);
    halo.addColorStop(0, rgba(mixHex('#ffd6f5', pal.a, 0.3), 0.35));
    halo.addColorStop(1, rgba(pal.a, 0));
    l.fillStyle = halo;
    l.fillRect(cx - r * 5, cy - r * 5, r * 10, r * 10);
    l.fillStyle = mixHex('#fff0f6', pal.a, 0.18);
    pcircle(l, cx, cy, r);
    l.fillStyle = rgba(mixHex('#c79ad8', pal.a, 0.2), 0.55);
    pcircle(l, cx - 6, cy - 4, 5); pcircle(l, cx + 7, cy + 5, 3); pcircle(l, cx + 2, cy - 10, 2); pcircle(l, cx - 3, cy + 9, 3);
    l.fillStyle = rgba(pal.sky[1], 0.5);
    for (let y = -r; y <= r; y++) { const hw = Math.floor(Math.sqrt(r * r - y * y)); l.fillRect(cx + hw - Math.floor(hw * 0.35), cy + y, Math.floor(hw * 0.35) + 1, 1); }
  }

  drawClouds(i, y, f, a) {
    const l = this.l, c = this.clouds[i];
    const off = -(((this.cam.x * f + this.time * (4 + i * 3)) % c.width) + c.width) % c.width;
    l.globalAlpha = a;
    for (let x = off; x < this.W; x += c.width) l.drawImage(c, Math.round(x), Math.round(this.H * y));
    l.globalAlpha = 1;
  }

  drawSearchlights(pal) {
    const l = this.l, t = this.time, W = this.W;
    l.globalCompositeOperation = 'lighter';
    const f = 0.1, span = 420;
    const ox = this.cam.x * f;
    for (let k = Math.floor((ox - 200) / span); k <= Math.floor((ox + W + 200) / span); k++) {
      const x = k * span + 120 * hash(k, 5) - ox, y = this.GROUND - 40;
      const a = -Math.PI / 2 + Math.sin(t * 0.35 + k * 1.7) * 0.55;
      const len = this.H * 1.3, wd = 0.07;
      const g = l.createLinearGradient(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len);
      const col = hash(k, 8) < 0.5 ? pal.b : '#d8c8ff';
      g.addColorStop(0, rgba(col, 0.22));
      g.addColorStop(1, rgba(col, 0));
      l.fillStyle = g;
      l.beginPath();
      l.moveTo(x, y);
      l.lineTo(x + Math.cos(a - wd) * len, y + Math.sin(a - wd) * len);
      l.lineTo(x + Math.cos(a + wd) * len, y + Math.sin(a + wd) * len);
      l.closePath();
      l.fill();
    }
    l.globalCompositeOperation = 'source-over';
  }

  drawLayer(L, yOff) {
    const l = this.l, W = this.W, t = this.time;
    const ox = this.cam.x * L.f;
    const base = this.GROUND + 4 + yOff;
    const i0 = Math.floor((ox - 90) / L.slot), i1 = Math.floor((ox + W + 90) / L.slot);
    for (let i = i0; i <= i1; i++) {
      const b = this.getB(L, i);
      const sx = Math.round(i * L.slot + b.off - ox), sy = base - b.h;
      l.drawImage(b.img, sx - b.pad, sy - b.padTop);
      for (const d of b.dyn) this.drawDyn(d, sx, sy, b, t);
    }
  }

  drawDyn(d, sx, sy, b, t) {
    const l = this.l;
    const x = sx + d.x, y = sy + d.y;
    if (d.t === 'beacon') {
      const on = Math.sin(t * 2.6 + d.seed * 20) > 0.55;
      l.fillStyle = on ? '#ff3050' : '#4a1020';
      l.fillRect(x - (on ? 1 : 0), y - 1, on ? 2 : 1, on ? 2 : 1);
      if (on) { l.fillStyle = 'rgba(255,40,80,0.25)'; l.fillRect(x - 2, y - 2, 4, 4); }
    } else if (d.t === 'img' || d.t === 'sign') {
      const f = flick(d.seed, t);
      const bf = 0.85 + this.beat * 0.15;
      if (d.bracket) { l.fillStyle = '#2a2438'; l.fillRect(d.bracket > 0 ? x + d.img.width - 2 : x - 4, y + 4, 6, 1); }
      l.globalAlpha = f * bf;
      l.drawImage(d.img, x, y);
      l.globalAlpha = 1;
      if (f > 0.5 && d.t === 'sign') {
        l.globalCompositeOperation = 'lighter';
        l.fillStyle = 'rgba(255,255,255,0.04)';
        l.fillRect(x - 2, y - 2, d.img.width + 4, d.img.height + 4);
        l.globalCompositeOperation = 'source-over';
      }
    } else if (d.t === 'strip') {
      const f = flick(d.seed, t);
      l.fillStyle = rgba(d.color, 0.9 * f);
      l.fillRect(x, y, d.w, 1);
    } else if (d.t === 'roof') {
      const f = flick(d.seed, t);
      l.fillStyle = '#1a1426';
      l.fillRect(x + 3, y + d.img.height, 1, 6); l.fillRect(x + d.img.width - 4, y + d.img.height, 1, 6);
      l.globalAlpha = f;
      l.drawImage(d.img, x, y);
      l.globalAlpha = 1;
    } else if (d.t === 'ad') {
      this.drawAd(x, y, d, t);
    } else if (d.t === 'koi') {
      this.drawKoi(x, y, d, t);
    } else if (d.t === 'tiny') {
      const f = flick(d.seed, t);
      drawTiny(l, d.text, x, y, f > 0.5 ? d.color : rgba(d.color, 0.25));
    } else if (d.t === 'outline') {
      const f = flick(d.seed, t);
      l.fillStyle = rgba(d.color, 0.85 * f);
      l.fillRect(sx, sy + 1, d.w, 1);
      l.fillRect(sx, sy + 1, 1, 20); l.fillRect(sx + d.w - 1, sy + 1, 1, 20);
    }
  }

  adCanvas(i, t) {
    if (!this.adCache) this.adCache = [];
    if (this.adCache[i]) return this.adCache[i];
    const A = ADS[i], w = 56, h = 34;
    const c = makeCanvas(w, h), x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, shade(A.c1, -0.25)); g.addColorStop(1, '#12051e');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    for (let k = 0; k < 6; k++) { x.fillStyle = rgba(A.c2, 0.12); x.fillRect(0, 4 + k * 5, w, 1); }
    x.fillStyle = rgba(A.c2, 0.5);
    pcircle(x, w - 10, 10, 6);
    const tt = pixelText(A.t1, '#ffffff');
    x.drawImage(tt, Math.max(2, Math.round((w - tt.width) / 2)), 5);
    drawTiny(x, A.t2, Math.round((w - tinyWidth(A.t2)) / 2), 22, A.c2);
    x.fillStyle = A.c2;
    x.fillRect(0, 0, w, 1); x.fillRect(0, h - 1, w, 1); x.fillRect(0, 0, 1, h); x.fillRect(w - 1, 0, 1, h);
    this.adCache[i] = c;
    return c;
  }

  drawAd(x, y, d, t) {
    const l = this.l;
    const phase = (t + d.seed * 7) / 7;
    const idx = (d.ad + Math.floor(phase)) % ADS.length;
    const fr = phase - Math.floor(phase);
    const img = this.adCanvas(idx);
    l.fillStyle = '#15101f';
    l.fillRect(x - 2, y - 2, img.width + 4, img.height + 4);
    l.fillRect(x + 8, y + img.height + 2, 2, 8); l.fillRect(x + img.width - 10, y + img.height + 2, 2, 8);
    if (fr > 0.965) {
      for (let k = 0; k < 10; k++) { l.fillStyle = hash(k, Math.floor(t * 30)) < 0.5 ? ADS[idx].c1 : ADS[idx].c2; l.fillRect(x, y + Math.floor(hash(k, 3, Math.floor(t * 30)) * img.height), img.width, 1 + Math.floor(hash(k, 9) * 3)); }
      return;
    }
    l.globalAlpha = 0.9 + this.beat * 0.1;
    l.drawImage(img, x, y);
    l.globalAlpha = 1;
    const sy = y + Math.floor(((t * 20) % (img.height + 10))) - 5;
    if (sy > y && sy < y + img.height) { l.fillStyle = 'rgba(255,255,255,0.18)'; l.fillRect(x, sy, img.width, 2); }
  }

  drawKoi(x, y, d, t) {
    const l = this.l;
    l.globalCompositeOperation = 'lighter';
    const N = 16;
    const path = (tt) => [x + Math.sin(tt * 0.55 + d.seed * 9) * 34, y + Math.sin(tt * 1.1 + d.seed * 3) * 8];
    for (let i = N - 1; i >= 0; i--) {
      const [px, py] = path(t - i * 0.09);
      const r = i < 3 ? 3 + i * 0.5 : Math.max(1, 5 - (i - 3) * 0.35);
      const a = (i === 0 ? 0.55 : 0.28) * (0.8 + Math.sin(t * 9 + i) * 0.2);
      l.fillStyle = rgba(d.color, a);
      for (let yy = -Math.round(r); yy <= Math.round(r); yy++) {
        if ((Math.round(py) + yy) % 2) continue;
        const hw = Math.round(Math.sqrt(r * r - yy * yy));
        l.fillRect(Math.round(px - hw), Math.round(py + yy), hw * 2 + 1, 1);
      }
      if (i === 5 || i === N - 1) { l.fillStyle = rgba(d.color, 0.3); l.fillRect(Math.round(px - 1), Math.round(py - 7), 2, 14); }
    }
    const [hx, hy] = path(t);
    l.fillStyle = 'rgba(255,255,255,0.8)';
    l.fillRect(Math.round(hx), Math.round(hy - 1), 1, 1);
    l.globalCompositeOperation = 'source-over';
  }

  drawCars(lanes) {
    const l = this.l;
    for (const c of this.cars) {
      if (!lanes.includes(c.li)) continue;
      const ln = this.lanes[c.li];
      const sx = Math.round(c.x - this.cam.x * ln.f), sy = Math.round(this.H * ln.y + c.yo);
      const s = ln.s, len = Math.round(16 * s), hgt = Math.max(2, Math.round(4 * s));
      l.globalCompositeOperation = 'lighter';
      const bx = c.dir > 0 ? sx + len : sx;
      const g = l.createLinearGradient(bx, 0, bx + c.dir * 36 * s, 0);
      g.addColorStop(0, 'rgba(255,250,220,0.35)'); g.addColorStop(1, 'rgba(255,250,220,0)');
      l.fillStyle = g;
      l.beginPath();
      l.moveTo(bx, sy + 1); l.lineTo(bx + c.dir * 36 * s, sy - 4 * s); l.lineTo(bx + c.dir * 36 * s, sy + 6 * s); l.closePath(); l.fill();
      const tg = l.createLinearGradient(c.dir > 0 ? sx : sx + len, 0, (c.dir > 0 ? sx : sx + len) - c.dir * 26 * s, 0);
      tg.addColorStop(0, 'rgba(255,40,70,0.35)'); tg.addColorStop(1, 'rgba(255,40,70,0)');
      l.fillStyle = tg;
      l.fillRect(Math.min(sx, sx - c.dir * 26 * s), sy + 1, 26 * s + len, Math.max(1, Math.round(s)));
      l.globalCompositeOperation = 'source-over';
      l.fillStyle = '#1a1628';
      l.fillRect(sx, sy, len, hgt);
      l.fillStyle = '#3a3552';
      l.fillRect(sx + 2, sy - 1, len - 4, 1);
      l.fillStyle = rgba(c.col, 0.8);
      l.fillRect(sx + Math.round(len * 0.3), sy, Math.round(len * 0.35), 1);
      l.fillStyle = rgba(c.col, 0.9);
      l.fillRect(sx + 1, sy + hgt, len - 2, 1);
      l.fillStyle = '#fff6d8';
      l.fillRect(c.dir > 0 ? sx + len - 1 : sx, sy + 1, 1, 1);
      l.fillStyle = '#ff2848';
      l.fillRect(c.dir > 0 ? sx : sx + len - 1, sy + 1, 1, 1);
    }
  }

  drawTrain(yOff) {
    const l = this.l, W = this.W;
    const ox = this.cam.x * TRAIN_F;
    const ty = Math.round(this.GROUND - 92 + yOff);
    l.fillStyle = '#140d22';
    l.fillRect(0, ty + 9, W, 3);
    l.fillStyle = '#2a2040';
    l.fillRect(0, ty + 9, W, 1);
    const span = 150;
    for (let k = Math.floor((ox - 20) / span); k <= Math.floor((ox + W + 20) / span); k++) {
      const x = Math.round(k * span - ox);
      l.fillStyle = '#120b1e';
      l.fillRect(x, ty + 12, 5, this.GROUND - ty);
      l.fillRect(x - 3, ty + 11, 11, 2);
    }
    const tr = this.train;
    if (!tr.active) return;
    const sx = Math.round(tr.x - ox);
    const cars = 4, cw = tr.len / cars;
    for (let k = 0; k < cars; k++) {
      const x = sx + Math.round(k * cw);
      l.fillStyle = '#231a36';
      l.fillRect(x, ty - 2, Math.round(cw) - 3, 11);
      l.fillStyle = '#4a3d66';
      l.fillRect(x, ty - 2, Math.round(cw) - 3, 1);
      for (let wx = x + 4; wx < x + cw - 8; wx += 7) {
        l.fillStyle = hash(wx - sx, k) < 0.8 ? '#ffe6b0' : '#29f0ff';
        l.fillRect(wx, ty + 1, 4, 3);
      }
      l.fillStyle = '#ff2bd6';
      l.fillRect(x, ty + 7, Math.round(cw) - 3, 1);
    }
    l.fillStyle = '#ffffff';
    l.fillRect(tr.dir > 0 ? sx + tr.len - 4 : sx, ty + 3, 2, 2);
  }

  drawRain(drops, color, slant) {
    const l = this.l;
    l.strokeStyle = color;
    l.lineWidth = 1;
    l.beginPath();
    for (const d of drops) {
      l.moveTo(Math.round(d.x) + 0.5, Math.round(d.y));
      l.lineTo(Math.round(d.x + d.l * slant) + 0.5, Math.round(d.y + d.l));
    }
    l.stroke();
  }

  drawStreet(yOff, pal) {
    const l = this.l, W = this.W, t = this.time;
    const ox = this.cam.x;
    const base = this.GROUND + yOff;
    const i0 = Math.floor((ox - 200) / STREET_SLOT), i1 = Math.floor((ox + W + 200) / STREET_SLOT);
    const slots = [];
    for (let i = i0; i <= i1; i++) slots.push([i, this.getStreet(i)]);
    // facades
    for (const [i, s] of slots) {
      const sx = Math.round(i * STREET_SLOT - ox);
      if (s.alley) { this.drawAlley(sx, base, s, t); continue; }
      const fx = sx + s.x0, fy = base - s.h;
      l.drawImage(s.img, fx - s.pad, fy - s.padTop);
      for (const d of s.dyn) this.drawDyn(d, fx, fy, s, t);
    }
    // sidewalk
    const G = this.GROUND;
    l.fillStyle = mixHex('#120a1e', pal.haze, 0.18);
    l.fillRect(0, G, W, this.ROAD - G);
    l.fillStyle = rgba(pal.a, 0.28);
    l.fillRect(0, G, W, 1);
    l.fillStyle = 'rgba(0,0,0,0.25)';
    const tOff = -(((ox % 16) + 16) % 16);
    for (let x = tOff; x < W; x += 16) l.fillRect(Math.round(x), G + 1, 1, this.ROAD - G - 2);
    l.fillRect(0, G + 7, W, 1);
    // door light spills
    l.globalCompositeOperation = 'lighter';
    for (const [i, s] of slots) {
      if (s.alley) continue;
      const cx = Math.round(i * STREET_SLOT - ox) + s.x0 + s.doorX + 7;
      const g = l.createRadialGradient(cx, G + 2, 1, cx, G + 2, 34);
      g.addColorStop(0, rgba(s.interior, 0.32)); g.addColorStop(1, rgba(s.interior, 0));
      l.fillStyle = g;
      l.fillRect(cx - 34, G - 8, 68, this.ROAD - G + 8);
    }
    l.globalCompositeOperation = 'source-over';
    // props behind people
    for (const [i, s] of slots) {
      const sx = Math.round(i * STREET_SLOT - ox);
      for (const p of s.props) this.drawProp(p, sx + p.x + (s.alley ? 0 : 0), s, i, t);
    }
    // steam particles
    for (const p of this.steam) {
      const a = 0.16 * (1 - p.t / p.life);
      l.fillStyle = `rgba(230,210,255,${a})`;
      const r = Math.round(p.r);
      l.fillRect(Math.round(p.x - ox - r), Math.round(p.y - r), r * 2, r * 2);
    }
    // people
    for (const n of this.npcs) if (n.depth < 0) this.drawNPC(n);
    this.drawPlayer();
    for (const n of this.npcs) if (n.depth >= 0) this.drawNPC(n);
    // curb
    l.fillStyle = mixHex('#2a1f3e', pal.haze, 0.2);
    l.fillRect(0, this.ROAD - 2, W, 2);
    l.fillStyle = rgba(pal.b, 0.18);
    l.fillRect(0, this.ROAD - 2, W, 1);
  }

  drawAlley(sx, base, s, t) {
    const l = this.l;
    l.fillStyle = 'rgba(6,3,12,0.55)';
    l.fillRect(sx, base - 60, STREET_SLOT, 60);
    // fire escape
    l.fillStyle = '#1a1428';
    const fx = sx + 20;
    for (let k = 0; k < 4; k++) {
      const y = base - 34 - k * 26;
      l.fillRect(fx, y, 40, 2);
      pline(l, fx + (k % 2 ? 36 : 4), y, fx + (k % 2 ? 4 : 36), y + 24);
      l.fillRect(fx, y - 8, 1, 8); l.fillRect(fx + 39, y - 8, 1, 8); l.fillRect(fx, y - 8, 40, 1);
    }
    l.globalAlpha = flick(s.seed, t);
    l.drawImage(s.sign, sx + s.signX, base - 20 - s.sign.height - 40);
    l.globalAlpha = 1;
    if (s.lanterns) {
      const y0 = base - 70 - s.lanternY;
      l.fillStyle = '#2a1a22';
      for (let x = 0; x < STREET_SLOT; x += 2) { const sag = Math.sin((x / STREET_SLOT) * Math.PI) * 14; l.fillRect(sx + x, Math.round(y0 + sag), 2, 1); }
      for (let x = 10; x < STREET_SLOT - 6; x += 16) {
        const sag = Math.sin((x / STREET_SLOT) * Math.PI) * 14;
        const sw = Math.round(Math.sin(t * 1.6 + x) * 1);
        const lx = sx + x + sw, ly = Math.round(y0 + sag + 2);
        l.fillStyle = '#ff3a3a';
        l.fillRect(lx - 2, ly, 5, 6);
        l.fillStyle = '#ffb070';
        l.fillRect(lx - 1, ly + 1, 3, 4);
        l.fillStyle = '#ffd24a';
        l.fillRect(lx, ly + 6, 1, 2);
        l.globalCompositeOperation = 'lighter';
        l.fillStyle = 'rgba(255,60,40,0.12)';
        l.fillRect(lx - 5, ly - 3, 11, 12);
        l.globalCompositeOperation = 'source-over';
      }
    }
  }

  vendSprite(color) {
    if (this.vendCache.has(color)) return this.vendCache.get(color);
    const c = makeCanvas(14, 26), x = c.getContext('2d');
    x.fillStyle = shade(color, -0.55); x.fillRect(0, 0, 14, 26);
    x.fillStyle = shade(color, 0.2); x.fillRect(1, 1, 12, 4);
    x.fillStyle = '#0c0816'; x.fillRect(2, 6, 10, 12);
    const cols = ['#ff4d4d', '#ffd166', '#29f0ff', '#39ff6a', '#ff2bd6', '#ffffff'];
    for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) { x.fillStyle = cols[(r * 4 + k) % cols.length]; x.fillRect(3 + k * 2, 7 + r * 4, 1, 2); }
    x.fillStyle = '#05030a'; x.fillRect(3, 20, 8, 3);
    x.fillStyle = shade(color, 0.5); x.fillRect(11, 19, 1, 2);
    this.vendCache.set(color, c);
    return c;
  }

  drawProp(p, x, s, i, t) {
    const l = this.l, G = this.GROUND;
    if (p.t === 'lamp') {
      l.fillStyle = '#1e1830';
      l.fillRect(x, G - 74, 2, 74 + 6);
      l.fillRect(x, G - 74, 12, 2);
      l.fillStyle = '#3a3050';
      l.fillRect(x + 8, G - 72, 6, 2);
      const on = flick(hash(i, 44), t) > 0.5;
      l.fillStyle = on ? '#fff3d6' : '#554a40';
      l.fillRect(x + 8, G - 70, 6, 1);
      if (on) {
        l.globalCompositeOperation = 'lighter';
        const g = l.createLinearGradient(0, G - 70, 0, G + 8);
        g.addColorStop(0, 'rgba(255,230,190,0.2)'); g.addColorStop(1, 'rgba(255,230,190,0.04)');
        l.fillStyle = g;
        l.beginPath(); l.moveTo(x + 8, G - 70); l.lineTo(x + 14, G - 70); l.lineTo(x + 30, G + 8); l.lineTo(x - 8, G + 8); l.closePath(); l.fill();
        const rg = l.createRadialGradient(x + 11, G + 6, 1, x + 11, G + 6, 26);
        rg.addColorStop(0, 'rgba(255,230,190,0.25)'); rg.addColorStop(1, 'rgba(255,230,190,0)');
        l.fillStyle = rg; l.fillRect(x - 16, G - 4, 54, 20);
        l.globalCompositeOperation = 'source-over';
      }
    } else if (p.t === 'vend') {
      const img = this.vendSprite(p.color);
      l.drawImage(img, Math.round(x), G - 22);
      l.globalCompositeOperation = 'lighter';
      l.fillStyle = rgba(p.color, 0.12 + this.beat * 0.05);
      l.fillRect(Math.round(x) - 4, G - 26, 22, 34);
      l.globalCompositeOperation = 'source-over';
    } else if (p.t === 'dumpster') {
      l.fillStyle = '#1f3a36'; l.fillRect(x, G - 12, 26, 14);
      l.fillStyle = '#2c524c'; l.fillRect(x - 1, G - 14, 28, 2);
      l.fillStyle = '#0c1a18'; l.fillRect(x + 3, G - 9, 20, 1);
    } else if (p.t === 'trash') {
      l.fillStyle = '#15121e'; l.fillRect(x, G + 1, 7, 5); l.fillRect(x + 5, G + 2, 6, 4);
      l.fillStyle = '#2a2638'; l.fillRect(x + 1, G + 1, 3, 1);
    } else if (p.t === 'cat') {
      const cx = Math.round(x), cy = G - 13;
      l.fillStyle = '#07040c';
      l.fillRect(cx, cy, 6, 3); l.fillRect(cx + 4, cy - 2, 3, 3); l.fillRect(cx + 4, cy - 3, 1, 1); l.fillRect(cx + 6, cy - 3, 1, 1);
      l.fillRect(cx - 1 + Math.round(Math.sin(t * 2) * 1), cy - 3, 1, 4);
      if (Math.sin(t * 0.8 + i) > -0.9) { l.fillStyle = '#c6ff3d'; l.fillRect(cx + 5, cy - 1, 1, 1); }
    } else if (p.t === 'steam') {
      l.fillStyle = '#231c33'; l.fillRect(x - 4, G + 3, 10, 2);
      if (Math.random() < 0.35) this.steam.push({ x: x + this.cam.x + (Math.random() - 0.5) * 4, y: G + 3, v: 14 + Math.random() * 14, r: 1, t: 0, life: 2 + Math.random() * 1.5, seed: Math.random() * 6 });
    }
  }

  drawNPC(n) {
    const l = this.l;
    const x = Math.round(n.x - this.cam.x), y = this.FEET + n.depth;
    if (x < -30 || x > this.W + 30) return;
    const d = n.dir;
    const R = (dx, dy, w, h) => l.fillRect(d > 0 ? x + dx : x - dx - w + 1, y + dy, w, h);
    const sw = n.idle ? 0 : Math.sin(n.phase) * 2.5;
    const hh = n.h;
    l.fillStyle = '#0a0812';
    pline(l, x, y - 7, x + Math.round(sw) * d, y - 1);
    pline(l, x, y - 7, x - Math.round(sw) * d, y - 1);
    l.fillStyle = n.coat;
    R(-2, -hh + 5, 5, hh - 11);
    l.fillStyle = shade(n.coat, 0.2);
    R(2, -hh + 5, 1, hh - 11);
    l.fillStyle = '#0d0a14';
    R(-2, -hh, 4, 5);
    l.fillStyle = '#c9a28c';
    R(1, -hh + 2, 1, 2);
    if (n.phone) {
      l.fillStyle = '#6ff7ff';
      R(2, -hh + 6, 1, 2);
      l.globalCompositeOperation = 'lighter';
      l.fillStyle = 'rgba(110,247,255,0.18)';
      R(0, -hh, 5, 8);
      l.globalCompositeOperation = 'source-over';
    }
    if (n.umb) {
      const uy = y - hh - 4;
      l.fillStyle = '#100b1a';
      l.fillRect(x, uy, 1, 7);
      l.fillStyle = 'rgba(16,10,26,0.92)';
      for (let dx = -8; dx <= 8; dx++) {
        const hgt = Math.round(Math.sqrt(64 - dx * dx) * 0.55);
        l.fillRect(x + dx, uy - hgt, 1, hgt + 1);
      }
      l.fillStyle = n.umb;
      l.fillRect(x - 8, uy, 17, 1);
      l.globalCompositeOperation = 'lighter';
      l.fillStyle = rgba(n.umb, 0.16);
      l.fillRect(x - 10, uy - 6, 21, 10);
      l.fillStyle = rgba(n.umb, 0.5);
      for (let dx = -8; dx <= 8; dx += 2) l.fillRect(x + dx, uy - Math.round(Math.sqrt(64 - dx * dx) * 0.55), 1, 1);
      l.globalCompositeOperation = 'source-over';
    }
  }

  drawPlayerSprite() {
    const c = this.pctx, p = this.player, t = this.time;
    c.clearRect(0, 0, 44, 44);
    const X = 22, Y = 38;
    const speed = Math.abs(p.vx);
    const moving = p.ground && speed > 5;
    const sw = moving ? Math.sin(p.phase) : 0;
    const run = p.run && speed > 90;
    const air = !p.ground;
    const bob = moving ? Math.round(Math.abs(Math.cos(p.phase)) * (run ? 1.5 : 1)) : Math.round(Math.sin(t * 2) * 0.6 + 0.4);
    const sq = Math.round(p.squash * 3);
    const lean = run ? 2 : moving ? 1 : 0;
    const top = Y - 26 + bob + sq;
    // legs
    c.fillStyle = '#0b0a14';
    if (air) {
      pline(c, X - 1, Y - 9, X - 3, Y - 4, 2); pline(c, X + 1, Y - 9, X + 4, Y - 5, 2);
    } else {
      const A = Math.round(sw * (run ? 5 : 3.5));
      pline(c, X, Y - 9 + sq, X - A, Y - 1 - (A < 0 && run ? 2 : 0), 2);
      c.fillStyle = '#161524';
      pline(c, X, Y - 9 + sq, X + A, Y - 1 - (A > 0 && run ? 2 : 0), 2);
      c.fillStyle = '#05040a';
      c.fillRect(X - A - 1, Y - 1, 4, 1); c.fillRect(X + A - 1, Y - 1, 4, 1);
    }
    // coat tail
    const flow = Math.min(1, speed / 150);
    c.fillStyle = '#18233a';
    for (let k = 0; k < 7; k++) {
      const wav = Math.round(Math.sin(t * 12 - k * 0.9) * flow * 1.5);
      c.fillRect(X - 4 - Math.round(k * flow * 0.6), top + 13 + k, 3 + Math.round(flow * 2), 1 + (wav > 0 ? 1 : 0));
    }
    // torso / coat
    c.fillStyle = '#1d2a42';
    c.fillRect(X - 3 + lean, top + 6, 7, 12);
    c.fillStyle = '#2d4266';
    c.fillRect(X + 3 + lean, top + 7, 1, 11);
    c.fillStyle = '#ff2bd6';
    c.fillRect(X - 3 + lean, top + 17, 7, 1);
    c.fillStyle = '#29f0ff';
    c.fillRect(X - 3 + lean, top + 7, 1, 10);
    // arms
    const armA = moving ? Math.round(-sw * (run ? 4 : 3)) : 0;
    c.fillStyle = '#121a2c';
    pline(c, X + lean, top + 8, X + lean + armA, top + 14 - (run ? 2 : 0), 2);
    c.fillStyle = '#2a3c5c';
    pline(c, X + 1 + lean, top + 8, X + 1 + lean - armA, top + 14 - (run ? 2 : 0), 2);
    c.fillStyle = '#d9b09a';
    c.fillRect(X + 1 + lean - armA, top + 15 - (run ? 2 : 0), 2, 1);
    // scarf
    c.fillStyle = '#ff3860';
    c.fillRect(X - 2 + lean, top + 5, 6, 2);
    for (let k = 0; k < 5; k++) c.fillRect(X - 3 + lean - k - Math.round(flow * k * 0.8), top + 5 + Math.round(Math.sin(t * 10 - k) * flow * 1.2) + (flow < 0.2 ? k : 0), 1, 1);
    // head
    c.fillStyle = '#d9b09a';
    c.fillRect(X - 1 + lean, top, 5, 5);
    c.fillStyle = '#0c0a18';
    c.fillRect(X - 2 + lean, top - 1, 6, 2);
    c.fillRect(X - 2 + lean, top, 2, 5);
    c.fillRect(X - 3 + lean, top + 1, 1, 3 + Math.round(flow * 2));
    c.fillStyle = '#29f0ff';
    c.fillRect(X + 1 + lean, top + 2, 4, 1);
    c.fillStyle = '#e8ffff';
    c.fillRect(X + 3 + lean, top + 2, 1, 1);
  }

  drawPlayer() {
    const l = this.l, p = this.player;
    for (const g of this.ghosts) {
      if (g.a <= 0.01) continue;
      l.globalAlpha = g.a;
      l.globalCompositeOperation = 'lighter';
      this.blitSprite(g.c, g.x, g.y, g.face);
    }
    l.globalAlpha = 1;
    l.globalCompositeOperation = 'source-over';
    // shadow
    l.fillStyle = 'rgba(0,0,0,0.45)';
    const sh = Math.max(2, 7 - Math.round((this.FEET - p.y) / 20));
    l.fillRect(Math.round(p.x - this.cam.x) - sh, this.FEET, sh * 2 + 1, 1);
    this.drawPlayerSprite();
    this.blitSprite(this.pc, p.x, p.y, p.face);
    // visor glow
    l.globalCompositeOperation = 'lighter';
    const vx = Math.round(p.x - this.cam.x) + p.face * 3, vy = Math.round(p.y) - 24;
    l.fillStyle = 'rgba(41,240,255,0.2)';
    l.fillRect(vx - 4, vy - 3, 8, 6);
    l.globalCompositeOperation = 'source-over';
    if (this.shock) {
      const k = this.shock.t / 0.8, r = Math.round(6 + k * 90);
      l.strokeStyle = rgba(this.pal.b, (1 - k) * 0.8);
      l.lineWidth = 1;
      l.beginPath();
      l.ellipse(Math.round(this.shock.x - this.cam.x) + 0.5, this.FEET + 0.5, r, Math.max(1, r * 0.1), 0, 0, Math.PI * 2);
      l.stroke();
    }
  }

  blitSprite(c, x, y, face) {
    const l = this.l;
    const sx = Math.round(x - this.cam.x), sy = Math.round(y);
    if (face >= 0) l.drawImage(c, sx - 22, sy - 38);
    else { l.save(); l.translate(sx, 0); l.scale(-1, 1); l.drawImage(c, -22, sy - 38); l.restore(); }
  }

  drawTag() {
    if (this.tag.a <= 0.01 || !this.tag.shop) return;
    const l = this.l, s = this.tag.shop;
    const text = s.shop.en;
    const w = tinyWidth(text) + 8;
    const x = Math.round(s.x - this.cam.x - w / 2), y = this.GROUND - 58 - Math.round((1 - this.tag.a) * 6);
    l.globalAlpha = this.tag.a;
    l.fillStyle = 'rgba(8,3,18,0.85)';
    l.fillRect(x, y, w, 11);
    l.fillStyle = s.color;
    l.fillRect(x, y, 2, 11);
    l.fillRect(x, y + 10, w, 1);
    drawTiny(l, text, x + 5, y + 3, '#ffffff');
    l.fillRect(x + (w >> 1), y + 11, 1, 3);
    l.globalAlpha = 1;
  }

  drawReflection() {
    const l = this.l, W = this.W, H = this.H, R = this.ROAD, t = this.time;
    const depth = H - R;
    l.globalAlpha = 0.5;
    for (let y = 0; y < depth; y += 2) {
      const sy = R - 2 - y;
      if (sy < 0) break;
      const wob = Math.round(Math.sin(y * 0.7 + t * 4) * (0.5 + y * 0.05));
      l.drawImage(this.lo, 0, sy, W, 2, wob, R + y, W, 2);
    }
    l.globalAlpha = 1;
  }

  drawRoad(pal) {
    const l = this.l, W = this.W, H = this.H, R = this.ROAD;
    const g = l.createLinearGradient(0, R, 0, H);
    g.addColorStop(0, 'rgba(10,5,22,0.35)');
    g.addColorStop(1, 'rgba(6,3,14,0.9)');
    l.fillStyle = g;
    l.fillRect(0, R, W, H - R);
    const ox = this.cam.x * 1.15;
    const off = -(((ox % 40) + 40) % 40);
    l.fillStyle = rgba(pal.c, 0.35);
    for (let x = off; x < W; x += 40) l.fillRect(Math.round(x), R + 20, 18, 1);
    l.fillStyle = rgba(pal.a, 0.2);
    l.fillRect(0, H - 6, W, 1);
    // ripples
    l.fillStyle = 'rgba(200,215,255,0.35)';
    for (const r of this.ripples) {
      const k = r.t / 0.5, rw = Math.round(1 + k * 5);
      l.globalAlpha = 1 - k;
      l.fillRect(Math.round(r.x - this.cam.x - rw), Math.round(r.y), rw * 2 + 1, 1);
    }
    l.globalAlpha = 1;
    // road hover cars
    for (const c of this.roadCars) {
      const sx = Math.round(c.x - ox), y = R + 14;
      const len = 30;
      l.globalCompositeOperation = 'lighter';
      const tr = l.createLinearGradient(c.dir > 0 ? sx : sx + len, 0, (c.dir > 0 ? sx : sx + len) - c.dir * 160, 0);
      tr.addColorStop(0, rgba(c.col, 0.6)); tr.addColorStop(1, rgba(c.col, 0));
      l.fillStyle = tr;
      l.fillRect(c.dir > 0 ? sx - 160 : sx + len, y + 5, 160, 2);
      const hb = l.createLinearGradient(c.dir > 0 ? sx + len : sx, 0, (c.dir > 0 ? sx + len : sx) + c.dir * 90, 0);
      hb.addColorStop(0, 'rgba(255,248,220,0.55)'); hb.addColorStop(1, 'rgba(255,248,220,0)');
      l.fillStyle = hb;
      const hx = c.dir > 0 ? sx + len : sx;
      l.beginPath(); l.moveTo(hx, y + 3); l.lineTo(hx + c.dir * 90, y - 6); l.lineTo(hx + c.dir * 90, y + 14); l.closePath(); l.fill();
      l.globalCompositeOperation = 'source-over';
      l.fillStyle = '#16121f';
      l.fillRect(sx, y, len, 7);
      l.fillStyle = '#2e2742';
      l.fillRect(sx + 6, y - 3, 16, 3);
      l.fillStyle = rgba('#29f0ff', 0.6);
      l.fillRect(sx + (c.dir > 0 ? 14 : 8), y - 2, 7, 2);
      l.fillStyle = c.col;
      l.fillRect(sx + 2, y + 7, len - 4, 1);
      l.fillStyle = '#fff6dc';
      l.fillRect(c.dir > 0 ? sx + len - 2 : sx, y + 2, 2, 2);
      l.fillStyle = '#ff2848';
      l.fillRect(c.dir > 0 ? sx : sx + len - 2, y + 2, 2, 2);
    }
  }

  composite() {
    const d = this.ctx, cw = this.canvas.width, ch = this.canvas.height;
    const g = this.gctx, gw = this.glow.width, gh = this.glow.height;
    g.imageSmoothingEnabled = true;
    g.globalCompositeOperation = 'copy';
    g.drawImage(this.lo, 0, 0, gw, gh);
    g.globalCompositeOperation = 'multiply';
    g.drawImage(this.glow, 0, 0);
    g.globalCompositeOperation = 'source-over';
    const g2 = this.g2ctx;
    g2.imageSmoothingEnabled = true;
    g2.globalCompositeOperation = 'copy';
    g2.drawImage(this.glow, 0, 0, this.glow2.width, this.glow2.height);
    g2.globalCompositeOperation = 'source-over';

    d.globalCompositeOperation = 'source-over';
    d.globalAlpha = 1;
    d.imageSmoothingEnabled = false;
    d.drawImage(this.lo, 0, 0, cw, ch);
    d.imageSmoothingEnabled = true;
    d.imageSmoothingQuality = 'high';
    d.globalCompositeOperation = 'lighter';
    d.globalAlpha = 0.5;
    d.drawImage(this.glow, 0, 0, cw, ch);
    d.globalAlpha = 0.38 + this.beat * 0.12;
    d.drawImage(this.glow2, 0, 0, cw, ch);
    d.globalAlpha = 1;
    d.globalCompositeOperation = 'source-over';
  }
}
