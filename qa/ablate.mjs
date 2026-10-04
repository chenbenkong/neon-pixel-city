#!/usr/bin/env node
/**
 * ablate.mjs —— 消融分析：逐项关闭渲染要素，量出各自的真实成本与占比
 *
 * 两类成本必须分开看（这是 PM 诊断里最关键的区分）：
 *
 *   A. canvas 内部绘制 —— 发生在 JS 里，CDP Profiler 的 self-time 能直接量到
 *   B. 浏览器 CSS 合成 —— 发生在 compositor，**不在** JS self-time 里。
 *      grain 层的 mix-blend-mode: screen 属于这一类：它在 headless 小视口下
 *      被严重低估（合成代价随视口面积增长，而 headless 常常只有几百像素）。
 *      所以 grain 我用「整层 display:none 前后的 work 时长差 + rAF 间隔」双指标量，
 *      并明确标注它可能被低估。
 *
 * 用法：node ablate.mjs --url http://127.0.0.1:8195/ --w 1920 --h 1080 --dpr 2
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeProfile } from './edge-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const URL_ = arg('url', 'http://127.0.0.1:8195/');
const W = Number(arg('w', 1920)), H = Number(arg('h', 1080)), DPR = Number(arg('dpr', 2));
const PORT = Number(arg('port', 9720));
const SETTLE = 5000, MEASURE = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killEdge = () => { try { spawn('taskkill', ['/F', '/IM', 'msedge.exe', '/T'], { stdio: 'ignore' }); } catch { /* */ } };

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.l = new Map();
    ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id !== undefined && this.p.has(m.id)) { const h = this.p.get(m.id); this.p.delete(m.id); m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result); }
      else if (m.method) (this.l.get(m.method) || []).forEach((f) => f(m.params || {})); }); }
  on(k, f) { if (!this.l.has(k)) this.l.set(k, []); this.l.get(k).push(f); }
  send(m, p = {}) { const id = (this.id += 1); return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + m)); } }, 90000); }); }
  async eval(x, safe) { try { const r = await this.send('Runtime.evaluate', { expression: x, returnByValue: true }); if (r.exceptionDetails) { if (safe !== undefined) return safe; throw new Error('eval ' + (r.exceptionDetails.text || '')); } return r.result ? r.result.value : undefined; } catch (e) { if (safe !== undefined) return safe; throw e; } }
}
async function waitEp(port, t = 30000) { const dl = Date.now() + t; while (Date.now() < dl) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return r.json(); } catch { /* */ } await sleep(300); } throw new Error('no ep'); }

// ---- 消融项：每项一段 JS，在页面里执行后测一轮 ----
const ABLATIONS = [
  { id: 'baseline', label: '基线（什么都不关）', js: '1' },
  { id: 'composite', label: '关 composite()（3 次全屏 drawImage）', js: "window.__neonDebug.city2d.composite = function(){}" },
  { id: 'reflection', label: '关 drawReflection()（~22 条全宽 drawImage）', js: "window.__neonDebug.city2d.drawReflection = function(){}" },
  { id: 'haze', label: '关 hazeOver()（每帧 3 个 createLinearGradient）', js: "window.__neonDebug.city2d.hazeOver = function(){}" },
  { id: 'grain', label: '关 grain 层（CSS mix-blend-mode: screen）', js: "var e=document.getElementById('crt');if(e){var s=document.createElement('style');s.textContent='#crt::after{display:none!important}';document.head.appendChild(s);}" },
  { id: 'enemies', label: '关战斗实体（drones 全清空）', js: "window.__neonDebug.city2d.enemies.reset(); window.__neonDebug.city2d.enemies.update=function(){}; window.__neonDebug.city2d.combat.update=function(){}" },
  { id: 'shake', label: '关震屏平移（shakeX/Y 恒 0）', js: "var f=window.__neonDebug.city2d.feedback; Object.defineProperty(f,'shakeX',{get:function(){return 0;},configurable:true}); Object.defineProperty(f,'shakeY',{get:function(){return 0;},configurable:true});" },
  { id: 'allCanvas', label: '关全部 canvas 绘制（composite+reflection+haze+drone+npc）',
    js: "var c=window.__neonDebug.city2d; c.composite=function(){}; c.drawReflection=function(){}; c.hazeOver=function(){}; c.drawDrones=function(){}; c.drawNPC=function(){};" },
];

