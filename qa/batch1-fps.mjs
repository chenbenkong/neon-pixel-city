#!/usr/bin/env node
/**
 * batch1-fps.mjs —— 帧率实测（Edge headless + --use-angle=d3d11 + CDP）
 *
 * 为什么必须带 --use-angle=d3d11：缺了它 headless 会退回 SwiftShader 软件渲染，
 * 上一轮把 90fps 测成了 5fps（软件渲染伪影）。这是硬性要求，不是可选项。
 *
 * 采样方式：直接读 window.__neonDebug.stats.perf（主循环里 perf.sample(rawDt*1000) 的环形缓冲），
 * 外加 rAF 帧间隔作为交叉校验。两路都取，只报环形缓冲的 avg/p95（与 QA 基线口径一致）。
 *
 * 用法：node batch1-fps.mjs --tag 15 --port 8126 --cdp 9415
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = __dirname.replace(/[\\/]qa$/, '');
const OUT = join(__dirname, '..', 'shots');
const PY = 'C:/Users/moli/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const TAG = arg('--tag', 'cur');
const PORT = Number(arg('--port', '8126'));
const CDP_PORT = Number(arg('--cdp', '9415'));
// DSF：模拟真实高分屏（dpr=2），让 dprCap 2 与 1.5 两条分支都真正生效
const DSF = Number(arg('--dsf', '2'));
// 解锁帧率：解除 vsync 才能测出真实每帧成本
const UNLOCK = arg('--unlock', '1') !== '0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[fps]', ...a);

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); } }, 90000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || ''));
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
async function getPageWs(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const p = list.find((t) => t.type === 'page');
  return p.webSocketDebuggerUrl;
}

/** 装一个 rAF 帧间隔采样器 */
const INSTALL_FPS = `(function(){
  if (window.__fpsHook) return;
  window.__fpsHook = true;
  window.__fps = { raf: [], last: 0 };
  var loop = function (t) {
    if (window.__fps.last) window.__fps.raf.push(t - window.__fps.last);
    window.__fps.last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();`;

async function main() {
  if (!mkdirSync(OUT, { recursive: true })) { /* exists */ }
  const srv = spawn(PY, ['-m', 'http.server', String(PORT), '--directory', REPO], { stdio: 'ignore' });
  await sleep(1200);
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(__dirname, '.edge-fps-' + TAG)}`,
    '--window-size=1280,720', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    // 硬性要求：不加 --use-angle=d3d11 会退回 SwiftShader 软件渲染，测出的是伪影帧率
    '--use-gl=angle', '--use-angle=d3d11',
    // 解除 vsync 与帧率上限：否则两条 dpr 分支都会被锁在同一个 90fps，
    // 测不出 dpr 到底省了多少 CPU/GPU。真实成本只有在解除限帧时才看得见。
    ...(UNLOCK ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitEndpoint(CDP_PORT);
    const ws = new WebSocket(await getPageWs(CDP_PORT));
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const errors = [];
    cdp.listeners.set('Runtime.exceptionThrown', [(p) => errors.push(JSON.stringify((p.exceptionDetails || {}).text))]);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTALL_FPS });
    // 强制 dpr=2 的高分屏环境：dprCap=2 与 dprCap=1.5 才有两条不同的分支可测
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: DSF, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    await sleep(9000);
    await cdp.eval(`(function(){var b=document.getElementById('enter');if(b){b.disabled=false;b.click();}return 1;})()`);
    await sleep(2500);   // 入场动画 + 场景稳态

    const phases = {};
    // 2D 稳态
    await cdp.eval('window.__fps.raf.length = 0');
    await sleep(9000);
    phases.fps2d = await cdp.eval(`(function(){
      var s = window.__neonDebug.stats;
      var r = window.__fps.raf.slice(30);
      var sum = 0; for (var i=0;i<r.length;i++) sum += r[i];
      return { perfAvgMs: +s.perf.avg.toFixed(2), perfP95Ms: +s.perf.p95.toFixed(2), perfMaxMs: +s.perf.max.toFixed(2),
               rafSamples: r.length, rafAvgMs: +(sum/Math.max(1,r.length)).toFixed(2),
               rafFps: +(1000/(sum/Math.max(1,r.length))).toFixed(1),
               canvasW: window.__neonDebug.city2d.canvas.width, canvasH: window.__neonDebug.city2d.canvas.height,
               dpr: window.devicePixelRatio };
    })()`);

    // 3D
    await cdp.eval(`document.getElementById('modeSwitch').click()`);
    await sleep(5000);
    await cdp.eval('window.__fps.raf.length = 0');
    await sleep(8000);
    phases.fps3d = await cdp.eval(`(function(){
      var r = window.__fps.raf.slice(30);
      var sum = 0; for (var i=0;i<r.length;i++) sum += r[i];
      return { perfAvgMs: +window.__neonDebug.stats.perf.avg.toFixed(2),
               perfP95Ms: +window.__neonDebug.stats.perf.p95.toFixed(2),
               rafSamples: r.length, rafAvgMs: +(sum/Math.max(1,r.length)).toFixed(2),
               rafFps: +(1000/(sum/Math.max(1,r.length))).toFixed(1) };
    })()`);

    const out = { tag: TAG, phases, exceptions: errors.length };
    writeFileSync(join(OUT, `fps${TAG}.json`), JSON.stringify(out, null, 2));
    log(JSON.stringify(out));
  } finally {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ }
    try { spawn('taskkill', ['/F', '/T', '/PID', String(srv.pid)], { stdio: 'ignore' }); } catch { /* */ }
  }
}
main().catch((e) => { console.error('[fps] 失败：', e); process.exit(1); });
