#!/usr/bin/env node
/**
 * batch2-fps.mjs —— T03-29 战斗全开帧率（干净会话，不做任何模式切换）
 *
 * 为什么必须开干净会话：2D/3D 往返会重建 WebGL 上下文与转场，
 * 把切换期的帧混进 120 帧环形缓冲里，测出来的 avg 会被严重污染
 * （实测同一场景 11.1ms vs 切换后 23.5ms，差异全部来自切换而非战斗负载）。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeProfile } from './edge-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_ = process.argv[2] || 'http://127.0.0.1:8170/';
const PORT = 9550, CDP = 9551;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a);

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.p = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id !== undefined && this.p.has(m.id)) {
        const h = this.p.get(m.id); this.p.delete(m.id);
        m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result);
      }
    });
  }
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
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || ''));
    return r.result ? r.result.value : undefined;
  }
}
const kd = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const ku = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
async function waitEp(port, t = 30000) {
  const dl = Date.now() + t;
  while (Date.now() < dl) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return r.json(); } catch { /* */ } await sleep(300); }
  throw new Error('no ep');
}

async function main() {
  const unlock = process.argv[3] === 'unlock';
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${edgeProfile('b2f-')}`,
    '--window-size=1280,720', '--mute-audio', '--no-first-run', '--disable-extensions',
    '--use-gl=angle', '--use-angle=d3d11',
    ...(unlock ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []), 'about:blank'], { stdio: 'ignore' });
  const checks = [];
  const add = (id, d, p, det) => { checks.push({ id, desc: d, pass: !!p, detail: det }); log(`${p ? '✔' : '✘'} ${id} ${det}`); };
  try {
    await waitEp(CDP);
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    // 与批次 1 的 batch1-fps.mjs 保持完全一致的测量条件，否则帧率数字不可比
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
    await cdp.send('Page.navigate', { url: URL_ });
    for (let i = 0; i < 45; i++) { await sleep(700); const r = await cdp.eval('(function(){var b=document.getElementById("enter");return !!(b&&b.disabled===false);})()').catch(() => false); if (r === true) break; }
    await cdp.eval('(function(){var b=document.getElementById("enter");if(b){b.disabled=false;b.click();}return 1;})()');
    for (let i = 0; i < 20; i++) { await sleep(400); if (await cdp.eval('!!window.__neonDebug') === true) break; }
    await sleep(3000);

    /* --- A. 静默基线（无战斗）--- */
    const base = JSON.parse(await cdp.eval('JSON.stringify(window.__neonDebug.stats.perf)'));
    add('FPS-A', '无战斗基线帧时长（对照批次 1 的 11.1ms）', base.avg <= 12.0,
      `avg=${base.avg}ms p95=${base.p95}ms → ${(1000 / base.avg).toFixed(1)}fps`);

    /* --- B. 战斗全开：7 敌 + 持续奔跑 + 持续挥击 --- */
    await cdp.eval(`(function(){
      var c = window.__neonDebug.city2d;
      c.waves.frozen = true;              // 锁住波次，自己控制敌人数量
      c.enemies.reset();
      for (var i=0;i<7;i++){ var d=c.enemies.spawn(c.player.x + 70 + i*38, {}); d.state='chase'; }
      return 1;
    })()`);
    await kd(cdp, 'ShiftLeft', 16);
    await kd(cdp, 'KeyD', 68);
    // 边跑边砍：每 400ms 一次挥击，让命中反馈/粒子/顿帧全部持续触发
    for (let i = 0; i < 12; i++) {
      await kd(cdp, 'KeyJ', 74); await sleep(50); await ku(cdp, 'KeyJ', 74);
      await sleep(350);
    }
    await ku(cdp, 'KeyD', 68);
    await ku(cdp, 'ShiftLeft', 16);
    const combat = JSON.parse(await cdp.eval('JSON.stringify(window.__neonDebug.stats.perf)'));
    const st = JSON.parse(await cdp.eval('JSON.stringify({alive:window.__neonDebug.city2d.enemies.aliveCount,kills:window.__neonDebug.city2d.runKills,swings:window.__neonDebug.city2d.runSwings,hits:window.__neonDebug.city2d.runHits})'));
    add('FPS-B', `战斗全开（7 敌 + 奔跑 + 挥击 ${st.swings} 次）帧时长不劣于批次 1 基线`,
      combat.avg <= 12.0,
      `avg=${combat.avg}ms p95=${combat.p95}ms max=${combat.max}ms → ${(1000 / combat.avg).toFixed(1)}fps；场上 ${st.alive} 敌，命中 ${st.hits}/${st.swings}，击杀 ${st.kills}`);
    add('T03-29', 'T03-29 战斗全开帧时长 ≤ 批次 1 基线 11.1ms + 10% 容差', combat.avg <= 12.2,
      `战斗 ${combat.avg}ms vs 基线 ${base.avg}ms（+${(((combat.avg - base.avg) / base.avg) * 100).toFixed(1)}%）`);

    const out = { checks, mode: unlock ? 'unlocked' : 'vsync' };
    const failed = checks.filter((c) => !c.pass);
    out.summary = { total: checks.length, passed: checks.length - failed.length, failed: failed.length };
    writeFileSync(join(__dirname, '..', 'shots', 'batch2-fps.json'), JSON.stringify(out, null, 2));
    console.log('\n===== ' + out.summary.passed + '/' + out.summary.total + ' =====');
  } catch (e) { console.error('[fps2] 异常：', e); process.exitCode = 1; }
  finally { try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ } }
}
main();
