#!/usr/bin/env node
/**
 * grain-compare.mjs —— grain 层「mix-blend-mode: screen vs 普通叠加」的零视觉劣化验证
 *
 * 用途：证明把 `#crt::after` 的 `mix-blend-mode: screen` 换成预乘半透明叠加
 * 之后，画面差异在像素风下不可见。这是「性能与体验不允许降级」这条硬约束的验收门。
 *
 * 方法（沿用 batch1-diff.mjs 的思路，关键是第 3 条）：
 *   1. PSNR + 最大像素差 + MAE
 *   2. 边缘锐度（梯度能量）——「像素风被糊掉」的直接度量
 *   3. **「整体平移 1px」基准 PSNR** —— 差异必须**小于**一个像素的抖动才算是不可见。
 *      没有这条基准，PSNR 33dB 到底是"看不出来"还是"有点糊"根本无从判断。
 *   4. 纯色区 RMS —— 排除整体发灰/色彩漂移
 *
 * 两张截图必须是**同一确定性画面**：冻结玩家位置、冻结 grain 动画相位。
 * grain 是无限动画（steps(6) / 0.6s），不锁相位的话两次截图的噪点图案根本不同。
 *
 * 用法：node grain-compare.mjs --url http://127.0.0.1:8200/
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, '..', 'shots');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const URL_ = arg('url', 'http://127.0.0.1:8200/');
const PORT = Number(arg('port', 9740));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 最小 PNG 解码（8bit RGB/RGBA/灰度，5 种过滤器） ---------- */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8, w = 0, h = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8) throw new Error('只支持 8bit'); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * bpp);
  const stride = w * bpp;
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev ? prev[x] : 0, c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

/* ---------- 差异度量 ---------- */
function metrics(A, B) {
  const n = A.w * A.h;
  const step = A.bpp;
  let se = 0, sae = 0, maxDiff = 0, countMax = 0;
  for (let i = 0; i < n; i++) {
    const o = i * step;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(A.data[o + c] - B.data[o + c]);
      se += d * d; sae += d;
      if (d > maxDiff) { maxDiff = d; countMax = 1; } else if (d === maxDiff) countMax++;
    }
  }
  const mse = se / (n * 3);
  const psnr = mse === 0 ? Infinity : 20 * Math.log10(255 / Math.sqrt(mse));
  return { psnr, mae: sae / (n * 3), maxDiff, countMax, mse };
}

/** 梯度能量（锐度）。像素风被糊掉时这个值会明显下降 */
function sharpness(A) {
  let g = 0, n = 0;
  for (let y = 1; y < A.h - 1; y++) {
    for (let x = 1; x < A.w - 1; x++) {
      const o = (y * A.w + x) * A.bpp;
      const l = A.data[o] * 0.299 + A.data[o + 1] * 0.587 + A.data[o + 2] * 0.114;
      const ol = (y * A.w + x - 1) * A.bpp;
      const or_ = (y * A.w + x + 1) * A.bpp;
      const ll = A.data[ol] * 0.299 + A.data[ol + 1] * 0.587 + A.data[ol + 2] * 0.114;
      const lr = A.data[or_] * 0.299 + A.data[or_ + 1] * 0.587 + A.data[or_ + 2] * 0.114;
      g += Math.abs(lr - ll); n++;
    }
  }
  return g / n;
}

