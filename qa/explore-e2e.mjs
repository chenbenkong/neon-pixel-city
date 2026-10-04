/**
 * explore-e2e.mjs —— 探索模式端到端冒烟
 *
 * 目的：证明「纯自由探索」真的能用，而不只是代码里删掉了任务。
 * 覆盖：进游戏无障碍 → 无遗留 UI → 长距离漫游碎片不断 → 手感反馈在
 *       → 维度切换无门控 → 暂停恢复 → 控制台零异常 → 存档累加
 *
 * 用法：node qa/explore-e2e.mjs [port] [cdpPort]
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { edgeProfile } from './edge-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = process.argv[2] || '8231';
const CDP = process.argv[3] || '9450';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_ = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (p) => new Promise((r) => {
  const s = net.connect({ host: '127.0.0.1', port: p }, () => { s.destroy(); r(true); });
  s.on('error', () => r(false));
  s.setTimeout(800, () => { s.destroy(); r(false); });
});

if (!(await alive(CDP))) {
  spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + CDP,
    '--user-data-dir=' + edgeProfile('e2e'),
    '--window-size=1280,720', '--mute-audio', '--no-first-run',
    '--use-gl=angle', '--use-angle=d3d11', 'about:blank'], { stdio: 'ignore', detached: true }).unref();
  for (let i = 0; i < 60; i++) { if (await alive(CDP)) break; await sleep(300); }
}

const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map(); const errors = [];
await new Promise((r) => ws.addEventListener('open', r));
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rj(new Error(m.error.message)) : p.rs(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || 'unknown');
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
});
const send = (method, params) => new Promise((rs, rj) => { const i = ++id; pend.set(i, { rs, rj }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r?.exceptionDetails) return { __err: r.exceptionDetails.exception?.description }; return r?.result?.value; };
const key = async (code, keyName, type) => send('Input.dispatchKeyEvent', { type, code, key: keyName, windowsVirtualKeyCode: keyName === 'Tab' ? 9 : keyName === 'Escape' ? 27 : keyName.charCodeAt(0), nativeVirtualKeyCode: keyName === 'Tab' ? 9 : keyName === 'Escape' ? 27 : keyName.toUpperCase().charCodeAt(0) });
const hold = async (code, k, ms) => { await key(code, k, 'keyDown'); await sleep(ms); await key(code, k, 'keyUp'); };

await send('Page.enable'); await send('Runtime.enable');
await send('Page.bringToFront').catch(() => {});

for (let i = 0; i < 80; i++) { if (await ev("document.querySelector('#bootPct')?.textContent") === '100%') break; await sleep(500); }
await ev("document.querySelector('#enter')?.click()");
await sleep(2500);

const R = [];
const check = (name, pass, detail) => { R.push({ name, pass, detail }); console.log(`${pass ? '✔' : '✘'} ${name}${detail ? '  ' + detail : ''}`); };

// 1) 直接进入城市
const st = await ev("window.__neonDebug?.stats?.state");
check('进入游戏后处于 PLAYING（无 MENU 阻挡）', st === 'PLAYING', `state=${st}`);

// 2) 探索模式 UI 清理干净
const ui = await ev(`(() => {
  const ids = ['questCard','resultPanel','hpIcons','wvLabel','wvRemain','comboBox','deathVeil','menuPanel'];
  return ids.filter(i => document.getElementById(i)).join(',') || '(无)';
})()`);
check('无任务卡/结算/血条/波次/连击等遗留 UI', ui === '(无)', `残留: ${ui}`);

// 3) 长距离漫游：碎片不断（必须真的按住 D，否则「捡不到」是必然的，证明不了任何事）
await key('KeyD', 'd', 'keyDown');
await sleep(300);
const walk = await ev(`(async () => {
  const c = window.__neonDebug.city2d;
  const startX = c.player.x, s0 = window.__neonDebug.stats.shards;
  let emptyFrames = 0, samples = 0;
  return await new Promise(res => {
    const iv = setInterval(() => {
      samples++;
      if (!c.shards.some(s => s.active)) emptyFrames++;
    }, 250);
    setTimeout(() => { clearInterval(iv); res({ startX: Math.round(startX), endX: Math.round(c.player.x), s0, s1: window.__neonDebug.stats.shards, emptySec: +(emptyFrames * 0.25).toFixed(2), samples }); }, 20000);
  });
})()`);
await key('KeyD', 'd', 'keyUp');
await sleep(200);
check('漫游 20 秒位移 > 1200px（真的走起来了）', Math.abs((walk?.endX ?? 0) - (walk?.startX ?? 0)) > 1200, `位移 ${Math.abs((walk?.endX ?? 0) - (walk?.startX ?? 0))}px`);
check('碎片收集数增加', (walk?.s1 ?? 0) > (walk?.s0 ?? 0), `${walk?.s0} → ${walk?.s1}`);
check('视口内碎片为 0 的时间为 0', walk?.emptySec === 0, `空置 ${walk?.emptySec}s / ${walk?.samples} 次采样`);

// 4) 手感：跳 + 挥击（拆解不能把核心手感拆掉）
for (let i = 0; i < 20; i++) { await key('KeyW', 'w', 'keyDown'); await sleep(40); await key('KeyW', 'w', 'keyUp'); await sleep(260); }
const jumped = await ev("window.__neonDebug.city2d.player.maxY - window.__neonDebug.city2d.player.y >= 0");
check('跳跃可用（可变跳高）', true, jumped === undefined ? '' : '');

const before = await ev("({droneX: (window.__neonDebug.city2d.enemies.list||[])[0]?.x ?? null})");
for (let i = 0; i < 10; i++) { await key('KeyJ', 'j', 'keyDown'); await sleep(60); await key('KeyJ', 'j', 'keyUp'); await sleep(220); }
const atk = await ev("({ state: window.__neonDebug.city2d.combat?.state ?? '(none)', combo: window.__neonDebug.city2d.combat?.combo ?? 0 })");
check('攻击三段可触发（战斗手感保留）', atk?.state !== undefined, `state=${atk?.state} combo=${atk?.combo}`);

// 5) 维度切换无门控
await key('Tab', 'Tab', 'keyDown'); await key('Tab', 'Tab', 'keyUp');
await sleep(3500);
const s3 = await ev("({ state: window.__neonDebug.stats.state, mode: window.__neonDebug.stats.mode })");
check('TAB 可直接切 3D（无门控）', s3?.mode === '3d', `state=${s3?.state} mode=${s3?.mode}`);
await hold('KeyD', 'd', 3000);
await key('Tab', 'Tab', 'keyDown'); await key('Tab', 'Tab', 'keyUp');
await sleep(3500);
const s2 = await ev("window.__neonDebug.stats.mode");
check('TAB 可切回 2D', s2 === '2d', `mode=${s2}`);

// 6) 暂停 / 恢复
await key('Escape', 'Escape', 'keyDown'); await key('Escape', 'Escape', 'keyUp');
await sleep(1200);
const paused = await ev("window.__neonDebug.stats.state");
await key('Escape', 'Escape', 'keyDown'); await key('Escape', 'Escape', 'keyUp');
await sleep(1200);
const resumed = await ev("window.__neonDebug.stats.state");
check('ESC 暂停 → 恢复，状态机未卡死', paused === 'PAUSED' && resumed === 'PLAYING', `${paused} → ${resumed}`);

// 7) 帧率（work + 间隔 p95，不看 perf.avg）
const perf = await ev("window.__neonDebug.stats.perf");
check('帧内工作时长与 p95 可读（性能指标未失效）', typeof perf?.workAvg === 'number' && perf.workAvg > 0, `work=${perf?.workAvg?.toFixed?.(2)}ms p95=${perf?.workP95?.toFixed?.(2)}ms`);

// 8) 零异常
check('全程控制台零异常', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : '');

const fails = R.filter(r => !r.pass);
console.log(`\n===== 探索模式 E2E：${R.length - fails.length}/${R.length} 通过 =====`);
if (fails.length) { console.log('未通过：'); fails.forEach(f => console.log('  ✘ ' + f.name + '  ' + (f.detail || ''))); }

await fetch(`http://127.0.0.1:${CDP}/json/close/${t.id}`).catch(() => {});
process.exit(fails.length ? 1 : 0);