async function main() {
  killEdge();
  await sleep(4000);
  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + edgeProfile('abl'),
    '--window-size=' + W + ',' + H, '--mute-audio', '--no-first-run', '--disable-extensions',
    '--use-gl=angle', '--use-angle=d3d11', 'about:blank'], { stdio: 'ignore' });
  try {
    await waitEp(PORT);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
    await cdp.send('Page.navigate', { url: URL_ });
    for (let i = 0; i < 50; i++) { await sleep(700); if (await cdp.eval("(function(){try{var b=document.getElementById('enter');return !!(b&&b.disabled===false);}catch(e){return false;}})()", false)) break; }
    await cdp.eval("(function(){try{var b=document.getElementById('enter');if(b){b.disabled=false;b.click();}}catch(e){}return 1;})()", 0);
    for (let i = 0; i < 25; i++) { await sleep(400); if (await cdp.eval('!!window.__neonDebug', false) === true) break; }
    await sleep(SETTLE);

    // 记下画布实际尺寸与 CSS 合成层
    const env = JSON.parse(await cdp.eval(`(function(){
      var c = document.getElementById('c2d');
      var crt = document.getElementById('crt');
      var cs = crt ? getComputedStyle(crt, '::after') : null;
      return JSON.stringify({ canvasW: c.width, canvasH: c.height, mpx: +((c.width*c.height)/1e6).toFixed(2),
        grainBlend: cs ? cs.mixBlendMode : 'n/a', grainDisplay: cs ? cs.display : 'n/a',
        layers: document.querySelectorAll('#crt > *, #hud > *').length });
    })()`));
    console.log(`画布 ${env.canvasW}x${env.canvasH} = ${env.mpx}M  |  grain mix-blend-mode=${env.grainBlend} display=${env.grainDisplay}`);
    console.log('');

    const rows = [];
    for (const ab of ABLATIONS) {
      // 每一项都从新页面开始，避免上一项的污染（monkey patch 无法可靠撤销）
      await cdp.send('Page.navigate', { url: URL_ });
      for (let i = 0; i < 50; i++) { await sleep(700); if (await cdp.eval("(function(){try{var b=document.getElementById('enter');return !!(b&&b.disabled===false);}catch(e){return false;}})()", false)) break; }
      await cdp.eval("(function(){try{var b=document.getElementById('enter');if(b){b.disabled=false;b.click();}}catch(e){}return 1;})()", 0);
      for (let i = 0; i < 25; i++) { await sleep(400); if (await cdp.eval('!!window.__neonDebug', false) === true) break; }
      await sleep(SETTLE);

      // 满编敌人，让战斗成本也进入基线
      await cdp.eval("(function(){try{var c=window.__neonDebug.city2d;c.enemies.reset();for(var i=0;i<7;i++)c.enemies.spawn(c.player.x+60+i*45,{});}catch(e){}return 1;})()", 0);
      if (ab.js !== '1') await cdp.eval('(function(){try{' + ab.js + '}catch(e){}return 1;})()', 0);
      await sleep(1500);
      // 页面健康检查：消融把主循环搞挂时跳过本项，不让整轮挂掉
      const alive = await cdp.eval('(function(){try{return !!window.__neonDebug && window.__neonDebug.stats.perf.workFrames > 0;}catch(e){return false;}})()', false);
      if (!alive) { console.log((ab.label + ' ').padEnd(46) + ' 页面无响应，跳过'); rows.push({ id: ab.id, label: ab.label + '（页面无响应，已跳过）', workAvg: NaN, workP95: NaN, workMax: NaN, intAvg: NaN, intP95: NaN, prof: [] }); continue; }

      // ---- A. JS self-time（Profiler）----
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });   // 0.2ms 采样
      await cdp.send('Profiler.start');
      await sleep(MEASURE);
      const prof = await cdp.send('Profiler.stop');
      const nodes = new Map();
      for (const n of prof.profile.nodes) nodes.set(n.id, n);
      const self = new Map();
      const total = new Map();
      for (const n of prof.profile.nodes) {
        const f = n.callFrame.functionName || '(anonymous)';
        const u = n.callFrame.url || '';
        if (u.indexOf('devtools://') === 0 || f === '(idle)') continue;
        self.set(f, (self.get(f) || 0) + (n.hitCount || 0));
      }
      // 归一化成 ms（interval 0.2ms × hitCount）
      const profRows = [...self.entries()].map(([f, hits]) => ({ fn: f, ms: +(hits * 0.2).toFixed(1) }))
        .sort((a, b) => b.ms - a.ms).slice(0, 12);

      // ---- B. work 时长（真实余量）----
      await cdp.eval('(function(){try{var p=window.__neonDebug.stats.perf;}catch(e){}return 1;})()', 0);
      const stats = JSON.parse(await cdp.eval(`(function(){
        var s = window.__neonDebug.stats.perf;
        return JSON.stringify({ workAvg: s.workAvg, workP95: s.workP95, workMax: s.workMax, workFrames: s.workFrames,
          intAvg: s.avg, intP95: s.p95 });
      })()`));

      rows.push({ id: ab.id, label: ab.label, ...stats, prof: profRows });
      const b = rows[0];
      const dw = b.workAvg - stats.workAvg;
      console.log(`${ab.label.padEnd(46)} work ${String(stats.workAvg).padStart(6)}ms  p95 ${String(stats.workP95).padStart(6)}ms  ` +
        `省 ${dw >= 0 ? dw.toFixed(2) : ('-' + (-dw).toFixed(2))}ms  (${((dw / b.workAvg) * 100).toFixed(1)}%)`);
    }

    const base = rows[0];
    console.log('');
    console.log('=== JS self-time top（基线档，0.2ms 采样）===');
    for (const r of base.prof) console.log(`  ${String(r.ms).padStart(7)}ms  ${r.fn}`);

    console.log('');
    console.log('=== 消融汇总（按节省量排序）===');
    const sorted = rows.slice(1).map((r) => ({ ...r, saved: +(base.workAvg - r.workAvg).toFixed(2) }))
      .sort((a, b) => b.saved - a.saved);
    console.log(`  ${'项目'.padEnd(44)} ${'work'.padStart(8)} ${'节省'.padStart(8)} ${'占比'.padStart(7)}`);
    for (const r of sorted) {
      console.log(`  ${r.label.slice(0, 43).padEnd(44)} ${(r.workAvg + 'ms').padStart(8)} ${(r.saved + 'ms').padStart(8)} ${((r.saved / base.workAvg) * 100).toFixed(1).padStart(6)}%`);
    }
    console.log('');
    console.log(`  p95 - avg 的落差（找周期性卡顿）：`);
    for (const r of rows) console.log(`    ${r.label.slice(0, 40).padEnd(42)} avg ${String(r.workAvg).padStart(6)}  p95 ${String(r.workP95).padStart(6)}  落差 ${(r.workP95 - r.workAvg).toFixed(2)}ms`);

    writeFileSync(join(__dirname, '..', 'shots', 'ablate.json'), JSON.stringify({ env, base: W + 'x' + H + '@' + DPR, rows }, null, 2));
    console.log('\n写入 shots/ablate.json');
  } catch (e) { console.error('[ablate] 异常：', e); process.exitCode = 1; }
  finally { try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ } }
}
main();
