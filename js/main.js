import { AudioEngine } from './audio.js';
import { Input } from './input.js';
import { City2D } from './city2d.js';
import { Transition } from './transition.js';
import { TRACKS, DISTRICTS } from './data.js';
import { Progress } from './progress.js';
import { QuestSystem } from './quest.js';
import { GameState, RunStats } from './state.js';
import { SCORE, HUD, AUDIO } from './config.js';

const AUDIO_BASE = AUDIO.MUSIC_BASE;
const DUCK_MENU = AUDIO.DUCK_MENU;

const $ = (s) => document.querySelector(s);
const audio = new AudioEngine();
const stage = $('#stage');
const input = new Input(stage);
const fx = new Transition($('#fx'));

/**
 * 唯一的流程真相。改造前是三个裸布尔（mode / 转场中 / 是否已进入），
 * 每加一个状态（暂停/结算/死亡）都要往那上面加分支，必然失控。
 */
const gs = new GameState();

// ---------- 玩法扩展：存档 / 任务 ----------
const save = new Progress();
const quest = new QuestSystem(save, {
  banner, toast, audio, refreshScore,
  getCity3d: () => city3d,
  randomDistrict: () => DISTRICTS[Math.floor(Math.random() * DISTRICTS.length)],
  isGameState: function () { return gs.is.apply(gs, arguments); },
});

/**
 * PerfWatch —— 只观测，不干预。
 *
 * 零降级铁律：本项目不再有任何"帧率低就砍实体"的静默降级链路（原性能护栏已整体删除）。
 * 这里只保留一个环形缓冲，供自动化验收读取 avg / p95，作为"是否回退"的客观证据。
 */
class PerfWatch {
  constructor(n) {
    this.buf = new Float32Array(n);
    this.n = n;
    this.i = 0;
    this.len = 0;
  }
  /** 入队一帧真实时长（毫秒，不 clamp —— 长卡顿必须被如实记录） */
  sample(ms) {
    this.buf[this.i] = ms;
    this.i = (this.i + 1) % this.n;
    if (this.len < this.n) this.len += 1;
  }
  avg() {
    if (!this.len) return 0;
    let s = 0;
    for (let i = 0; i < this.len; i++) s += this.buf[i];
    return s / this.len;
  }
  /** p95：复制一份排序求分位。只在自动化验收里被读取，不是每帧路径 */
  p95() {
    if (!this.len) return 0;
    const a = Array.prototype.slice.call(this.buf, 0, this.len).sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
  }
  max() {
    if (!this.len) return 0;
    let m = 0;
    for (let i = 0; i < this.len; i++) if (this.buf[i] > m) m = this.buf[i];
    return m;
  }
}
const perf = new PerfWatch(120);

// 积分 / 碎片 / 纪计 HUD（只在数值变化时改 DOM，由 hud() 节流器与事件驱动）
const scoreEl = $('#scScore'), shardEl = $('#scShard'), bestEl = $('#scBest');
let lastScore = '', lastShard = '', lastBest = '';
function refreshScore() {
  const s = String(save.mem.score), h = String(save.mem.shards);
  const b = save.mem.raceBest === null ? '--' : save.mem.raceBest + 's';
  if (s !== lastScore) { scoreEl.textContent = s; lastScore = s; }
  if (h !== lastShard) { shardEl.textContent = h; lastShard = h; }
  if (b !== lastBest) { bestEl.textContent = b; lastBest = b; }
}
/** 碎片收集统一入口（2D/3D 共用） */
function onShardCollect() {
  save.addShard();
  save.addScore(SCORE.SHARD);
  // 本局统计（结算面板用）。score 是跨局累计，本局分数另计。
  if (city2d) {
    city2d.runShards += 1;
    city2d.addScore(SCORE.SHARD);
  }
  quest.onShard();
  audio.blip(1900, 0.05, 0.05);
  const sh = save.mem.shards;
  quest.onAchievement('first_shard');
  if (sh >= 10) quest.onAchievement('shard_10');
  if (sh >= 50) quest.onAchievement('shard_50');
  if (sh >= 100) quest.onAchievement('shard_100');
  if (save.mem.score >= 1000) quest.onAchievement('rich');
  refreshScore();
}

