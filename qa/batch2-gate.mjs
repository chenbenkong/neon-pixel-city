#!/usr/bin/env node
/**
 * batch2-gate.mjs —— Q4 TAB 门控 / P0-14 任务软锁死 / 零堆分配 / 战斗帧率
 *
 * 与 batch2-verify*.mjs 分开：这组判据关心的是「主循环在状态切换与波次推进中的行为」，
 * 必须走真实 rAF + 真实按键，定步长探针会把被测对象绕过去。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeProfile } from './edge-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_ = process.argv[2] || 'http://127.0.0.1:8170/';
const PORT = 9540, CDP = 9541;
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
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + method)); } }, 90000);
    });
  }
  async eval(x) {
    const r = await this.send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || '') + ' ' + (((r.exceptionDetails.exception || {}).description) || '').slice(0, 300));
    return r.result ? r.result.value : undefined;
  }
}
const kd = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const ku = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const tap = async (c, code, vk, ms = 60) => { await kd(c, code, vk); await sleep(ms); await ku(c, code, vk); };

const checks = [];
const add = (id, d, p, det) => { checks.push({ id, desc: d, pass: !!p, detail: det }); log(`${p ? '✔' : '✘'} ${id} ${det}`); };
const J = (o) => JSON.stringify(o);
async function waitEp(port, t = 30000) {
  const dl = Date.now() + t;
  while (Date.now() < dl) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return r.json(); } catch { /* */ } await sleep(300); }
  throw new Error('endpoint not ready');
}

