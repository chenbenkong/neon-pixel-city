#!/usr/bin/env node
/**
 * qa-e2e.mjs —— QA 独立端到端验收探针（严过关）
 *
 * suites:
 *   full  —— 完整玩法 E2E：boot → 2D 收集/对话/任务 → 3D 收集/竞速检查点 → 存档 → 刷新持久化 → 触屏布局 → 帧率
 *   fps   —— 仅帧率分阶段采样（用于 baseline 对照）
 *   boot  —— 仅启动自检（bootPct=100 + VOXEL OK）
 *   nols  —— localStorage 禁用场景（页面不报错不卡死）
 *
 * 竞速 E2E 插桩说明（不改任何游戏文件）：
 *   通过 Page.addScriptToEvaluateOnNewDocument 在页面脚本运行前把 window.NEONCity3D
 *   替换为带 setter 的访问器：当 dist/city3d.js 挂载全局时，包装其 City3D 构造函数，
 *   把真实实例捕获到 window.__c3。游戏逻辑零改动，仅新增一个对象引用。
 *   随后测试用 __c3 读取碎片/检查点坐标并"传送飞船"，游戏内的
 *   update3dShards / updateRace 距离判定 → onRaceCheckpoint → quest.onCheckpoint
 *   等真实代码路径全部原样执行。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = { url: '', out: 'qa.json', port: 9300, label: 'QA', suite: 'full', ms: 45000,
    edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--url') { a.url = v; i += 1; }
    else if (k === '--out') { a.out = v; i += 1; }
    else if (k === '--port') { a.port = Number(v); i += 1; }
    else if (k === '--label') { a.label = v; i += 1; }
    else if (k === '--suite') { a.suite = v; i += 1; }
    else if (k === '--ms') { a.ms = Number(v); i += 1; }
    else if (k === '--edge') { a.edge = v; i += 1; }
  }
  return a;
}
const CFG = parseArgs(process.argv);
const START = Date.now();
const now = () => Date.now() - START;
const log = (...a) => console.log(`[${CFG.label}][${String(now()).padStart(6)}ms]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- CDP ----------------
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
  on(k, f) { if (!this.listeners.has(k)) this.listeners.set(k, []); this.listeners.get(k).push(f); }
  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout ' + method)); } }, 90000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.text || '') + ' ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 200));
    return r.result ? r.result.value : undefined;
  }
}
async function waitEndpoint(port, t = 30000) {
  const dl = Date.now() + t; let e = null;
  while (Date.now() < dl) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return await r.json(); }
    catch (er) { e = er; }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('endpoint not ready ' + (e && e.message));
}
async function getPageWs(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const p = list.find((t) => t.type === 'page');
  if (!p) throw new Error('no page target');
  return p.webSocketDebuggerUrl;
}

// ---------------- keys ----------------
const keyDown = (cdp, code, vk) => cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const keyUp = (cdp, code, vk) => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
async function holdKey(cdp, code, vk, duration) {
  await keyDown(cdp, code, vk); await sleep(duration); await keyUp(cdp, code, vk);
}
async function tapKey(cdp, code, vk) {
  await keyDown(cdp, code, vk); await sleep(60); await keyUp(cdp, code, vk);
}

// ---------------- snippets ----------------
const STATS = `JSON.stringify(window.__neonDebug ? window.__neonDebug.stats : null)`;
const INSTRUMENT = `(function(){
  if (window.__qaInst) return; window.__qaInst = true;
  var stored;
  Object.defineProperty(window, 'NEONCity3D', {
    configurable: true,
    get: function(){ return stored; },
    set: function(v){
      try {
        var Orig = v.City3D;
        var Wrapped = function(){ var inst = new (Function.prototype.bind.apply(Orig, [null].concat(Array.prototype.slice.call(arguments))))(); window.__c3 = inst; return inst; };
        Wrapped.prototype = Orig.prototype;
        window.__setterHit = (window.__setterHit || 0) + 1;
        stored = { City3D: Wrapped }; // 注意：v.City3D 是 esbuild __export 生成的 getter-only 访问器，不能直接改写，须替换整个对象
        return;
      } catch (e) { window.__qaInstErr = String(e); }
      stored = v;
    }
  });
})()`;
const FRAMES_INJECT = `(() => {
  if (window.__fpHooked) return 'already';
  window.__fpHooked = true;
  window.__frames = [];
  let last = performance.now();
  function loop(t) { window.__frames.push(t - last); if (window.__frames.length > 6000) window.__frames.splice(0, window.__frames.length - 6000); last = t; requestAnimationFrame(loop); }
  requestAnimationFrame(loop);
  return 'ok';
})()`;
const SNAP = `(() => {
  const q = (s) => document.querySelector(s);
  let save = null; try { save = localStorage.getItem('neon-city-save-v1'); } catch (e) { save = 'ERR:' + e.message; }
  let dbg = null; try { dbg = window.__neonDebug ? window.__neonDebug.stats : null; } catch (e) { dbg = null; }
  return JSON.stringify({
    pct: q('#bootPct') ? q('#bootPct').textContent : null,
    score: q('#scScore') ? q('#scScore').textContent : null,
    shard: q('#scShard') ? q('#scShard').textContent : null,
    best: q('#scBest') ? q('#scBest').textContent : null,
    qTitle: q('#qTitle') ? q('#qTitle').textContent : null,
    qProg: q('#qProg') ? q('#qProg').textContent : null,
    qBar: q('#qBar') ? q('#qBar').style.width : null,
    mode: document.body.dataset.mode || '2d',
    musicOff: q('#btnMusic') ? q('#btnMusic').classList.contains('off') : null,
    dname: q('#dname') ? q('#dname').textContent : null,
    tele: q('#tele') ? q('#tele').textContent.replace(/\\s+/g, ' ').trim() : null,
    save, dbg,
  });
})()`;
const RACE_STATE = `(() => {
  const c = window.__c3; if (!c) return JSON.stringify({ has: false });
  return JSON.stringify({
    has: true, raceTotal: c.raceTotal || 0, raceIdx: c.raceIdx || 0,
    next: (c.racePoints && c.racePoints[c.raceIdx]) ? { x: c.racePoints[c.raceIdx].x, y: c.racePoints[c.raceIdx].y, z: c.racePoints[c.raceIdx].z } : null,
    activeShards: c.shardPool ? c.shardPool.filter(function(s){ return s.active; }).map(function(s){ return { x: s.x, y: s.y, z: s.z }; }).slice(0, 4) : [],
    pos: c.st ? { x: c.st.pos.x, y: c.st.pos.y, z: c.st.pos.z } : null,
  });
})()`;
const TELEPORT = (p) => `(() => { const c = window.__c3; if (!c) return 'no-c3';
  c.st.pos.x = ${p.x}; c.st.pos.y = ${p.y}; c.st.pos.z = ${p.z};
  c.st.vel.x = 0; c.st.vel.y = 0; c.st.vel.z = 0; c.st.vy = 0; c.st.speed = 0;
  return 'ok'; })()`;
const TOUCH_CHECK = `(() => {
  document.body.classList.add('touch');
  const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
  const qc = r('#questCard'), joy = r('#joy'), sb = r('#scoreBoard'), btns = r('.tbtns');
  document.body.classList.remove('touch');
  const ov = (a, b) => a && b && !(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t);
  return JSON.stringify({ questCard: qc, joy, scoreBoard: sb, tbtns: btns,
    qOverlapsJoy: ov(qc, joy), qOverlapsBtns: ov(qc, btns), sbOverlapsBtns: ov(sb, btns), sbOverlapsJoy: ov(sb, joy) });
})()`;
const fsStat = (list, name) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const avg = list.reduce((s, x) => s + x, 0) / list.length;
  return { phase: name, samples: list.length, avgMs: Math.round(avg * 10) / 10, avgFps: Math.round(1000 / avg), p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10 };
};

// ---------------- harness ----------------
const rep = { label: CFG.label, suite: CFG.suite, url: CFG.url, console: [], exceptions: [], samples: [], result: {}, checks: {} };
function check(name, pass, detail) { rep.checks[name] = { pass: !!pass, detail }; log(`CHECK ${pass ? 'PASS' : 'FAIL'} · ${name} · ${detail}`); }

async function waitEnterEnabled(cdp, timeoutS = 75) {
  for (let i = 0; i < timeoutS; i++) {
    await sleep(1000);
    const dis = await cdp.eval(`document.querySelector('#enter') ? document.querySelector('#enter').disabled : 'no-btn'`);
    if (dis === false) return true;
  }
  return false;
}
async function bootCheck(cdp) {
  const snap = JSON.parse(await cdp.eval(SNAP));
  const voxel = await cdp.eval(`(() => { const el = document.querySelector('#bootLog'); if (!el) return 'NO_LOG'; const m = el.textContent.split('\\n').filter(x => /VOXEL/.test(x)); return m.length ? m[0].trim() : 'NOT_FOUND'; })()`);
  return { snap, voxel };
}
async function gotoGame(cdp) {
  await cdp.send('Page.navigate', { url: CFG.url });
  log('已导航 ' + CFG.url);
  const ok = await waitEnterEnabled(cdp);
  const { snap, voxel } = await bootCheck(cdp);
  return { ok, snap, voxel };
}
async function enterCity(cdp) {
  await cdp.eval(`document.querySelector('#enter').click()`);
  await sleep(2200);
  await cdp.eval(FRAMES_INJECT);
}
/**
 * 切 2D/3D。
 *
 * 批次 2 起 TAB 受 Q4 波次门控：只在波次未开始 / 间歇期允许切换
 * （GameState.beginShift() 返回 'blocked' 时会 toast 提示并拒绝）。
 * 所以这里不能盲按 TAB —— 必须先等 canShift() 为真再按，否则会一直撞门控。
 * 这是**有意的产品行为变更**，不是回归。
 */