/** 把 A 整体平移 1px 后与 B 比 —— 作为「差异有多大才算可见」的基准 */
function shiftPsnr(A, B) {
  let se = 0, n = 0;
  for (let y = 0; y < A.h; y++) {
    for (let x = 1; x < A.w; x++) {
      const o = (y * A.w + x) * A.bpp, os = (y * A.w + x - 1) * A.bpp;
      for (let c = 0; c < 3; c++) { const d = A.data[os + c] - B.data[o + c]; se += d * d; n++; }
    }
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 20 * Math.log10(255 / Math.sqrt(mse));
}

/** 纯色区（低梯度区）的 RMS —— 排除整体发灰/色彩漂移 */
function flatRms(A, B) {
  let se = 0, n = 0;
  for (let y = 1; y < A.h - 1; y += 2) {
    for (let x = 1; x < A.w - 1; x += 2) {
      const o = (y * A.w + x) * A.bpp;
      const g = Math.abs(A.data[o] - A.data[o + A.bpp]) + Math.abs(A.data[o] - A.data[o + A.bpp * A.w]);
      if (g > 24) continue;   // 有边缘，跳过
      for (let c = 0; c < 3; c++) { const d = A.data[o + c] - B.data[o + c]; se += d * d; n++; }
    }
  }
  return n ? Math.sqrt(se / n) : 0;
}

/* ---------- CDP ---------- */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map();
    ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id !== undefined && this.p.has(m.id)) { const h = this.p.get(m.id); this.p.delete(m.id); m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result); } }); }
  send(m, p = {}) { const id = (this.id += 1); return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + m)); } }, 90000); }); }
  async eval(x, safe) { try { const r = await this.send('Runtime.evaluate', { expression: x, returnByValue: true }); if (r.exceptionDetails) { if (safe !== undefined) return safe; throw new Error('eval ' + (r.exceptionDetails.text || '')); } return r.result ? r.result.value : undefined; } catch (e) { if (safe !== undefined) return safe; throw e; } }
}
async function waitEp(port, t = 30000) { const dl = Date.now() + t; while (Date.now() < dl) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return r.json(); } catch { /* */ } await sleep(300); } throw new Error('no ep'); }

async function shot(cdp, path) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path, Buffer.from(r.data, 'base64'));
  return path;
}

