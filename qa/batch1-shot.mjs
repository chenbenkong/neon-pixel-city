#!/usr/bin/env node
/**
 * batch1-shot.mjs —— dpr 上限 2.0 vs 1.5 的同场景截图对比探针
 *
 * 为什么必须做：dpr 上限从 2 降到 1.5 是「零降级」能否达成的关键杠杆
 * （1920×1080 合成像素 830 万 → 467 万，-43.7%），但它动了视觉。
 * 硬性验收条件：像素风最近邻插值下 6× 与 8× 放大必须肉眼无可见劣化，否则回退到 2.0。
 *
 * 真正的风险点（不是"内部缓冲被拉伸"，那两次完全一样）：
 *   内部缓冲 lo 是 W×H（与 dpr 无关），composite() 的第一次 drawImage 是
 *   imageSmoothingEnabled=false 的最近邻 → dpr 2 与 1.5 只是放大倍数不同，不会糊。
 *   风险在**浏览器合成器**：canvas backing store 1920×1080 缩到 CSS 1280×720 是 1.5:1
 *   的**非整数**缩放，走的是浏览器自己的重采样；dpr=2 时是 2:1 整数缩放。
 *   非整数缩放在像素风上会产生不等宽的像素条带与边缘软化 —— 这才是要测的东西。
 *
 * 因此本脚本测的是「屏幕上的最终观感」而不是内部缓冲：
 *   1. 确定性注入（固定 Math.random 种子 + 固定 60Hz 时间轴）→ 两次运行场景逐像素同源
 *   2. 固定 player.x / cam.x / time → 同一帧的同一场景
 *   3. 取合成后的 canvas，按浏览器合成器的方式缩到 CSS 尺寸 1280×720 = 屏幕观感
 *   4. 同时抓内部缓冲 lo 的原始像素，用于证明「场景内容确实同源」
 *   5. 输出 6× / 8× 最近邻放大的角色区裁切，供肉眼比对
 *
 * 用法：
 *   node build.mjs && node batch1-shot.mjs --tag 15
 *   NEON_DPR_CAP=2 node build.mjs && node batch1-shot.mjs --tag 2
 *   node batch1-diff.mjs        （比对两个 tag，输出结论）
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = __dirname.replace(/[\\/]qa$/, '');
const SHOTS = join(__dirname, '..', 'shots');
const PY = 'C:/Users/moli/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const TAG = arg('--tag', 'cur');
const PORT = Number(arg('--port', '8126'));
const CDP_PORT = Number(arg('--cdp', '9415'));
const CSS_W = 1280, CSS_H = 720, SEED = 0x9e3779b9;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[shot]', ...a);

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
        return;
      }
      if (m.method) (this.listeners.get(m.method) || []).forEach((f) => { try { f(m.params || {}); } catch { /* */ } });
    });
  }
  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); } }, 90000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || '') + ' ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 400));
    return r.result ? r.result.value : undefined;
  }
}

/** 确定性注入：固定随机数 + 固定时间轴 + 可手动泵帧的 rAF */
const DETERMINISM = `(function () {
  var s = ${SEED} >>> 0;
  Math.random = function () {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  var t = 0, STEP = 1000 / 60;
  performance.now = function () { return t; };
  var queue = [];
  window.requestAnimationFrame = function (cb) { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = function () {};
  window.__pump = function (frames) {
    for (var i = 0; i < frames; i++) {
      var q = queue; queue = [];
      t += STEP;
      for (var j = 0; j < q.length; j++) { try { q[j](t); } catch (e) { window.__rafErr = String(e); } }
    }
    return queue.length;
  };
  // 屏幕观感取样：把合成后的 canvas 按浏览器合成器的方式缩到 CSS 尺寸
  window.__grab = function (cssW, cssH) {
    var cv = document.getElementById('c2d');
    var out = document.createElement('canvas');
    out.width = cssW; out.height = cssH;
    var g = out.getContext('2d');
    g.imageSmoothingEnabled = true;          // 浏览器合成器默认开启平滑
    g.imageSmoothingQuality = 'high';
    g.drawImage(cv, 0, 0, cssW, cssH);
    return out.toDataURL('image/png');
  };
  // 内部缓冲原始像素（dpr 无关，用于证明场景同源）
  window.__grabLo = function () {
    var c = window.__neonDebug.city2d;
    return c.lo.toDataURL('image/png');
  };
  // 角色区最近邻放大：模拟像素风整数倍放大
  window.__grabZoom = function (k, w, h, ox, oy) {
    var c = window.__neonDebug.city2d;
    var p = c.player;
    var src = document.createElement('canvas');
    src.width = w; src.height = h;
    var sx = src.getContext('2d');
    sx.imageSmoothingEnabled = false;
    sx.drawImage(c.lo, Math.round(p.x - c.cam.x) - ox, Math.round(p.y) - oy, w, h, 0, 0, w, h);
    var out = document.createElement('canvas');
    out.width = w * k; out.height = h * k;
    var g = out.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(src, 0, 0, w * k, h * k);
    return out.toDataURL('image/png');
  };
})();`;

