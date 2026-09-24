import { AudioEngine } from './audio.js';
import { Input } from './input.js';
import { City2D } from './city2d.js';
import { Transition } from './transition.js';
import { TRACKS } from './data.js';

const $ = (s) => document.querySelector(s);
const audio = new AudioEngine();
const stage = $('#stage');
const input = new Input(stage);
const fx = new Transition($('#fx'));

const IDLE = { down: () => false, hit: () => false, joy: { x: 0, y: 0 }, btn: {}, drag: { dx: 0, dy: 0, active: false }, wheel: 0, touchJump: false };
const DEMO = { ...IDLE, down: (...c) => c.includes('KeyD') };

let mode = '2d', busy = false, entered = false;
let city2d = null, city3d = null, city3dReady = null;
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');

// ---------- grain texture ----------
{
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d'), d = x.createImageData(128, 128);
  for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
  x.putImageData(d, 0, 0);
  document.documentElement.style.setProperty('--grain', `url(${c.toDataURL()})`);
}

// ---------- boot ----------
const LOG = [
  'NEON//OS v20.77 · KERNEL BOOT ............ OK',
  'MOUNTING CITY GRID  [34 x 34 BLOCKS] ...... OK',
  'SPAWNING CITIZENS · 2,048,576 ............. OK',
  'CALIBRATING NEON TUBES · 4,096 HZ ......... OK',
  'ACID RAIN PROBABILITY ..................... 87%',
  'SYNTHWAVE ENGINE · 94 BPM · A MINOR ....... OK',
  'DIMENSION DRIVE · 2D <-> 3D ............... ARMED',
  'LOADING VOXEL SKYLINE ..................... ',
];
const logEl = $('#bootLog');
let logText = '';
function typeLine(s) {
  return new Promise((res) => {
    let i = 0;
    const tick = () => {
      i += 3;
      logEl.textContent = logText + s.slice(0, i) + '█';
      if (i < s.length) setTimeout(tick, 12);
      else { logText += s + '\n'; logEl.textContent = logText; res(); }
    };
    tick();
  });
}
function progress(p) {
  $('#bootBar').style.width = p + '%';
  $('#bootPct').textContent = Math.round(p) + '%';
}

async function boot() {
  const fonts = Promise.race([
    Promise.all(['12px FusionPixel', '16px PressStart2P', '18px VT323'].map((f) => document.fonts.load(f))),
    new Promise((r) => setTimeout(r, 3500)),
  ]);
  progress(8);
  await fonts;
  city2d = new City2D($('#c2d'), audio);
  requestAnimationFrame(frame);
  progress(24);
  city3dReady = import('./city3d.js')
    .then((m) => {
      city3d = new m.City3D($('#c3d'), audio);
      city3d.update(0.016, IDLE);
      city3d.render();
      return city3d;
    })
    .catch((e) => { console.error(e); toast('3D 模块加载失败：你的设备可能不支持 WebGL2'); return null; });
  for (let i = 0; i < LOG.length - 1; i++) { await typeLine(LOG[i]); progress(24 + (i + 1) * 8); }
  await typeLine(LOG[LOG.length - 1]);
  await city3dReady;
  logText = logText.trimEnd() + ' ' + (city3d ? 'OK' : 'FAIL') + '\n> READY. WELCOME TO NEON CITY_';
  logEl.textContent = logText;
  progress(100);
  const btn = $('#enter');
  btn.disabled = false;
  btn.focus();
}

function enter() {
  if (entered || $('#enter').disabled) return;
  entered = true;
  audio.init();
  audio.resume();
  audio.onTrack = updateTrack;
  $('#boot').classList.add('off');
  setTimeout(() => $('#boot').remove(), 1100);
  document.body.classList.add('entered');
  city2d.enter();
  updateControls();
  updateTrack(0);
  setTimeout(() => banner('PIXEL STREET', '2D · 像素街道'), 900);
  if (innerHeight > innerWidth) setTimeout(() => toast('横屏浏览体验更佳'), 4500);
}
$('#enter').addEventListener('click', enter);
$('#enter').addEventListener('pointerenter', () => audio.blip(1800, 0.03, 0.03));

// ---------- mode switching ----------
async function switchMode() {
  if (busy || !entered) return;
  if (!city3d) {
    toast('3D 城市仍在加载…');
    await city3dReady;
    if (!city3d) return;
  }
  busy = true;
  const to = mode === '2d' ? '3d' : '2d';
  const sw = $('#modeSwitch');
  const r = sw.querySelector('.mode-track').getBoundingClientRect();
  sw.dataset.mode = to;
  document.body.classList.add('shifting');
  audio.transition();
  fx.play({
    source: () => (mode === '2d' ? city2d.canvas : city3d.canvas),
    origin: [r.left + r.width / 2, r.top + r.height / 2],
    to,
    title: 'DIMENSION SHIFT',
    sub: to === '3d' ? '维度跃迁 → 3D · 霓虹天际线' : '维度跃迁 → 2D · 像素街道',
    onSwap: () => {
      mode = to;
      $('#c2d').classList.toggle('active', to === '2d');
      $('#c3d').classList.toggle('active', to === '3d');
      document.body.dataset.mode = to;
      audio.setFlavor(to);
      if (to === '2d') audio.setEngine(false);
      (to === '3d' ? city3d : city2d).enter();
      updateControls();
      lastDistrict = null;
    },
    onDone: () => {
      busy = false;
      document.body.classList.remove('shifting');
      banner(to === '3d' ? 'NEON SKYLINE' : 'PIXEL STREET', to === '3d' ? '3D · 霓虹天际线' : '2D · 像素街道');
    },
  });
}
$('#modeSwitch').addEventListener('click', (e) => { e.stopPropagation(); switchMode(); });
$('#modeSwitch').addEventListener('pointerenter', () => audio.blip(1400, 0.03, 0.03));

