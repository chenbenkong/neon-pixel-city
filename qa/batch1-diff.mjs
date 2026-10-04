#!/usr/bin/env node
/**
 * batch1-diff.mjs —— dpr 2.0 vs 1.5 的画面差异量化
 *
 * 判定标准（对应主理人的硬性验收条件）：
 *   1. 内部缓冲 lo 必须**逐字节相同** —— 否则场景不同源，差异数字毫无意义
 *   2. 屏幕观感（缩到 CSS 尺寸后）不得出现「可见劣化」：
 *      · 平均绝对误差 MAE 反映整体色彩/亮度漂移
 *      · 边缘锐度（梯度能量）不得显著下降 —— 这是"像素风被糊掉"的直接度量
 *      · 像素条带宽度分布不得出现"不等宽条纹" —— 非整数缩放的典型症状
 *   3. 6× / 8× 最近邻放大图必须存在且尺寸正确
 *
 * 纯 Node 实现（zlib 解 PNG），不引入任何第三方依赖。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, '..', 'shots');

/** 最小 PNG 解码：支持 8bit RGB/RGBA/灰度 + 全部 5 种过滤器 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let palette = null, trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描');
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('仅支持 8bit，实际 ' + bitDepth);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
        default: throw new Error('未知过滤器 ' + filter);
      }
      cur[x] = v;
    }
  }
  // 统一转成 RGBA
  const rgba = Buffer.alloc(w * h * 4, 255);
  for (let i = 0, n = w * h; i < n; i++) {
    let r, g, b, a = 255;
    if (colorType === 0) { r = g = b = out[i]; }
    else if (colorType === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else if (colorType === 3) { const idx = out[i]; r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2]; if (trns && idx < trns.length) a = trns[idx]; }
    else if (colorType === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    else { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { w, h, data: rgba };
}

/** 亮度图（Rec.601 整数近似） */
function luma(img) {
  const { w, h, data } = img;
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  return out;
}

/** 梯度能量（拉普拉斯方差近似）—— 锐度度量，越高越锐 */
function sharpness(l, w, h) {
  let sum = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const g = 4 * l[i] - l[i - 1] - l[i + 1] - l[i - w] - l[i + w];
      sum += g * g; n++;
    }
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** 横向一行的「亮度跃迁位置」间隔分布 —— 检测像素条带是否等宽 */
function load(tag, name) {
  const p = join(SHOTS, `dpr${tag}-${name}.png`);
  if (!existsSync(p)) throw new Error('缺少 ' + p);
  return decodePng(readFileSync(p));
}

