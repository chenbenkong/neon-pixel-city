/** prof.mjs —— 逐段计时，定位批次 2 引入的帧时长回归 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { edgeProfile } from './edge-profile.mjs';
const DIR = 'C:/Users/moli/WorkBuddy/2026-09-26-23-23-41/qa';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map();
    ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id !== undefined && this.p.has(m.id)) { const h = this.p.get(m.id); this.p.delete(m.id); m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result); } }); }
  send(m, p = {}) { const id = (this.id += 1); return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout')); } }, 60000); }); }
  async eval(x) { const r = await this.send('Runtime.evaluate', { expression: x, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; }
}
async function we(p) { const d = Date.now() + 30000; while (Date.now() < d) { try { const r = await fetch('http://127.0.0.1:' + p + '/json/version'); if (r.ok) return r.json(); } catch { /* */ } await sleep(300); } throw new Error('no ep'); }
const PORT = 9560;
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + edgeProfile('prof'),
  '--window-size=1280,720', '--mute-audio', '--no-first-run', '--use-gl=angle', '--use-angle=d3d11', 'about:blank'], { stdio: 'ignore' });
try {
  await we(PORT);
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8170/' });
  await sleep(11000);
  await cdp.eval("(function(){var b=document.getElementById('enter');if(b){b.disabled=false;b.click();}return 1;})()");
  await sleep(9000);   // 让波次自然刷出敌人
  console.log('render 分项:', await cdp.eval(`(function(){
    var c = window.__neonDebug.city2d, N = 100, out = {}, enemies = c.enemies.aliveCount;
    function bench(){ var a = performance.now(); for (var i=0;i<N;i++) c.render(); return +((performance.now()-a)/N).toFixed(3); }
    out.normal = bench();
    var od = c.drawDrones; c.drawDrones = function(){}; out.noDrones = bench(); c.drawDrones = od;
    var of = c.feedback.render.bind(c.feedback); c.feedback.render = function(){}; out.noFeedbackRender = bench(); c.feedback.render = of;
    var op = c.drawPlayer; c.drawPlayer = function(){}; out.noPlayer = bench(); c.drawPlayer = op;
    out.enemies = enemies;
    return JSON.stringify(out);
  })()`));
  console.log('update 分项:', await cdp.eval(`(function(){
    var c = window.__neonDebug.city2d, N = 200, dt = 1/90, out = {};
    var fake = { down:function(){return false;}, hit:function(){return false;}, joy:{x:0,y:0}, btn:{}, drag:{dx:0,dy:0,active:false}, wheel:0, touchJump:false, touchAtk:false };
    function bench(){ var a = performance.now(); for (var i=0;i<N;i++) c.update(dt, fake); return +((performance.now()-a)/N).toFixed(3); }
    out.normal = bench();
    var oe = c.enemies.update.bind(c.enemies); c.enemies.update = function(){}; out.noEnemies = bench(); c.enemies.update = oe;
    var oc = c.combat.update.bind(c.combat); c.combat.update = function(){}; out.noCombat = bench(); c.combat.update = oc;
    var ow = c.waves.update.bind(c.waves); c.waves.update = function(){}; out.noWaves = bench(); c.waves.update = ow;
    var ou = c.updateParticles.bind(c); c.updateParticles = function(){}; out.noParticles = bench(); c.updateParticles = ou;
    out.enemies = c.enemies.aliveCount;
    return JSON.stringify(out);
  })()`));
  // A/B：真实 rAF 帧时长，有敌 vs 无敌
  async function raf(label) {
    await cdp.eval('window.__rafT=[];(function loop(){window.__rafT.push(performance.now());requestAnimationFrame(loop);})();return 1');
    await sleep(300);
    await cdp.eval('window.__rafT=[];return 1');
    await sleep(3000);
    const v = JSON.parse(await cdp.eval('(function(){var a=window.__rafT;var d=[];for(var i=1;i<a.length;i++)d.push(a[i]-a[i-1]);d.sort(function(x,y){return x-y;});return JSON.stringify({n:d.length,avg:+(d.reduce(function(s,x){return s+x;},0)/d.length).toFixed(2),p50:+d[Math.floor(d.length*0.5)].toFixed(2),p95:+d[Math.floor(d.length*0.95)].toFixed(2)});})()'));
    console.log(label, JSON.stringify(v));
  }
  await raf('有敌人 (' + (await cdp.eval('window.__neonDebug.city2d.enemies.aliveCount')) + ' 只):');
  await cdp.eval("(function(){var c=window.__neonDebug.city2d;c.waves.freeze();c.enemies.reset();return 1;})()");
  await sleep(600);
  await raf('无敌人（波次冻结）:');
  await cdp.eval("(function(){var c=window.__neonDebug.city2d;c.feedback.reset();return 1;})()");
  await raf('无敌人+无粒子:  ');
} finally { try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ } }
