#!/usr/bin/env node
/**
 * batch2-smoke.mjs —— 战斗系统冒烟测试：先确认能跑起来、敌人会出现、能打死
 * 这一步只做"能不能玩"的粗筛，精细判据由 batch2-verify.mjs 负责。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeProfile } from './edge-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PY = 'C:/Users/moli/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_ = process.argv[2] || 'http://127.0.0.1:8150/';
const PORT = 9500, CDP = 9501;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.l = new Map(); ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.id !== undefined && this.p.has(m.id)) { const h = this.p.get(m.id); this.p.delete(m.id); m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result); } else if (m.method) (this.l.get(m.method) || []).forEach((f) => f(m.params || {})); }); }
  on(k, f) { if (!this.l.has(k)) this.l.set(k, []); this.l.get(k).push(f); }
  send(method, params = {}) { const id = (this.id += 1); return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + method)); } }, 30000); }); }
  async eval(x) { const r = await this.send('Runtime.evaluate', { expression: x, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; }
}
async function waitEndpoint(port) { const dl = Date.now() + 30000; while (Date.now() < dl) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return r.json(); } catch { /* */ } await sleep(300); } throw new Error('no endpoint'); }
const keyDown = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const keyUp = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });

const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${edgeProfile('smoke')}`,
  '--window-size=1280,720', '--mute-audio', '--no-first-run', '--disable-extensions',
  '--use-gl=angle', '--use-angle=d3d11', 'about:blank'], { stdio: 'ignore' });
try {
  await waitEndpoint(CDP);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  const errs = [];
  cdp.on('Runtime.exceptionThrown', (p) => errs.push(JSON.stringify((p.exceptionDetails || {}).text) + ' ' + ((p.exceptionDetails || {}).exception || {}).description));
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') errs.push('console: ' + (p.args || []).map((a) => a.value || a.description).join(' ')); });
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(9000);
  const boot = await cdp.eval(`JSON.stringify({pct:(document.getElementById('bootPct')||{}).textContent, enter:!!document.getElementById('enter')})`);
  log('boot:', boot);
  await cdp.eval(`(function(){var b=document.getElementById('enter');if(b){b.disabled=false;b.click();}return 1;})()`);
  await sleep(3000);
  log('state after enter:', await cdp.eval('window.__neonDebug.state'));

  // 等敌人刷出来（wave1 count=3, gapMs=1400）
  await sleep(9000);
  const s1 = JSON.parse(await cdp.eval('JSON.stringify(window.__neonDebug.stats)'));
  log('enemies:', JSON.stringify(s1.enemies));
  log('waves:', JSON.stringify(s1.waves));
  log('combat:', JSON.stringify(s1.combat));

  // 连续挥击 20 次
  for (let i = 0; i < 20; i++) {
    await keyDown(cdp, 'KeyJ', 74); await sleep(40); await keyUp(cdp, 'KeyJ', 74);
    await sleep(300);
  }
  await sleep(1500);
  const s2 = JSON.parse(await cdp.eval('JSON.stringify(window.__neonDebug.stats)'));
  log('after 20 swings:');
  log('  combat:', JSON.stringify(s2.combat));
  log('  enemies:', JSON.stringify(s2.enemies));
  log('  feedback:', JSON.stringify(s2.feedback));
  log('  hp:', s2.combat.hp, 'state:', s2.state);

  // 结算/暂停路径
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(600);
  log('after ESC:', await cdp.eval('window.__neonDebug.state'), 'pausePanel shown:', await cdp.eval(`document.getElementById('pausePanel').classList.contains('show')`));
  await keyDown(cdp, 'Escape', 27); await sleep(40); await keyUp(cdp, 'Escape', 27);
  await sleep(400);
  log('after ESC again:', await cdp.eval('window.__neonDebug.state'));

  log('errors:', errs.length);
  errs.slice(0, 8).forEach((e) => log('  !', e.slice(0, 220)));
  writeFileSync(join(__dirname, '..', 'shots', 'batch2-smoke.json'), JSON.stringify({ errs, after: s2 }, null, 2));
} catch (e) {
  console.error('[smoke] 失败', e);
  process.exitCode = 1;
} finally {
  try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ }
}