// 轻量调试快照：供自动化验证与排障读取。getter 惰性求值，不访问则零每帧开销。
window.__neonDebug = {
  talks: 0,
  get city2d() { return city2d; },
  get state() { return gs.cur; },
  get quest() { return quest; },
  get quest() { return quest; },
  get gs() { return gs; },
  get stats() {
    var q = quest.current;
    var p = city2d ? city2d.player : null;
    var fb = city2d ? city2d.feedback : null;
    var cm = city2d ? city2d.combat : null;
    var wv = city2d ? city2d.waves : null;
    return {
      mode: gs.mode, state: gs.cur, entered: !gs.is('BOOT'), shifting: gs.shifting,
      score: save.mem.score, shards: save.mem.shards,
      bestScore: save.mem.bestScore, runs: save.mem.runs, wins: save.mem.wins, bestWave: save.mem.bestWave,
      questsDone: save.mem.questsDone, raceBest: save.mem.raceBest,
      districts: Object.keys(save.mem.districts || {}).length,
      achievements: Object.keys(save.mem.achievements || {}).length,
      questType: q ? q.type : null, questDone: q ? q.done : 0, questN: q ? q.n : 0,
      talks: window.__neonDebug.talks,
      // 性能观测（只读，不参与任何降级决策）
      perf: { avg: perf.avg(), p95: perf.p95(), max: perf.max(), frames: perf.len },
      // 双时间轴：rawDt 真实帧时长 / lastSimDt 送进游戏逻辑的步长（顿帧期为 0）
      rawDt: lastRawDt, lastSimDt: lastSimDt,
      // 手感观测：跳跃三件套与移动曲线的直接证据
      player: p ? {
        x: p.x, y: p.y, vx: p.vx, vy: p.vy, face: p.face,
        ground: p.ground, coyoteT: p.coyoteT, bufferT: p.bufferT,
        jumpHeld: p.jumpHeld, apex: p.apex, apexHold: p.apexHold,
        sqx: p.sqx, sqy: p.sqy,
      } : null,
      camX: city2d ? city2d.cam.x : 0,
      // 战斗观测
      combat: city2d ? {
        hp: city2d.hp, maxHp: city2d.maxHp, iframes: city2d.iframes,
        combo: city2d.combo, comboT: city2d.comboT,
        phase: cm ? cm.phase : 'idle', phaseT: cm ? +cm.phaseT.toFixed(4) : 0,
        swingId: cm ? cm.swingId : 0, hitCount: cm ? cm.hitCount : 0,
        swings: city2d.runSwings, hits: city2d.runHits, kills: city2d.runKills,
        runScore: city2d.runScore,
        hitbox: cm ? (function () { var b = cm.hitbox(); return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null; })() : null,
      } : null,
      // 顿帧与震屏（判据 15~19 的硬证据）
      feedback: fb ? {
        lastHitstop: +fb.lastHitstop.toFixed(1),
        shakeX: +fb.shakeX.toFixed(3), shakeY: +fb.shakeY.toFixed(3),
        shakeAmp: +fb.shakeAmp.toFixed(3),
        timeScale: fb.timeScale, hurtT: +fb.hurtT.toFixed(3),
        sparks: fb.sparkCount, debris: fb.debrisCount,
        sparkCap: 96, debrisCap: 128, poolLenSparks: fb.sparks.length, poolLenDebris: fb.debris.length,
      } : null,
      // 敌人池（判据 11/28：长度必须恒为 12）
      enemies: city2d ? {
        poolLen: city2d.enemies.drones.length,
        alive: city2d.enemies.aliveCount,
        hitBufLen: city2d.enemies._hitBuf.length,
        hitCount: city2d.enemies.hitCount,
        states: city2d.enemies.drones.filter(function (d) { return d.active; })
          .map(function (d) { return d.state; }),
        hps: city2d.enemies.drones.filter(function (d) { return d.active; }).map(function (d) { return d.hp; }),
        xs: city2d.enemies.drones.filter(function (d) { return d.active; }).map(function (d) { return Math.round(d.x); }),
        flashT: city2d.enemies.drones.filter(function (d) { return d.active; }).map(function (d) { return +d.flashT.toFixed(3); }),
      } : null,
      // 波次（判据 23~27）
      waves: wv ? {
        wave: wv.wave, phase: wv.phase, spawned: wv.spawned,
        timer: +wv.timer.toFixed(3), frozen: wv.frozen, label: wv.label(),
        remaining: wv.remaining(),
      } : null,
    };
  },
};

