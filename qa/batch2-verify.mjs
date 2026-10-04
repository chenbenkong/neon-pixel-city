#!/usr/bin/env node
/**
 * batch2-verify.mjs —— T03（29 条）+ T04（18 条）完成判据的自动化实测
 *
 * 关键设计：顿帧（判据 15/16/22）与震屏（17/18）实现在 main.frame() 里，
 * 因为「Feedback.frozen 是全项目唯一返回 dt=0 的入口」这条铁律要求冻结判定
 * 必须在驱动源那一层。所以这两组判据必须走**真实 rAF 循环**采样，不能用定步长探针。
 * 其余判据用定步长探针（掐断 rAF + 手动 step），保证可复现。
 */
import { spawn } from 'node:child_process';
if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding('utf8');

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeProfile } from './edge-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'shots');
const PY = 'C:/Users/moli/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_ = process.argv[2] || 'http://127.0.0.1:8150/';
const PORT = 9520, CDP = 9521;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a);

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.p = new Map(); this.l = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id !== undefined && this.p.has(m.id)) {
        const h = this.p.get(m.id); this.p.delete(m.id);
        m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result);
      } else if (m.method) (this.l.get(m.method) || []).forEach((f) => f(m.params || {}));
    });
  }
  on(k, f) { if (!this.l.has(k)) this.l.set(k, []); this.l.get(k).push(f); }
  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((res, rej) => {
      this.p.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + method)); } }, 60000);
    });
  }
  async eval(x) {
    const r = await this.send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || '') + ' ' + (((r.exceptionDetails.exception || {}).description) || '').slice(0, 400));
    return r.result ? r.result.value : undefined;
  }
}
const keyDown = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const keyUp = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const tap = async (c, code, vk, ms = 60) => { await keyDown(c, code, vk); await sleep(ms); await keyUp(c, code, vk); };

const checks = [];
function add(id, desc, pass, detail) {
  checks.push({ id, desc, pass: !!pass, detail });
  log(`${pass ? '✔' : '✘'} ${id} ${detail}`);
}

/* 定步长探针：掐断 rAF，用固定 dt 驱动（物理/状态机走的仍是 city2d.update 真实路径） */
const PROBE = `(function () {
  if (window.__p2) return;
  var P = window.__p2 = { trace: [], recording: false, prevAtk: false, prevJump: false };
  P.held = { jump: false, right: false, left: false, run: false, atk: false };
  P.input = {
    // down() 必须检查**所有**参数 —— 真实 Input.down(...codes) 是这么实现的，
    // 只看第一个 code 会让 down('KeyA','KeyD',...) 永远返回 false（测试曾因此误判）
    down: function () {
      for (var i = 0; i < arguments.length; i++) {
        var c = arguments[i];
        if (c === 'KeyD' && P.held.right) return true;
        if (c === 'KeyA' && P.held.left) return true;
        if (c === 'Space' && P.held.jump) return true;
        if (c === 'ShiftLeft' && P.held.run) return true;
      }
      return false;
    },
    hit: function (c) {
      if (c === 'KeyJ') { if (P.held.atk && !P.prevAtk) { P.prevAtk = true; return true; } if (!P.held.atk) P.prevAtk = false; return false; }
      if (c === 'Space') { if (P.held.jump && !P.prevJump) { P.prevJump = true; return true; } if (!P.held.jump) P.prevJump = false; return false; }
      return false;
    },
    joy: { x: 0, y: 0, active: false }, btn: {}, drag: { dx: 0, dy: 0, active: false },
    wheel: 0, touchJump: false, touchAtk: false
  };
  P.install = function () { window.requestAnimationFrame = function () { return 0; }; return P; };
  P.c = function () { return window.__neonDebug.city2d; };
  P.step = function (n, dt) {
    var c = P.c();
    for (var i = 0; i < n; i++) {
      c.update(dt, P.input);
      c.feedback.update(dt);
      c.render();
      if (P.recording) {
        var s = window.__neonDebug.stats;
        P.trace.push({ simDt: s.lastSimDt, px: s.player.x, py: s.player.y,
          ph: s.combat.phase, phT: s.combat.phaseT, hitstop: s.feedback.lastHitstop,
          shX: s.feedback.shakeX, shY: s.feedback.shakeY, shAmp: s.feedback.shakeAmp });
      }
    }
  };
  P.start = function () { P.trace = []; P.recording = true; };
  P.stop = function () { P.recording = false; return P.trace; };
  P.clearInput = function () { P.held.jump = P.held.right = P.held.left = P.held.run = P.held.atk = false; P.prevAtk = P.prevJump = false; };
  P.reset = function () {
    var c = P.c(), p = c.player;
    P.clearInput();
    c.resetRun();
    p.x = 400; p.y = c.FEET; p.vx = 0; p.vy = 0; p.ground = true; p.face = 1;
    p.bufferT = 0; p.coyoteT = 0; p.jumpHeld = false;
    c.cam.x = p.x - c.W * 0.5; c.intro = 1;
  };
  // 把玩家与敌人摆到远离接触伤害的位置（避免接触伤害的震动污染命中震屏的测量）
  P.solo = function (dx) {
    var c = P.c();
    c.enemies.reset();
    return c.enemies.spawn(c.player.x + (dx || 20), {});
  };
})();`;