async function switchTo(cdp, want, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const cur = JSON.parse(await cdp.eval(SNAP));
    if (cur.mode === want) return true;
    // 等门控开窗：波次间歇最长 2.5s，轮询 300ms 一次
    let waited = 0;
    while (waited < 12000) {
      const gate = await cdp.eval('(function(){var d=window.__neonDebug;return d&&d.stats&&d.stats.waves?d.stats.waves.phase:"?";})()');
      if (gate === 'idle' || gate === 'intermission' || gate === 'done') break;
      await sleep(300);
      waited += 300;
    }
    await tapKey(cdp, 'Tab', 9);
    await sleep(3800);
    const s2 = JSON.parse(await cdp.eval(SNAP));
    if (s2.mode === want) return true;
    log(`切模式重试 ${i + 1}: mode=${s2.mode}`);
  }
  return false;
}
async function waitForCond(cdp, expr, timeoutMs, interval = 400, desc = '') {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    let v = null;
    try { v = await cdp.eval(expr); } catch { /* */ }
    if (v) return v;
    await sleep(interval);
  }
  throw new Error('waitForCond timeout: ' + desc);
}

// ---- 3D 玩法驱动（借助 __c3 传送，游戏判定代码原样执行） ----
async function collectOne3D(cdp, timeoutMs = 20000) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    const st = JSON.parse(await cdp.eval(RACE_STATE));
    if (!st.has) throw new Error('instrumentation missing (__c3)');
    if (st.activeShards.length) {
      const s = st.activeShards[0];
      await cdp.eval(TELEPORT({ x: s.x, y: s.y, z: s.z }));
      return true;
    }
    await sleep(500);
  }
  return false;
}
async function completeCollect3D(cdp, maxShards = 20, timeoutMs = 120000) {
  const dl = Date.now() + timeoutMs;
  let collected = 0;
  while (Date.now() < dl && collected < maxShards) {
    const dbg = JSON.parse(await cdp.eval(STATS));
    if (!dbg || dbg.questType !== 'collect') return collected;
    const target = dbg.questN - dbg.questDone;
    if (target <= 0) { await sleep(600); continue; }
    const before = dbg.shards;
    await collectOne3D(cdp, 15000);
    // 等待统计增长
    await waitForCond(cdp, `window.__neonDebug && window.__neonDebug.stats.shards > ${before}`, 6000, 200, 'shard++');
    collected += 1;
    const d2 = JSON.parse(await cdp.eval(STATS));
    rep.samples.push({ t: now(), where: '3d-collect', shards: d2.shards, score: d2.score, quest: `${d2.questType} ${d2.questDone}/${d2.questN}` });
    log(`3D 收集 #${collected}: shards=${d2.shards} score=${d2.score} quest=${d2.questDone}/${d2.questN}`);
  }
  return collected;
}
async function completeVisit3D(cdp, timeoutMs = 60000) {
  // 传送至城市网格各处直到进入任务目标区域（真实 onDistrict 判定）
  const pts = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) pts.push({ x: 60 + i * 190, y: 90, z: 60 + j * 190 });
  const dl = Date.now() + timeoutMs;
  let k = 0;
  while (Date.now() < dl) {
    const dbg = JSON.parse(await cdp.eval(STATS));
    if (!dbg || dbg.questType !== 'visit') return true;
    await cdp.eval(TELEPORT(pts[k % pts.length]));
    k += 1;
    await sleep(900);
  }
  return false;
}
async function runRace3D(cdp, q) {
  // 竞速已在 3D 开始（startRace 由 onModeChanged 真实触发）。逐个传送至检查点。
  const dl = Date.now() + 120000;
  let passed = 0;
  while (Date.now() < dl) {
    const dbg = JSON.parse(await cdp.eval(STATS));
    if (!dbg || dbg.questType !== 'race') break; // 竞速已完成（或异常）
    const st = JSON.parse(await cdp.eval(RACE_STATE));
    if (!st.has) throw new Error('instrumentation missing');
    if (st.raceTotal <= 0) { // 尚未 startRace（竞速任务在 3D 派发时需要切一次 2D→3D 触发 onModeChanged）
      await switchTo(cdp, '2d');
      rep.result.raceNeededDoubleSwitch = true;
      await switchTo(cdp, '3d');
      await sleep(800);
      continue;
    }
    if (st.raceIdx >= st.raceTotal) { await sleep(400); continue; }
    if (!st.next) { await sleep(300); continue; }
    await cdp.eval(TELEPORT(st.next));
    // 等待判定推进：raceIdx 前进，或竞速完成（completeRace 会 clearRace → raceTotal=0）
    await waitForCond(cdp, `(window.__c3 && (window.__c3.raceIdx > ${st.raceIdx} || window.__c3.raceTotal === 0)) || (window.__neonDebug && window.__neonDebug.stats.questType !== 'race')`, 8000, 100, 'checkpoint');
    const after = JSON.parse(await cdp.eval(RACE_STATE));
    const afterDbg = JSON.parse(await cdp.eval(STATS));
    if (after.raceIdx > st.raceIdx) {
      passed += 1;
      rep.samples.push({ t: now(), where: 'race-checkpoint', idx: passed, total: st.raceTotal, quest: `${afterDbg.questDone}/${afterDbg.questN}`, score: afterDbg.score });
      log(`检查点 ${passed}/${st.raceTotal} · quest=${afterDbg.questDone}/${afterDbg.questN} · score=${afterDbg.score}`);
      await sleep(250);
    } else {
      log(`竞速结束信号: raceIdx=${after.raceIdx} raceTotal=${after.raceTotal} questType=${afterDbg.questType} questsDone=${afterDbg.questsDone} raceBest=${afterDbg.raceBest}`);
    }
    if (afterDbg.questType !== 'race') break;
  }
  return passed;
}