function toggleMusic() {
  if (!audio.ctx) return;
  const m = audio.toggleMute();
  $('#btnMusic').classList.toggle('off', m);
  toast(m ? '声音已关闭' : '声音已开启');
}
$('#btnMusic').addEventListener('click', toggleMusic);
function toggleFull() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
}
$('#btnFull').addEventListener('click', toggleFull);

addEventListener('keydown', (e) => {
  if (!entered) { if (e.code === 'Enter' || e.code === 'Space') enter(); return; }
  if (e.code === 'Tab' || e.code === 'KeyT') { e.preventDefault(); switchMode(); }
  if (e.code === 'KeyM') toggleMusic();
  if (e.code === 'KeyF') toggleFull();
});
addEventListener('pointerdown', () => audio.resume());

// ---------- HUD ----------
const CONTROLS = {
  '2d': [
    ['A', 'D', '左右行走'],
    ['SHIFT', '奔跑 · 残影'],
    ['SPACE', '跳跃'],
    ['TAB', '切换 3D'],
  ],
  '3d': [
    ['W', 'S', '推进 / 刹车'],
    ['A', 'D', '转向'],
    ['SPACE', 'Q', '升 / 降'],
    ['SHIFT', '氮气加速'],
    ['拖拽', '滚轮', '环视 / 缩放'],
    ['TAB', '切换 2D'],
  ],
};
function updateControls() {
  const rows = CONTROLS[mode].map((r) => {
    const keys = r.slice(0, -1).map((k) => `<kbd>${k}</kbd>`).join('');
    return `<div class="row">${keys}<span class="t">${r[r.length - 1]}</span></div>`;
  });
  $('#controls').innerHTML = `<div class="ttl">CONTROLS // 操作</div>${rows.join('')}<div class="row"><kbd>M</kbd><span class="t">音乐</span><kbd>F</kbd><span class="t">全屏</span></div>`;
}

function updateTrack(i) {
  $('#track').textContent = TRACKS[i % TRACKS.length];
}

let bannerTimer = 0;
function banner(a, b) {
  const el = $('#banner');
  $('#b1').textContent = a;
  $('#b2').textContent = b;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('show'), 3700);
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

let lastDistrict = null, hudAcc = 0;
const tele = $('#tele'), dname = $('#dname'), den = $('#den'), clock = $('#clock');
const eq = $('#eq').getContext('2d'), spec = $('#spectrum').getContext('2d');
const start = new Date(2077, 8, 24, 23, 47, 0).getTime();
function hud(dt, scene) {
  hudAcc += dt;
  if (hudAcc > 0.1 && scene) {
    hudAcc = 0;
    const info = scene.getInfo();
    if (info.zh !== lastDistrict) {
      if (lastDistrict && entered && !busy) {
        if (mode === '2d') banner(info.en, info.zh);
        else toast(`进入区域 · ${info.zh} ${info.en}`);
      }
      lastDistrict = info.zh;
      dname.textContent = info.zh;
      den.textContent = info.en;
      dname.classList.remove('swap'); void dname.offsetWidth; dname.classList.add('swap');
      document.documentElement.style.setProperty('--accent', info.color);
    }
    tele.innerHTML = info.tele.map((t) => `<span>${t}</span>`).join('');
    const d = new Date(start + performance.now());
    const p = (n) => String(n).padStart(2, '0');
    clock.textContent = `2077.09.24 · ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  const f = audio.spectrum();
  const muted = audio.muted || !f;
  eq.clearRect(0, 0, 40, 22);
  for (let i = 0; i < 6; i++) {
    const v = muted ? 0.1 : f[2 + i * 4] / 255;
    const h = Math.max(2, Math.round(v * 20));
    eq.fillStyle = i % 2 ? '#29f0ff' : '#ff2bd6';
    eq.fillRect(3 + i * 6, 21 - h, 4, h);
  }
  spec.clearRect(0, 0, 220, 34);
  const n = 36;
  for (let i = 0; i < n; i++) {
    const v = muted ? 0.04 : Math.pow((f[i + 1] || 0) / 255, 1.4);
    const h = Math.max(1, Math.round(v * 30 / 3) * 3);
    for (let y = 0; y < h; y += 3) {
      const k = y / 30;
      spec.fillStyle = k > 0.7 ? '#ffffff' : k > 0.4 ? '#29f0ff' : '#ff2bd6';
      spec.fillRect(i * 6, 33 - y - 2, 5, 2);
    }
  }
}

// ---------- loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  const scene = mode === '2d' ? city2d : city3d;
  const inp = !entered ? (mode === '2d' ? DEMO : IDLE) : busy ? IDLE : input;
  if (scene) {
    scene.update(dt, inp);
    scene.render();
  }
  fx.update(dt);
  hud(dt, scene);
  input.endFrame();
  requestAnimationFrame(frame);
}

let rsz = 0;
addEventListener('resize', () => {
  clearTimeout(rsz);
  rsz = setTimeout(() => { city2d?.resize(); city3d?.resize(); fx.resize(); }, 120);
});

updateControls();
boot();
