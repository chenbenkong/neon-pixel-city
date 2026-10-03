/**
 * config.js —— 全部可调参数的单一来源
 *
 * 职责：手感 / 战斗 / 波次 / 反馈 / 音频 / HUD 的所有数值常量集中于此。
 * 明确不做：无逻辑、无状态、无副作用、无 import（叶子模块）。
 *
 * 为什么要单独一个文件：本轮要调的手感参数有 60+ 个，散落在业务文件里会导致
 * "改一个参数要读 5 个文件"。常量集中后，改手感不改逻辑、改平衡不改逻辑。
 *
 * 构建期可覆盖：build.mjs 会把 NEON_DPR_CAP 作为 esbuild --define 注入，
 * 用于「dpr 上限 2.0 vs 1.5」的截图对比实验（见 qa/batch1-shot.mjs）。
 * 未注入时（直接以 ES module 打开源码调试）回落到 DEFAULT_DPR_CAP。
 */

/** 默认 dpr 上限：如需还原为 2.0，构建时设环境变量 NEON_DPR_CAP=2 即可，无需改源码 */
export const DEFAULT_DPR_CAP = 1.5;

export const RENDER = {
  /** 合成层后处理的像素预算杠杆。2 → 1.5 可使 1920×1080 的合成像素减少 43.7% */
  dprCap: typeof NEON_DPR_CAP !== 'undefined' ? NEON_DPR_CAP : DEFAULT_DPR_CAP,
  /** 内部缓冲基准高度；宽度按视口宽高比推导并夹在 [300, 780] */
  baseH: 270,
  minW: 300,
  maxW: 780,
};

/** 移动曲线（P0-2）。四个系数分离：加速 / 减速 / 转身 / 空中 */
export const MOVE = {
  walkSpd: 62,        // px/s 行走
  runSpd: 150,        // px/s 奔跑
  kAcc: 13.33,        // 地面同向加速系数 = 1/0.075s（τ_acc = 75ms，落在 PRD 的 60~90ms）
  kDec: 26.3,         // 地面减速系数 = 1/0.038s（τ_dec ≈ 38ms，约为加速的 2 倍 = 抓地力）
  kTurn: 33.3,        // 地面转身制动系数 = 1/0.030s（+150 → -150 穿越 0 点约 21ms）
  airMul: 0.70,       // 空中系数 = 地面 × 0.70（PRD 要求 ∈ [0.6, 0.8]）
  camK: 10.5,         // 相机跟随系数 = 1/0.095s（τ = 95ms，PRD 要求 ≤130ms）
  camLook: 0.30,      // 镜头前瞻 = vx × 0.30
  camLookMax: 46,     // 前瞻夹紧上限 px，防止满速时镜头甩太远
  atkWindupMul: 0.35, // 攻击前摇期间水平速度上限倍率（允许轻攻击微调位置）
};

/** 跳跃三件套（P0-1）：输入缓冲 + 土狼时间 + 可变跳高 */
export const JUMP = {
  v0: 252,          // 起跳初速 px/s。上升期重力 620 下满跳 252²/(2×620) = 51.2px（PRD 要求长按 ≥45px）
  gRise: 620,       // 上升期重力 px/s²（比下落轻 → 上升更"飘"、滞空更可控）
  gFall: 900,       // 下落期重力 px/s²（比上升重 45% → 落地更利落）
  coyote: 0.10,     // 土狼时间 100ms（PRD 要求 100ms）
  buffer: 0.14,     // 输入缓冲 140ms（PRD 要求 ≥100ms 且覆盖 60Hz 下 8 帧 = 133ms）
  minH: 24,         // 短跳目标高度 px（PRD 要求 ≥22px）
  hardVy: 420,      // 硬着陆判定阈值 px/s
};

