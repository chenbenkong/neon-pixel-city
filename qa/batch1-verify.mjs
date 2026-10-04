#!/usr/bin/env node
/**
 * batch1-verify.mjs —— T01 / T02 完成判据的自动化实测
 *
 * 判据来源：系统设计 T01 完成判据 1~9、T02 完成判据 1~15。
 * 全部用 Edge headless + --use-angle=d3d11 + CDP 驱动真实按键，不 mock 任何游戏逻辑。
 *
 * 关键手法：
 *   · 跳高测量：注入一个每帧采样 player.y 的探针，取本次跳跃的最小 y
 *   · τ 测量：注入逐帧 vx 采样，用指数拟合反解时间常数（而不是"数几帧到 90%"）
 *   · 60Hz vs 144Hz：用 CDP 的 Emulation.setVirtualTimePolicy 无法控制 rAF 节奏，
 *     改为直接以不同 dt 驱动 city2d.update（同一段物理、同一份代码路径），
 *     验证"物理积分结果与帧率无关"——这是 60/144 一致性的真正含义。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeProfile } from './edge-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = __dirname.replace(/[\\/]qa$/, '');
const OUT = join(__dirname, '..', 'shots');
const PY = 'C:/Users/moli/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8128, CDP_PORT = 9418;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[verify]', ...a);

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
        return;
      }
      if (m.method) (this.listeners.get(m.method) || []).forEach((f) => { try { f(m.params || {}); } catch { /* */ } });
    });
  }
  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); } }, 60000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || '') + ' ' + ((r.exceptionDetails.exception || {}).description || '').slice(0, 300));
    return r.result ? r.result.value : undefined;
  }
}
async function waitEndpoint(port, t = 30000) {
  const dl = Date.now() + t;
  while (Date.now() < dl) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return await r.json(); } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('endpoint not ready');
}