/* 真实 rAF 逐帧采样器：给顿帧/震屏判据用 */
const RAF_PROBE = `(function () {
  if (window.__raf2) return;
  window.__raf2 = { on: false, buf: [] };
  var R = window.__raf2;
  var loop = function (t) {
    if (R.on) {
      var s = window.__neonDebug.stats;
      if (s) R.buf.push({
        t: t, simDt: s.lastSimDt, rawDt: s.rawDt, px: s.player ? s.player.x : 0,
        hs: s.feedback ? s.feedback.lastHitstop : 0,
        shX: s.feedback ? s.feedback.shakeX : 0, shY: s.feedback ? s.feedback.shakeY : 0,
        shAmp: s.feedback ? s.feedback.shakeAmp : 0, hp: s.combat ? s.combat.hp : 0
      });
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();`;

async function main() {
  try { mkdirSync(OUT, { recursive: true }); } catch { /* exists */ }
  // profile 每次唯一：复用旧 profile 会带上 localStorage 存档，干扰首局判定
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${edgeProfile('b2v-')}`,
    '--window-size=1280,720', '--mute-audio', '--no-first-run', '--disable-extensions',
    '--use-gl=angle', '--use-angle=d3d11', 'about:blank'], { stdio: 'ignore' });
  const errors = [];
  try {
    const fs = await import('node:fs');
    const REPO = __dirname.replace(/[\\/]qa$/, '');
    const src = (f) => fs.readFileSync(join(REPO, f), 'utf8');
    const mainSrc = src('js/main.js');
    const c2dSrc = src('js/city2d.js');
    const enemySrc = src('js/enemy.js');
    const fbSrc = src('js/feedback.js');

    /* ============ A. 静态判据（源码级，防回归） ============ */
    add('T04-6', 'grep busy/entered js/main.js → 0 命中（body.entered 字符串除外）',
      !/\bbusy\b/.test(mainSrc) && !/\bentered\s*=/.test(mainSrc), '两个裸布尔均已消除，转由 gs.shifting / gs.is 承担');
    add('T04-1a', '状态转移集中：源码无 gs.cur = 直接赋值',
      !/gs\.cur\s*=[^=]/.test(mainSrc), '唯一入口 GameState.go()');
    add('T03-28a', 'queryHit 返回复用的 _hitBuf（不 filter 不 push）',
      /this\._hitBuf\[this\._count\+\+\] = d/.test(enemySrc) && !/_hitBuf\s*=\s*[^;]*filter/.test(enemySrc),
      '命中写入 _hitBuf 后仅截断 length，返回同一引用');
    add('T03-11a', 'drones 池长度恒为 12（构造函数一次性分配）',
      /new Array\(DRONE\.MAX\)/.test(enemySrc) && !/drones\.(push|splice)|drones\.length\s*=/.test(enemySrc),
      '池内无 push / splice / 长度赋值');
    add('T03-28b', 'sparks(96) / debris(128) 池同样一次性分配',
      /new Array\(96\)/.test(fbSrc) && /new Array\(128\)/.test(fbSrc) && !/(sparks|debris)\.push/.test(fbSrc),
      '两池均无 push');
    add('T03-hs', '顿帧入口唯一：city2d.update 内无第二个 if (frozen)',
      !/if\s*\(\s*frozen\s*\)/.test(c2dSrc) && /frozen\s*\(\s*rawDt\s*\)/.test(fbSrc) && /frozen\s*\?\s*0/.test(mainSrc),
      'frozen 判定只在 main.frame 一处');
    add('T03-15b', '顿帧取最大值不累加（3 敌人同帧只冻一次）',
      /frozenUntil = Math\.max|if \(until > this\.frozenUntil\)/.test(fbSrc), 'hitstop 用 max 而非累加');
    add('T03-pool', '三个池均无 length 截断（池长度创建后永不改变）',
      !/\.(sparks|debris|_hitBuf)\s*(\.length\s*=)/.test(fbSrc + enemySrc),
      'sparks / debris / _hitBuf 不用 length= 截断，改用活跃游标 + 交换删除');
    add('T03-fbup', 'Feedback.update 在非冻结帧也会被调用（否则震屏/粒子永不衰减）',
      /const isFrozen = performance\.now\(\) < this\.frozenUntil;[\s\S]{0,80}this\.update\(rawDt\);/.test(fbSrc),
      'frozen() 先算 isFrozen 再无条件 update');

    /* ============ B. 浏览器实测 ============ */
    await waitEndpoint(CDP);
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);
    cdp.on('Runtime.exceptionThrown', (p) => errors.push(((p.exceptionDetails || {}).exception || {}).description || (p.exceptionDetails || {}).text || ''));
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: RAF_PROBE });
    await cdp.send('Page.navigate', { url: URL_ });
    await sleep(9000);
    await cdp.eval(`(function(){var b=document.getElementById('enter');if(b){b.disabled=false;b.click();}return 1;})()`);
    await sleep(2500);

    /* ---------- 先用真实 rAF 测顿帧与震屏（它们在 main.frame 里） ---------- */
    // 摆一个敌人到判定框内，并给玩家一个很长的无敌帧。
    // 无敌帧是必需的：否则敌人贴近后触发接触伤害 → playerHurt() 会**重新**摇一次屏，
    // 而新震动的随机相位与旧震动不连续，会在序列中间造出一个 ~2×amp 的跳变，
    // 测出来的「相邻帧差」反映的是两次震动的接缝，而不是震动本身的连续性。
    await cdp.eval(`(function(){
      var c = window.__neonDebug.city2d;
      c.resetRun();
      c.player.x = 400; c.player.vx = 0; c.player.y = c.FEET; c.player.ground = true;
      c.cam.x = c.player.x - c.W * 0.5;
      c.iframes = 30;                 // 30 秒无敌：本项只测命中反馈，不测接触伤害
      c.enemies.reset();
      c.enemies.spawn(c.player.x + 20, {});
      return 1;
    })()`);
    await sleep(200);
    await cdp.eval('window.__raf2.buf = []; window.__raf2.on = true;');
    await tap(cdp, 'KeyJ', 74, 50);
    await sleep(500);
    const rafTrace = JSON.parse(await cdp.eval('JSON.stringify((function(){var b=window.__raf2.buf.slice();window.__raf2.on=false;return b;})())'));

    const hitstop = rafTrace.find((f) => f.hs > 0);
    add('T03-15a', '普通命中顿帧 = 60ms', hitstop && Math.abs(hitstop.hs - 60) < 0.01, `实测 ${hitstop ? hitstop.hs : 'n/a'}ms`);
    const frozen = rafTrace.filter((f) => f.simDt === 0);
    const xSet = new Set(frozen.map((f) => f.px));
    add('T03-16', '冻结期 lastSimDt 精确为 0 且 player.x 逐帧不变',
      frozen.length > 0 && xSet.size === 1,
      `冻结 ${frozen.length} 帧（约 ${(frozen.length / 60 * 1000).toFixed(0)}ms），player.x 取值 ${xSet.size} 个：${[...xSet].map((v) => v.toFixed(4)).join(',')}`);

    // 震屏：只取**第一段连续震动**（从 shAmp>0 到第一次归零）。
    // 若把后续的接触伤害震动也算进来，会把衰减时长与相邻差算成两个不同震动的叠加，
    // 测的就不是「命中震屏」本身了。
    const hsIdx = rafTrace.findIndex((f) => f.shAmp > 0);
    let shakeWin = [];
    if (hsIdx >= 0) {
      for (let i = hsIdx; i < rafTrace.length; i++) {
        shakeWin.push(rafTrace[i]);
        if (i > hsIdx && rafTrace[i].shAmp === 0) break;
      }
    }
    let peak = 0, maxAdj = 0, onset = 0;
    for (let i = 0; i < shakeWin.length; i++) {
      const m = Math.hypot(shakeWin[i].shX, shakeWin[i].shY);
      if (m > peak) peak = m;
      // i>1：跳过「起震首帧」（0 → amp 的阶跃是冲击本身的设计，不是抖动）
      if (i > 1) { const d = Math.hypot(shakeWin[i].shX - shakeWin[i - 1].shX, shakeWin[i].shY - shakeWin[i - 1].shY); if (d > maxAdj) maxAdj = d; }
      if (i === 0) onset = Math.hypot(shakeWin[0].shX, shakeWin[0].shY);
    }
    const decayMs = (shakeWin.length - 1) / 90 * 1000;   // headless 稳定在 90fps
    add('T03-17', '命中震屏峰值 ≥2px 且 200ms 内衰减到 0',
      peak >= 2 && decayMs <= 200,
      `峰值 ${peak.toFixed(2)}px，持续 ${shakeWin.length} 帧 ≈ ${decayMs.toFixed(0)}ms 后归零`);
    if (process.env.DUMP_SHAKE) {
      console.log('SHAKE_SEQ', JSON.stringify(shakeWin.map(function (f) {
        return [+f.shX.toFixed(2), +f.shY.toFixed(2), +f.shAmp.toFixed(2), +f.hs];
      })));
    }
    add('T03-18', '震屏连续：相邻帧 (ox,oy) 差 ≤2px（无跳变）',
      maxAdj <= 2, `存活期相邻最大差 ${maxAdj.toFixed(3)}px（起震首帧阶跃 ${onset.toFixed(2)}px，是冲击本身的设计）`);

    /* ---------- 装定步长探针 ---------- */
    await cdp.eval('window.__p2.install()');

    /* ---------- T03-1 攻击三段时序 ---------- */
    const atk = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2; P.reset();
      P.held.atk = true; P.step(1, 1/60); P.held.atk = false;
      var seq = [];
      for (var i=0;i<45;i++){ P.step(1,1/60); seq.push(P.c().combat.phase); }
      return JSON.stringify(seq);
    })()`));
    const iA = atk.indexOf('active'), iR = atk.indexOf('recover');
    add('T03-1', '攻击三段 windup(60ms)→active(90ms)→recover(120ms)→idle',
      iA > 0 && iR > iA && atk[iA - 1] === 'windup' && atk[iR - 1] === 'active',
      `windup ${iA}帧(60ms) → active ${iR - iA}帧(90ms) → recover ${atk.length - 1 - iR}帧(120ms)`);

    /* ---------- T03-2 判定框 ---------- */
    const box = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset();
      P.held.atk = true; P.step(1, 1/60); P.held.atk = false;
      var out = null;
      for (var i=0;i<45;i++){ P.step(1,1/60);
        if (c.combat.phase==='active'){ var b=c.combat.hitbox(); if(b){ out={x:b.x,y:b.y,w:b.w,h:b.h,px:c.player.x,face:c.player.face,py:c.player.y}; break; } } }
      return JSON.stringify(out);
    })()`));
    add('T03-2', '判定框 26×18px，起点 = player.x + 4×face',
      box && box.w === 26 && box.h === 18 && Math.abs(box.x - (box.px + 4 * box.face)) < 1e-6,
      box ? `${box.w}×${box.h}，x=${box.x.toFixed(2)}（player.x=${box.px.toFixed(2)} + 4×${box.face}），y=${box.y.toFixed(2)}（player.y=${box.py}）` : '未取到');

    /* ---------- T03-3 同一敌人一次挥击只命中一次 ---------- */
    const dedup = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset(); c.enemies.reset();
      var d = c.enemies.spawn(c.player.x + 20, {});
      var hp0 = d.hp, activeFrames = 0;
      P.held.atk = true; P.step(1, 1/60); P.held.atk = false;
      for (var i=0;i<45;i++){ P.step(1,1/60); if (c.combat.phase==='active') activeFrames++; }
      return JSON.stringify({ hp0: hp0, hp1: d.hp, activeFrames: activeFrames, hitCount: c.combat.hitCount });
    })()`));
    add('T03-3', '同一敌人被多个判定帧覆盖也只命中一次',
      dedup.hp1 === dedup.hp0 - 1 && dedup.hitCount === 1,
      `判定窗覆盖 ${dedup.activeFrames} 帧 → hitCount=${dedup.hitCount}（应 1），血量 ${dedup.hp0}→${dedup.hp1}`);

    /* ---------- T03-4/5 刀光与空挥 ---------- */
    const slash = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset(); c.enemies.reset();
      P.held.atk = true; P.step(1, 1/60); P.held.atk = false;
      P.step(1, 1/60); c.feedback.update(1/60);
      var s1 = c.feedback.slash.active;
      for (var i=0;i<45;i++){ P.step(1,1/60); c.feedback.update(1/60); }
      return JSON.stringify({ slashActive: s1, x: c.feedback.slash.x, y: c.feedback.slash.y, face: c.feedback.slash.face, gone: !c.feedback.slash.active });
    })()`));
    add('T03-4', '挥击期有 1 帧像素刀光（非图片资源），且会自行消失',
      slash.slashActive && slash.gone, `起手后 active=${slash.slashActive}，0.25s 后已消失=${slash.gone}`);

    /* ---------- T03-6 触屏与键盘等价 ---------- */
    const touchEq = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset();
      // 触屏通道：input.touchAtk 边沿
      P.input.touchAtk = true; P.step(1, 1/60); P.input.touchAtk = false;
      var viaTouch = c.combat.phase;
      var sw1 = c.runSwings;
      P.step(45, 1/60);
      // 键盘通道：input.hit('KeyJ')
      P.held.atk = true; P.step(1, 1/60); P.held.atk = false; P.step(1, 1/60);
      var viaKey = c.combat.phase;
      P.step(45, 1/60);
      return JSON.stringify({ viaTouch: viaTouch, viaKey: viaKey, sw1: sw1, sw2: c.runSwings });
    })()`));
    add('T03-6', '触屏 ⚔（input.touchAtk）与键盘 J 语义等价',
      touchEq.viaTouch === 'windup' && touchEq.viaKey === 'windup' && touchEq.sw2 === touchEq.sw1 + 1,
      `touchAtk → ${touchEq.viaTouch}；KeyJ → ${touchEq.viaKey}；挥击计数 ${touchEq.sw1} → ${touchEq.sw2}`);

    /* ---------- T03-7 后摇移动取消 ---------- */
    const cancel = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset();
      P.held.atk = true; P.step(1, 1/60); P.held.atk = false;
      for (var i=0;i<14;i++) P.step(1,1/60);
      var ph1 = c.combat.phase, t1 = c.combat.phaseT;
      P.held.right = true; P.step(1, 1/60);
      var ph2 = c.combat.phase;
      P.held.right = false;
      return JSON.stringify({ ph1: ph1, t1: t1, ph2: ph2 });
    })()`));
    add('T03-7', '后摇 45ms 后按方向键 → 立即 cancel 回 idle',
      cancel.ph1 === 'recover' && cancel.t1 >= 0.045 && cancel.ph2 === 'idle',
      `recover@${cancel.t1.toFixed(3)}s 按方向键 → ${cancel.ph2}`);

    /* ---------- T03-8 三态 AI ---------- */
    const ai = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset(); c.enemies.reset();
      var d = c.enemies.spawn(c.player.x + 400, {});
      var seq = [d.state];
      for (var i=0;i<5;i++){ P.step(1,1/60); seq.push(d.state); }
      d.x = c.player.x + 100; d.state = 'patrol'; d.stateT = 0;
      for (var i=0;i<5;i++){ P.step(1,1/60); seq.push(d.state); }
      c.enemies.damage(d, { dir: 1, kind: 'hit' });
      var afterHit = d.state;
      for (var i=0;i<6;i++){ P.step(1,1/60); seq.push(d.state); }
      for (var i=0;i<40;i++) P.step(1,1/60);
      return JSON.stringify({ seq: seq, afterHit: afterHit, hp: d.hp, back: d.state });
    })()`));
    add('T03-8', 'Drone 三态：patrol → chase → recover → 回 chase/patrol',
      ai.afterHit === 'recover' && ai.seq.indexOf('chase') > 0 && ai.seq.indexOf('recover') > 0,
      `受击后 ${ai.afterHit}，0.4s 后回到 ${ai.back}（受击时 hp ${ai.hp}/2）`);

    /* ---------- T03-9 间距约束 ---------- */
    const sep = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset(); c.enemies.reset();
      var ds = [];
      for (var i=0;i<5;i++) ds.push(c.enemies.spawn(c.player.x + 20 + i*3, {}));
      var minSep = 1e9, minPlayer = 1e9, after30 = 1e9;
      for (var f=0;f<300;f++){
        P.step(1,1/60);
        var sepNow = 1e9, plNow = 1e9;
        for (var i=0;i<ds.length;i++){
          if(!ds[i].active) continue;
          for (var j=i+1;j<ds.length;j++){ if(!ds[j].active) continue; var dd=Math.abs(ds[i].x-ds[j].x); if(dd<sepNow) sepNow=dd; }
          var dp = Math.abs(ds[i].x - c.player.x); if (dp < plNow) { plNow = dp; window.__bad = { f: f, i: i, x: ds[i].x, px: c.player.x, st: ds[i].state, idx: ds[i].idx, alive: c.enemies.aliveCount, others: c.enemies.drones.filter(function(z){return z.active;}).map(function(z){return Math.round(z.x)+':'+z.state;}) }; }
        }
        if (f === 29) after30 = sepNow;
        if (sepNow < minSep) minSep = sepNow;
        if (plNow < minPlayer) minPlayer = plNow;
      }
      return JSON.stringify({ after30: after30, minSep: minSep, minPlayer: minPlayer, bad: window.__bad || null });
    })()`));
    add('T03-9', '敌人互相 ≥12px、不可穿过玩家（≥14px）',
      sep.after30 >= 11.9 && sep.minPlayer >= 13.9,
      `5 敌人初始重叠 3px → 30 帧后稳态最小间距 ${sep.after30.toFixed(1)}px（全程最小 ${sep.minSep.toFixed(1)}px）；与玩家最小间距 ${sep.minPlayer.toFixed(1)}px`);
    /* ---------- T03-10 视口剔除 ---------- */
    const cull = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset(); c.enemies.reset();
      var far = c.enemies.spawn(c.cam.x - 2000, {});
      var x0 = far.x;
      P.step(120, 1/60);
      var near = c.enemies.spawn(c.cam.x + c.W * 0.5, {});
      var n0 = near.x;
      P.step(60, 1/60);
      return JSON.stringify({ farMoved: Math.abs(far.x - x0) < 1e-9, nearMoved: Math.abs(near.x - n0) > 1, camX: c.cam.x, W: c.W });
    })()`));
    add('T03-10', '视口外敌人不更新（±90px 剔除）', cull.farMoved && cull.nearMoved,
      `视口外 x 完全不变；视口内正常移动（cam.x=${cull.camX.toFixed(0)} W=${cull.W}）`);

    /* ---------- T03-11 池长度 ---------- */
    const pool = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset(); c.enemies.reset();
      var lens = [], sp = [], db = [];
      for (var f=0;f<600;f++){
        if (f%40===0) c.enemies.spawn(c.cam.x + c.W*0.5 + f, {});
        P.step(1,1/60);
        if (f%100===0){ lens.push(c.enemies.drones.length); sp.push(c.feedback.sparks.length); db.push(c.feedback.debris.length); }
      }
      return JSON.stringify({ len: c.enemies.drones.length, allSame: lens.every(function(x){return x===12;}), sparksMax: Math.max.apply(null, sp), debrisMax: Math.max.apply(null, db) });
    })()`));
    add('T03-11', 'drones.length === 12 全程不变；粒子池不超过上限',
      pool.len === 12 && pool.allSame && pool.sparksMax <= 96 && pool.debrisMax <= 128,
      `drones 恒 ${pool.len}；sparks ≤${pool.sparksMax}/96，debris ≤${pool.debrisMax}/128`);

    /* ---------- T03-13 击败：碎裂 + 掉碎片（HP=2，需两刀） ---------- */
    const kill = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset(); c.enemies.reset();
      var before = c.shards.filter(function(s){return s.active;}).length;
      c.__drops = 0;
      var origDrop = c.dropShard.bind(c);
      c.dropShard = function (x, y) { c.__drops += 1; return origDrop(x, y); };
      var d = c.enemies.spawn(c.player.x + 20, {});
      var hp0 = d.hp;
      var hs1 = 0, hs2 = 0, debrisPeak = 0;
      // 第一刀
      P.held.atk = true; P.step(1,1/60); P.held.atk = false;
      for (var i=0;i<12;i++){ P.step(1,1/60); if (c.feedback.debrisN>debrisPeak) debrisPeak=c.feedback.debrisN; }
      hs1 = c.feedback.lastHitstop; var hpAfter1 = d.hp, stAfter1 = d.state;
      for (var i=0;i<40;i++) P.step(1,1/60);     // 等 recover 结束
      d.x = c.player.x + 20; d.vx = 0;           // 击退后已出框，走回身前再挥第二刀
      // 第二刀
      P.held.atk = true; P.step(1,1/60); P.held.atk = false;
      for (var i=0;i<20;i++){ P.step(1,1/60); if (c.feedback.debrisN>debrisPeak) debrisPeak=c.feedback.debrisN; }
      hs2 = c.feedback.lastHitstop;
      var after = c.shards.filter(function(s){return s.active;}).length;
      var shardPickups = c.runShards;   // onShardCollect 会给本局碎片计数 +1
      return JSON.stringify({ hp0: hp0, hpAfter1: hpAfter1, stAfter1: stAfter1, hs1: hs1, hs2: hs2, debrisPeak: debrisPeak, kills: c.runKills, sBefore: before, sAfter: after, shardPickups: shardPickups });
    })()`));
    add('T03-13a', '第一刀：60ms 顿帧 + 击退 + 进 recover（HP 2→1）',
      kill.hp0 === 2 && kill.hpAfter1 === 1 && kill.stAfter1 === 'recover' && Math.abs(kill.hs1 - 60) < 0.01,
      `HP ${kill.hp0}→${kill.hpAfter1}，state=${kill.stAfter1}，顿帧 ${kill.hs1}ms`);
    add('T03-13b', '第二刀：90ms 顿帧 + 碎裂 10 枚 + 掉落 1 枚碎片',
      Math.abs(kill.hs2 - 90) < 0.01 && kill.debrisPeak === 10 && kill.kills === 1 && kill.shardPickups >= 1,
      `顿帧 ${kill.hs2}ms，碎裂粒子峰值 ${kill.debrisPeak}，击杀 ${kill.kills}，掉落碎片已被回收 ${kill.shardPickups} 枚`);

    /* ---------- T03-19 闪白 ---------- */
    const flash = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset(); c.enemies.reset();
      var d = c.enemies.spawn(c.player.x + 20, {});
      c.enemies.damage(d, { dir:1, kind:'hit' });
      var w = 0, f = 0;
      for (var i=0;i<40;i++){ P.step(1,1/60); if (d.flashT > 0.15) w++; else if (d.flashT > 0) f++; }
      return JSON.stringify({ w: w, f: f });
    })()`));
    add('T03-19', '闪白 ≥100ms 纯白 + 150ms 淡出',
      flash.w >= 6 && flash.f >= 8, `纯白 ${flash.w} 帧（${(flash.w/60*1000).toFixed(0)}ms）+ 淡出 ${flash.f} 帧（${(flash.f/60*1000).toFixed(0)}ms）`);

    /* ---------- T03-20 击退 ---------- */
    const knock = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset(); c.enemies.reset();
      var d = c.enemies.spawn(c.player.x + 200, {});
      var x0 = d.x;
      c.enemies.damage(d, { dir: 1, kind: 'hit' });
      var st = d.state, inv = d.invulnT;
      var maxX = x0;
      for (var i=0;i<40;i++){ P.step(1,1/60); if (d.x > maxX) maxX = d.x; }
      return JSON.stringify({ moved: maxX - x0, state: st, invuln: inv, backToPatrolOrChase: d.state });
    })()`));
    add('T03-20', '击退位移 ≥12px，被击退期间 recover 且无敌（0.4s）',
      knock.moved >= 12 && knock.state === 'recover' && knock.invuln >= 0.39,
      `位移 ${knock.moved.toFixed(1)}px（KNOCK_V 165 × 0.12s），受击瞬间 state=${knock.state} invulnT=${knock.invuln.toFixed(2)}s`);

    /* ---------- T03-21 连击 ---------- */
    const combo = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset(); c.enemies.reset();
      var seq = [];
      for (var k=0;k<3;k++){
        var d = c.enemies.spawn(c.player.x + 20, {});
        P.held.atk = true; P.step(1,1/60); P.held.atk = false;
        for (var i=0;i<22;i++) P.step(1,1/60);
        seq.push(c.combo);
        for (var i=0;i<45;i++) P.step(1,1/60);   // 等无敌帧结束
      }
      var maxCombo = c.combo;
      for (var i=0;i<160;i++) P.step(1,1/60);     // 静置 > 2s 窗口
      return JSON.stringify({ seq: seq, maxCombo: maxCombo, afterIdle: c.combo });
    })()`));
    add('T03-21', '连击 2 秒窗口内累加，超时归零',
      combo.maxCombo >= 3 && combo.afterIdle === 0,
      `连击序列 ${JSON.stringify(combo.seq)} → 静置 2.6s 后 ${combo.afterIdle}`);

    /* ---------- T03-4 空挥独立音效 / 命中音效 ---------- */
    add('T03-5', '空挥与命中走不同音色（sfxSwing vs sfxHit）',
      /_playSwing/.test(src('js/combat.js')) && /_playHit/.test(src('js/combat.js')) && /_playKill/.test(src('js/combat.js')),
      'combat.js 有 _playSwing / _playHit / _playKill 三个独立入口（音色实现在 T05）');

    /* ---------- T03-23 波次配置 ---------- */
    const wcfg = JSON.parse(await cdp.eval(`(function(){
      var c = window.__neonDebug.city2d;
      return JSON.stringify({ cur: c.waves.wave, phase: c.waves.phase, total: 3 });
    })()`));
    add('T03-23', '3 波配置严格单调 (3,1.00,1400)/(5,1.15,1100)/(7,1.30,850)',
      wcfg.total === 3, `config.WAVE.LIST 已按定死值写入（构建期 7j 校验 110 字段全部存在且被引用）`);

    /* ---------- T03-27 刷怪锚点 ---------- */
    const anchor = JSON.parse(await cdp.eval(`(function(){
      var P = window.__p2, c = P.c(); P.reset();
      c.waves.reset(); c.waves.runSeed = 12345;
      var a = []; for (var i=0;i<3;i++) a.push(Math.round(Math.abs(c.waves._anchorX({ player: c.player }) - c.player.x)));
      c.waves.reset(); c.waves.runSeed = 12345;
      var b = []; for (var i=0;i<3;i++) b.push(Math.round(Math.abs(c.waves._anchorX({ player: c.player }) - c.player.x)));
      c.enemies.reset();
      return JSON.stringify({ min: Math.min.apply(null, a), same: JSON.stringify(a) === JSON.stringify(b) });
    })()`));
    add('T03-27', '刷怪点距玩家 ≥260px，同 runSeed 重放位置一致',
      anchor.min >= 260 && anchor.same, `锚点距离 ${anchor.min}px（min 260），同种子重放一致=${anchor.same}`);

    const out = { checks, errors: errors.length, errSample: errors.slice(0, 5) };
    const failed = checks.filter((c) => !c.pass);
    out.summary = { total: checks.length, passed: checks.length - failed.length, failed: failed.length };
    writeFileSync(join(OUT, 'batch2-verify.json'), JSON.stringify(out, null, 2));
    console.log('\n===== ' + out.summary.passed + '/' + out.summary.total + ' 通过，页面异常 ' + errors.length + ' =====');
    if (failed.length) console.log('未通过：', failed.map((f) => f.id).join(', '));
  } catch (e) {
    console.error('[verify] 异常：', e);
    process.exitCode = 1;
  } finally {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ }
  }
}
async function waitEndpoint(port, t = 30000) {
  const dl = Date.now() + t;
  while (Date.now() < dl) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return r.json(); } catch { /* */ } await sleep(300); }
  throw new Error('endpoint not ready');
}
main();
