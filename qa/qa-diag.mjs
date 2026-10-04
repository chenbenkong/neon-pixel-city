#!/usr/bin/env node
/** qa-diag.mjs —— 诊断：键盘事件是否到达页面 / 玩家是否移动 / 插桩是否生效 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeProfile } from './edge-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CFG = { url: process.argv[2] || 'http://127.0.0.1:8131/', port: Number(process.argv[3] || 9320) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result ? r.result.value : undefined;
  }
}
async function waitEndpoint(port) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch { /* */ }
    await sleep(300);
  }
  throw new Error('no endpoint');
}

const prof = edgeProfile('diag'); // 原：join(__dirname, `...`) —— profile 是可再生的一次性产物，不该落在仓库里
mkdirSync(prof, { recursive: true });
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', `--remote-debugging-port=${CFG.port}`, `--user-data-dir=${prof}`,
  '--no-first-run', '--window-size=1280,800', '--use-gl=angle', '--use-angle=d3d11',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });
try {
  await waitEndpoint(CFG.port);
  const list = await (await fetch(`http://127.0.0.1:${CFG.port}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

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
          v.City3D = Wrapped;
        } catch (e) { window.__qaInstErr = String(e); }
        stored = v;
      }
    });
  })()`;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });

  // 1. 纯事件层诊断：先在 about:blank 上测 rawKeyDown 是否产生 DOM keydown
  await cdp.eval(`window.__kl=[];addEventListener('keydown',e=>__kl.push('d:'+e.code+':r'+(e.repeat?1:0)));addEventListener('keyup',e=>__kl.push('u:'+e.code));'ok'`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 });
  await sleep(200);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 });
  await sleep(200);
  console.log('about:blank keylog:', await cdp.eval('JSON.stringify(window.__kl)'));

  // 2. 游戏页：键盘 + 插桩 + 移动观察
  await cdp.send('Page.navigate', { url: CFG.url });
  for (let i = 0; i < 75; i++) {
    await sleep(1000);
    if (await cdp.eval(`document.querySelector('#enter') ? !document.querySelector('#enter').disabled : false`) === true) break;
  }
  console.log('boot pct:', await cdp.eval(`document.querySelector('#bootPct').textContent`));
  console.log('instrumentation:', await cdp.eval(`JSON.stringify({qaInst: !!window.__qaInst, c3: !!window.__c3, hasNEON: typeof window.NEONCity3D, desc: (()=>{ try { const d = Object.getOwnPropertyDescriptor(window,'NEONCity3D'); return d ? (d.get?'accessor':(d.value?'value':'?')) : 'none'; } catch(e){ return 'err'; } })(), distLoaded: performance.getEntriesByType('resource').some(r=>/city3d/.test(r.name)), instErr: window.__qaInstErr || null })`));
  await cdp.eval(`window.__kl=[];addEventListener('keydown',e=>__kl.push('d:'+e.code));addEventListener('keyup',e=>__kl.push('u:'+e.code));'ok'`);
  await cdp.eval(`document.querySelector('#enter').click()`);
  await sleep(2500);
  const posExpr = `(() => { const t = document.querySelector('#tele'); return t ? t.textContent.replace(/\\s+/g, ' ').trim() : '-'; })()`;
  console.log('instrumentation after load:', await cdp.eval(`JSON.stringify({qaInst: !!window.__qaInst, c3: !!window.__c3, desc: (()=>{ try { const d = Object.getOwnPropertyDescriptor(window,'NEONCity3D'); return d ? (d.get?'accessor':(d.value?'value':'?')) : 'none'; } catch(e){ return 'err'; } })(), instErr: window.__qaInstErr || null })`));

  // 复刻 full 套件的按键序列：D 1400 → Space → E → A 400，观察 POS 是否前进
  for (let round = 0; round < 6; round++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 });
    await sleep(1400);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    await sleep(60);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyE', key: 'e', windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69 });
    await sleep(60);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyE', key: 'e', windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await sleep(400);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    console.log(`round ${round}: tele=`, await cdp.eval(posExpr), 'dbg=', await cdp.eval(`JSON.stringify(window.__neonDebug.stats)`));
  }

  // 持续按 D 5 秒，同时观察 dname / 分数 / keylog
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 });
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    console.log(`hold D ${(i + 1) * 0.5}s: dname=`, await cdp.eval(`document.querySelector('#dname').textContent`), 'score=', await cdp.eval(`document.querySelector('#scScore') ? document.querySelector('#scScore').textContent : '-'`), 'kl=', await cdp.eval(`window.__kl.length`));
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 });
  console.log('keylog sample:', await cdp.eval(`JSON.stringify(window.__kl.slice(0, 12))`));
  console.log('dbg:', await cdp.eval(`JSON.stringify(window.__neonDebug.stats)`));

  // 3. E 键对话（对照：hit() 路径）
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyE', key: 'e', windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69 });
  await sleep(80);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyE', key: 'e', windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69 });
  await sleep(300);
  console.log('after E, talks=', await cdp.eval(`window.__neonDebug.stats.talks`));
  console.log('c3 after enter:', await cdp.eval(`JSON.stringify({c3: !!window.__c3, raceTotal: window.__c3 ? window.__c3.raceTotal : -1, shards: window.__c3 ? window.__c3.shardPool.length : -1})`));
} catch (e) {
  console.log('DIAG FATAL', e.stack || e);
} finally {
  try { edge.kill(); } catch { /* */ }
  try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ }
  setTimeout(() => { try { rmSync(prof, { recursive: true, force: true }); } catch { /* */ } process.exit(0); }, 1200);
}