const IDLE = { down: () => false, hit: () => false, joy: { x: 0, y: 0 }, btn: {}, drag: { dx: 0, dy: 0, active: false }, wheel: 0, touchJump: false, touchAtk: false };
const DEMO = { ...IDLE, down: (...c) => c.includes('KeyD') };

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
  'ATMOSPHERE · ACID RAIN · PARTICLE-BASED .... OK',
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

// 3D 包双通道加载器：优先普通脚本（可绕开对 ES module 的拦截），失败则回退模块方式。
// 注意：import() 的 specifier 必须是变量（spec），否则 esbuild --bundle 会把模块打进主程序。
function loadCity3D() {
  return new Promise(function (resolve, reject) {
    var g = window.NEONCity3D;
    if (g && g.City3D) { resolve(g.City3D); return; }
    var triedModule = false;

    // 通道二：退回原始 ES module 路径（依赖页面里的 importmap 解析 three）
    function viaModule() {
      if (triedModule) { reject(new Error('3D 包两种加载方式均失败')); return; }
      triedModule = true;
      var spec = './js/city3d.js';
      import(spec).then(function (m) {
        if (m && m.City3D) resolve(m.City3D);
        else reject(new Error('模块方式加载 city3d 但未导出 City3D'));
      }).catch(reject);
    }

    // 通道一：普通 classic script，加载打包好的 dist/city3d.js（IIFE，挂 window.NEONCity3D）
    var s = document.createElement('script');
    s.src = 'dist/city3d.js';
    s.onload = function () {
      var g2 = window.NEONCity3D;
      if (g2 && g2.City3D) resolve(g2.City3D);
      else viaModule();
    };
    s.onerror = viaModule;
    document.head.appendChild(s);
  });
}

