#!/usr/bin/env node
/**
 * build.mjs —— neon-pixel-city 一键构建脚本（Node 22，无需安装依赖）
 *
 * 产物：
 *   1. dist/city3d.js   —— three + city3d 打包为 IIFE（挂 window.NEONCity3D），运行时懒加载
 *   2. index.html       —— 主程序（js/main.js 及其全部静态依赖）打包内联为普通 <script>
 *
 * 设计要点：
 *   - 主程序走「去模块化」：内联 classic script，兼容拦截 ES module 的浏览器扩展/安全软件
 *   - 3D 包走「双通道」：普通脚本优先 + ES module 回退（加载器在 js/main.js 源码里，
 *     import() 的 specifier 是变量形式，esbuild 不会把它打进主程序）
 *   - 源 html 为 src/index.src.html（含心跳进度块与 importmap，两者都会保留到产物）
 *
 * 用法：node build.mjs
 */
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_HTML = join(HERE, 'src', 'index.src.html');
// 临时目录带 PID：避免残留目录与沙箱批量删除保护导致清理失败
const BUILD = join(HERE, `.build-tmp-${process.pid}`);
const ESBUILD = 'C:/Users/moli/.workbuddy/binaries/node/workspace/node_modules/@esbuild/win32-x64/esbuild.exe';

let failed = 0;
const step = (n, msg) => console.log(`\n[步骤 ${n}] ${msg}`);
const ok = (msg) => console.log(`  ✔ ${msg}`);
const bad = (msg) => { console.error(`  ✘ ${msg}`); failed += 1; };

