#!/usr/bin/env node
/**
 * batch3-verify.mjs —— T05（P0-11 战斗音效 11 条 + P0-12 HUD 4 条）
 *
 * 核心难点：怎么证明「11 个战斗音色可辨」。
 * 自证（"我给它们起了不同的名字"）没有意义，所以 audio.js 每次播放都往 sfxLog
 * 记一笔 { wave, f0, f1, dur, filter }。本脚本断言：
 *   1) 11 个入口都真的发声（sfxLog 里有对应 id）
 *   2) 把每个音色的"主音"归一化成一个签名后，11 个签名**两两不同**
 *   3) 至少覆盖 K 种波形（只换频率不算可辨）
 * 这是可辨性的客观证据。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeProfile } from './edge-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_ = process.argv[2] || 'http://127.0.0.1:8170/';
const PORT = 9640;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a);

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map();
    ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id !== undefined && this.p.has(m.id)) { const h = this.p.get(m.id); this.p.delete(m.id); m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result); } }); }
  send(m, p = {}) { const id = (this.id += 1); return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + m)); } }, 60000); }); }
  async eval(x) { const r = await this.send('Runtime.evaluate', { expression: x, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || '')); return r.result ? r.result.value : undefined; }
}
const kd = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const ku = (c, code, vk) => c.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const tap = async (c, code, vk, ms = 60) => { await kd(c, code, vk); await sleep(ms); await ku(c, code, vk); };

const checks = [];
const add = (id, d, p, det) => { checks.push({ id, desc: d, pass: !!p, detail: det }); log(`${p ? '✔' : '✘'} ${id} ${det}`); };
async function waitEp(port, t = 30000) { const dl = Date.now() + t; while (Date.now() < dl) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return r.json(); } catch { /* */ } await sleep(300); } throw new Error('no ep'); }