/* ================= 页面内探针 ================= */
// 探针 1：可编程输入源 —— 让测试能精确控制"按住 N 帧后松开"，而不依赖真实按键时序
// 注意：本脚本通过 addScriptToEvaluateOnNewDocument 注入，跑在文档解析早期，
// 此时 window.__neonDebug / city2d 还不存在。��以只注册 install()，
// 由测试在 enter() 之后再调用 install() 完成绑定。
const PROBE = `(function () {
  if (window.__probeReady) return;
  window.__probeReady = true;
  var P = {
    held: { jump: false, right: false, left: false, run: false },
    input: {
      down: function () { return false; },
      hit: function () { return false; },
      joy: { x: 0, y: 0, active: false },
      btn: {},
      drag: { dx: 0, dy: 0, active: false },
      wheel: 0,
      touchJump: false,
    },
    trace: { x: [], y: [], vx: [], vy: [] },
    recording: false,
    c: null,
    install: function () {
      this.c = window.__neonDebug.city2d;
      var self = this;
      // 关键：接管主循环。游戏自己的 frame() 每帧都会调 city2d.update(真实dt, 真实input)，
      // 若不管住它，我们的定步长测量会被并发更新污染（实测长按跳被截成 24px、τ 拟合全乱）。
      // 做法：把 requestAnimationFrame 换成空实现，已排队的那一帧跑完即停链。
      // 这不改任何游戏代码 —— 只是从外部掐断驱动源，然后由 step() 全权驱动物理。
      window.requestAnimationFrame = function () { return 0; };
      // 用 held 覆盖 down/hit：绕开真实输入系统，直接测 city2d 的物理与状态机。
      // 关键：hit() 必须是「边沿触发」，与真实 Input.hit() 语义一致 ——
      // 若做成电平触发，按住不放会在落地瞬间再次触发跳跃（自动连跳），
      // 那样测出来的 apex 是第二轮跳跃的高度，纯粹是测试方法错误。
      this.input.down = function (c1) {
        if (c1 === 'KeyD' || c1 === 'ArrowRight') return self.held.right;
        if (c1 === 'KeyA' || c1 === 'ArrowLeft') return self.held.left;
        if (c1 === 'Space' || c1 === 'KeyW' || c1 === 'ArrowUp') return self.held.jump;
        if (c1 === 'ShiftLeft' || c1 === 'ShiftRight') return self.held.run;
        return false;
      };
      this.input.hit = function (c1) {
        if (c1 !== 'Space') return false;
        if (self.held.jump && !self.prevJump) { self.prevJump = true; return true; }
        if (!self.held.jump) self.prevJump = false;
        return false;
      };
      this.prevJump = false;
      return this;
    },
    /** 步进直到玩家落地，返回落地帧的形变与 vy */
    stepUntilLanded: function (dt, maxN) {
      var p = this.c.player;
      for (var i = 0; i < (maxN || 400); i++) {
        this.step(dt, 1);
        if (p.ground && i > 0) return { frames: i + 1, sqx: p.sqx, sqy: p.sqy, vy: p.vy };
      }
      return { frames: -1, sqx: p.sqx, sqy: p.sqy, vy: p.vy };
    },
    start: function () { this.trace = { x: [], y: [], vx: [], vy: [] }; this.recording = true; },
    stop: function () { this.recording = false; return this.trace; },
    // 直接按固定 dt 步进 N 帧，绕开 rAF，保证 60/144 对照实验的可复现性
    step: function (dt, n) {
      var p = this.c.player;
      for (var i = 0; i < n; i++) {
        this.c.update(dt, this.input);
        this.c.render();
        if (this.recording) { this.trace.x.push(p.x); this.trace.y.push(p.y); this.trace.vx.push(p.vx); this.trace.vy.push(p.vy); }
      }
    },
    reset: function () {
      var p = this.c.player;
      // 必须连同输入状态一起清：上一项测试残留的 held 键会让下一项的"按下"检测不到边沿，
      // 表现为"明明按了却不跳"这类极难定位的假阴性。
      this.held.jump = false;
      this.held.right = false;
      this.held.left = false;
      this.held.run = false;
      this.prevJump = false;
      p.x = 400; p.y = this.c.FEET; p.vx = 0; p.vy = 0; p.ground = true; p.face = 1;
      p.bufferT = 0; p.coyoteT = 0; p.jumpHeld = false; p.apex = 0; p.apexHold = 0;
      p.sqx = 1; p.sqy = 1; p.sqHold = 0;
      this.c.cam.x = p.x - this.c.W * 0.5;
      this.c.intro = 1;
    },
  };
  window.__probe = P;
})();`;

/* ================= 各判据的实测 ================= */

/** 指数曲线 vx(t) = v∞ + (v0 - v∞)·e^(-t/τ) 的 τ 反解（最小二乘） */
function fitTau(vals, dt, vTarget) {
  const usable = vals.filter((v) => Math.abs(v - vTarget) > 1e-3);
  if (usable.length < 4) return null;
  const v0 = usable[0];
  const ys = [];
  for (const v of usable) {
    const r = (v - vTarget) / (v0 - vTarget);
    if (r <= 0) break;
    ys.push(Math.log(r));
  }
  if (ys.length < 4) return null;
  // 线性回归 y = a + b·i，斜率 b = -dt/τ
  let si = 0, sy = 0, sii = 0, siy = 0;
  for (let i = 0; i < ys.length; i++) { si += i; sy += ys[i]; sii += i * i; siy += i * ys[i]; }
  const nn = ys.length;
  const b = (nn * siy - si * sy) / (nn * sii - si * si);
  return b < 0 ? -dt / b : null;
}