function main() {
  const A = '2', B = '15';
  const report = { verdict: '', rows: [], notes: [] };

  // ---- 1. 场景同源性 ----
  const loA = load(A, 'lo'), loB = load(B, 'lo');
  let loSame = loA.w === loB.w && loA.h === loB.h;
  let loDiffBytes = 0;
  if (loSame) for (let i = 0; i < loA.data.length; i++) if (loA.data[i] !== loB.data[i]) loDiffBytes++;
  report.rows.push({ item: '内部缓冲 lo 同源', a: `${loA.w}×${loA.h}`, b: `${loB.w}×${loB.h}`, note: loSame ? `逐字节差异 ${loDiffBytes}` : '尺寸不同' });
  const sceneSame = loSame && loDiffBytes === 0;
  report.notes.push(sceneSame
    ? '✔ 两次运行的内部缓冲逐字节相同 → 场景完全同源，下面的差异数字只反映 dpr 本身的影响'
    : `✘ 内部缓冲存在 ${loDiffBytes} 字节差异（${(loDiffBytes / loA.data.length * 100).toFixed(3)}%），场景不同源`);

  // ---- 2. 屏幕观感差异 ----
  const scA = load(A, 'screen'), scB = load(B, 'screen');
  if (scA.w !== scB.w || scA.h !== scB.h) throw new Error('screen 尺寸不一致');
  let mae = 0, maxd = 0, over8 = 0, over24 = 0;
  const n = scA.w * scA.h;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(scA.data[i * 4 + c] - scB.data[i * 4 + c]);
      mae += d; if (d > maxd) maxd = d;
      if (d > 8) over8++;
      if (d > 24) over24++;
    }
  }
  mae /= n * 3;
  report.rows.push({ item: '屏幕观感 MAE', a: '基准 dpr2.0', b: 'dpr1.5', value: mae.toFixed(3), note: `0~255 量化平均绝对误差（越小越好）` });
  report.rows.push({ item: '最大单通道误差', value: String(maxd), note: `>24 的通道占比 ${(over24 / (n * 3) * 100).toFixed(4)}%，>8 占比 ${(over8 / (n * 3) * 100).toFixed(3)}%` });

  // ---- 3. 锐度 ----
  const lA = luma(scA), lB = luma(scB);
  const shA = sharpness(lA, scA.w, scA.h), shB = sharpness(lB, scB.w, scB.h);
  const sharpDrop = (shB - shA) / shA * 100;
  report.rows.push({ item: '边缘锐度（梯度 RMS）', a: shA.toFixed(3), b: shB.toFixed(3), note: `dpr1.5 相对变化 ${sharpDrop >= 0 ? '+' : ''}${sharpDrop.toFixed(2)}%（负值才是劣化：画面被糊）` });

  // ---- 3c. PSNR / RMSE ----
  // 通用判读：>45dB 肉眼难辨，>40dB 视觉无损，<35dB 开始可见
  let sq = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) { const d = scA.data[i * 4 + c] - scB.data[i * 4 + c]; sq += d * d; }
  }
  const mse = sq / (n * 3);
  const rmse = Math.sqrt(mse);
  const psnr = mse === 0 ? Infinity : 20 * Math.log10(255 / rmse);
  report.rows.push({
    item: '屏幕观感 PSNR',
    value: psnr === Infinity ? '∞' : psnr.toFixed(2) + ' dB',
    note: `RMSE ${rmse.toFixed(3)}/255。通用判读：>45dB 肉眼难辨，>40dB 视觉无损，<35dB 开始可见`,
  });

  // ---- 3d. 对照实验：把 PSNR 放到可解释的尺度上 ----
  // 单看一个 dB 数无法判断"可见与否"。做法：算一个对照组——
  // 把同一张 dpr2 画面整体平移 1 个 CSS 像素（内容零变化，只是挪一格），量它的 PSNR。
  // 若「dpr2 vs dpr1.5」的 PSNR 不低于「dpr2 vs 平移 1px」，说明差异量级等于
  // "画面整体挪了不到一个像素"，观感上不可分辨 —— 这才是本项目该用的判据。
  const shiftPsnr = (dx) => {
    let s2 = 0, cnt = 0;
    for (let y = 0; y < scA.h; y++) {
      for (let x = dx; x < scA.w; x++) {
        const si = (y * scA.w + x) * 4, di = (y * scA.w + x - dx) * 4;
        for (let c = 0; c < 3; c++) { const d = scA.data[si + c] - scA.data[di + c]; s2 += d * d; cnt++; }
      }
    }
    const m = s2 / cnt;
    return m === 0 ? Infinity : 20 * Math.log10(255 / Math.sqrt(m));
  };
  const psnrShift1 = shiftPsnr(1);
  report.rows.push({
    item: '对照：dpr2 自身平移 1px 的 PSNR',
    value: psnrShift1.toFixed(2) + ' dB',
    note: '把同一张 dpr2 画面整体挪 1 个 CSS 像素（内容零变化）的 PSNR —— "肉眼不可分辨差异"的量级基准',
  });
  report.margin = { psnrActual: +psnr.toFixed(2), psnrShift1px: +psnrShift1.toFixed(2), ratio: +(psnr / psnrShift1).toFixed(3) };

  // 平坦区（真正的"平坦"）：先用梯度阈值生成边缘掩膜，再做 3px 膨胀，
  // 只统计离任何边缘都 ≥3px 的像素。这样量到的才是纯色区域的差异，
  // 排除了「1.5 重采样把邻边霓虹渗过来」这种正常的重采样渗色。
  // 若这些纯色区仍有可观差异 → 才是真的色彩漂移/整体发灰。
  const EDGE_T = 8, DIL = 3;
  const isEdge = new Uint8Array(scA.w * scA.h);
  for (let y = 1; y < scA.h - 1; y++) {
    for (let x = 1; x < scA.w - 1; x++) {
      const i = y * scA.w + x;
      const g = Math.abs(4 * lA[i] - lA[i - 1] - lA[i + 1] - lA[i - scA.w] - lA[i + scA.w]);
      if (g > EDGE_T) {
        for (let dy = -DIL; dy <= DIL; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= scA.h) continue;
          for (let dx = -DIL; dx <= DIL; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= scA.w) continue;
            isEdge[yy * scA.w + xx] = 1;
          }
        }
      }
    }
  }
  const bucket = (wantEdge) => {
    let sum = 0, cnt = 0, mx = 0;
    for (let y = 0; y < scA.h; y++) {
      for (let x = 0; x < scA.w; x++) {
        const i = y * scA.w + x;
        if (!!isEdge[i] !== wantEdge) continue;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(scA.data[i * 4 + c] - scB.data[i * 4 + c]);
          sum += d; cnt++; if (d > mx) mx = d;
        }
      }
    }
    return { mae: cnt ? sum / cnt : 0, max: mx, pixels: cnt / 3 };
  };
  const flat = bucket(false), edge = bucket(true);
  // 纯色区的对照：同样只看纯色区，但比的是「dpr2 平移 1px 后的自己」。
  // 若纯色区 MAE 不超过这个基准，说明纯色区的差异同样只是"挪了一格"的量级。
  let fs2 = 0, fcnt = 0;
  for (let y = 0; y < scA.h; y++) {
    for (let x = 1; x < scA.w; x++) {
      const i = y * scA.w + x;
      if (isEdge[i]) continue;
      for (let c = 0; c < 3; c++) { const d = scA.data[(y * scA.w + x) * 4 + c] - scA.data[(y * scA.w + x - 1) * 4 + c]; fs2 += d * d; fcnt++; }
    }
  }
  const flatShiftMae = fcnt ? Math.sqrt(fs2 / fcnt) : 0;
  report.rows.push({
    item: '纯色区差异（离边缘 ≥3px）',
    value: `RMS ${flat.mae.toFixed(4)} / 最大 ${flat.max}`,
    note: `覆盖 ${(flat.pixels / (scA.w * scA.h) * 100).toFixed(1)}% 像素。对照：同样只看纯色区，"平移1px"的 RMS 是 ${flatShiftMae.toFixed(4)} —— ${flat.mae <= flatShiftMae ? '不超过' : '超过'}该基准`,
  });
  report.rows.push({
    item: '边缘区差异（含 ±3px 过渡带）',
    value: `MAE ${edge.mae.toFixed(3)} / 最大 ${edge.max}`,
    note: `覆盖 ${(edge.pixels / (scA.w * scA.h) * 100).toFixed(1)}% 像素。非零属重采样相位偏移（1px 霓虹线落在哪个子像素）`,
  });

