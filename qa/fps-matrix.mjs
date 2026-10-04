#!/usr/bin/env node
/**
 * fps-matrix.mjs —— 分辨率 / DPR 矩阵基准（复现「用户说卡但基准说 85fps」）
 *
 * 为什么要这个脚本：原来的 batch1-fps.mjs 固定 1280×720 窗口，
 * 内部画布 = 1280×720 × min(DPR,1.5)² = 1920×1080 = 2.07M 像素。
 * 用户在 1920×1080 甚至 2560×1440 的屏上玩，内部画布是 4.67M / 8.29M 像素，
 * 是原基准的 2.25× / 4×。**基准测的不是用户的场景**，这就是「85fps」和「卡」能同时成立的原因。
 *
 * 关键：RENDER.dprCap = 1.5（config.js），所以
 *   内部画布像素 = CSS 视口宽高 × min(devicePixelRatio, 1.5)²
 * 而不是 视口 × DPR²。报告里两个数都打出来，避免口径混淆。
 *
 * 用法：
 *   node fps-matrix.mjs --url http://127.0.0.1:8180/ --out shots/fps-matrix.json
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeProfile } from './edge-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PY = 'C:/Users/moli/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const URL_ = arg('url', 'http://127.0.0.1:8180/');
const OUT = arg('out', join(__dirname, '..', 'shots', 'fps-matrix.json'));
const SETTLE = Number(arg('settle', 5000));      // 等 boot/3D懒加载的长帧从 120 帧环形缓冲换掉
const MEASURE = Number(arg('measure', 6000));   // 采样时长
const PORT = Number(arg('port', 9700));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 五档。注意 DPR 是「设备像素比」，不是内部画布倍率。
const TIERS = [
  { w: 1280, h: 720, dpr: 2 },
  { w: 1920, h: 1080, dpr: 1 },
  { w: 1920, h: 1080, dpr: 1.5 },
  { w: 1920, h: 1080, dpr: 2 },
  { w: 2560, h: 1440, dpr: 2 },
];

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map();
    ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id !== undefined && this.p.has(m.id)) { const h = this.p.get(m.id); this.p.delete(m.id); m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result); } }); }
  send(m, p = {}) { const id = (this.id += 1); return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + m)); } }, 90000); }); }
  // setDeviceMetricsOverride 会触发一次导航竞态，轮询期的 eval 必须容错，
  // 否则「执行上下文已销毁」会把整个基准脚本打断（实测踩过）。
  async eval(x, safe) { try { const r = await this.send('Runtime.evaluate', { expression: x, returnByValue: true }); if (r.exceptionDetails) { if (safe !== undefined) return safe; throw new Error('eval ' + (r.exceptionDetails.text || '')); } return r.result ? r.result.value : undefined; } catch (e) { if (safe !== undefined) return safe; throw e; } }
}
async function waitEp(port, t = 30000) { const dl = Date.now() + t; while (Date.now() < dl) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return r.json(); } catch { /* */ } await sleep(300); } throw new Error('no ep'); }

/** 杀掉残留 Edge —— 不清掉的话同一次测量能在 56~90fps 间乱跳（实测踩过） */
function killEdge() {
  try { spawn('taskkill', ['/F', '/IM', 'msedge.exe', '/T'], { stdio: 'ignore' }); } catch { /* */ }
}