/** squash & stretch（P0-3）：双向缩放，禁止用整体位移冒充 */
export const SQUASH = {
  jumpX: 0.87,      // 起跳上升：横向压缩 ≤0.88
  jumpY: 1.14,      // 起跳上升：纵向拉伸 ≥1.12
  jumpTau: 0.12,    // 形变指数回落时间常数 s
  fallX: 1.08,      // 下落：横向微胀
  fallY: 0.93,      // 下落：纵向微压
  fallRef: 420,     // 下落形变的参考速度
  softX: 1.18,      // 软着陆横向拉伸 ≥1.15
  softY: 0.86,      // 软着陆纵向压缩 ≤0.85
  softTau: 0.10,
  hardX: 1.34,      // 硬着陆：幅度为软着陆的 2 倍
  hardY: 0.72,
  hardTau: 0.16,
};

/** 攻击三段状态机（P0-6） */
export const ATK = {
  WINDUP: 0.060,           // 前摇 60ms
  ACTIVE: 0.090,           // 判定窗口 90ms
  RECOVER: 0.120,          // 后摇 120ms
  BOX_W: 26,               // 判定框宽（身前）
  BOX_H: 18,               // 判定框高
  BOX_OFF: 4,              // 判定框起点距玩家中心（face 方向）
  CANCEL_RECOVER_AT: 0.045, // 后摇进行到 45ms 后允许移动取消（取消窗口 75ms）
  BUFFER: 0.120,           // 攻击输入缓冲 120ms
  HITSTOP_KILL: 0.090,
  HITSTOP_HIT: 0.060,
};

/** 追踪无人机 Drone（P0-5）。HP = 2 是为了让 P0-7 的双档顿帧（60ms / 90ms）都可达 */
export const DRONE = {
  MAX: 12,
  PATROL_SPD: 19,          // px/s，PRD 区间 16~22
  CHASE_SPD: 40,           // px/s，PRD 区间 34~46（再乘波次倍率）
  SENSE_X: 120,            // 水平感知范围
  SENSE_Y: 26,             // 垂直感知范围（限制"从头顶越过"）
  RECOVER_T: 0.40,         // recover 抖动时长
  KNOCK_V: 165,            // 击退初速 px/s（位移 = 165 × 0.12 = 19.8px ≥ 12px）
  KNOCK_TAU: 0.12,         // 击退速度衰减时间常数
  SEPARATION: 12,          // 敌人间最小间距
  PLAYER_SEPARATION: 14,   // 敌人与玩家最小间距（不可穿过）
  HP: 2,
  HIT_FLASH: 0.25,         // 闪白总时长 = 100ms 纯白 + 150ms 淡出
  INVULN_ON_RECOVER: true,
  BODY_W: 13, BODY_H: 11,  // 绘制与命中判定的身体尺寸
  CULL_PAD: 90,            // 视口外剔除余量
  LOSE_SIGHT_T: 0.8,       // 脱离感知持续多久回到 patrol
};