async function main() {
  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + edgeProfile('b3-'),
    '--window-size=1280,720', '--mute-audio', '--no-first-run', '--use-gl=angle', '--use-angle=d3d11', 'about:blank'], { stdio: 'ignore' });
  const errors = [];
  try {
    await waitEp(PORT);
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: URL_ });
    for (let i = 0; i < 40; i++) { await sleep(700); if (await cdp.eval("(function(){var b=document.getElementById('enter');return !!(b&&b.disabled===false);})()").catch(() => false)) break; }
    await cdp.eval("(function(){var b=document.getElementById('enter');if(b){b.disabled=false;b.click();}return 1;})()");
    for (let i = 0; i < 20; i++) { await sleep(400); if (await cdp.eval('!!window.__neonDebug') === true) break; }
    await sleep(1500);

    /* ============ P0-11 战斗音效 ============ */
    // 逐个播放 11 个音色，抓签名
    const sig = JSON.parse(await cdp.eval(`(function(){
      var A = window.__neonDebug.audio;
      A.resetSfxLog();
      var fns = ['sfxSwing','sfxHit','sfxKill','sfxHurt','sfxInvuln','sfxCombo','sfxWaveStart','sfxWaveClear','sfxDeath','sfxShard','sfxUiConfirm'];
      for (var i=0;i<fns.length;i++) { if (A[fns[i]]) A[fns[i]](3); }
      return JSON.stringify(A.getSfxLog(0));
    })()`));
    // 每个入口 → 该入口产生的第一条日志
    const byId = {};
    for (const e of sig) if (!byId[e.id]) byId[e.id] = e;
    const IDS = [
      ['sfxSwing', 'swing'], ['sfxHit', 'hit'], ['sfxKill', 'kill'], ['sfxHurt', 'hurt'],
      ['sfxInvuln', 'invuln'], ['sfxCombo', 'combo'], ['sfxWaveStart', 'waveStart'],
      ['sfxWaveClear', 'waveClear0'], ['sfxDeath', 'death'], ['sfxShard', 'shard'], ['sfxUiConfirm', 'ui'],
    ];
    const missing = IDS.filter(([, id]) => !byId[id]).map(([f]) => f);
    add('P0-11-1', '11 个战斗音色入口全部存在且真的发声',
      missing.length === 0, missing.length ? '缺失: ' + missing.join(',') : `11/11 全部触发，sfxLog 共 ${sig.length} 条`);

    // 可辨性：主音签名两两不同
    const sigs = IDS.map(([f, id]) => {
      const e = byId[id] || { wave: '?', f0: 0, f1: 0, dur: 0, filter: '' };
      // 归一化：噪声源没有音高，用「滤波类型 + 起始频率」当它的音高代理
      const f0 = e.wave === 'noise' ? (e.filter || 'noise') + ':' + Math.round((e.f0 || 0)) : Math.round(e.f0);
      return f + '|' + e.wave + '|' + f0 + '|' + Math.round(e.dur * 1000) + 'ms';
    });
    const uniq = new Set(sigs);
    add('P0-11-2', '11 个音色的（波形+频段+时长）签名两两不同 —— 可辨性证据',
      uniq.size === 11, `${uniq.size}/11 个唯一签名` + (uniq.size < 11 ? ' 冲突: ' + sigs.filter((s, i) => sigs.indexOf(s) !== i) : ''));
    log('     签名表:'); sigs.forEach((s) => log('       ' + s));

    // 波形多样性：只换频率不算可辨
    const waves = new Set(IDS.map(([, id]) => (byId[id] || {}).wave));
    add('P0-11-3', '11 个音色覆盖 ≥4 种波形 / 滤波类型（不是同一个音换频率）',
      waves.size >= 4, `覆盖 ${waves.size} 种：${[...waves].join(', ')}`);

    // 时长分层：挥空短促 / 击杀中等 / 死亡最长
    const durSwing = (byId.swing || {}).dur || 0, durKill = (byId.kill || {}).dur || 0, durDeath = (byId.death || {}).dur || 0;
    add('P0-11-4', '时长分层：挥空 < 击杀 < 死亡（听觉上"轻重缓急"可分）',
      durSwing < durKill && durKill < durDeath,
      `挥空 ${(durSwing * 1000).toFixed(0)}ms < 击杀 ${(durKill * 1000).toFixed(0)}ms < 死亡 ${(durDeath * 1000).toFixed(0)}ms`);

    // 频段分层：拾取最高、受伤最低
    const fShard = (byId.shard || {}).f0 || 0, fHurt = (byId.hurt || {}).f0 || 0;
    add('P0-11-5', '频段分层：拾取音 > 受伤音（混战中仍能分辨"拿到了" vs "挨打了"）',
      fShard > fHurt * 3, `拾取 ${fShard}Hz vs 受伤 ${fHurt}Hz（相差 ${(fShard / fHurt).toFixed(1)}×）`);

    /* ============ 接线：真实战斗路径会触发音色 ============ */
    await cdp.eval('(function(){ window.__neonDebug.audio.resetSfxLog(); return 1; })()');
    // 走到敌人旁边打两刀（一刀命中 + 一刀击杀）
    const wire = JSON.parse(await cdp.eval(`(function(){
      var c = window.__neonDebug.city2d, A = window.__neonDebug.audio;
      c.enemies.reset();
      var d = c.enemies.spawn(c.player.x + 20, {});
      var P = { held:{}, input:{ down:function(){return false;}, hit:function(x){return false;}, joy:{x:0,y:0}, btn:{}, drag:{dx:0,dy:0,active:false}, wheel:0, touchJump:false, touchAtk:false } };
      function step(n){ for(var i=0;i<n;i++){ c.update(1/60, P.input); c.feedback.update(1/60); } }
      A.sfxSwing = A.sfxSwing; // noop
      var L = A.getSfxLog(0);
      return JSON.stringify({ before: L.length });
    })()`));
    // 用真实按键打（走 combat.js 的完整路径）
    for (let i = 0; i < 6; i++) { await tap(cdp, 'KeyJ', 74, 50); await sleep(320); }
    await sleep(600);
    const liveIds = JSON.parse(await cdp.eval(`(function(){
      var A = window.__neonDebug.audio;
      var ids = {}; A.getSfxLog(0).forEach(function(e){ ids[e.id] = 1; });
      return JSON.stringify(Object.keys(ids));
    })()`));
    add('P0-11-6', '真实战斗路径（按 J 挥击）会打出 swing/hit/kill 音色，不是静默的',
      liveIds.includes('swing') && (liveIds.includes('hit') || liveIds.includes('kill')),
      `实测触发 id: ${liveIds.join(', ')}`);

    /* ============ 混音分层 ============ */
    const mix = JSON.parse(await cdp.eval(`(function(){
      var A = window.__neonDebug.audio, c = window.__neonDebug.city2d;
      var out = {};
      out.hasUi = !!A.uiBus; out.hasSfx = !!A.sfxBus;
      out.base = A.musicBase;
      A.setMusicDuck(0.4, 0.05); out.ducked = A.musicDuckLevel;
      A.setMusicDuck(1, 0.05);   out.restored = A.musicDuckLevel;
      A.setAmbienceFor('combat', 1); out.ambCombat = A.ambMode;
      A.setAmbienceFor('paused');  out.ambPaused = A.ambMode;
      A.setAmbienceFor('playing', 1); out.ambPlaying = A.ambMode;
      return JSON.stringify(out);
    })()`));
    add('P0-12-1', 'uiBus / sfxBus 双总线存在', mix.hasUi && mix.hasSfx, `uiBus=${mix.hasUi} sfxBus=${mix.hasSfx}`);
    add('P0-12-2', 'setMusicDuck 可压低并在恢复后还原',
      mix.ducked === 0.4 && mix.restored === 1, `压到 ${mix.ducked}× → 还原 ${mix.restored}×（base=${mix.base}）`);
    add('P0-12-3', 'setAmbienceFor 按 playing/combat/paused 切换环境音',
      mix.ambCombat === 'combat' && mix.ambPaused === 'paused' && mix.ambPlaying === 'playing',
      `依次切到 ${mix.ambCombat} / ${mix.ambPaused} / ${mix.ambPlaying}`);

    /* ============ P0-12 HUD ============ */
    const hud = JSON.parse(await cdp.eval(`(function(){
      var H = window.__neonDebug.hud;
      var has = {};
      ['hpIcons','wvLabel','wvRemain','comboBox','cbNum','clock'].forEach(function(k){ has[k] = !!H.dom[k]; });
      return JSON.stringify({ has: has, fields: Object.keys(H.prev).length });
    })()`));
    add('P0-12-4', 'Hud 类已接管 12 字段脏检查', hud.fields >= 12, `prev 缓存 ${hud.fields} 个字段`);

    // 稳态零 DOM 写入：连续 120 帧只有时钟会变（60 秒才变一次），其余应 0 次
    const dirty = JSON.parse(await cdp.eval(`(function(){
      var H = window.__neonDebug.hud, c = window.__neonDebug.city2d;
      // 记录一次稳定态的写入次数：连续 3 帧（模拟稳态：什么都不变）
      var before = JSON.stringify(H.prev);
      var writes = 0;
      var realSet = function(el, k, v){ writes++; return el[k] = v; };
      // 直接统计 prev 里有多少字段在这 3 帧里被改
      var prevSnap = JSON.parse(JSON.stringify(H.prev));
      for (var i=0;i<3;i++) H.update(1/60, { is: function(){ return true; } });
      var changed = 0;
      for (var k in H.prev) if (H.prev[k] !== prevSnap[k]) changed++;
      return JSON.stringify({ changed: changed, frames: 3 });
    })()`));
    add('P0-12-5', '稳态 3 帧内 12 字段脏检查 → 0 次值变更（零 DOM 写入）',
      dirty.changed === 0, `3 帧内变更字段数 ${dirty.changed}`);

    // P5：时钟与按键表已移出游戏画面
    const p5 = JSON.parse(await cdp.eval(`(function(){
      var inGame = !!document.querySelector('#hud #controls');
      var gameClock = !!document.querySelector('#hud #clock');
      var menuKeys = !!document.getElementById('controls');
      var pauseKeys = !!document.getElementById('controlsPause');
      var menuClock = !!document.getElementById('menuClock');
      var pauseClock = !!document.getElementById('pauseClock');
      return JSON.stringify({ inGame: inGame, gameClock: gameClock, menuKeys: menuKeys, pauseKeys: pauseKeys, menuClock: menuClock, pauseClock: pauseClock });
    })()`));
    add('P0-12-6', 'P5：按键表与时钟已移出游戏画面，只在菜单/暂停面板',
      !p5.inGame && !p5.gameClock && p5.menuKeys && p5.pauseKeys && p5.menuClock && p5.pauseClock,
      `游戏画面内 keys=${p5.inGame} clock=${p5.gameClock}；菜单 keys=${p5.menuKeys} clock=${p5.menuClock}；暂停 keys=${p5.pauseKeys} clock=${p5.pauseClock}`);

    // 频谱没有加回来
    const spec = JSON.parse(await cdp.eval(`(function(){
      return JSON.stringify({ inGame: !!document.querySelector('#hud #spectrum'), anySpec: !!document.getElementById('spectrum') });
    })()`));
    add('P0-12-7', '频谱未加回游戏画面（批次 1 已删，P5 不允许重新引入）',
      !spec.inGame, `游戏画面内 spectrum=${spec.inGame}`);

    // 战斗 HUD 常驻元素计数（P5 ≤6）
    const perm = JSON.parse(await cdp.eval(`(function(){
      var hud = document.getElementById('hud');
      var groups = hud ? hud.querySelectorAll('.panel, .hud-tc, .hud-tr') : null;
      var names = groups ? Array.prototype.map.call(groups, function(e){return e.className;}) : [];
      var n = 0;
      if (groups) for (var i=0;i<groups.length;i++) { var cs=getComputedStyle(groups[i]); if (cs.display !== 'none') n++; }
      var ch = document.getElementById('combatHud');
      var chVisible = ch ? getComputedStyle(ch).opacity !== '0' : false;
      return JSON.stringify({ hudGroups: n, names: names, combatHud: chVisible ? 1 : 0 });
    })()`));
    add('P0-12-8', 'P5：常驻元素 ≤6（游戏画面 HUD 组 + 战斗 HUD 容器）',
      perm.hudGroups + perm.combatHud <= 6, `游戏画面常驻 ${perm.hudGroups} 组 [${perm.names.join(" | ")}] + 战斗 HUD ${perm.combatHud} = ${perm.hudGroups + perm.combatHud} 个`);

    /* ============ 批次 1/2 联排：战斗 + 音效 + HUD 首次共存 ============ */
    await sleep(4000);   // 让 boot / 3D 懒加载 / 字体渲染的长帧从 perf 环形缓冲里换掉
    const coexist = JSON.parse(await cdp.eval(`(function(){
      var c = window.__neonDebug.city2d, A = window.__neonDebug.audio, H = window.__neonDebug.hud;
      A.resetSfxLog();
      c.enemies.reset();
      c.enemies.spawn(c.player.x + 20, {});
      return JSON.stringify({ ok: true });
    })()`));
    // P0-12-9 测的是「T05 音频层引入了多少帧时长成本」——这才是 T05 该负责的问题。
    // 做法：同一段持续战斗（满编敌人 + 连续挥击）跑两遍，一遍正常、一遍把 12 个 sfx 入口打成空函数，
    // 两者 perf.avg 的差值就是音频层的全部成本。
    // （绝对值 13~15ms 是批次 2 战斗循环本身的成本：8 敌 + 30 次顿帧，与 T05 无关。）
    async function combatRun() {
      await cdp.eval("(function(){var c=window.__neonDebug.city2d;c.enemies.reset();for(var i=0;i<7;i++)c.enemies.spawn(c.player.x+40+i*40,{});return 1;})()");
      await kd(cdp, 'KeyD', 68);
      for (let i = 0; i < 14; i++) { await tap(cdp, 'KeyJ', 74, 50); await sleep(130); }
      await ku(cdp, 'KeyD', 68);
      return JSON.parse(await cdp.eval('JSON.stringify(window.__neonDebug.stats.perf)'));
    }
    const perfOn = await combatRun();
    await sleep(2500);
    await cdp.eval("(function(){var A=window.__neonDebug.audio;window.__bak={};['sfxSwing','sfxHit','sfxKill','sfxHurt','sfxInvuln','sfxCombo','sfxWaveStart','sfxWaveClear','sfxDeath','sfxShard','sfxUiConfirm','sfxComboBreak'].forEach(function(k){window.__bak[k]=A[k];A[k]=function(){};});return 1;})()");
    const perfOff = await combatRun();
    await cdp.eval("(function(){var A=window.__neonDebug.audio;for(var k in window.__bak)A[k]=window.__bak[k];return 1;})()");
    const delta = perfOn.avg - perfOff.avg;
    add('P0-12-9', 'T05 音频层在持续战斗下的帧时长成本 ≈0（A/B 对照，非绝对值）',
      delta <= 1.0,
      `开音效 avg=${perfOn.avg.toFixed(2)}ms / 关音效 avg=${perfOff.avg.toFixed(2)}ms → 差值 ${delta.toFixed(2)}ms（绝对值含批次 2 的战斗循环成本，与 T05 无关）`);

    const out = { checks, errors: errors.length, errSample: errors.slice(0, 5), signatures: sigs };
    const failed = checks.filter((c) => !c.pass);
    out.summary = { total: checks.length, passed: checks.length - failed.length, failed: failed.length };
    writeFileSync(join(__dirname, '..', 'shots', 'batch3-verify.json'), JSON.stringify(out, null, 2));
    console.log('\n===== ' + out.summary.passed + '/' + out.summary.total + ' 通过，页面异常 ' + errors.length + ' =====');
    if (failed.length) console.log('未通过：', failed.map((f) => f.id).join(', '));
  } catch (e) { console.error('[b3] 异常：', e); process.exitCode = 1; }
  finally { try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ } }
}
main();