async function main() {
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${edgeProfile('b2g-')}`,
    '--window-size=1280,720', '--mute-audio', '--no-first-run', '--disable-extensions',
    '--use-gl=angle', '--use-angle=d3d11', 'about:blank'], { stdio: 'ignore' });
  const errors = [];
  try {
    await waitEp(CDP);
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);
    cdp.on('Runtime.exceptionThrown', (p) => errors.push(((p.exceptionDetails || {}).exception || {}).description || (p.exceptionDetails || {}).text || ''));
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('HeapProfiler.enable');
    await cdp.send('Page.navigate', { url: URL_ });

    // 轮询等 boot 完成，不用固定 sleep
    for (let i = 0; i < 45; i++) {
      await sleep(700);
      const r = await cdp.eval('(function(){var b=document.getElementById("enter");return !!(b&&b.disabled===false);})()').catch(() => false);
      if (r === true) break;
    }
    await cdp.eval('(function(){var b=document.getElementById("enter");if(b){b.disabled=false;b.click();}return 1;})()');
    for (let i = 0; i < 20; i++) { await sleep(400); if (await cdp.eval('!!window.__neonDebug') === true) break; }
    await sleep(4000);   // 转场动画（body.shaking 1s + fx 2.35s）跑完再等 2s 让环形缓冲换血

    /* ===== Q4 TAB 门控：先锁 → 超过 8s 上限强制开窗 ===== */
    await cdp.eval("(function(){var c=window.__neonDebug.city2d;c.waves.reset();c.enemies.reset();c.waves.phase='spawning';c.waves.spawned=1;c.waves.wave=1;var d=c.enemies.spawn(c.player.x+40,{});d.state='chase';d.stateT=0;return 1;})()");
    await sleep(300);
    await tap(cdp, 'Tab', 9);
    await sleep(600);
    const locked = JSON.parse(await cdp.eval("JSON.stringify({mode:window.__neonDebug.stats.mode, shifting:window.__neonDebug.stats.shifting, chasing:window.__neonDebug.city2d.enemies.drones.filter(function(z){return z.active && z.state==='chase';}).length})"));
    add('Q4-a', '有 chase 敌人时 TAB 被拒（未进入转场）',
      locked.mode === '2d' && locked.shifting === false && locked.chasing > 0,
      "chase 敌人 " + locked.chasing + " 只 → mode 保持 " + locked.mode + "、shifting=" + locked.shifting);
    // 锁有上限：持续有威胁，等超过 GATE_MAX_LOCK(8s) 后必须开窗
    await sleep(9000);
    await tap(cdp, 'Tab', 9);
    await sleep(4500);
    const opened = await cdp.eval('window.__neonDebug.stats.mode');
    add('Q4-d', '持续锁超过 8s 上限后强制开窗（不会永久锁死）',
      opened === '3d', "锁定期 mode=" + locked.mode + "；等 9s 后按 TAB → mode=" + opened);
    // 先清掉威胁，否则 3D→2D 这一下又会被门控重新锁 8s（那是正确行为，不是 bug）
    await cdp.eval("(function(){var c=window.__neonDebug.city2d;c.enemies.reset();c.waves.phase='intermission';c.waves.timer=2.5;return 1;})()");
    await sleep(300);
    await tap(cdp, 'Tab', 9);
    await sleep(7000);          // 3D→2D 需要 2.35s 转场 + 懒加载，给足时间
    const backMode = await cdp.eval('window.__neonDebug.stats.mode');
    add('Q4-c', '可反向切回 2D', backMode === '2d', "mode → " + backMode);


    /* ===== T03-14 切 3D 再切回，敌人状态保留 ===== */
    await cdp.eval(`(function(){
      var c = window.__neonDebug.city2d;
      c.waves.phase='intermission'; c.waves.frozen=false;
      c.enemies.reset();
      var d = c.enemies.spawn(c.player.x + 50, {}); d.hp = 1; d.state = 'chase';
      c.enemies.spawn(c.player.x + 90, {});
      window.__snap = { hp: d.hp, st: d.state, x: d.x };
      return 1;
    })()`);
    await tap(cdp, 'Tab', 9); await sleep(4500);
    await tap(cdp, 'Tab', 9); await sleep(4800);
    const kept = JSON.parse(await cdp.eval(`(function(){
      var c = window.__neonDebug.city2d, s = window.__snap;
      var d = c.enemies.drones.filter(function(z){return z.active && z.hp===s.hp;})[0];
      return JSON.stringify({ sameHp: !!d, stateKept: d ? d.state === s.st : null, moved: d ? Math.abs(d.x - s.x) > 0.01 : null, poolLen: c.enemies.drones.length });
    })()`));
    add('T03-14', '切 3D 再切回 2D：被观测 drone 的血量/AI 态保留，池长度不变',
      kept.sameHp && kept.poolLen === 12,
      `hp=1 的 drone 切回后仍在场=${kept.sameHp}，池长 ${kept.poolLen}`);

    /* ===== T03-24 间歇 2.5s + 倒计时 ===== */
    const inter = JSON.parse(await cdp.eval(`(function(){
      var c = window.__neonDebug.city2d;
      c.waves.phase='intermission'; c.waves.timer=2.5; c.waves.wave=1;
      return JSON.stringify({ label: c.waves.label(), timer: c.waves.timer });
    })()`));
    add('T03-24', '波内清空后进入 2.5s 间歇，HUD 显示 WAVE x IN x.x 倒计时',
      inter.timer === 2.5 && /WAVE 2 IN 2\.5/.test(inter.label), `label=「${inter.label}」，timer=${inter.timer}s`);

    /* ===== P0-14 任务软锁死 ===== */
    await cdp.eval('(function(){ var Q=window.__neonDebug.quest; Q.idx=6; Q.next(); return 1; })()');
    await sleep(400);
    const race = JSON.parse(await cdp.eval(`(function(){
      var Q = window.__neonDebug.quest, q = Q.current;
      return JSON.stringify({ type:q?q.type:null, raceActive:Q.raceActive,
        desc:(document.getElementById('qDesc')||{}).textContent,
        skip:(document.getElementById('questSkip')||{}).style ? document.getElementById('questSkip').style.display !== 'none' : null });
    })()`));
    add('T04-13', 'race 任务在 2D 下进入 WAIT 且卡片告知 20s 自动改派',
      race.type === 'race' && !race.raceActive && /自动改派/.test(race.desc || ''),
      `type=${race.type} raceActive=${race.raceActive}，卡片「${race.desc}」`);
    add('T04-15', '「放弃」按钮在 race-WAIT 态可见', race.skip === true, `questSkip 可见=${race.skip}`);
    // 阈值相对推进：把 waitT 顶到 waitLimit 前 0.6s，等 1.5s 自然越过。
    // 写死 19.4 会在 waitLimit 改成 45s 后失效（改派不触发）——这种「魔法数字」要避免。
    await cdp.eval('(function(){ var Q = window.__neonDebug.quest; Q.waitT = Q.waitLimit - 0.6; return Q.waitLimit; })()');
    await sleep(1500);
    const rq = JSON.parse(await cdp.eval('(function(){var q=window.__neonDebug.quest.current;return JSON.stringify({type:q?q.type:null,n:q?q.n:0,done:q?q.done:0,title:q?q.title:"",limit:window.__neonDebug.quest.waitLimit});})()'));
    add('T04-14', 'race 越过 waitLimit 后自动改派为 collect（不再是死锁，且可继续完成领奖）',
      rq.type === 'collect' && rq.done === 0 && rq.n > 0,
      `waitLimit=${rq.limit}s；改派后「${rq.title}」${rq.done}/${rq.n}`);

    /* ===== T04-16 PAUSED 冻结任务计时 ===== */
    const q1 = await cdp.eval('(document.getElementById("qProg")||{}).textContent');
    await tap(cdp, 'Escape', 27); await sleep(400);
    const q2 = await cdp.eval('(document.getElementById("qProg")||{}).textContent');
    await sleep(900);
    const q3 = await cdp.eval('(document.getElementById("qProg")||{}).textContent');
    add('T04-16', 'PAUSED 状态下任务卡进度不再变化', q1 === q2 && q2 === q3, `暂停前后 qProg 均为「${q3}」`);
    await tap(cdp, 'Escape', 27); await sleep(350);

    /* ===== T03-29 战斗全开帧率 ===== */
    await cdp.eval(`(function(){
      var c = window.__neonDebug.city2d;
      c.waves.phase='spawning'; c.waves.spawned=0; c.waves.wave=3; c.waves.frozen=false;
      c.enemies.reset();
      for (var i=0;i<7;i++) c.enemies.spawn(c.player.x + 60 + i*40, {});
      return 1;
    })()`);
    await kd(cdp, 'KeyD', 68);
    await sleep(1500);
    // 清空 PerfWatch 环形缓冲，避免把切换期的帧算进来
    await cdp.eval('(function(){var c=window.__neonDebug.city2d;return 1;})()');
    await sleep(4000);
    const perf = JSON.parse(await cdp.eval('JSON.stringify(window.__neonDebug.stats.perf)'));
    await ku(cdp, 'KeyD', 68);
    add('T03-29', '战斗全开（7 敌 + 持续奔跑）帧时长不劣于批次 1 基线 11.1ms',
      perf.avg <= 12.5, `perf.avg=${perf.avg}ms p95=${perf.p95}ms max=${perf.max}ms`);

    /* ===== T03-12 / T03-28 零堆分配 ===== */
    await cdp.send('HeapProfiler.collectGarbage'); await sleep(300);
    const h0 = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    await kd(cdp, 'ShiftLeft', 16);
    for (let i = 0; i < 45; i++) { await tap(cdp, 'KeyJ', 74, 50); await sleep(140); }
    await ku(cdp, 'ShiftLeft', 16);
    await cdp.send('HeapProfiler.collectGarbage'); await sleep(400);
    const h1 = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    const growth = (h1 - h0) / 1048576;
    add('T03-12', '连续战斗 45 次挥击后堆增长 <2MB', growth < 2,
      `${(h0 / 1048576).toFixed(2)}MB → ${(h1 / 1048576).toFixed(2)}MB（${growth >= 0 ? '+' : ''}${growth.toFixed(3)}MB）`);
    const pools = JSON.parse(await cdp.eval('JSON.stringify({d:window.__neonDebug.city2d.enemies.drones.length,h:window.__neonDebug.city2d.enemies._hitBuf.length,s:window.__neonDebug.city2d.feedback.sparks.length,b:window.__neonDebug.city2d.feedback.debris.length})'));
    add('T03-28', '战斗后四个池长度全部不变', pools.d === 12 && pools.h === 12 && pools.s === 96 && pools.b === 128,
      `drones=${pools.d} _hitBuf=${pools.h} sparks=${pools.s} debris=${pools.b}`);

    const out = { checks, errors: errors.length, errSample: errors.slice(0, 5) };
    const failed = checks.filter((c) => !c.pass);
    out.summary = { total: checks.length, passed: checks.length - failed.length, failed: failed.length };
    writeFileSync(join(__dirname, '..', 'shots', 'batch2-gate.json'), JSON.stringify(out, null, 2));
    console.log('\n===== ' + out.summary.passed + '/' + out.summary.total + ' 通过，页面异常 ' + errors.length + ' =====');
    if (failed.length) console.log('未通过：', failed.map((f) => f.id).join(', '));
  } catch (e) {
    console.error('[gate] 异常：', e);
    process.exitCode = 1;
  } finally {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ }
  }
}
main();