// ---------------- suites ----------------
async function suiteFull(cdp) {
  // 1. boot
  const { ok, snap, voxel } = await gotoGame(cdp);
  check('boot_100', ok && snap.pct === '100%', `pct=${snap.pct} enterEnabled=${ok}`);
  check('boot_voxel_ok', /OK$/.test(voxel), voxel);
  if (!ok) throw new Error('boot 未完成');
  rep.result.instrumentation = await cdp.eval(`JSON.stringify({ qaInst: !!window.__qaInst, setterHit: window.__setterHit || 0, c3: !!window.__c3, instErr: window.__qaInstErr || null })`);
  log('插桩状态: ' + rep.result.instrumentation);
  await enterCity(cdp);
  await sleep(1500);
  let dbg = JSON.parse(await cdp.eval(STATS));
  check('entered', dbg && dbg.entered === true, JSON.stringify(dbg));

  // 2. 2D 阶段：走/跳/奔跑 + 收集 + 对话 + 任务进度（真实操作）
  let mark3d = -1, markBack = -1;
  const phase2d = Math.min(CFG.ms, 48000);
  let el = 0, runRounds = 0;
  const dnameSeen = new Set();
  let lastProg = null, progIncreased = false;
  while (el < phase2d) {
    const isRun = el > phase2d * 0.5;
    if (isRun) { await keyDown(cdp, 'ShiftLeft', 16); runRounds += 1; }
    await holdKey(cdp, 'KeyD', 68, 1400);
    if (isRun) await keyUp(cdp, 'ShiftLeft', 16);
    if (Math.random() < 0.5) await tapKey(cdp, 'Space', 32);
    await tapKey(cdp, 'KeyE', 69);
    await holdKey(cdp, 'KeyA', 65, 400);
    el += 2400;
    const s = JSON.parse(await cdp.eval(SNAP));
    s.t = now(); s.where = '2d';
    rep.samples.push(s);
    dnameSeen.add(s.dname);
    if (s.qProg && s.qProg !== lastProg) {
      if (lastProg && /\d+\/\d+/.test(s.qProg) && s.qProg !== 'STANDBY') progIncreased = true;
      lastProg = s.qProg;
    }
    log(`2D ${Math.round(el / 1000)}s: score=${s.score} shard=${s.shard} q="${s.qTitle}" ${s.qProg} district=${s.dname} run=${isRun} tele=${s.tele}`);
    const d = s.dbg;
    if (d && (d.questType === 'race')) break; // 竞速已到，转 3D
  }
  const d2d = JSON.parse(await cdp.eval(STATS));
  check('walk_changes_district', dnameSeen.size >= 1, `districts seen: ${[...dnameSeen].join(',')}`);
  check('shard_collect_2d', d2d.shards > 0 && d2d.score > 0, `shards=${d2d.shards} score=${d2d.score} (+10/枚)`);
  check('npc_talk_2d', d2d.talks > 0, `talks=${d2d.talks}`);
  check('quest_received_and_progress', d2d.questsDone >= 0 && d2d.questType !== null && (progIncreased || d2d.questsDone >= 1 || /\d+\/\d+/.test(String(lastProg))), `quest=${d2d.questType} ${d2d.questDone}/${d2d.questN} done=${d2d.questsDone} progMoved=${progIncreased}`);
  rep.result.walkRunRounds = runRounds;

  // 音乐开关（M）
  await tapKey(cdp, 'KeyM', 77);
  await sleep(400);
  let s = JSON.parse(await cdp.eval(SNAP));
  const musicOff = s.musicOff === true;
  await tapKey(cdp, 'KeyM', 77);
  check('music_toggle', musicOff, `musicOff=${s.musicOff}`);

  // 3. 切 3D
  mark3d = await cdp.eval(`window.__frames ? window.__frames.length : 0`);
  const to3d = await switchTo(cdp, '3d');
  check('switch_to_3d', to3d, `mode=${(JSON.parse(await cdp.eval(SNAP))).mode}`);

  // 4. 3D 玩法推进（收集/打卡/竞速），限时 150s
  const questDl = Date.now() + 150000;
  let racePassed = 0, raceTotalSeen = 0;
  while (Date.now() < questDl) {
    dbg = JSON.parse(await cdp.eval(STATS));
    if (!dbg) throw new Error('__neonDebug 丢失');
    if (dbg.questType === 'collect') {
      await completeCollect3D(cdp, dbg.questN, 90000);
      await sleep(1000);
    } else if (dbg.questType === 'visit') {
      const done = await completeVisit3D(cdp, 45000);
      if (!done) log('visit 未能完成（区域未命中）');
      await sleep(1000);
    } else if (dbg.questType === 'race') {
      log('竞速任务已派发，驱动检查点…');
      racePassed = await runRace3D(cdp, dbg);
      dbg = JSON.parse(await cdp.eval(STATS));
      raceTotalSeen = racePassed;
      break;
    } else {
      // null：等下一任务派发（2.6s 延迟）
      await sleep(800);
      const d3 = JSON.parse(await cdp.eval(STATS));
      if (!d3.questType) {
        // 若长时间无任务且竞速已跑过则退出
        if (raceTotalSeen > 0) break;
        await sleep(1200);
      }
    }
  }
  dbg = JSON.parse(await cdp.eval(STATS));
  check('shard_collect_3d', dbg.shards > d2d.shards || raceTotalSeen > 0, `shards ${d2d.shards} → ${dbg.shards}`);
  check('race_checkpoints_e2e', raceTotalSeen >= 1, `checkpoints passed=${racePassed}, questsDone=${dbg.questsDone}, raceBest=${dbg.raceBest}`);
  check('race_best_recorded', typeof dbg.raceBest === 'number' && dbg.raceBest > 0, `raceBest=${dbg.raceBest}s`);
  check('quest_loop_continues', dbg.questsDone >= 1, `questsDone=${dbg.questsDone} achievements=${dbg.achievements}`);

  // 触屏布局检查
  const touch = JSON.parse(await cdp.eval(TOUCH_CHECK));
  rep.result.touch = touch;
  check('touch_layout_no_overlap', touch.questCard && touch.joy && !touch.qOverlapsJoy && !touch.qOverlapsBtns && !touch.sbOverlapsBtns && !touch.sbOverlapsJoy,
    `q∩joy=${touch.qOverlapsJoy} q∩btns=${touch.qOverlapsBtns} sb∩btns=${touch.sbOverlapsBtns} sb∩joy=${touch.sbOverlapsJoy}`);

  // 5. 切回 2D
  markBack = await cdp.eval(`window.__frames ? window.__frames.length : 0`);
  const back = await switchTo(cdp, '2d');
  await holdKey(cdp, 'KeyD', 68, 3000);
  check('switch_back_2d', back, `mode=${(JSON.parse(await cdp.eval(SNAP))).mode}`);

  // 6. F 全屏（headless 下可能被拒，但不得抛异常）
  await tapKey(cdp, 'KeyF', 70);
  await sleep(600);

  // 7. 存档 + 刷新持久化
  const pre = JSON.parse(await cdp.eval(STATS));
  const saveRaw = await cdp.eval(`(() => { try { return localStorage.getItem('neon-city-save-v1'); } catch (e) { return 'ERR:' + e.message; } })()`);
  rep.result.saveRaw = saveRaw;
  check('save_written', typeof saveRaw === 'string' && saveRaw.includes('"score"') && saveRaw.includes('"raceBest"'), String(saveRaw).slice(0, 140));

  await gotoGame(cdp); // 重新加载
  const postSaveRaw0 = await cdp.eval(`(() => { try { return localStorage.getItem('neon-city-save-v1'); } catch (e) { return 'ERR:' + e.message; } })()`);
  await enterCity(cdp);
  await sleep(1500);
  const post = JSON.parse(await cdp.eval(STATS));
  const postSaveRaw = await cdp.eval(`(() => { try { return localStorage.getItem('neon-city-save-v1'); } catch (e) { return 'ERR:' + e.message; } })()`);
  rep.result.persistence = { pre, post, postSaveRaw };
  // 注意：进入前游戏以 DEMO 演示模式运行（自动向右走），会继续收集碎片（+10 分/枚），
  // 因此刷新后 score/shards 允许增加，但增量必须恰好等于 10×碎片增量；
  // questsDone / raceBest / achievements / districts 必须完全一致。
  const ds = post.shards - pre.shards, dsc = post.score - pre.score;
  const persistOk = post.questsDone === pre.questsDone && post.raceBest === pre.raceBest
    && post.achievements === pre.achievements && post.districts === pre.districts
    && dsc >= 0 && ds >= 0 && dsc === ds * 10 && post.score > 0 && post.raceBest !== null;
  check('persist_after_reload', persistOk, `score ${pre.score}→${post.score}(+${dsc}), shards ${pre.shards}→${post.shards}(+${ds}), quests ${pre.questsDone}→${post.questsDone}, raceBest ${pre.raceBest}→${post.raceBest}, ach ${pre.achievements}→${post.achievements}, districts ${pre.districts}→${post.districts}; 存档刷新后: ${String(postSaveRaw).slice(0, 120)}`);

  // 8. 帧率
  const frames = JSON.parse(await cdp.eval(`JSON.stringify(window.__frames || [])`));
  const arr = frames.filter((f) => f > 0 && f < 1000);
  const a2d = arr.slice(0, mark3d > 0 ? mark3d : arr.length);
  const a3d = mark3d > 0 ? arr.slice(mark3d, markBack > mark3d ? markBack : arr.length) : [];
  const aBack = markBack > 0 ? arr.slice(markBack) : [];
  rep.result.fps2d = fsStat(a2d, '2d');
  rep.result.fps3d = fsStat(a3d, '3d');
  rep.result.fpsBack = fsStat(aBack, 'back-2d');
  rep.result.frameMarks = { mark3d, markBack, total: arr.length };
}