async function runTier(tier, idx) {
  killEdge();
  await sleep(4000);
  const port = PORT + idx;
  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + port,
    '--user-data-dir=' + edgeProfile('mx'),
    '--window-size=' + tier.w + ',' + tier.h, '--mute-audio', '--no-first-run',
    '--disable-extensions', '--use-gl=angle', '--use-angle=d3d11',
    'about:blank'], { stdio: 'ignore' });
  try {
    await waitEp(port);
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    // 关键：用 CDP 改视口与设备像素比，而不是靠 --window-size（headless 下两者不一致）
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: tier.w, height: tier.h, deviceScaleFactor: tier.dpr, mobile: false,
    });
    await cdp.send('Page.navigate', { url: URL_ });
    // 等 boot
    for (let i = 0; i < 50; i++) {
      await sleep(700);
      if (await cdp.eval("(function(){try{var b=document.getElementById('enter');return !!(b&&b.disabled===false);}catch(e){return false;}})()", false)) break;
    }
    await cdp.eval("(function(){try{var b=document.getElementById('enter');if(b){b.disabled=false;b.click();}}catch(e){}return 1;})()", 0);
    for (let i = 0; i < 25; i++) { await sleep(400); if (await cdp.eval('!!window.__neonDebug', false) === true) break; }
    await sleep(SETTLE);

    // 采样：同时取「内部画布实测」与「perf 环形缓冲」
    await cdp.eval('(function(){try{window.__rafT=[];(function loop(){window.__rafT.push(performance.now());requestAnimationFrame(loop);})();}catch(e){}return 1;})()', 0);
    await sleep(400);
    await cdp.eval('(function(){try{window.__rafT=[];}catch(e){}return 1;})()', 0);
    const t0 = Date.now();
    while (Date.now() - t0 < MEASURE) await sleep(500);
    const res = JSON.parse(await cdp.eval(`(function(){
      if (!window.__neonDebug) return JSON.stringify({perf:{avg:0,p95:0,max:0},workAvg:0,workP95:0,workMax:0,workFrames:0,canvasW:0,canvasH:0,innerW:0,innerH:0,devicePixelRatio:0,rafAvg:0,rafP95:0,rafFps:0,samples:0});
      var c = document.getElementById('c2d');
      var raf = window.__rafT, d = [];
      for (var i = 1; i < raf.length; i++) d.push(raf[i] - raf[i-1]);
      d.sort(function(x,y){return x-y;});
      var s = window.__neonDebug.stats;
      return JSON.stringify({
        perf: s.perf, workAvg: s.perf.workAvg, workP95: s.perf.workP95, workMax: s.perf.workMax, workFrames: s.perf.workFrames,
        canvasW: c ? c.width : 0, canvasH: c ? c.height : 0,
        innerW: window.innerWidth, innerH: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        rafAvg: d.length ? +(d.reduce(function(a,b){return a+b;},0)/d.length).toFixed(2) : 0,
        rafP95: d.length ? +d[Math.floor(d.length*0.95)].toFixed(2) : 0,
        rafFps: d.length ? +(1000/(d.reduce(function(a,b){return a+b;},0)/d.length)).toFixed(1) : 0,
        samples: d.length
      });
    })()`));
    const capPixels = res.canvasW * res.canvasH;
    const nominalPixels = tier.w * tier.h * tier.dpr * tier.dpr;
    return {
      tier, innerW: res.innerW, innerH: res.innerH, devicePixelRatio: res.devicePixelRatio,
      canvasW: res.canvasW, canvasH: res.canvasH,
      canvasPixels: capPixels,                 // 真正要画的像素数（受 dprCap=1.5 限制）
      nominalPixels,                          // 名义像素（视口 × DPR²）
      canvasMP: +(capPixels / 1e6).toFixed(2),
      workAvgMs: +res.workAvg.toFixed(2),
      workP95Ms: +res.workP95.toFixed(2),
      workMaxMs: +res.workMax.toFixed(2),
      perfAvgMs: +res.perf.avg.toFixed(2),
      perfP95Ms: +res.perf.p95.toFixed(2),
      perfMaxMs: +res.perf.max.toFixed(2),
      rafAvgMs: res.rafAvg, rafP95Ms: res.rafP95, rafFps: res.rafFps, samples: res.samples,
    };
  } finally {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ }
  }
}

async function main() {
  const rows = [];
  console.log('分辨率/DPR 矩阵基准  (Edge headless + --use-angle=d3d11, 内部画布受 RENDER.dprCap=1.5 限制)');
  console.log('');
  console.log('  视口            DPR   内部画布        画布像素    工作时长   work_p95 帧间隔   rAF fps');
  console.log('  ' + '-'.repeat(76));
  for (let i = 0; i < TIERS.length; i++) {
    const r = await runTier(TIERS[i], i);
    rows.push(r);
    console.log(`  ${String(TIERS[i].w + 'x' + TIERS[i].h).padEnd(15)} ${String(TIERS[i].dpr).padEnd(5)} ` +
      `${(r.canvasW + 'x' + r.canvasH).padEnd(15)} ${(r.canvasMP + 'M').padEnd(11)} ` +
      `${(r.workAvgMs + 'ms').padEnd(9)} ${(r.workP95Ms + 'ms').padEnd(8)} ${(r.perfAvgMs + 'ms').padEnd(9)} ${r.rafFps}`);
  }
  console.log('');
  // 线性度分析：帧时长 vs 画布像素
  const base = rows[0];
  console.log('线性度分析（按**工作时长**，相对第一档 1280x720@DPR2）:');
  for (const r of rows) {
    const px = r.canvasPixels / base.canvasPixels;
    const t = r.workAvgMs / base.workAvgMs;
    console.log(`  ${String(r.canvasMP + 'M').padEnd(8)} 像素×${px.toFixed(2)}  帧时长×${t.toFixed(2)}  ` +
      `比值 ${(t / px).toFixed(2)}（1.00 = 完全线性）`);
  }
  writeFileSync(OUT, JSON.stringify({ tiers: rows, base: { canvasPixels: base.canvasPixels, perfAvgMs: base.perfAvgMs } }, null, 2));
  console.log('\n写入 ' + OUT);
}
main();