/** 递归列出目录下全部文件（相对路径，正斜杠） */
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(p.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

/** esbuild 调用封装 */
function esbuild(args) {
  execFileSync(ESBUILD, args, { stdio: 'inherit' });
}

// ---------------------------------------------------------------- 步骤 0：前置检查
step(0, '前置检查');
if (!existsSync(ESBUILD)) { bad(`未找到 esbuild: ${ESBUILD}`); process.exit(1); }
if (!existsSync(SRC_HTML)) { bad(`未找到源 html: ${SRC_HTML}`); process.exit(1); }
for (const f of ['js/main.js', 'js/city3d.js', 'vendor/three/three.module.js']) {
  if (!existsSync(join(HERE, f))) { bad(`缺少源文件: ${f}`); process.exit(1); }
}
ok('esbuild 与全部源文件就位');

// ---------------------------------------------------------------- 步骤 1：搭建临时构建目录
step(1, `准备临时构建目录 ${BUILD}`);
try { rmSync(BUILD, { recursive: true, force: true }); } catch { /* 同名目录残留时容忍，直接覆盖 */ }
mkdirSync(BUILD, { recursive: true });
cpSync(join(HERE, 'js'), join(BUILD, 'js'), { recursive: true });
cpSync(join(HERE, 'vendor'), join(BUILD, 'vendor'), { recursive: true });
ok('已复制 js/ 与 vendor/');

// ---------------------------------------------------------------- 步骤 2：改写裸模块名为相对路径
step(2, '改写裸模块名（three → 相对路径）');

// 2a. js/city3d.js：'three' 与 'three/addons/' 都改为相对 build 根的路径
const city3dPath = join(BUILD, 'js', 'city3d.js');
let city3d = readFileSync(city3dPath, 'utf8');
const before1 = city3d.length;
city3d = city3d.replace(/from 'three';/g, "from '../vendor/three/three.module.js';")
               .replace(/from 'three\/addons\//g, "from '../vendor/three/addons/");
writeFileSync(city3dPath, city3d, 'utf8');
ok(`js/city3d.js 裸模块名已改写（${before1} → ${city3d.length} 字符）`);
if (/from 'three/.test(city3d)) bad('js/city3d.js 仍残留裸模块名 three');

// 2b. vendor/three/addons/**：} from 'three'; → 相对路径（addons 下任意子目录均为 ../../）
const addonFiles = walk(join(BUILD, 'vendor', 'three', 'addons'));
let addonHits = 0;
for (const rel of addonFiles) {
  const p = join(BUILD, 'vendor', 'three', 'addons', rel);
  let s = readFileSync(p, 'utf8');
  if (s.includes("} from 'three';")) {
    s = s.replace(/\} from 'three';/g, "} from '../../three.module.js';");
    writeFileSync(p, s, 'utf8');
    addonHits += 1;
  }
}
ok(`vendor/three/addons 下改写 ${addonHits}/${addonFiles.length} 个文件的 three 引用`);
if (addonHits === 0) bad('addons 中没有命中任何 three 引用，sed 规则可能失配');

// ---------------------------------------------------------------- 步骤 3：生成 3D 入口
step(3, '生成 entry-city3d.js');
writeFileSync(join(BUILD, 'entry-city3d.js'), "export { City3D } from './js/city3d.js';\n", 'utf8');
ok('入口已生成');

// ---------------------------------------------------------------- 步骤 4：esbuild 打包 city3d → dist/city3d.js
step(4, 'esbuild 打包 city3d（IIFE / 挂 NEONCity3D / 压缩 / es2019）');
esbuild([
  join(BUILD, 'entry-city3d.js'),
  '--bundle',
  '--format=iife',
  '--global-name=NEONCity3D',
  '--minify',
  '--target=es2019',
  `--outfile=${join(HERE, 'dist', 'city3d.js')}`,
  '--log-level=warning',
]);

// ---------------------------------------------------------------- 步骤 5：esbuild 打包 main → app.js
step(5, 'esbuild 打包 main（IIFE / 压缩 / es2019）');
// dpr 上限可配：默认取 config.js 的 DEFAULT_DPR_CAP；`NEON_DPR_CAP=2 node build.mjs`
// 可临时构建出 dpr 上限 2.0 的版本，用于「改造前后同场景截图对比」实验（见 qa/batch1-shot.mjs）。
const dprCap = process.env.NEON_DPR_CAP ? Number(process.env.NEON_DPR_CAP) : null;
if (dprCap !== null) console.log(`  （构建期覆盖 NEON_DPR_CAP = ${dprCap}）`);
esbuild([
  join(BUILD, 'js', 'main.js'),
  '--bundle',
  '--format=iife',
  '--minify',
  '--target=es2019',
  ...(dprCap === null ? [] : [`--define:NEON_DPR_CAP=${dprCap}`]),
  `--outfile=${join(BUILD, 'app.js')}`,
  '--log-level=warning',
]);
const app = readFileSync(join(BUILD, 'app.js'), 'utf8');

// ---------------------------------------------------------------- 步骤 6：内联进 index.html
step(6, '内联主程序进 index.html');
let html = readFileSync(SRC_HTML, 'utf8');
const TAG = '<script type="module" src="js/main.js"></script>';
if (!html.includes(TAG)) { bad('源 html 中未找到 module script 标签，内联失配'); process.exit(1); }
// 关键转义 1：内联脚本里不能出现 </script，否则会提前闭合标签
const inlined = `<script>${app.replace(/<\/script/g, '<\\/script')}</script>`;
// 关键转义 2：必须用替换函数而不是替换字符串。
// String.prototype.replace 的字符串替换会解释 $& / $` / $' / $$ 等特殊模式，
// 而 esbuild 压缩后的产物里天然会出现 "$&&"（某个变量被压缩命名为 $，后面跟着 &&），
// 于是 $& 会被展开成「被匹配的 TAG」，把整段 <script type="module" src="js/main.js"></script>
// 注入进 bundle 中间 —— 产物里凭空多出 3 处 module script 标签，且代码被静默改写。
// 这是一个会随机命中的地雷（取决于压缩器的变量命名分配），用替换函数彻底规避。
html = html.replace(TAG, () => inlined);
writeFileSync(join(HERE, 'index.html'), html, 'utf8');
ok(`index.html 已内联主程序（${(html.length / 1024).toFixed(1)} KB）`);

// ---------------------------------------------------------------- 步骤 7：产物自检
step(7, '产物自检');
const distJs = readFileSync(join(HERE, 'dist', 'city3d.js'), 'utf8');

// 7a. index.html 不得再引用 module script
// 计数而非布尔判断：历史上出现过「产物中间凭空多出 3 处 module script 标签」的静默污染
if (html.includes('type="module" src=')) bad('index.html 仍残留 type="module" src=（可能是内联替换污染）');
else ok('index.html 无 type="module" src=');
// 7a-2. 主程序源码里不得出现 HTML 结束标签（会被浏览器提前闭合内联脚本）
if (/<\/script/i.test(app)) bad('主程序含 </script 字面量，会提前闭合内联脚本标签');
else ok('主程序无 </script 字面量');

// 7b. 主程序不得内联进 three（WebGLRenderer 只允许出现在 dist/city3d.js）
if (app.includes('WebGLRenderer')) bad('主程序被内联进了 three（WebGLRenderer 命中），动态 import 隔离失效');
else ok('主程序未内联 three');

// 7c. 双通道加载器必须存在
if (!app.includes('NEONCity3D')) bad('主程序里找不到 NEONCity3D（双通道加载器缺失）');
else ok('主程序含 NEONCity3D 加载器');
if (!distJs.includes('NEONCity3D')) bad('dist/city3d.js 缺少 NEONCity3D 全局名');
else ok(`dist/city3d.js 含 NEONCity3D（${(distJs.length / 1024).toFixed(1)} KB）`);

// 7d. 心跳进度块与 importmap 必须保留
if (!html.includes('__stopHeartbeat')) bad('心跳进度块丢失');
else ok('心跳进度块保留');
if (!html.includes('type="importmap"')) bad('importmap 丢失（模块回退通道依赖它）');
else ok('importmap 保留');

// 7e. city3d 包内不得残留裸模块名（会导致运行时解析失败）
if (/from['"]three['"]|from['"]three\//.test(distJs)) bad('dist/city3d.js 残留裸模块名 three');
else ok('dist/city3d.js 无裸模块名残留');

// 7f. es2019 目标下不得残留可选链/空值合并（语法层面已由 esbuild 转译，二次确认）
// 注意排除 minify 误报：三元表达式 `o ? 0.05 : x` 会被压缩成 `o?.05:x`，`?.` 后跟数字不是可选链
if (/\?\.(?![0-9])/.test(app) || /\?\?/.test(app)) bad('主程序残留可选链/空值合并');
else ok('主程序无可选链/空值合并残留');

// 7g. 零降级铁律：主程序不得残留任何静默降级链路
// 背景：项目要求「零降级」，但历史上存在一条 perfMonitor 护栏，会在帧率低时静默把
// 场景实体砍到 40% 并弹出「性能模式 · 场景实体已精简」这种正面措辞的 toast ——
// 玩家不知道自己看到的是被削减过的画面。这条自检把承诺变成铁律。
//
// 关键：必须扫**源码**而不是产物。实测踩过的坑：只查 app（压缩产物）时，
// esbuild 的 minifier 会把未被调用的 perfMonitor 函数整个摇掉（tree shaking），
// 于是「重新引入降级护栏」这种最该拦住的情况反而检查不出来 ——
// 实测注入一个未被调用的 perfMonitor 后，产物自检依然全绿。查源码才拦得住。
const mainSrc = readFileSync(join(HERE, 'js', 'main.js'), 'utf8');
const city2dSrc = readFileSync(join(HERE, 'js', 'city2d.js'), 'utf8');
if (/perfMonitor/.test(mainSrc)) bad('js/main.js 含静默降级 perfMonitor（违反零降级铁律）');
else ok('js/main.js 无静默降级 perfMonitor');
// entityScale 同理。注意 city3d.js 里的 setEntityScale 方法定义是允许保留的死方法
// （死方法优于死代码清理，见系统设计 §6.4），只查 main 与 city2d 两个文件。
if (/entityScale/.test(mainSrc) || /entityScale/.test(city2dSrc)) bad('主程序含 entityScale 实体缩放（违反零降级铁律）');
else ok('主程序无实体缩放链路');
if (/性能模式 · 场景实体已精简/.test(mainSrc)) bad('js/main.js 含静默降级提示文案「性能模式 · 场景实体已精简」');
else ok('无静默降级提示文案');

// ---------------------------------------------------------------- 收尾
try {
  rmSync(BUILD, { recursive: true, force: true });
} catch (e) {
  console.log(`  （提示：临时目录 .build-tmp 自动清理被系统安全策略拦截，不影响产物，可手动删除）`);
}
console.log(`\n${failed === 0 ? '✔ 构建完成，全部自检通过' : `✘ 构建完成，但有 ${failed} 项自检失败`}`);
process.exit(failed === 0 ? 0 : 1);
