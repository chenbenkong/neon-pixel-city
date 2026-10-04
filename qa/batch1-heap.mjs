#!/usr/bin/env node
/**
 * batch1-heap.mjs —— 零堆分配实测（60 秒激战后 usedJSHeapSize 增长 < 2MB）
 *
 * 为什么必须实测：T01 把 city2d 的三处 filter() 改成原地压缩、steam 改成按时间累加，
 * 都是为了消除每帧堆分配。但「代码看起来不分配」不等于「运行时没分配」——
 * 只有拿真实战斗/漫游负载跑一段时间看堆曲线才能证明。
 *
 * 负载设计（60 秒）：持续奔跑 + 每 0.5s 跳一次 + 频繁转向。
 * 这会同时压到：粒子系统（splashes/ripples/steam）、碎片重生、NPC 生成与剔除、
 * 视差层与霓虹招牌的每帧绘制路径。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = __dirname.replace(/[\\/]qa$/, '');
const OUT = join(__dirname, '..', 'shots');
const PY = 'C:/Users/moli/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8139, CDP = 9426, SECONDS = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[heap]', ...a);

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.id !== undefined && this.p.has(m.id)) { const h = this.p.get(m.id); this.p.delete(m.id); m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result); } }); }
  send(method, params = {}) { const id = (this.id += 1); return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + method)); } }, 60000); }); }
  async eval(x) { const r = await this.send('Runtime.evaluate', { expression: x, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; }
}
async function waitEndpoint(port) { const dl = Date.now() + 30000; while (Date.now() < dl) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return r.json(); } catch { /* */ } await sleep(300); } throw new Error('no endpoint'); }
const keyDown = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const keyUp = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });

const srv = spawn(PY, ['-m', 'http.server', String(PORT), '--directory', REPO], { stdio: 'ignore' });
await sleep(1200);
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${join(__dirname, '.edge-heap')}`,
  '--window-size=1280,720', '--mute-audio', '--no-first-run', '--disable-extensions',
  '--use-gl=angle', '--use-angle=d3d11', '--js-flags=--expose-gc', 'about:blank'], { stdio: 'ignore' });

try {
  await waitEndpoint(CDP);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('HeapProfiler.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(9000);
  await cdp.eval(`(function(){var b=document.getElementById('enter');if(b){b.disabled=false;b.click();}return 1;})()`);
  await sleep(3000);

  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    await sleep(300);
    const r = await cdp.send('Runtime.getHeapUsage');
    return r.usedSize;
  };

  const before = await heap();
  log('起始 usedSize =', (before / 1048576).toFixed(2), 'MB');

  // 60 秒激战负载：Shift 奔跑 + 每 0.4s 跳 + 每 2s 急转方向
  await keyDown(cdp, 'ShiftLeft', 16);
  const t0 = Date.now();
  let flip = 1, samples = [];
  while ((Date.now() - t0) / 1000 < SECONDS) {
    await keyDown(cdp, 'KeyD', 68); await sleep(700); await keyUp(cdp, 'KeyD', 68);
    await keyDown(cdp, 'Space', 32); await sleep(120); await keyUp(cdp, 'Space', 32);
    await keyDown(cdp, 'KeyA', 65); await sleep(400); await keyUp(cdp, 'KeyA', 65);
    await keyDown(cdp, 'Space', 32); await sleep(120); await keyUp(cdp, 'Space', 32);
    if (flip++ % 5 === 0) {
      const h = await heap();
      const s = await cdp.eval('(function(){var d=window.__neonDebug.stats;return JSON.stringify({shards:d.shards,score:d.score,x:Math.round(d.player.x),perf:+d.perf.avg.toFixed(2)});})()');
      const rec = { t: Math.round((Date.now() - t0) / 1000), mb: +(h / 1048576).toFixed(2), state: JSON.parse(s) };
      samples.push(rec);
      log(`t=${rec.t}s heap=${rec.mb}MB shards=${rec.state.shards} score=${rec.state.score} x=${rec.state.x} perf=${rec.state.perf}ms`);
    }
  }
  await keyUp(cdp, 'ShiftLeft', 16);
  const after = await heap();
  const growth = (after - before) / 1048576;
  log('');
  log(`结束 usedSize = ${(after / 1048576).toFixed(2)} MB`);
  log(`增长 = ${growth >= 0 ? '+' : ''}${growth.toFixed(3)} MB（判据 < 2MB）`);
  const pass = growth < 2;
  log(pass ? '✔ 零堆分配达标' : '✘ 堆增长超阈值');

  writeFileSync(join(OUT, 'batch1-heap.json'), JSON.stringify({ seconds: SECONDS, beforeMB: +(before / 1048576).toFixed(3), afterMB: +(after / 1048576).toFixed(3), growthMB: +growth.toFixed(3), pass, samples }, null, 2));
  process.exitCode = pass ? 0 : 1;
} finally {
  try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ }
  try { spawn('taskkill', ['/F', '/T', '/PID', String(srv.pid)], { stdio: 'ignore' }); } catch { /* */ }
}