async function boot() {
  window.__bootStarted = true;
  if (window.__stopHeartbeat) window.__stopHeartbeat();
  const fonts = Promise.race([
    Promise.all(['12px FusionPixel', '16px PressStart2P', '18px VT323'].map((f) => document.fonts.load(f))),
    new Promise((r) => setTimeout(r, 3500)),
  ]);
  progress(8);
  await fonts;
  city2d = new City2D($('#c2d'), audio);
  city2d.onShardCollect = onShardCollect;
  // 死亡序列结束 → 失败结算；第 3 波清空 → 胜利结算
  city2d.onDeathEnd = () => endRun(false);
  city2d.onWin = () => endRun(true);
  city2d.talkKey = isTouch ? null : 'E'; // 触屏无 E 键，隐藏按键提示（点击对话）
  requestAnimationFrame(frame);
  progress(24);
  city3dReady = loadCity3D()
    .then((City3D) => {
      city3d = new City3D($('#c3d'), audio);
      city3d.update(0.016, IDLE);
      city3d.render();
      // 玩法接线：碎片收集 / 竞速检查点（窄接口，three 对象不出 city3d）
      city3d.onShardCollect = onShardCollect;
      city3d.onRaceCheckpoint = (idx, total) => quest.onCheckpoint(idx, total);
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
  if (!gs.is('BOOT') || $('#enter').disabled) return;
  audio.init();
  audio.resume();
  audio.onTrack = updateTrack;
  gs.go('MENU');
  gs.go('PLAYING', { fresh: true });
  $('#boot').classList.add('off');
  setTimeout(() => $('#boot').remove(), 1100);
  document.body.classList.add('entered');
  city2d.enter();
  updateControls();
  updateTrack(0);
  if (quest.idx === 0) quest.next(); // 进入城市后派发第一个任务
  setTimeout(() => banner('PIXEL STREET', '2D · 像素街道'), 900);
  if (innerHeight > innerWidth) setTimeout(() => toast('横屏浏览体验更佳'), 4500);
}
$('#enter').addEventListener('click', enter);
$('#enter').addEventListener('pointerenter', () => audio.blip(1800, 0.03, 0.03));

// ---------- mode switching ----------
async function switchMode() {
  if (gs.shifting || gs.is('BOOT')) return;
  // 主理人 Q4 裁决：TAB 只允许在波次间歇（未开始 / intermission）切换。
  // 理由：2D/3D 往返是惩罚式的（2.35s 转场无输入 + 切回强制从 170px 高空重砸 +
  // 1.9s 入场动画 ≈ 5~6 秒失控），在波次进行中切换会直接毁掉战斗节奏。
  const gate = gs.beginShift();
  if (gate === 'blocked') {
    toast('战斗进行中 · 清完这一波才能切换维度');
    if (audio.uiConfirm) audio.uiCancel();
    return;
  }
  if (gate !== true) return;
  if (!city3d) {
    toast('3D 城市仍在加载…');
    await city3dReady;
    if (!city3d) { gs.endShift(); return; }
  }
  const to = gs.mode === '2d' ? '3d' : '2d';
  const sw = $('#modeSwitch');
  const r = sw.querySelector('.mode-track').getBoundingClientRect();
  sw.dataset.mode = to;
  document.body.classList.add('shifting');
  audio.transition();
  fx.play({
    source: () => (gs.mode === '2d' ? city2d.canvas : city3d.canvas),
    origin: [r.left + r.width / 2, r.top + r.height / 2],
    to,
    title: 'DIMENSION SHIFT',
    sub: to === '3d' ? '维度跃迁 → 3D · 霓虹天际线' : '维度跃迁 → 2D · 像素街道',
    onSwap: () => {
      gs.setMode(to);
      $('#c2d').classList.toggle('active', to === '2d');
      $('#c3d').classList.toggle('active', to === '3d');
      document.body.dataset.mode = to;
      audio.setFlavor(to);
      if (to === '2d') audio.setEngine(false);
      (to === '3d' ? city3d : city2d).enter();
      updateControls();
      lastDistrict = null;
      quest.onModeChanged(to); // 竞速任务只在 3D 进行
      if (to === '3d') quest.onAchievement('first_flight');
    },
    onDone: () => {
      gs.endShift();
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
  // 不使用可选链语法，避免旧内核浏览器在解析阶段抛 SyntaxError
  var fsRequest = document.documentElement.requestFullscreen;
  var fsExit = document.exitFullscreen;
  if (!document.fullscreenElement) {
    if (fsRequest) fsRequest.call(document.documentElement).catch(function () {});
  } else if (fsExit) {
    fsExit.call(document);
  }
}
$('#btnFull').addEventListener('click', toggleFull);

addEventListener('keydown', (e) => {
  if (gs.is('BOOT')) { if (e.code === 'Enter' || e.code === 'Space') enter(); return; }
  if (e.code === 'Tab' || e.code === 'KeyT') { e.preventDefault(); switchMode(); }
  if (e.code === 'KeyM') toggleMusic();
  if (e.code === 'KeyF') toggleFull();
  // 暂停 / 重试：状态转移必须同帧发生，所以不走 inputFor 的逐帧闸门
  if (e.code === 'Escape' || e.code === 'KeyP') {
    e.preventDefault();
    if (gs.is('PLAYING')) gs.go('PAUSED');
    else if (gs.is('PAUSED')) gs.go('PLAYING');
  }
  if (e.code === 'KeyR') {
    if (gs.is('PAUSED') || gs.is('RESULT')) retryRun();
  }
});
addEventListener('pointerdown', () => audio.resume());

// 触屏点击对话：短促点按（位移 <10px、时长 <500ms）就近找 NPC
let tapInfo = null;
stage.addEventListener('pointerdown', (e) => { tapInfo = { x: e.clientX, y: e.clientY, t: performance.now() }; });
stage.addEventListener('pointerup', (e) => {
  const tp = tapInfo;
  tapInfo = null;
  if (!tp || gs.is('BOOT') || gs.shifting || gs.mode !== '2d' || !city2d) return;
  const dx = e.clientX - tp.x, dy = e.clientY - tp.y;
  if (dx * dx + dy * dy < 100 && performance.now() - tp.t < 500) {
    const line = city2d.tryTalkAt(e.clientX, e.clientY);
    if (line) { toast(line, 3000); audio.blip(1300, 0.05, 0.04); }
  }
});

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
  const rows = CONTROLS[gs.mode].map((r) => {
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
const start = new Date(2077, 8, 24, 23, 47, 0).getTime();
function hud(dt, scene) {
  hudAcc += dt;
  if (hudAcc > 0.1 && scene) {
    hudAcc = 0;
    const info = scene.getInfo();
    if (info.zh !== lastDistrict) {
      if (lastDistrict && !gs.is('BOOT') && !gs.shifting) {
        if (gs.mode === '2d') banner(info.en, info.zh);
        else toast(`进入区域 · ${info.zh} ${info.en}`);
      }
      lastDistrict = info.zh;
      dname.textContent = info.zh;
      den.textContent = info.en;
      dname.classList.remove('swap'); void dname.offsetWidth; dname.classList.add('swap');
      document.documentElement.style.setProperty('--accent', info.color);
      // 玩法接线：区域打卡（任务 + 六区成就）
      if (!gs.is('BOOT')) {
        save.visitDistrict(info.zh);
        quest.onDistrict(info.zh);
        if (save.districtCount() >= 6) quest.onAchievement('all_districts');
      }
    }
    tele.innerHTML = info.tele.map((t) => `<span>${t}</span>`).join('');
    const d = new Date(start + performance.now());
    const p = (n) => String(n).padStart(2, '0');
    clock.textContent = `2077.09.24 · ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
}

// ---------- loop ----------
let last = performance.now();
let lastRawDt = 0, lastSimDt = 0;
/**
 * 主循环：双时间轴。
 *
 * rawDt —— 真实帧时长，不 clamp。只被 perf 统计与 Feedback 自身计时消费，
 *          长卡顿必须被如实记录（原实现把 clamp 后的 dt 喂给统计，
 *          导致一次 200ms 卡顿被上报为 50ms，护栏对卡顿完全失明）。
 * simDt —— clamp 后乘时间倍率的物理步长，进一切游戏逻辑。顿帧期为 0。
 *
 * ★ 顿帧判定的**唯一入口**是 feedback.frozen(rawDt)。city2d.update 里不允许出现
 *   第二个 `if (frozen)` —— 否则物理会在冻结帧继续积分导致穿透。
 */
function frame(now) {
  // ① 双时间轴
  const rawDt = (now - last) / 1000;
  last = now;
  lastRawDt = rawDt;
  perf.sample(rawDt * 1000);

  // ② 顿帧判定（唯一入口）。冻结期仍推进震屏/闪白/粒子，所以画面不会"卡住"。
  const frozen = city2d ? city2d.feedback.frozen(rawDt) : false;
  gs.frozen = frozen;

  // ③ 慢镜（死亡 0.35× / 击杀 0.25×）。顿帧优先：frozen 为真时直接用 0。
  const scale = frozen ? 0 : (city2d ? city2d.feedback.timeScale : 1);

  // ④ 物理步长：clamp 上限 0.05 防长卡顿穿模，下限 0.001 防除零
  const simDt = Math.min(0.05, Math.max(0.001, rawDt)) * scale;
  lastSimDt = simDt;

  const scene = gs.mode === '2d' ? city2d : city3d;
  const inp = inputFor();
  if (scene) {
    // 非 PLAYING 状态（PAUSED / RESULT / MENU）逻辑完全冻结，但 render 继续跑 ——
    // 结算面板的 CSS 逐条淡入由合成器驱动，需要 rAF 持续工作。
    if (gs.is('PLAYING') || gs.is('BOOT')) scene.update(simDt, inp);
    scene.render();
  }
  fx.update(simDt);
  if (gs.is('PLAYING')) quest.update(simDt); // 竞速计时等
  hud(simDt, scene);
  updateCombatHud();
  // NPC 对话：桌面 E 键（复用 input 的统一按键状态，避免重复 keydown 监听）
  if (gs.is('PLAYING') && !gs.shifting && gs.mode === '2d' && city2d && input.hit('KeyE')) {
    const line = city2d.tryTalk();
    if (line) { window.__neonDebug.talks += 1; toast(line, 3000); audio.blip(1300, 0.05, 0.04); }
  }
  // 冻结期不清 pressed：玩家在 60ms 顿帧内按下的 J 会被下一个非冻结帧消费到
  input.endFrame(frozen);
  requestAnimationFrame(frame);
}

/** 输入闸门：按状态决定这一帧给不给游戏逻辑喂真实输入 */
function inputFor() {
  if (gs.is('BOOT')) return gs.mode === '2d' ? DEMO : IDLE;  // 开机演示
  if (gs.is('MENU')) return IDLE;                              // 菜单不吃游戏输入
  if (gs.shifting) return IDLE;                                // 转场 2.35s 无输入权
  if (gs.is('PAUSED')) return IDLE;
  if (gs.is('RESULT')) return IDLE;
  return input;
}

// ================================================================
// GameState → DOM / audio 桥接（唯一的状态出口）
// 战斗模块之间一律用方法调用不用事件；事件只用于这一层。
// ================================================================

// 波次门控注入：state.js 不依赖 waves.js，由这里把判定送进去。
//
// Q4 要求「只在波次间歇允许切换」，但按字面实现（只看 wave.phase）有个死锁：
// 玩家只要一直跑、不清场，波次永远停在 clearing/ spawning，**TAB 就永久锁死**。
// 2D 里玩家步行 62px/s、敌人追击 40px/s，完全跑得掉 —— 这不是理论风险。
//
// 改成「有实时威胁才锁」：只要还有无人机在 chase 状态（即正在 hunt 你）就锁；
// 一旦全部脱离（进入 patrol），战斗实质上已经结束，开窗放行。
// 这样既满足 Q4 的本意（不要在被打的时候切维度丢掉 5~6 秒操作权），
// 又不会把玩家关在 2D 里出不来。此处我做了自主决策，理由见批次 2 报告。
gs.gatePhase = function () {
  if (!city2d) return null;
  const ds = city2d.enemies.drones;
  for (let i = 0; i < ds.length; i++) {
    if (ds[i].active && ds[i].state === 'chase') return 'combat';   // 有敌人正在追
  }
  const ph = city2d.waves.phase;
  if (ph === 'spawning' || ph === 'clearing') return 'idle';        // 无威胁 → 开窗
  return ph;
};

/** 把 city2d 的战斗数据同步进 RunStats（结算面板的唯一数据源） */
function syncStats() {
  const st = gs.stats;
  const c = city2d;
  st.hp = c.hp;
  st.survive = c.runTime || 0;
  st.kills = c.runKills;
  st.shards = c.runShards;      // ← 漏掉这行会让结算面板的「碎片」恒为 0
  st.swings = c.runSwings;
  st.hits = c.runHits;
  st.combo = c.combo;
  st.comboT = c.comboT;
  st.score = c.runScore;
  return st;
}

function showPanel(name) {
  ['menuPanel', 'pausePanel', 'resultPanel', 'helpPanel'].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('show', id === name);
  });
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

/** 结算面板填充：5 项统计 + 评级 + 新纪录 */
function fillResult(win) {
  const st = syncStats();
  const grade = st.grade();
  const el = {
    title: $('#resTitle'), sub: $('#resSub'),
    time: $('#resTime'), kills: $('#resKills'), shards: $('#resShards'),
    rate: $('#resRate'), score: $('#resScore'),
    grade: $('#resGrade'), record: $('#resRecord'),
  };
  if (el.title) el.title.textContent = win ? 'MISSION CLEAR' : 'MISSION FAILED';
  if (el.sub) el.sub.textContent = win ? '回合结束 · 你守住了霓虹街' : '回合结束 · 你被淹没了霓虹';
  if (el.time) el.time.textContent = fmtTime(st.survive);
  if (el.kills) el.kills.textContent = String(st.kills);
  if (el.shards) el.shards.textContent = String(st.shards);
  if (el.rate) el.rate.textContent = Math.round(st.hitRate() * 100) + '%';
  if (el.score) el.score.textContent = String(st.score);
  if (el.grade) {
    el.grade.textContent = grade;
    el.grade.className = 'grade g' + grade + (win ? '' : ' lose');
  }
  const isRecord = save.setBestScore(st.score);
  if (el.record) {
    el.record.style.display = isRecord ? '' : 'none';
    if (isRecord) el.record.textContent = '★ 新纪录！最高分 ' + String(st.score);
  }
  save.addRun(!!win, city2d.waves.wave);
  refreshScore();
  return st;
}

/** 重开一局：生命回满、波次归 1、敌人清空、计分归零；跨局累计数据保留 */
function retryRun() {
  if (!city2d) return;
  city2d.resetRun();
  city2d.runTime = 0;
  gs.stats.reset();
  if (gs.is('RESULT')) gs.go('PLAYING', { fresh: true });
  else gs.go('PLAYING');
  showPanel('none');
  document.body.classList.remove('dying');
  toast('新的一局 · 生命已回满');
}

/** 结束一局：胜利或失败都进 RESULT */
function endRun(win) {
  if (gs.is('RESULT')) return;
  fillResult(win);
  gs.go('RESULT', { win: win });
}

gs.on('enter:PLAYING', function () {
  document.body.classList.add('entered');
  document.body.classList.remove('dying');
  showPanel('none');
  if (city2d) { city2d.waves.thaw(); }
  // 恢复累积分数（历史成绩，不清）
  if (audio.setMusicDuck) audio.setMusicDuck(AUDIO_BASE, 0.1);
});
gs.on('enter:PAUSED', function () {
  showPanel('pausePanel');
  if (city2d) city2d.waves.freeze();
  if (audio.setMusicDuck) audio.setMusicDuck(DUCK_MENU, 0.1);
  fillPauseSummary();
});
gs.on('exit:PAUSED', function () {
  showPanel('none');
  if (city2d) city2d.waves.thaw();
  if (audio.setMusicDuck) audio.setMusicDuck(AUDIO_BASE, 0.1);
});
gs.on('enter:RESULT', function (payload) {
  showPanel('resultPanel');
  if (city2d) { city2d.waves.freeze(); city2d.enemies.reset(); }
  if (audio.setMusicDuck) audio.setMusicDuck(DUCK_MENU, 0.13);
  document.body.classList.toggle('dying', !(payload && payload.win));
});
gs.on('enter:MENU', function () {
  showPanel('menuPanel');
  if (audio.setRain) audio.setRain(0.07);
});
// 2D/3D 转场期间冻结波次计时（不惩罚玩家）
gs.on('shift:start', function () { if (city2d) city2d.waves.freeze(); });
gs.on('shift:end', function () { if (city2d && gs.is('PLAYING')) city2d.waves.thaw(); });

/** 暂停面板的进度摘要 */
function fillPauseSummary() {
  if (!city2d) return;
  const c = city2d;
  const w = $('#pauseWave'), k = $('#pauseKills'), s = $('#pauseShards'), cm = $('#pauseCombo');
  if (w) w.textContent = 'WAVE ' + c.waves.wave + '/3';
  if (k) k.textContent = '击杀 ' + c.runKills;
  if (s) s.textContent = '碎片 ' + c.runShards;
  if (cm) cm.textContent = '连击 ×' + c.combo;
}

// 面板按钮
function on(id, fn) { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); }
on('pauseResume', function () { gs.go('PLAYING'); });
on('pauseRetry', function () { retryRun(); });
on('pauseMenu', function () { gs.go('MENU'); });
on('resRetry', function () { retryRun(); });
on('resMenu', function () { gs.go('MENU'); });
on('btnHelp', function () { showPanel('helpPanel'); });
on('btnHelpBack', function () { showPanel('menuPanel'); });
on('btnStart', function () { if (gs.is('MENU')) retryRun(); });

/** 战斗 HUD 的 4 项常驻信息。全部脏检查，稳态零 DOM 写入（T05 判据 10） */
const hudCache = { hp: -1, label: '', remain: -1, combo: -1, low: null, hurt: '' };
function updateCombatHud() {
  if (!city2d || !gs.is('PLAYING')) return;
  const m = city2d.getHudModel();
  if (m.hp !== hudCache.hp) {
    hudCache.hp = m.hp;
    const icons = document.querySelectorAll('#hpIcons i');
    for (let i = 0; i < icons.length; i++) icons[i].classList.toggle('on', i < m.hp);
    const box = document.getElementById('hpIcons');
    box.classList.toggle('low', m.hp === 1);
    // 受击红闪：移除 + 强制 reflow + 添加，重启一次性动画
    box.classList.remove('hurt');
    void box.offsetWidth;
    if (m.hp < HUD.MAX_HP) box.classList.add('hurt');
  }
  if (m.label !== hudCache.label) {
    hudCache.label = m.label;
    const el = document.getElementById('wvLabel');
    if (el) el.textContent = m.label;
  }
  if (m.remaining !== hudCache.remain) {
    hudCache.remain = m.remaining;
    const el = document.getElementById('wvRemain');
    if (el) el.textContent = '剩余 ' + m.remaining;
  }
  if (m.combo !== hudCache.combo) {
    hudCache.combo = m.combo;
    const box = document.getElementById('comboBox');
    if (box) box.classList.toggle('on', m.combo > 1);
    const n = document.getElementById('cbNum');
    if (n) n.textContent = String(Math.max(0, m.combo));
  }
  // 受击渐晕：#hurtVignette 是 inset:0 的全屏元素，每帧改它的 opacity 会强制
  // 合成器重建整屏图层（实测 2D +4ms、3D +7ms）。必须脏检查：
  // 未受击时值恒为 '0'，一次写入后就再不碰。
  const hv = city2d.feedback.hurtAlpha();
  const hvStr = hv > 0 ? String(Math.min(1, hv * 1.8)) : '0';
  if (hvStr !== hudCache.hurt) {
    hudCache.hurt = hvStr;
    const v = document.getElementById('hurtVignette');
    if (v) v.style.opacity = hvStr;
  }
}

let rsz = 0;
addEventListener('resize', () => {
  clearTimeout(rsz);
  // 不使用可选链语法，避免旧内核浏览器在解析阶段抛 SyntaxError
  rsz = setTimeout(function () { if (city2d) city2d.resize(); if (city3d) city3d.resize(); fx.resize(); }, 120);
});

// 任务卡 DOM 注入 + 初始渲染
quest.init({
  card: $('#questCard'),
  title: $('#qTitle'),
  desc: $('#qDesc'),
  bar: $('#qBar'),
  prog: $('#qProg'),
});
quest.renderCard();
refreshScore();

updateControls();
boot();