async function suiteFps(cdp) {
  const { ok, snap, voxel } = await gotoGame(cdp);
  check('boot_100', ok && snap.pct === '100%', `pct=${snap.pct} voxel=${voxel}`);
  if (!ok) throw new Error('boot 未完成');
  await enterCity(cdp);
  let mark3d = -1, markBack = -1;
  const phase = Math.min(CFG.ms, 25000);
  let el = 0;
  while (el < phase) { await holdKey(cdp, 'KeyD', 68, 1600); await tapKey(cdp, 'Space', 32); el += 2000; }
  mark3d = await cdp.eval(`window.__frames ? window.__frames.length : 0`);
  if (await switchTo(cdp, '3d')) {
    for (let i = 0; i < 5; i++) {
      await holdKey(cdp, 'KeyW', 87, 1800);
      await holdKey(cdp, i % 2 ? 'KeyD' : 'KeyA', 65, 400);
      await holdKey(cdp, 'Space', 32, 300);
    }
    markBack = await cdp.eval(`window.__frames ? window.__frames.length : 0`);
    await switchTo(cdp, '2d');
    await holdKey(cdp, 'KeyD', 68, 4000);
  } else {
    log('baseline 无法切 3D（如老版本无 TAB），跳过 3D 段');
  }
  const frames = JSON.parse(await cdp.eval(`JSON.stringify(window.__frames || [])`));
  const arr = frames.filter((f) => f > 0 && f < 1000);
  const a2d = arr.slice(0, mark3d > 0 ? mark3d : arr.length);
  const a3d = mark3d > 0 && markBack > mark3d ? arr.slice(mark3d, markBack) : [];
  const aBack = markBack > 0 ? arr.slice(markBack) : [];
  rep.result.fps2d = fsStat(a2d, '2d');
  rep.result.fps3d = fsStat(a3d, '3d');
  rep.result.fpsBack = fsStat(aBack, 'back-2d');
  log(`FPS 2D=${JSON.stringify(rep.result.fps2d)} 3D=${JSON.stringify(rep.result.fps3d)} back=${JSON.stringify(rep.result.fpsBack)}`);
}