async function main() {
  try { spawn('taskkill', ['/F', '/IM', 'msedge.exe', '/T'], { stdio: 'ignore' }); } catch { /* */ }
  await sleep(4000);
  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + join(__dirname, '.edge-gr' + Date.now()),
    '--window-size=1280,720', '--mute-audio', '--no-first-run', '--disable-extensions',
    '--use-gl=angle', '--use-angle=d3d11', 'about:blank'], { stdio: 'ignore' });
  try {
    await waitEp(PORT);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: URL_ });
    for (let i = 0; i < 50; i++) { await sleep(700); if (await cdp.eval("(function(){try{var b=document.getElementById('enter');return !!(b&&b.disabled===false);}catch(e){return false;}})()", false)) break; }
    await cdp.eval("(function(){try{var b=document.getElementById('enter');if(b){b.disabled=false;b.click();}}catch(e){}return 1;})()", 0);
    for (let i = 0; i < 25; i++) { await sleep(400); if (await cdp.eval('!!window.__neonDebug', false) === true) break; }
    await sleep(3000);

    // ---- 锁定确定性画面：玩家位置、场景时间、grain 动画相位全部冻结 ----
    const frozen = await cdp.eval(`(function(){
      try {
        var c = window.__neonDebug.city2d;
        c.enemies.reset(); c.waves.freeze();
        c.player.x = 400; c.player.y = c.FEET; c.player.vx = 0; c.player.vy = 0; c.player.face = 1;
        c.cam.x = c.player.x - c.W * 0.5; c.intro = 1; c.time = 3.0;
        // 真正停住渲染：只冻玩家坐标是不够的，主循环还在跑，
        // CRT 闪烁 / 雨 / 蒸汽 / 噪点相位都在变，两次截图的差异会被运动淹没。
        window.__neonDebug.stopLoop();
        var st = document.createElement('style');
        st.id = 'freezeGrain';
        st.textContent = '*,*::before,*::after{animation-play-state:paused!important}';
        document.head.appendChild(st);
        window.__neonDebug.renderOnce();
        return 'frozen';
      } catch (e) { return 'ERR ' + e.message; }
    })()`, 'err');
    console.log('画面冻结: ' + frozen);
    await sleep(1800);   // 等所有 transition 跑完，否则两次截图的布局高度不同

    const blend = await cdp.eval("(function(){var e=document.getElementById('crt');return e?getComputedStyle(e,'::after').mixBlendMode:'n/a';})()", 'n/a');
    console.log('grain mix-blend-mode = ' + blend);
    console.log('');

    // A：现状（screen）
    await cdp.eval("(function(){window.__neonDebug.renderOnce();return 1;})()", 0);
    await sleep(900);
    const a = await shot(cdp, join(SHOTS, 'grain-a-screen.png'));
    // B：去掉 mix-blend-mode（模拟优化后的效果）
    if (!args.includes('--null-test')) await cdp.eval("(function(){var s=document.createElement('style');s.textContent='#crt::after{mix-blend-mode:normal!important}';document.head.appendChild(s);return 1;})()", 0);
    await sleep(900);
    const b = await shot(cdp, join(SHOTS, 'grain-b-normal.png'));

    const A = decodePng(readFileSync(a));
    const B = decodePng(readFileSync(b));
    if (A.w !== B.w || A.h !== B.h) throw new Error(`尺寸不一致 ${A.w}x${A.h} vs ${B.w}x${B.h}`);
    if (A.w !== 1280 || A.h !== 720) console.log(`⚠️ 截图尺寸 ${A.w}x${A.h}，与视口不符`);

    const m = metrics(A, B);
    const sA = sharpness(A), sB = sharpness(B);
    const shift = shiftPsnr(A, B);
    const flat = flatRms(A, B);

    console.log(args.includes('--null-test') ? '=== 零测试（两次截图之间什么都不改）===' : '=== grain screen → normal 画面差异 ===');
    console.log(`  尺寸          ${A.w}x${A.h}`);
    console.log(`  PSNR          ${m.psnr === Infinity ? '∞' : m.psnr.toFixed(2) + ' dB'}`);
    console.log(`  「平移1px」基准 ${shift === Infinity ? '∞' : shift.toFixed(2) + ' dB'}   ← 差异必须明显高于这个数才算不可见`);
    console.log(`  MAE           ${m.mae.toFixed(3)} / 255`);
    console.log(`  最大像素差    ${m.maxDiff}（${m.countMax} 个通道）`);
    console.log(`  锐度         ${sA.toFixed(3)} → ${sB.toFixed(3)}  (${(((sB - sA) / sA) * 100).toFixed(2)}%)`);
    console.log(`  纯色区 RMS    ${flat.toFixed(3)}`);

    const ok = [];
    const bad = [];
    if (m.psnr > shift + 3) ok.push(`PSNR ${m.psnr.toFixed(1)}dB 比「平移1px」基准 ${shift.toFixed(1)}dB 高 ${(m.psnr - shift).toFixed(1)}dB（差异量级 < 1 像素）`);
    else bad.push(`PSNR ${m.psnr.toFixed(1)}dB 没能显著超过「平移1px」基准 ${shift.toFixed(1)}dB`);
    if (Math.abs((sB - sA) / sA) < 0.02) ok.push(`锐度变化 ${(((sB - sA) / sA) * 100).toFixed(2)}%（未变糊）`);
    else bad.push(`锐度变化 ${(((sB - sA) / sA) * 100).toFixed(2)}%，超过 2% 阈值（画面被糊）`);
    if (flat < 1.0) ok.push(`纯色区 RMS ${flat.toFixed(3)} < 1.0（无整体发灰 / 色彩漂移）`);
    else bad.push(`纯色区 RMS ${flat.toFixed(3)} ≥ 1.0（可能有整体色彩漂移）`);

    console.log('');
    console.log('判据：');
    ok.forEach((r) => console.log('  ✔ ' + r));
    bad.forEach((r) => console.log('  ✘ ' + r));
    console.log('');
    console.log(bad.length === 0
      ? 'PASS · 换成普通叠加后差异小于一个像素，像素风下不可见'
      : 'FAIL · 达不到零视觉劣化，按约定放弃这条优化');

    writeFileSync(join(SHOTS, 'grain-compare.json'), JSON.stringify({
      viewport: A.w + 'x' + A.h, blendBefore: blend,
      psnr: m.psnr, psnrShift1px: shift, mae: m.mae, maxDiff: m.maxDiff, countMax: m.countMax,
      sharpBefore: +sA.toFixed(3), sharpAfter: +sB.toFixed(3), flatRms: flat,
      ok, bad, verdict: bad.length === 0 ? 'PASS' : 'FAIL',
    }, null, 2));
    console.log('\n对比图: shots/grain-a-screen.png / shots/grain-b-normal.png');
    console.log('写入 shots/grain-compare.json');
  } catch (e) { console.error('[grain-compare] 异常：', e); process.exitCode = 1; }
  finally { try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ } }
}
main();