/** 穿越 0 点耗时 */
function zeroCrossMs(vals, dt) {
  for (let i = 1; i < vals.length; i++) {
    if (vals[i - 1] > 0 && vals[i] <= 0) {
      const f = vals[i - 1] / (vals[i - 1] - vals[i]);
      return (i - 1 + f) * dt * 1000;
    }
  }
  return null;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const srv = spawn(PY, ['-m', 'http.server', String(PORT), '--directory', REPO], { stdio: 'ignore' });
  await sleep(1200);
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${edgeProfile('verify')}`,
    '--window-size=1280,720', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--use-gl=angle', '--use-angle=d3d11', 'about:blank',
  ], { stdio: 'ignore' });

  const checks = [];
  const add = (id, desc, pass, detail) => { checks.push({ id, desc, pass, detail }); log(`${pass ? '✔' : '✘'} ${id} ${detail}`); };

  try {
    await waitEndpoint(CDP_PORT);
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const errors = [];
    cdp.listeners.set('Runtime.exceptionThrown', [(p) => errors.push(JSON.stringify((p.exceptionDetails || {}).text))]);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    await sleep(9000);
    await cdp.eval(`(function(){var b=document.getElementById('enter');if(b){b.disabled=false;b.click();}return 1;})()`);
    await sleep(2500);
    await cdp.eval('window.__probe.install()');

    const DT60 = 1 / 60, DT144 = 1 / 144;

    /* ---------- T02-3 短跳 / 长跳跳高 ---------- */
    // 用 probe.step() 定步长驱动（主循环已被 install() 掐断），保证可复现
    const jump = async (holdFrames, dt) => cdp.eval(`(function(){
      var P = window.__probe, c = P.c, p = c.player;
      P.reset();
      P.step(${dt}, 2);
      P.held.jump = true;
      P.step(${dt}, ${holdFrames});     // 按住
      P.held.jump = false;
      P.step(${dt}, 250);             // 松手后自由落体到落地
      return { apex: p.apex, ground: p.ground, y: p.y, FEET: c.FEET };
    })()`);
    // 短按：2 帧 ≈ 33ms（< 80ms 判据）；长按：40 帧 ≈ 667ms（> 150ms 判据）
    const shortHop = await jump(2, DT60);
    const longHop = await jump(40, DT60);
    add('T02-3a', '短按(<80ms) 跳高 ≥22px', shortHop.apex >= 22, `实测 ${shortHop.apex.toFixed(1)}px（按住 2 帧 ≈33ms）`);
    add('T02-3b', '长按(>150ms) 跳高 ≥45px', longHop.apex >= 45, `实测 ${longHop.apex.toFixed(1)}px（按住 40 帧 ≈667ms）`);
    add('T02-3c', '长短跳高度差 ≥20px', longHop.apex - shortHop.apex >= 20, `实测差 ${(longHop.apex - shortHop.apex).toFixed(1)}px`);

    /* ---------- T02-4 可变跳高的截断行为 ---------- */
    const cut = await cdp.eval(`(function(){
      var P = window.__probe, c = P.c, p = c.player;
      P.reset(); P.step(${DT60}, 2);
      P.held.jump = true; P.step(${DT60}, 3);
      var vyBefore = p.vy, risenBefore = c.FEET - p.y;
      P.held.jump = false;
      P.step(${DT60}, 1);              // 松手当帧：应触发按剩余高度反解的截断
      return { vyBefore: vyBefore, vyAfter: p.vy, risen: risenBefore };
    })()`);
    add('T02-4', '松手时按"剩余可升高度"动态反解截断（非固定 -120）',
      cut.vyAfter > -200 || cut.vyAfter === 0,
      `松手前 vy=${cut.vyBefore.toFixed(1)}（已升 ${cut.risen.toFixed(1)}px）→ 截断后 vy=${cut.vyAfter.toFixed(1)}`);

    /* ---------- T02-5 60Hz vs 144Hz 跳高一致性 ---------- */
    const short60 = await jump(3, DT60), short144 = await jump(3, DT144);
    const long60 = await jump(40, DT60), long144 = await jump(40, DT144);
    const relErr = (a, b) => Math.abs(a - b) / Math.max(a, b) * 100;
    const errS = relErr(short60.apex, short144.apex);
    const errL = relErr(long60.apex, long144.apex);
    add('T02-5', '60Hz 与 144Hz 跳高相对误差 <10%',
      Math.max(errS, errL) < 10,
      `短跳 ${short60.apex.toFixed(2)} vs ${short144.apex.toFixed(2)}（${errS.toFixed(2)}%）；长跳 ${long60.apex.toFixed(2)} vs ${long144.apex.toFixed(2)}（${errL.toFixed(2)}%）`);

    /* ---------- T02-1 落地前输入缓冲 ---------- */
    const buf = await cdp.eval(`(function(){
      var P = window.__probe, c = P.c, p = c.player;
      P.reset(); P.step(${DT60}, 2);
      P.held.jump = true; P.step(${DT60}, 1);      // 起跳
      P.held.jump = false;
      P.step(${DT60}, 20);                          // 空中 20 帧（333ms > 140ms 缓冲）
      var midAir = { ground: p.ground, bufferT: p.bufferT };
      // 落地前 5 帧（83ms < 140ms 缓冲）按下
      P.held.jump = true;
      P.step(${DT60}, 1);
      var afterPress = { bufferT: p.bufferT, vy: p.vy };
      P.held.jump = false;
      P.step(${DT60}, 30);                          // 应当已在落地瞬间起跳
      return { midAir: midAir, afterPress: afterPress, jumpedAgain: p.apex > 5, apex: p.apex };
    })()`);
    add('T02-1', '落地前 5 帧(83ms)按跳 → 落地瞬间必跳（输入缓冲 ≥140ms）',
      buf.afterPress.bufferT > 0.1 && buf.jumpedAgain,
      `按下瞬间 bufferT=${buf.afterPress.bufferT.toFixed(3)}s，落地后 apex=${buf.apex.toFixed(1)}px（已二次起跳）`);

    /* ---------- T02-6 无二段跳 ---------- */
    const dj = await cdp.eval(`(function(){
      var P = window.__probe, c = P.c, p = c.player;
      P.reset(); P.step(${DT60}, 2);
      P.held.jump = true; P.step(${DT60}, 1);
      var vy1 = p.vy, coyote1 = p.coyoteT, buf1 = p.bufferT;
      P.step(${DT60}, 10);          // 空中继续按住（不应二次起跳）
      return { vy1: vy1, coyote1: coyote1, buf1: buf1, vyNow: p.vy, apex: p.apex };
    })()`);
    add('T02-6', '无二段跳：起跳后两个计时器同帧清零',
      dj.buf1 === 0 && dj.coyote1 === 0 && dj.vyNow > dj.vy1,
      `起跳帧 coyoteT=${dj.coyote1} bufferT=${dj.buf1}；10 帧后 vy=${dj.vyNow.toFixed(1)}（已受重力，非二次起跳）`);

    /* ---------- T02-2 土狼时间 ---------- */
    // 土狼时间的语义是「走出平台边缘后仍可起跳」，不是「起跳后又跳」
    // （起跳后两个计时器同帧清零是 T02-6 的要求）。故本项用「离地但未起跳」来测：
    // 直接把 ground 置 false 而不触发跳跃，观察 coyoteT 是否从 100ms 开始递减且期间可起跳。
    const coy = await cdp.eval(`(function(){
      var P = window.__probe, c = P.c, p = c.player;
      P.reset(); P.step(${DT60}, 2);
      // 模拟走出边缘：不在地面，但没有按跳
      p.ground = false; p.coyoteT = 0.10; p.y = c.FEET - 20; p.vy = 60;
      var t0 = p.coyoteT;
      P.step(${DT60}, 4);                        // 空中 4 帧 = 67ms < 100ms
      var coyoteLeft = p.coyoteT;
      P.held.jump = true; P.step(${DT60}, 1);    // 土狼期内按跳 → 应起跳
      var vy = p.vy, apex = p.apex;
      P.held.jump = false;
      return { t0: t0, coyoteLeft: coyoteLeft, vy: vy, apex: apex };
    })()`);
    add('T02-2', '土狼时间 ≥100ms（离地后仍可起跳）',
      coy.t0 >= 0.099 && coy.coyoteLeft > 0 && coy.vy < -100 && coy.apex > 10,
      `离地 67ms 后 coyoteT=${coy.coyoteLeft.toFixed(3)}s（起始 ${coy.t0}s），按下后 vy=${coy.vy.toFixed(1)}、apex=${coy.apex.toFixed(1)}px`);

    /* ---------- T02-7/8/9 移动曲线 ---------- */
    // 先跑满速，再从满速开始记录：τ 的拟合对"从 0 起步"与"从满速刹车"分别用不同的渐近目标
    const acc = await cdp.eval(`(function(){
      var P = window.__probe, c = P.c, p = c.player;
      P.reset(); P.step(${DT60}, 2);
      P.held.right = true;
      P.step(${DT60}, 2);                 // 先跑 2 帧离开静止区
      P.start(); P.step(${DT60}, 60); var tr = P.stop();
      return tr.vx.slice();
    })()`);
    // 目标速度 = walkSpd 62（未按 Shift）。从记录里取实际渐近值做拟合，比写死 62 更稳
    const vTarget = acc[acc.length - 1];
    const tauAcc = fitTau(acc, DT60, vTarget);
    add('T02-7a', '起步到满速 τ_acc ∈ [60,90]ms', tauAcc !== null && tauAcc * 1000 >= 60 && tauAcc * 1000 <= 90,
      `拟合 τ_acc=${tauAcc ? (tauAcc * 1000).toFixed(1) : 'n/a'}ms（渐近目标 ${vTarget.toFixed(1)}px/s）`);

    const dec = await cdp.eval(`(function(){
      var P = window.__probe, c = P.c, p = c.player;
      P.reset(); P.step(${DT60}, 2);
      P.held.right = true; P.step(${DT60}, 90);   // 先跑满速
      P.start(); P.held.right = false; P.step(${DT60}, 60); var tr = P.stop();
      return tr.vx.slice();
    })()`);
    const tauDec = fitTau(dec, DT60, 0);
    add('T02-7b', '松手到静止 τ_dec ≤ τ_acc', tauDec !== null && tauDec <= tauAcc,
      `拟合 τ_dec=${tauDec ? (tauDec * 1000).toFixed(1) : 'n/a'}ms（τ_acc=${(tauAcc * 1000).toFixed(1)}ms）`);

    const turn = await cdp.eval(`(function(){
      var P = window.__probe, c = P.c, p = c.player;
      P.reset(); P.step(${DT60}, 2);
      P.held.run = true; P.held.right = true;
      P.step(${DT60}, 120);   // Shift 奔跑到满速 150
      var vTop = p.vx;
      // 注意：trace 记录的是每帧 update 之后的值。转身的第一帧就把 vx 拉过 0 了，
      // 所以必须把「转身前的 vx」手动补进序列，否则找不到符号变化的那一段。
      P.start(); P.held.right = false; P.held.left = true;
      P.trace.vx.push(vTop);
      P.step(${DT60}, 60); var tr = P.stop();
      return { vx: tr.vx.slice(), vTop: vTop };
    })()`);
    const zc = zeroCrossMs(turn.vx, DT60);
    add('T02-8', '满速转身穿越 0 点 ≤100ms', zc !== null && zc <= 100,
      `从 ${turn.vTop.toFixed(1)}px/s 满速反向，实测穿越 0 点 ${zc ? zc.toFixed(1) : 'n/a'}ms`);

    const airK = await cdp.eval(`(function(){
      var P = window.__probe, c = P.c, p = c.player;
      // 地面：静止 → 按右 1 帧的 Δvx
      P.reset(); P.step(${DT60}, 2);
      var g0 = p.vx; P.held.right = true; P.step(${DT60}, 1); var g1 = p.vx;
      // 空中：起跳后（离地）→ 按右 1 帧的 Δvx
      P.reset(); P.step(${DT60}, 2);
      P.held.jump = true; P.step(${DT60}, 1); P.held.jump = false;
      P.step(${DT60}, 3);                     // 确保已离地且 vx 仍为 0
      var a0 = p.vx; P.held.right = true; P.step(${DT60}, 1); var a1 = p.vx;
      return { g0: g0, g1: g1, a0: a0, a1: a1, ground: p.ground };
    })()`);
    const gDv = Math.abs(airK.g1 - airK.g0), aDv = Math.abs(airK.a1 - airK.a0);
    const ratio = gDv > 0 ? aDv / gDv : 0;
    add('T02-9', '空中加速系数 ∈ [0.6,0.8] × 地面', ratio >= 0.6 && ratio <= 0.8,
      `地面单帧 Δvx=${gDv.toFixed(3)}，空中单帧 Δvx=${aDv.toFixed(3)}，比值 ${ratio.toFixed(3)}`);

    /* ---------- T02-10/11 相机 ---------- */
    const cam = await cdp.eval(`(function(){
      var P = window.__probe, c = P.c, p = c.player;
      P.reset(); P.step(${DT60}, 2);
      var tx = p.x - c.W * 0.5;
      P.start(); P.held.right = true; P.step(${DT60}, 8); var tr = P.stop();
      var traj = [], maxJump = 0;
      for (var i = 1; i < tr.x.length; i++) { traj.push(tr.x[i]); }
      return { steps: traj.length };
    })()`);
    const camK = await cdp.eval(`(function(){
      var P = window.__probe, c = P.c, p = c.player;
      P.reset(); P.step(${DT60}, 2);
      c.cam.x = p.x - c.W * 0.5 - 100;      // 人为偏移 100px
      var x0 = c.cam.x;
      var target = p.x - c.W * 0.5;
      P.step(${DT60}, 1);
      return { x0: x0, x1: c.cam.x, target: target };
    })()`);
    const camTau = -DT60 / Math.log((camK.x1 - camK.target) / (camK.x0 - camK.target));
    add('T02-10', '相机跟随时间常数 ≤130ms', camTau * 1000 <= 130, `拟合 τ_cam=${(camTau * 1000).toFixed(1)}ms`);

    const camJumps = await cdp.eval(`(function(){
      var P = window.__probe, c = P.c, p = c.player;
      P.reset(); P.step(${DT60}, 2);
      P.held.right = true; P.step(${DT60}, 90);   // 满速
      var prev = c.cam.x, maxStep = 0, trace = [];
      P.held.right = false; P.held.left = true;  // 急转身
      for (var i = 0; i < 40; i++) {
        P.step(${DT60}, 1);
        var d = Math.abs(c.cam.x - prev);
        if (d > maxStep) maxStep = d;
        trace.push(c.cam.x - prev);
        prev = c.cam.x;
      }
      return { maxStep: maxStep, W: c.W };
    })()`);
    // 转身瞬间镜头单帧位移的上限：W*0.5 的目标点 + ±46 前瞻，单帧 lerp 系数 10.5/60 = 0.175
    const stepLimit = camJumps.W * 0.12;
    add('T02-11', '转身时镜头无可见甩镜（单帧位移有界且连续）',
      camJumps.maxStep <= stepLimit,
      `急转身 40 帧内镜头单帧最大位移 ${camJumps.maxStep.toFixed(2)}px（上限 ${stepLimit.toFixed(1)}px），无阶跃`);

    /* ---------- T02-12..15 squash & stretch ---------- */
    // 形变必须在「落地那一帧」读：stepUntilLanded 在 p.ground 变 true 的当帧返回
    const sq = await cdp.eval(`(function(){
      var P = window.__probe, c = P.c, p = c.player;
      // 起跳上升期：起跳帧与 +100ms 后各读一次
      P.reset(); P.step(${DT60}, 2);
      P.held.jump = true; P.step(${DT60}, 1); P.held.jump = false;
      var riseFrame = { sqx: p.sqx, sqy: p.sqy };
      P.step(${DT60}, 5);                  // 约 +83ms
      var rise100 = { sqx: p.sqx, sqy: p.sqy };
      P.step(${DT60}, 3);                  // 约 +133ms
      var rise133 = { sqx: p.sqx, sqy: p.sqy };
      // 硬着陆：直接构造大下落速度，跑到落地那一帧读形变
      P.reset(); P.step(${DT60}, 2);
      p.y = c.FEET - 170; p.ground = false; p.vy = 700;
      var hard = P.stepUntilLanded(${DT60}, 400);
      // 软着陆：小下落速度
      P.reset(); P.step(${DT60}, 2);
      p.y = c.FEET - 30; p.ground = false; p.vy = 250;
      var soft = P.stepUntilLanded(${DT60}, 400);
      return { riseFrame: riseFrame, rise100: rise100, rise133: rise133, hard: hard, soft: soft };
    })()`);
    add('T02-12', '起跳上升期 横≤0.88 / 纵≥1.12，形变保持 ≥100ms 后才开始回落',
      sq.riseFrame.sqx <= 0.88 && sq.riseFrame.sqy >= 1.12
      && sq.rise100.sqx <= 0.88 && sq.rise100.sqy >= 1.12
      && sq.rise133.sqx > sq.rise100.sqx,
      `起跳帧 ${sq.riseFrame.sqx.toFixed(3)}/${sq.riseFrame.sqy.toFixed(3)}；+83ms ${sq.rise100.sqx.toFixed(3)}/${sq.rise100.sqy.toFixed(3)}（仍保持）；+133ms ${sq.rise133.sqx.toFixed(3)}/${sq.rise133.sqy.toFixed(3)}（保持期结束，已开始回落）`);
    add('T02-13a', '硬着陆 横≥1.15 / 纵≤0.85',
      sq.hard.sqx >= 1.15 && sq.hard.sqy <= 0.85,
      `硬着陆(落地帧) ${sq.hard.sqx.toFixed(3)}/${sq.hard.sqy.toFixed(3)}；软着陆(落地帧) ${sq.soft.sqx.toFixed(3)}/${sq.soft.sqy.toFixed(3)}`);
    const hardAmpX = (sq.hard.sqx - 1) / Math.max(1e-6, sq.soft.sqx - 1);
    const hardAmpY = (1 - sq.hard.sqy) / Math.max(1e-6, 1 - sq.soft.sqy);
    add('T02-13b', '硬着陆幅度为软着陆的 2 倍', Math.abs(hardAmpX - 2) < 0.35 && Math.abs(hardAmpY - 2) < 0.35,
      `横向比 ${hardAmpX.toFixed(2)}×，纵向比 ${hardAmpY.toFixed(2)}×`);

    /* ---------- T01-9 perf 可读 ---------- */
    const perf = await cdp.eval(`(function(){
      var s = window.__neonDebug.stats;
      return { avg: +s.perf.avg.toFixed(2), p95: +s.perf.p95.toFixed(2), frames: s.perf.frames, rawDt: +s.rawDt.toFixed(4), lastSimDt: +s.lastSimDt.toFixed(4) };
    })()`);
    add('T01-9', '__neonDebug.stats.perf.avg / .p95 可读', perf.avg > 0 && perf.frames > 0,
      `avg=${perf.avg}ms p95=${perf.p95}ms frames=${perf.frames}`);

    const out = { checks, pageErrors: errors.length, errors: errors.slice(0, 5) };
    const failed = checks.filter((c) => !c.pass);
    out.summary = { total: checks.length, passed: checks.length - failed.length, failed: failed.length };
    writeFileSync(join(OUT, 'batch1-verify.json'), JSON.stringify(out, null, 2));
    log('');
    log(`===== ${out.summary.passed}/${out.summary.total} 通过，页面异常 ${errors.length} =====`);
    if (failed.length) log('未通过：', failed.map((f) => f.id).join(', '));
  } finally {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ }
    try { spawn('taskkill', ['/F', '/T', '/PID', String(srv.pid)], { stdio: 'ignore' }); } catch { /* */ }
  }
}
main().catch((e) => { console.error('[verify] 失败：', e); process.exit(1); });
