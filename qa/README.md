# qa/ — 验收脚本说明

所有脚本都用 **Edge headless + `--use-angle=d3d11`** 通过 CDP 驱动真实页面，不用 mock 任何游戏逻辑。

---

## ⚠️ 两条会让结论完全错误的测量纪律

### 1. `perf.avg` 采的是帧**间隔**，不是帧**工作时长**

`main.js` 的 `PerfWatch` 有两套指标，**必须一起读**：

| 指标 | 含义 | 用途 |
|---|---|---|
| `perf.avg / p95 / max` | 两次 rAF 回调之间的**帧间隔** | 观感平滑度 |
| `perf.workAvg / workP95 / workMax` | `frame()` 入口到 `requestAnimationFrame` 的**同步工作量** | 真实性能余量 |

**帧间隔受 vsync 节奏支配。** `--unlock 0` 把 vsync 锁到 90Hz 时，只要单帧工作没超预算，`perf.avg` 就永远显示 11.1ms —— **它有个硬上限，与实际负载无关。**

> 历史教训：批次 2 期间我用 `--unlock 0` 得出"战斗零回归、帧时长 11.1ms"，
> 那个数字是被 vsync 封顶的。同一份代码在 4.67M 画布下真实间隔是 14.82ms、p95 22.30ms。
> **锁 vsync 时不要用 `perf.avg` 判断性能。**

**判断"会不会卡"看 `workP95` 和间隔 p95。** 实测 4.67M 档位：work 5.65ms / 间隔 14.82ms / 间隔 p95 22.30ms —— JS 只占 38%，剩下 ~9ms 是 GPU 光栅化 + 浏览器合成，**不在 JS 里**，CDP Profiler 归因不到（esbuild 把函数内联成 IIFE，self-time 全是 `(anonymous)`）。

### 2. 测帧率/堆之前必须杀掉残留 Edge

```bash
taskkill //F //IM msedge.exe //T
```

不清掉的话，30 个残留 headless 进程会互相抢 CPU，**同一次测量能在 56~90fps 之间乱跳**。我因此误判过一次"帧时长回归"，`taskkill` 后复测就正常了。

### 3. `perf` 环形缓冲深 120 帧，测之前要等它换血

```bash
await sleep(4000);   // 必须 > 4s
```

否则 boot / 3D 懒加载 / 字体渲染 / 维度转场的长帧还留在缓冲里，会测出 17~25ms 的**假回归**。

### 4. Edge profile 每次唯一

`--user-data-dir` 用时间戳。复用旧 profile 会带上 localStorage 存档，干扰首局判定。

---

## 脚本清单

### 批次 1（性能预算 + 手感）
| 脚本 | 作用 |
|---|---|
| `batch1-verify.mjs` | 18 项判据（零降级预算 / 手感三件套） |
| `batch1-fps.mjs` | 帧率基准。**`--unlock 0` 会封顶 `perf.avg`，只用来锁 pacing，不用来判性能** |
| `batch1-heap.mjs` | 60 秒激战堆增长 |
| `batch1-shot.mjs` | 截图（可指定 `--dpr`） |
| `batch1-diff.mjs` | 画面差异量化：PSNR + 锐度 + 「平移 1px」基准 |
| `batch1-compare.mjs` / `batch1-crop.mjs` | 放大对比图 |

### 批次 2（T03 战斗 + T04 状态机）
| 脚本 | 作用 |
|---|---|
| `batch2-verify.mjs` | 31 项（T03 战斗闭环）。定步长探针 + 真实 rAF 双模式 |
| `batch2-verify2.mjs` | 16 项（T04 状态机 / 结算 / 软锁死） |
| `batch2-gate.mjs` | 12 项（Q4 门控 / 任务软锁死 / 零堆分配 / 战斗帧率） |
| `batch2-smoke.mjs` | 冒烟 |

> `batch2-verify.mjs` 里的**顿帧与震屏判据必须走真实 rAF**，因为 `Feedback.frozen()` 是全项目唯一返回 `dt=0` 的入口，它住在 `main.frame()` 里。定步长探针会绕开被测对象。

### 批次 3（T05 音效 + HUD）
| 脚本 | 作用 |
|---|---|
| `batch3-verify.mjs` | 15 项（11 个战斗音色可辨性 + HUD 脏检查 + P5 常驻元素） |

**11 个音色的可辨性怎么证明的**：光看波形名字是自证。`audio.js` 每次播放往 `sfxLog` 记一笔 `{wave, f0, f1, dur, filter}`，`batch3-verify.mjs` 断言 **11 个签名两两不同 + 覆盖 ≥4 种波形 + 时长分层 + 频段分层**。实测签名表见 `shots/batch3-verify.json` 的 `signatures` 字段。

### 性能诊断（本轮新增）
| 脚本 | 作用 |
|---|---|
| `fps-matrix.mjs` | **分辨率/DPR 五档矩阵**。显式打印内部画布尺寸与有效像素 |
| `ablate.mjs` | **消融分析**。逐项关闭渲染要素，量 work / 间隔 / p95 三列 |
| `prof.mjs` | 分段计时，定位单个函数的成本 |
| `ab-audio.mjs` | A/B 对照：量音频层引入的帧时长成本 |

**`fps-matrix.mjs` 存在的理由**：内部画布 = `视口 × min(devicePixelRatio, RENDER.dprCap)²`，而 `dprCap = 1.5`。所以 1080p@DPR2 的真实档位是 **4.67M**，不是 8.3M。任何帧率结论都必须标明画布尺寸，否则不可比。

```bash
node fps-matrix.mjs --url http://127.0.0.1:8200/
node ablate.mjs --url http://127.0.0.1:8200/ --w 1920 --h 1080 --dpr 2
```

### 通用
| 脚本 | 作用 |
|---|---|
| `qa-e2e.mjs` | 24 项端到端回归清单。`--suite boot\|full --url ... --label ...` |
| `qa-diag.mjs` | 现场诊断快照 |
| `qa-vartest.mjs` | 变体测试 |

---

## 常用复现序列

```bash
# 0) 构建（11 项自检，含 config 字段引用完整性）
cd work-repo && node build.mjs

# 1) 起服务（background servers 容易被回收，断了就重起）
cd work-repo && python -m http.server 8200 --directory .

# 2) 判据
node qa/batch1-verify.mjs      # 18
node qa/batch2-verify.mjs      # 31   需 --url
node qa/batch2-verify2.mjs     # 16   需 --url
node qa/batch3-verify.mjs      # 15   需 --url

# 3) 端到端回归
node qa/qa-e2e.mjs --url http://127.0.0.1:8200/ --port 9800 --label LOCAL --suite full

# 4) 性能（务必先 taskkill）
taskkill //F //IM msedge.exe //T
node qa/fps-matrix.mjs --url http://127.0.0.1:8200/
node qa/ablate.mjs    --url http://127.0.0.1:8200/ --w 1920 --h 1080 --dpr 2
```

## 判据脚本的两种模式

- **定步长探针**（`batch2-verify.mjs`）：掐断 `requestAnimationFrame`，手动 `city2d.update(dt, input)` + `render()`。可复现、能量准时序。**但会绕开 `main.frame()`**，所以测不了顿帧/震屏（它们住在 frame 里）。
- **真实 rAF + CDP 按键**：能量「主循环怎么推进」「DOM 什么时候写」「用户实际体感的帧间隔」。

选错模式会得到**假通过**或**假失败**，两者都踩过。