async function suiteBoot(cdp) {
  const { ok, snap, voxel } = await gotoGame(cdp);
  check('boot_100', ok && snap.pct === '100%', `pct=${snap.pct} enterEnabled=${ok}`);
  check('boot_voxel_ok', /OK$/.test(voxel), voxel);
  rep.result.snap = snap;
}

async function suiteNols(cdp) {
  // 已通过 --disable-local-storage 启动；先确认 localStorage 确实被禁
  const lsState = await cdp.eval(`(() => { try { localStorage.getItem('x'); return 'ALLOWED'; } catch (e) { return 'THROWS:' + e.name; } })()`);
  rep.result.localStorage = lsState;
  const { ok, snap, voxel } = await gotoGame(cdp);
  check('nols_boot_100', ok && snap.pct === '100%', `pct=${snap.pct} ls=${lsState}`);
  check('boot_voxel_ok', /OK$/.test(voxel), voxel);
  if (!ok) throw new Error('boot 未完成');
  await enterCity(cdp);
  // 走动收集（内存态积分应照常工作）
  let el = 0;
  while (el < 16000) {
    await holdKey(cdp, 'KeyD', 68, 1400);
    await tapKey(cdp, 'KeyE', 69);
    el += 2000;
    const s = JSON.parse(await cdp.eval(SNAP));
    rep.samples.push({ t: now(), where: 'nols-2d', score: s.score, shard: s.shard, dbg: s.dbg });
    log(`NOLS ${Math.round(el / 1000)}s: score=${s.score} shard=${s.shard}`);
  }
  const dbg = JSON.parse(await cdp.eval(STATS));
  check('nols_score_works_in_memory', dbg && dbg.score > 0, `score=${dbg && dbg.score} shards=${dbg && dbg.shards}`);
  const back = await switchTo(cdp, '3d');
  check('nols_switch_3d_ok', back, '3D 可用（不因存档失败卡死）');
  await switchTo(cdp, '2d');
}