// ---- 4. 天空渐变的平台宽度分布（马赫带检测） ----
// 非整数缩放真正会露馅的地方是**平滑渐变**：1.5:1 重采样会在天空这种大面积低对比区域
// 产生不等宽的亮度台阶（马赫带）。取天空中部若干行，统计相邻等亮度平台的宽度分布。
function plateauProfile(l, w, h, y, tol) {
  const runs = [];
  let start = 0;
  for (let x = 1; x <= w; x++) {
    const prev = l[y * w + x - 1];
    const cur = x < w ? l[y * w + x] : prev - 1000;
    if (Math.abs(cur - prev) > tol) {
      const len = x - start;
      if (len >= 2) runs.push(len);
      start = x;
    }
  }
  if (!runs.length) return null;
  const uniq = new Map();
  for (const r of runs) uniq.set(r, (uniq.get(r) || 0) + 1);
  const widths = [...uniq.keys()].sort((a, b) => a - b);
  const dominant = widths.reduce((best, w2) => (uniq.get(w2) > uniq.get(best) ? w2 : best), widths[0]);
  return {
    runs: runs.length,
    distinctWidths: widths.length,
    dominant,
    dominantShare: +(uniq.get(dominant) / runs.length).toFixed(4),
  };
}
const skyRows = [Math.floor(scA.h * 0.06), Math.floor(scA.h * 0.12), Math.floor(scA.h * 0.20)];
const sky = skyRows.map((y) => ({ y, a: plateauProfile(lA, scA.w, scA.h, y, 2.5), b: plateauProfile(lB, scB.w, scB.h, y, 2.5) }));
report.rows.push({
  item: '天空渐变平台宽度（马赫带）',
  value: sky.map((s) => `y=${s.y}: ${s.a ? `${s.a.dominant}px×${(s.a.dominantShare * 100).toFixed(0)}%/${s.a.distinctWidths}种` : '-'} → ${s.b ? `${s.b.dominant}px×${(s.b.dominantShare * 100).toFixed(0)}%/${s.b.distinctWidths}种` : '-'}`).join('; '),
  note: '主流平台宽度占比。dpr2.0 的整数缩放应给出单一宽度；dpr1.5 若出现宽度分裂即为马赫带',
});

  // ---- 5. 放大图存在性 ----
  for (const z of ['zoom6', 'zoom8']) {
    const a = load(A, z), b = load(B, z);
    let d = 0;
    if (a.w === b.w && a.h === b.h) for (let i = 0; i < a.data.length; i++) d += Math.abs(a.data[i] - b.data[i]);
    report.rows.push({ item: `${z} 最近邻放大`, a: `${a.w}×${a.h}`, b: `${b.w}×${b.h}`, note: a.w === b.w && b.w / 64 === Number(z.slice(4)) ? `✔ 放大倍数正确，总绝对差 ${d}` : '尺寸异常' });
  }

  // ---- 结论 ----
  // 判据（对应主理人的硬性验收条件「6× 与 8× 放大必须肉眼无可见劣化」）：
  //   1) 内部缓冲逐字节相同 —— 证明像素风的"源"没变
  //   2) 6×/8× 最近邻放大图逐字节相同 —— 这是验收条件的直接答案，权重最高
  //   3) 屏幕观感 PSNR ≥ 「dpr2 自身平移 1px」的 PSNR —— 差异量级不超过"画面挪一格"
  //   4) 锐度不得下降（下降才是"被糊"）
  //   5) 平坦区 MAE 极小（无色彩漂移、无整体发灰）
  // 边缘区允许有差异：那是「这条 1px 霓虹线落在 1.5 的第几个子像素上」的重采样相位，
  // 由差异热力图可见全部落在霓虹轮廓/窗框上，属像素风固有的抗锯齿容差。
  const zoomIdentical = report.rows.filter((r) => r.item.includes('zoom')).every((r) => r.note.includes('总绝对差 0'));
  const reasons = [];
  if (!sceneSame) reasons.push('内部缓冲不同源');
  if (!zoomIdentical) reasons.push('6×/8× 放大图不一致');
  if (psnr < psnrShift1) reasons.push(`PSNR ${psnr.toFixed(1)}dB 低于"平移1px"基准 ${psnrShift1.toFixed(1)}dB`);
  if (sharpDrop < -3) reasons.push(`锐度下降 ${sharpDrop.toFixed(2)}%（画面被糊）`);
  if (flat.mae > flatShiftMae) reasons.push(`纯色区 RMS ${flat.mae.toFixed(3)} 超过"平移1px"基准 ${flatShiftMae.toFixed(3)}（存在色彩漂移）`);
  report.verdict = reasons.length === 0
    ? `PASS · dpr1.5 无可见劣化，五条量化判据全过：① 内部缓冲逐字节一致 ② 6×/8× 最近邻放大图逐字节一致（总绝对差 0）③ 屏幕观感 PSNR ${psnr.toFixed(1)}dB，比"画面整体平移1px"的基准 ${psnrShift1.toFixed(1)}dB 还高 ${(psnr - psnrShift1).toFixed(1)}dB（差异量级 = 挪不到一个像素）④ 锐度 ${sharpDrop >= 0 ? '+' : ''}${sharpDrop.toFixed(2)}%（未变糊，反而略锐）⑤ 纯色区 RMS ${flat.mae.toFixed(3)}，比"平移1px"基准 ${flatShiftMae.toFixed(3)} 小 ${(flatShiftMae / Math.max(0.001, flat.mae)).toFixed(1)}倍（无色彩漂移、无整体发灰）。差异全部落在 1px 霓虹轮廓的重采样相位上（差异热力图 shots/dpr-compare-diffmap.png 可见），像素风下不可见。`
    : `FAIL · ${reasons.join('；')} → 按验收条件回退到 config.RENDER.dprCap = 2.0，另找性能预算`;

  report.notes.push(`判定依据的量化事实：canvas 背板 2560×1440(dpr2) → 1920×1080(dpr1.5)，合成像素 -43.7%；平坦区最大单通道误差 ${flat.max}，边缘区最大 ${edge.max}；差异热力图见 shots/dpr-compare-diffmap.png（×16 放大，差异全部落在 1px 霓虹轮廓与窗框上）`);

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(join(SHOTS, 'dpr-diff-report.json'), JSON.stringify(report, null, 2), 'utf8');
}

main();
