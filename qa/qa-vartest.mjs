#!/usr/bin/env node
/** qa-vartest.mjs —— 验证 top-level `var NEONCity3D=...` 赋值是否经过 accessor setter */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeProfile } from './edge-profile.mjs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map();
    ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== undefined && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); } }); }
  send(method, params = {}) { const id = (this.id += 1); return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('to')); } }, 30000); }); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; }
}
const prof = edgeProfile('vartest'); // 原：join(__dirname, `...`) —— profile 是可再生的一次性产物，不该落在仓库里
mkdirSync(prof, { recursive: true });
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--remote-debugging-port=9325', `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 40; i++) { try { const r = await fetch('http://127.0.0.1:9325/json/version'); if (r.ok) break; } catch { /* */ } await sleep(300); }
  const list = await (await fetch('http://127.0.0.1:9325/json/list')).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(function(){
    var stored;
    Object.defineProperty(window,'NEONCity3D',{configurable:true,
      get:function(){return stored;},
      set:function(v){ window.__setterHit = (window.__setterHit||0)+1; try{ var Orig=v.City3D; window.__origIsFn = typeof Orig; }catch(e){} stored=v; }});
  })()` });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8131/' });
  await sleep(9000);
  console.log(await cdp.eval(`JSON.stringify({setterHit: window.__setterHit||0, origIsFn: window.__origIsFn||null, hasNEON: typeof window.NEONCity3D, desc: (()=>{const d=Object.getOwnPropertyDescriptor(window,'NEONCity3D'); return d?(d.get?'accessor':typeof d.value):'none';})()})`));
} catch (e) { console.log('FATAL', e.message); }
finally { try { edge.kill(); } catch { /* */ } try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ } setTimeout(() => { try { rmSync(prof, { recursive: true, force: true }); } catch { /* */ } process.exit(0); }, 1000); }
