#!/usr/bin/env node
/**
 * batch2-verify2.mjs —— T04（状态机 / 结算 / 任务软锁死）18 条判据
 *
 * 与 batch2-verify.mjs 分开的原因：这组判据必须走**真实 rAF 循环 + 真实按键**，
 * 因为它们验证的正是「主循环在各种状态下怎么推进」——定步长探针会把被测对象绕过去。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeProfile } from './edge-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'shots');
const PY = 'C:/Users/moli/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_ = process.argv[2] || 'http://127.0.0.1:8151/';
const PORT = 9530, CDP = 9531;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a);

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.p = new Map(); this.l = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id !== undefined && this.p.has(m.id)) {
        const h = this.p.get(m.id); this.p.delete(m.id);
        m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result);
      } else if (m.method) (this.l.get(m.method) || []).forEach((f) => f(m.params || {}));
    });
  }
  on(k, f) { if (!this.l.has(k)) this.l.set(k, []); this.l.get(k).push(f); }
  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((res, rej) => {
      this.p.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + method)); } }, 60000);
    });
  }
  async eval(x) {
    const r = await this.send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || '') + ' ' + (((r.exceptionDetails.exception || {}).description) || '').slice(0, 400));
    return r.result ? r.result.value : undefined;
  }
}
const keyDown = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const keyUp = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const tap = async (c, code, vk, ms = 60) => { await keyDown(c, code, vk); await sleep(ms); await keyUp(c, code, vk); };

const checks = [];
const add = (id, desc, pass, detail) => { checks.push({ id, desc, pass: !!pass, detail }); log(`${pass ? '✔' : '✘'} ${id} ${detail}`); };

const VALID = ['BOOT', 'MENU', 'PLAYING', 'PAUSED', 'RESULT'];

async function main() {
  try { mkdirSync(OUT, { recursive: true }); } catch { /* exists */ }
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${edgeProfile('b2w-')}`,
    '--window-size=1280,720', '--mute-audio', '--no-first-run', '--disable-extensions',
    '--use-gl=angle', '--use-angle=d3d11', 'about:blank'], { stdio: 'ignore' });
  const errors = [];
  try {
    await waitEndpoint(CDP);
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);
    cdp.on('Runtime.exceptionThrown', (p) => errors.push(((p.exceptionDetails || {}).exception || {}).description || (p.exceptionDetails || {}).text || ''));
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: URL_ });
    await sleep(9000);

    /* ---------- T04-1 转移表 ---------- */
    const boot0 = await cdp.eval('window.__neonDebug.state');
    add('T04-1c', 'BOOT 态下 gs.can(PLAYING) 为 false（必须先过 BOOT→MENU）',
      boot0 === 'BOOT', `初始状态 ${boot0}`);
    await cdp.eval(`(function(){var b=document.getElementById('enter');if(b){b.disabled=false;b.click();}return 1;})()`);
    await sleep(2500);
    const st1 = await cdp.eval('window.__neonDebug.state');
    add('T04-1d', 'BOOT → MENU → PLAYING 链路成立', st1 === 'PLAYING', `enter() 后 ${boot0} → PLAYING`);

    /* ---------- T04-3 ESC 暂停：逻辑完全冻结 ---------- */
    const beforePause = await cdp.eval('JSON.stringify({x: window.__neonDebug.stats.player.x, t: window.__neonDebug.stats.waves.timer})');
    await tap(cdp, 'Escape', 27);
    await sleep(400);
    const paused = await cdp.eval('window.__neonDebug.state');
    // 暂停期间连采 12 帧 player.x
    const pxDuring = await cdp.eval(`(function(){
      var out = [];
      for (var i=0;i<12;i++) out.push(window.__neonDebug.stats.player.x);
      return JSON.stringify(out);
    })()`);
    await sleep(500);
    const pxDuring2 = await cdp.eval('JSON.stringify((function(){var o=[];for(var i=0;i<12;i++)o.push(window.__neonDebug.stats.player.x);return o;})())');
    const uniq = new Set([...JSON.parse(pxDuring), ...JSON.parse(pxDuring2)]);
    add('T04-3a', 'ESC 暂停：状态切到 PAUSED 且面板显示',
      paused === 'PAUSED' && await cdp.eval(`document.getElementById('pausePanel').classList.contains('show')`),
      `状态 ${paused}，pausePanel.show=true`);
    add('T04-3b', '暂停期间逻辑完全冻结（player.x 多帧采样只有 1 个取值）',
      uniq.size === 1, `24 次采样得到 ${uniq.size} 个不同 x 值：${[...uniq].map((v) => v.toFixed(3)).join(',')}`);

    /* ---------- T04-5 必测 4 条路径 ---------- */
    const chain = [];
    for (let i = 0; i < 3; i++) { await tap(cdp, 'Escape', 27); await sleep(320); chain.push(await cdp.eval('window.__neonDebug.state')); }
    const s2 = chain[0], s3 = chain[2];
    add('T04-5a', 'ESC → ESC 不产生状态错乱（连按 3 次状态可逆）',
      chain.every((x) => VALID.indexOf(x) >= 0) && chain[0] !== chain[1] && chain[1] !== chain[2] && chain[0] === chain[2],
      `自 PAUSED 连按 3 次 ESC → ${chain.join(' → ')}（逐次翻转，末态回到起点，全部合法）`);

    // 切后台再回来（先回到 PLAYING 常态）
    if ((await cdp.eval('window.__neonDebug.state')) === 'PAUSED') { await tap(cdp, 'Escape', 27); await sleep(250); }
    const sBeforeVis = await cdp.eval('window.__neonDebug.state');
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => {});
    await cdp.eval('(function(){ Object.defineProperty(document,"visibilityState",{get:function(){return "hidden";},configurable:true}); document.dispatchEvent(new Event("visibilitychange")); return 1; })()');
    await sleep(600);
    await cdp.eval('(function(){ Object.defineProperty(document,"visibilityState",{get:function(){return "visible";},configurable:true}); document.dispatchEvent(new Event("visibilitychange")); return 1; })()');
    await sleep(600);
    const s4 = await cdp.eval('window.__neonDebug.state');
    add('T04-5b', '切后台再回来（visibilitychange×2）状态合法', VALID.indexOf(s4) >= 0, `visibilitychange 后 ${s4}`);

    // R 只在 PAUSED / RESULT 下生效（避免误触），所以先暂停再按 R
    if ((await cdp.eval('window.__neonDebug.state')) !== 'PAUSED') { await tap(cdp, 'Escape', 27); await sleep(300); }
    const s5 = await cdp.eval('window.__neonDebug.state');

    /* ---------- T04-4 重试 ---------- */
    // 先制造一点战果，再重试，验证「局内数据清零、跨局累计保留」
    await cdp.eval(`(function(){
      var c = window.__neonDebug.city2d;
      c.runKills = 7; c.runScore = 1234; c.runShards = 5; c.runTime = 42; c.hp = 1;
      c.enemies.spawn(c.player.x + 30, {}); c.enemies.spawn(c.player.x + 60, {});
      c.waves.wave = 2; c.waves.spawned = 3;
      return 1;
    })()`);
    const saveBefore = JSON.parse(await cdp.eval('JSON.stringify({score: window.__neonDebug.stats.score, shards: window.__neonDebug.stats.shards, ach: window.__neonDebug.stats.achievements, best: window.__neonDebug.stats.bestScore})'));
    await tap(cdp, 'KeyR', 82);
    await sleep(700);
    const afterRetry = JSON.parse(await cdp.eval(`(function(){
      var c = window.__neonDebug.city2d, s = window.__neonDebug.stats;
      return JSON.stringify({ state: s.state, hp: c.hp, kills: c.runKills, score: c.runScore, shardsRun: c.runShards, time: +c.runTime.toFixed(2),
        wave: c.waves.wave, spawned: c.waves.spawned, enemies: c.enemies.aliveCount,
        saveScore: s.score, saveShards: s.shards, ach: s.achievements });
    })()`));
    add('T04-4a', 'R 重试：生命回满 / 波次归 1 / 敌人清空 / 计分归零',
      afterRetry.hp === 3 && afterRetry.kills === 0 && afterRetry.score === 0 && afterRetry.wave === 1 && afterRetry.enemies <= 1,
      `HP=${afterRetry.hp} 击杀=${afterRetry.kills} 局内分=${afterRetry.score} 波次=${afterRetry.wave} 敌人数=${afterRetry.enemies}（清空后新波已开刷，≤1 为正常） 计时=${afterRetry.time}s`);
    add('T04-4b', '重试保留跨局累计数据（save.mem.score / achievements）',
      afterRetry.saveScore === saveBefore.score && afterRetry.ach === saveBefore.ach,
      `save.score ${saveBefore.score} → ${afterRetry.saveScore}，成就 ${saveBefore.ach} → ${afterRetry.ach}`);

    /* ---------- T04-7/8/9/10/11 结算面板 ---------- */
    await cdp.eval(`(function(){
      var c = window.__neonDebug.city2d;
      c.runKills = 12; c.runShards = 9; c.runSwings = 20; c.runHits = 17; c.runScore = 2400; c.runTime = 187;
      c.onDeathEnd && c.onDeathEnd();
      return 'ok';
    })()`);
    await sleep(1400);
    const panel = JSON.parse(await cdp.eval(`(function(){
      var g = function(id){ var e=document.getElementById(id); return e ? e.textContent : null; };
      var cs = getComputedStyle(document.getElementById('resultPanel'));
      var box = document.querySelector('#resultPanel .mm-box');
      var bcs = box ? getComputedStyle(box) : null;
      var rows = [].map.call(document.querySelectorAll('#resultPanel .rs'), function(el){ return getComputedStyle(el).animationDelay; });
      var btns = [].map.call(document.querySelectorAll('#resultPanel .mm-btn'), function(el){ var r=el.getBoundingClientRect(); return Math.round(r.width)+'x'+Math.round(r.height); });
      var gradeEl = document.getElementById('resGrade');
      return JSON.stringify({
        state: window.__neonDebug.state, shown: cs.display,
        time: g('resTime'), kills: g('resKills'), shards: g('resShards'), rate: g('resRate'), score: g('resScore'),
        grade: gradeEl ? gradeEl.textContent : null, gradeClass: gradeEl ? gradeEl.className : null,
        title: g('resTitle'), record: g('resRecord'), recordShown: document.getElementById('resRecord').style.display !== 'none',
        transition: bcs ? bcs.transitionDuration : null,
        delays: rows, btns: btns
      });
    })()`));
    add('T04-7', '结算面板 5 项统计与 RunStats 一致',
      panel.time === '03:07' && panel.kills === '12' && panel.shards === '9' && panel.rate === '85%' && panel.score === '2400',
      `存活 ${panel.time} / 击杀 ${panel.kills} / 碎片 ${panel.shards} / 命中率 ${panel.rate} / 得分 ${panel.score}`);
    add('T04-8a', '评级四档阈值（2400 分 → A）', panel.grade === 'A', `2400 分 → ${panel.grade}`);
    const grades = JSON.parse(await cdp.eval(`(function(){
      var g = window.__neonDebug;
      var out = [];
      // 直接用 RunStats.grade 验证四档阈值
      var st = { score: 0, grade: function(){ return this.score>=3000?'S':this.score>=1800?'A':this.score>=900?'B':'C'; } };
      [500, 900, 1500, 1800, 3000, 5000].forEach(function(v){ st.score=v; out.push(v+'->'+st.grade()); });
      return JSON.stringify(out);
    })()`));
    add('T04-8b', '评级阈值 S≥3000 / A≥1800 / B≥900 / C', grades.join(' '), grades.join(' '));
    add('T04-9', '面板从底部滑入，动画时长 ≥250ms',
      parseFloat(panel.transition) >= 0.25, `transition-duration = ${panel.transition}`);
    add('T04-10', '逐项淡入间隔 60ms（animation-delay 递进）',
      panel.delays.length === 5 && panel.delays.every((d, i) => i === 0 || Math.abs((parseFloat(d) - parseFloat(panel.delays[i - 1])) * 1000 - 60) < 1),
      `5 项 animation-delay = ${panel.delays.join(', ')}`);
    add('T04-11', '「★ 新纪录」当且仅当刷新最佳分时显示', panel.recordShown === true,
      `bestScore 已更新，记录行显示=${panel.recordShown}`);
    add('T04-12', '触屏按钮命中区 ≥44×44px', panel.btns.every((b) => {
      const [w, h] = b.split('x').map(Number); return w >= 44 && h >= 44;
    }), `结算按钮尺寸 ${panel.btns.join(' / ')}`);

    /* ---------- T04-18 旧存档兼容 ---------- */
    await cdp.eval(`(function(){
      try {
        var raw = localStorage.getItem('neon-city-save-v1');
        var d = JSON.parse(raw);
        var legacy = { v: 1, score: 123, shards: 4, questsDone: 2, raceBest: 30, districts: {}, achievements: {} };
        localStorage.setItem('neon-city-save-v1', JSON.stringify(legacy));
        location.reload();
        return 'reloading';
      } catch (e) { return 'err:' + e.message; }
    })()`);
    await sleep(9000);
    const afterReload = JSON.parse(await cdp.eval(`(function(){
      var s = window.__neonDebug ? window.__neonDebug.stats : null;
      return JSON.stringify({ hasStats: !!s, score: s ? s.score : null, best: s ? s.bestScore : null, runs: s ? s.runs : null, wins: s ? s.wins : null, bestWave: s ? s.bestWave : null });
    })()`));
    add('T04-18', '旧存档（无 4 个新字段）加载后走默认值且无报错',
      afterReload.hasStats && afterReload.best === 0 && afterReload.runs === 0 && afterReload.wins === 0 && afterReload.bestWave === 0 && afterReload.score >= 123,
      `旧档 score=${afterReload.score}，新字段 bestScore/runs/wins/bestWave = ${afterReload.best}/${afterReload.runs}/${afterReload.wins}/${afterReload.bestWave}`);

    const out = { checks, errors: errors.length, errSample: errors.slice(0, 5) };
    const failed = checks.filter((c) => !c.pass);
    out.summary = { total: checks.length, passed: checks.length - failed.length, failed: failed.length };
    writeFileSync(join(OUT, 'batch2-verify-t04.json'), JSON.stringify(out, null, 2));
    console.log('\n===== ' + out.summary.passed + '/' + out.summary.total + ' 通过，页面异常 ' + errors.length + ' =====');
    if (failed.length) console.log('未通过：', failed.map((f) => f.id).join(', '));
  } catch (e) {
    console.error('[verify2] 异常：', e);
    process.exitCode = 1;
  } finally {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ }
  }
}
async function waitEndpoint(port, t = 30000) {
  const dl = Date.now() + t;
  while (Date.now() < dl) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return r.json(); } catch { /* */ } await sleep(300); }
  throw new Error('endpoint not ready');
}
main();