async function waitEndpoint(port, t = 30000) {
  const dl = Date.now() + t; let e = null;
  while (Date.now() < dl) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return await r.json(); }
    catch (er) { e = er; }
    await sleep(300);
  }
  throw new Error('endpoint not ready ' + (e && e.message));
}
async function getPageWs(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const p = list.find((t) => t.type === 'page');
  if (!p) throw new Error('no page target');
  return p.webSocketDebuggerUrl;
}
async function connectWs(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  return new Cdp(ws);
}

const savePng = (name, dataUrl) => writeFileSync(join(SHOTS, name), Buffer.from(String(dataUrl).split(',')[1], 'base64'));

async function main() {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

  const srv = spawn(PY, ['-m', 'http.server', String(PORT), '--directory', REPO], { stdio: 'ignore' });
  await sleep(1200);
  // --use-angle=d3d11 是必须的：缺了它 headless 会退回 SwiftShader 软件渲染，帧率与画面都不可信
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(__dirname, '.edge-shot-' + TAG)}`,
    '--window-size=1280,720', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--use-gl=angle', '--use-angle=d3d11', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    const ver = await waitEndpoint(CDP_PORT);
    log('Edge', ver['Browser']);
    const cdp = await connectWs(await getPageWs(CDP_PORT));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    const errors = [];
    cdp.listeners.set('Log.entryAdded', [(p) => { if (p.entry && p.entry.level === 'error') errors.push(p.entry.text); }]);
    cdp.listeners.set('Runtime.exceptionThrown', [(p) => errors.push('EXC ' + JSON.stringify((p.exceptionDetails || {}).text))]);

    // deviceScaleFactor=2 → window.devicePixelRatio = 2，dprCap 2 与 1.5 两条分支都会真正生效
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: CSS_W, height: CSS_H, deviceScaleFactor: 2, mobile: false });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: DETERMINISM });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    await sleep(9000);

    await cdp.eval(`(function(){var b=document.getElementById('enter');if(b){b.disabled=false;b.click();return 'clicked';}return 'no-btn';})()`);
    await sleep(600);

    const info = await cdp.eval(`(function(){
      var c = window.__neonDebug && window.__neonDebug.city2d;
      if (!c) return { err: 'no city2d' };
      var p = c.player;
      // 入场动画直接推到完成态：intro 控的是视差层滑入，未完成时街景还在画面外
      c.intro = 1;
      c.introDrop = false;
      p.x = 520; p.y = c.FEET; p.vx = 0; p.vy = 0; p.ground = true; p.face = 1;
      p.phase = 1.2; p.run = false;
      c.cam.x = p.x - c.W * 0.5;
      c.time = 7.5;
      // 泵若干帧让粒子/雨/车流进入稳态（固定步长 → 两次运行完全一致）
      window.__pump(90);
      c.render();
      return { W: c.W, H: c.H, canvasW: c.canvas.width, canvasH: c.canvas.height,
               dpr: window.devicePixelRatio, loW: c.lo.width, loH: c.lo.height,
               npcs: c.npcs.length, steam: c.steam.length, rain: c.backRain.length + c.frontRain.length,
               rafErr: window.__rafErr || null };
    })()`);
    log('scene', JSON.stringify(info));

    // 整屏截图（含 HUD）
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOTS, `dpr${TAG}-full.png`), Buffer.from(shot.data, 'base64'));

    // 屏幕观感（缩到 CSS 尺寸）
    savePng(`dpr${TAG}-screen.png`, await cdp.eval(`window.__grab(${CSS_W}, ${CSS_H})`));
    // 内部缓冲原始像素（证明场景同源）
    savePng(`dpr${TAG}-lo.png`, await cdp.eval('window.__grabLo()'));
    // 6× 与 8× 最近邻放大的角色区（64×48 覆盖角色与街景）
    savePng(`dpr${TAG}-zoom6.png`, await cdp.eval('window.__grabZoom(6, 64, 48, 24, 30)'));
    savePng(`dpr${TAG}-zoom8.png`, await cdp.eval('window.__grabZoom(8, 64, 48, 24, 30)'));

    writeFileSync(join(SHOTS, `dpr${TAG}-meta.json`), JSON.stringify({ tag: TAG, info, errors }, null, 2));
    log(`完成 → shots/dpr${TAG}-*.png  errors=${errors.length}`);
    if (errors.length) log('页面错误：', errors.slice(0, 5));
  } finally {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch { /* */ }
    try { spawn('taskkill', ['/F', '/T', '/PID', String(srv.pid)], { stdio: 'ignore' }); } catch { /* */ }
  }
}

main().catch((e) => { console.error('[shot] 失败：', e); process.exit(1); });