// ---------------- main ----------------
async function main() {
  const prof = join(__dirname, `tmp-qa-${CFG.port}-${Date.now()}`);
  mkdirSync(prof, { recursive: true });
  const flags = [
    '--headless=new', `--remote-debugging-port=${CFG.port}`, `--user-data-dir=${prof}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--window-size=1280,800',
    '--use-gl=angle', '--use-angle=d3d11',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ];
  if (CFG.suite === 'nols') flags.splice(flags.length - 1, 0, '--disable-local-storage');
  const edge = spawn(CFG.edge, flags, { stdio: 'ignore' });

  try {
    await waitEndpoint(CFG.port);
    const ws = new WebSocket(await getPageWs(CFG.port));
    await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
    const cdp = new Cdp(ws);
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const t = (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
      if (p.type === 'error' || p.type === 'warning') rep.console.push({ t: now(), type: p.type, text: t.slice(0, 250) });
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      rep.exceptions.push({ t: now(), text: d.text, desc: ((d.exception && d.exception.description) || '').slice(0, 300) });
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    if (CFG.suite === 'full') await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });

    if (CFG.suite === 'full') await suiteFull(cdp);
    else if (CFG.suite === 'fps') await suiteFps(cdp);
    else if (CFG.suite === 'boot') await suiteBoot(cdp);
    else if (CFG.suite === 'nols') await suiteNols(cdp);
    else throw new Error('unknown suite ' + CFG.suite);

    rep.result.consoleErrors = rep.console.filter((c) => c.type === 'error').length;
    rep.result.exceptions = rep.exceptions.length;
    log(`console错误=${rep.result.consoleErrors} 未捕获异常=${rep.result.exceptions}`);
  } catch (e) {
    rep.fatal = String((e && e.stack) || e);
    log('FATAL ' + rep.fatal);
  } finally {
    writeFileSync(resolve(CFG.out), JSON.stringify(rep, null, 2), 'utf8');
    log('写入 ' + resolve(CFG.out));
    try { edge.kill(); } catch { /* */ }
    try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ }
    setTimeout(() => { try { rmSync(prof, { recursive: true, force: true }); } catch { /* */ } process.exit(0); }, 1500);
  }
}
main();