/** 打击感反馈（P0-7 / P0-4）。每一项都是"一次命中同时触发 ≥4 个感官通道"的组成部分 */
export const FEEL = {
  HITSTOP_HIT: 0.060,      // 普通命中 60ms
  HITSTOP_KILL: 0.090,     // 击杀 90ms
  HITSTOP_HURT: 0.075,     // 玩家受伤 75ms
  SHAKE_HIT: [3.2, 0.170], // [幅度px, 时长s]。取 3.2 而非 2.6：逐帧限幅 + 25ms 起振会削掉峰值，
                        // 2.6 实测只剩 1.24px（达不到「峰值 ≥2px」）。3.2 实测峰值约 2.9px，留余量。
  SHAKE_KILL: [4.2, 0.200],
  // 受伤震幅取 4.4 而非架构师原稿的 5.0：连续性判据是「相邻帧偏移差 ≤2px」，
  // 而相邻差 ≈ amp × 2πf × dt。f=3.5Hz、60Hz 下 amp 5.0 会到 1.83px（只剩 8% 余量），
  // 掉帧时立刻超标。4.4 → 1.61px，且仍满足 PRD「受击震屏 ≥3px」。
  SHAKE_HURT: [4.4, 0.220],
  SHAKE_LAND_HARD: [4.0, 0.200],
  SHAKE_LAND_SOFT: [1.2, 0.120],
  // 震屏方向变化频率。**这个值不能大**：
  // 相邻帧最大跳变 ≈ amp × 2πf × dt。60Hz 下 46Hz 的相位步长是 4.82 rad（≈0.77 个**周期**，
  // 不是 0.77 **弧度**），首尾帧完全去相关 → 偏移在 ±amp 之间来回翻，视觉上是"频闪"而不是"抖动"，
  // 实测相邻帧差 4.5px，直接违反「连续 10 帧相邻差 ≤2px」。
  // 3.5Hz 在 60Hz 下相位步长 0.366rad，90Hz 下 0.244rad，受伤震屏（amp 4.4）跳变约 1.6px，留足余量。
  SHAKE_FREQ: 3.5,        // 震屏方向变化频率 Hz。46Hz 在 60fps 下相位步长 4.8rad（≈0.77 个周期）会逐帧乱跳
  // 单帧偏移变化上限。验收判据是「相邻帧 (ox,oy) 差 ≤2px」，若只靠频率控制，
  // 掉帧到 30fps 时步长翻倍就会超标。做成构造性限幅后该判据在**任何帧率**下都成立；
  // 正常帧率（11ms，自然步长约 0.6px）下完全不受影响，震动观感不变。
  SHAKE_MAX_STEP: 1.9,
  FLASH_HOLD: 0.100,       // 纯白保持 100ms
  FLASH_FADE: 0.150,       // 淡出 150ms
  COMBO_WINDOW: 2.0,       // 连击窗口 2s
  IFRAMES: 1.2,            // 无敌帧 1.2s
  IFRAME_BLINK_HZ: 8,      // 8Hz 闪烁
  SLOWMO_DEATH: [0.60, 0.35], // [时长s, 时间倍率]
  SLOWMO_HIT: [0.045, 0.25], // 击杀瞬间的极短慢镜
  HURT_KNOCK_V: 190,       // 玩家受击退初速（190 × 0.09 = 17.1px ≥ 8px）
  HURT_KNOCK_TAU: 0.09,
};

/** 波次（P0-8）。三个难度参数严格单调递增（PRD P7） */
export const WAVE = {
  LIST: [
    { count: 3, speedMul: 1.00, gapMs: 1400 },
    { count: 5, speedMul: 1.15, gapMs: 1100 },
    { count: 7, speedMul: 1.30, gapMs: 850 },
  ],
  INTERMISSION: 2.5,     // 波间间歇 2.5s
  SPAWN_ANCHOR_MIN: 260, // 刷怪点距玩家至少 260px（避免刷脸上）
  DRONE_HP: 2,
};

/** 计分（P0-10）。S 需要"打得好"而不是"活得久" */
export const SCORE = {
  KILL: 120,
  SHARD: 10,             // 复用既有 addScore(10)
  COMBO_STEP: 10,        // 每次命中的连击奖励 = 10 × (combo - 1)
  COMBO_CAP: 90,
  WAVE_CLEAR: 200,       // 通过一波 = 200 × wave
  SURVIVE_PER_SEC: 2,    // 结算时一次性 = 2 × floor(survive)
  WIN: 1000,             // 通关第 3 波
  GRADE_S: 3000,
  GRADE_A: 1800,
  GRADE_B: 900,
};

/** 音频（P0-11）。music 基准增益，duck 目标值全部相对它 */
export const AUDIO = {
  MUSIC_BASE: 0.62,
  DUCK_HIT: 0.52,
  DUCK_KILL: 0.45,
  DUCK_HURT: 0.60,
  DUCK_MENU: 0.30,
  MUSIC_BASE_BY_MODE: { MENU: 0.07, RESULT: 0.03 },
};

/** HUD（P0-12 / P0-5） */
export const HUD = {
  MAX_HP: 3,             // 生命 3 格
  HP_PULSE_HZ: 2,        // 剩 1 格时心形 2Hz 脉冲警示
  TELE_HZ: 10,           // 遥测面板刷新 10Hz（不是每帧）
  LOW_HEART_HZ: 2,
};

/** 场景粒子（P0-13）。蒸汽按时间累加生成，帧率无关 */
export const PARTICLE = {
  STEAM_RATE: 7,         // 每秒 7 枚（原先 0.35 × 60 = 21 枚/秒，且与帧率绑定）
  STEAM_CAP: 220,        // 硬上限兜底
};
