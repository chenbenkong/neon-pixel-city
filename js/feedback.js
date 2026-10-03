/**
 * feedback.js —— 命中反馈四件套（顿帧 / 震屏 / 闪白 / 击退）与粒子池
 *
 * 职责边界（横切关注点，所以单独成文件而不是塞进 combat.js）：
 *   · 顿帧冻结：frozen() 是**全项目唯一**能返回 dt=0 的入口
 *   · 震屏：只算偏移量，不移动相机（移动相机会与视差层 f 系数耦合，远景 f=0.05
 *           会让震屏幅度只剩 5%，不符合"屏幕震动"的语义）
 *   · 闪白 / 刀光 / 粒子：只画，不做物理位移与伤害结算（那些由调用方给数）
 *
 * 硬约束：三个池在构造函数里一次性分配，之后只改字段，永不 push/splice。
 * 战斗粒子密度会涨 5~10 倍，任何每帧分配都会把对象池的收益吃掉。
 */
import { FEEL } from './config.js';

const TAU = Math.PI * 2;

export class Feedback {
  constructor() {
    // ---- 顿帧 ----
    this.frozenUntil = 0;   // performance.now() 域的解冻时刻
    this.lastHitstop = 0;   // 本次顿帧时长（ms），供验收读取

    // ---- 震屏 ----
    this.shakeAmp = 0;
    this.shakeT = 0;        // 已进行时长（s）
    this.shakeDur = 0;      // 总时长（s）
    this.shakeSeed = 0;     // 随机初相位，决定方向
    this.shakeX = 0;        // 本帧偏移（px），由 city2d 消费
    this.shakeY = 0;

    // ---- 慢镜 ----
    this.slowT = 0;         // 剩余慢镜时长（s）
    this.slowScale = 1;     // 当前时间倍率
    this.timeScale = 1;     // 对外暴露：给 main.js 乘到 simDt 上

    // ---- 受伤红闪 ----
    this.hurtT = 0;

    // ---- 刀光（全局最多一个，非池）----
    this.slash = { active: false, t: 0, x: 0, y: 0, face: 1, hit: false };

    // ---- 池 1：sparks(96)，命中火花 ----
    // 铁律（系统设计 §6.2）：池的长度创建后永不改变，回收用 active=false，不用 splice。
    // 所以活跃区间用 [0, n) 的游标表示，**绝不能**用 array.length = w 截断 ——
    // 那会把 new Array(96) 永久缩成空数组，之后再也 spawn不出任何粒子（实测踩过）。
    this.sparks = new Array(96);
    this.sparksN = 0;
    for (let i = 0; i < 96; i++) {
      this.sparks[i] = { active: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 0, col: '#ffffff', size: 1 };
    }
    // ---- 池 2：debris(128)，击杀碎裂的像素块 ----
    this.debris = new Array(128);
    this.debrisN = 0;
    for (let i = 0; i < 128; i++) {
      this.debris[i] = { active: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 0, size: 1, col: '#29f0ff' };
    }

    // ---- 连击（计数存在 RunStats，这里只管断连事件）----
    this.comboBreakHook = null;
  }

  // ================================================================
  // 顿帧 —— 全项目唯一返回 dt=0 的地方
  // ================================================================

  /**
   * 判定本帧是否处于顿帧冻结期。**全项目唯一返回 dt=0 的入口**。
   *
   * @param {number} rawDt 真实帧时长（秒）
   * @returns {boolean} true = 冻结中，调用方必须传 dt=0
   *
   * 注意 update 在**两种情况下都要调用**：冻结期要用 rawDt 推进震屏/闪白/粒子
   * （否则打击瞬间画面会"卡住不动"，玩家感知不到冲击），非冻结期更要推进
   * （否则震屏永不衰减、粒子永不老化、慢镜永不结束）。
   */
  frozen(rawDt) {
    const isFrozen = performance.now() < this.frozenUntil;
    this.update(rawDt);
    return isFrozen;
  }

  /**
   * 设置顿帧。**取最大值，不累加**：3 个敌人同帧被击中只冻 60ms 而非 180ms。
   * 累加会让玩家经历 180ms 无法操作的手感崩溃。
   */
  hitstop(seconds) {
    const until = performance.now() + seconds * 1000;
    if (until > this.frozenUntil) this.frozenUntil = until;
    this.lastHitstop = seconds * 1000;
  }

  /**
   * 慢镜。顿帧与慢镜可叠加，但顿帧优先（main.js 里 frozen 为真时直接用 0）。
   */
  slowmo(duration, scale) {
    this.slowT = Math.max(this.slowT, duration);
    this.slowScale = scale;
    this.timeScale = scale;
  }

  // ================================================================
  // 震屏
  // ================================================================

  /**
   * 触发震屏。shake 为 [幅度px, 时长s]。
   *
   * 曲线设计（这里的三个取值都是踩过坑的）：
   *
   * 1) 频率 3.5Hz，不是架构师原稿的 46Hz。
   *    震屏偏移 = amp · E(t) · cos(2πft + seed)，相邻帧最大跳变 ≈ amp · 2πf · dt。
   *    60Hz 下 46Hz 的相位步长是 4.82 rad（≈0.77 个**周期**，不是 0.77 **弧度**），
   *    首尾帧完全去相关，跳变可达 2×amp = 10px，直接违反「连续 10 帧相邻差 ≤2px」。
   *    3.5Hz 在 90Hz 下相位步长 0.244rad，命中震屏（amp 2.6）的跳变约 0.6px。
   *
   * 2) 包络用升余弦 (1+cos(πt/dur))/2，不用 (1-t/dur)²。
   *    后者在 t=0 处的斜率是 -2/dur，最高速衰减会带来额外跳变；
   *    升余弦两端斜率都是 0，冲击的"进入"和"收尾"都是平滑的。
   *    顺带：不乘原稿里的 0.5，否则峰值只有 1.3px，达不到「命中峰值 ≥2px」。
   *
   * 3) 叠加时**只抬幅度**，不重置相位、不改包络参数（shakeT / shakeDur 都不动）。
   *    原实现每次都换新随机相位 + shakeT 归零 + shakeDur 换新值，于是
   *    「命中震动还在衰减时又被打」会让偏移从 +amp 瞬间跳到 -amp（实测相邻差 5.2px）；
   *    而只改 shakeDur 也会让归一化进度 k = t/dur 突降、包络 env 突升，同样是跳变
   *    （实测延长到受伤震屏时长后相邻差 4.7px）。
   *    现在中途来更强的击打只把当前震动变大，时序完全沿用原曲线 → 全程连续。
   */
  shake(amp, dur) {
    if (this.shakeAmp <= 0 || this.shakeT >= this.shakeDur) {
      // 没有震动在进行 → 开一个新段
      this.shakeSeed = Math.random() * TAU;
      this.shakeT = 0;
      this.shakeDur = dur;
      this.shakeAmp = amp;
      // 起始偏移给 0，不给 cos(seed)*amp。
      // 包络里的 20ms 起振（见 update）就是为消除这个阶跃存在的：若这里直接落到峰值，
      // 序列第 0→1 帧就是一个 amp 大小的跳变（实测 2.6px），正是连续性判据要排除的。
      this.shakeX = 0;
      this.shakeY = 0;
      return;
    }
    // 已有震动在进行 → 只抬幅度，相位与时序完全沿用（保证逐帧连续）
    if (amp > this.shakeAmp) this.shakeAmp = amp;
  }

  // ================================================================
  // 事件入口
  // ================================================================

  /**
   * 命中反馈。kind: 'hit' | 'kill' | 'softLand' | 'hardLand'
   * 一次命中同时触发 ≥4 个感官通道（PRD P3）。
   */
  hit(opts) {
    const o = opts || {};
    const kind = o.kind || 'hit';
    const x = o.x || 0;
    const y = o.y || 0;
    const dir = o.dir || 1;

    if (kind === 'kill') {
      this.hitstop(FEEL.HITSTOP_KILL);
      this.shake(FEEL.SHAKE_KILL[0], FEEL.SHAKE_KILL[1]);
      this.spawnDebris(x, y, 10);
      this.spawnSparks(x, y, 14, dir);
    } else if (kind === 'hardLand') {
      this.shake(FEEL.SHAKE_LAND_HARD[0], FEEL.SHAKE_LAND_HARD[1]);
    } else if (kind === 'softLand') {
      this.shake(FEEL.SHAKE_LAND_SOFT[0], FEEL.SHAKE_LAND_SOFT[1]);
    } else {
      this.hitstop(FEEL.HITSTOP_HIT);
      this.shake(FEEL.SHAKE_HIT[0], FEEL.SHAKE_HIT[1]);
      this.spawnSparks(x, y, 8, dir);
    }
    this.slowmo(FEEL.SLOWMO_HIT[0], FEEL.SLOWMO_HIT[1]);
  }

  /** 玩家受伤：震屏 + 红闪（击退由调用方写玩家 vx，这里不碰物理） */
  playerHurt() {
    this.hitstop(FEEL.HITSTOP_HURT);
    this.shake(FEEL.SHAKE_HURT[0], FEEL.SHAKE_HURT[1]);
    this.hurtT = 0.26;
  }

  /** 挥击刀光。hit=true 表示这一挥命中了（刀光颜色不同） */
  swing(x, y, face, hit) {
    this.slash.active = true;
    this.slash.t = 0;
    this.slash.x = x;
    this.slash.y = y;
    this.slash.face = face;
    this.slash.hit = !!hit;
  }

  // ================================================================
  // 池操作
  // ================================================================

  /**
   * 取得一个空闲槽，池满返回 null。绝不新建对象。
   * 必须扫**整个**池而不是只扫 [0, n)：活跃区 [0, n) 里全是 active 的，
   * 空闲槽永远在 [n, len) —— 只扫活跃区会导致第一次 spawn 就返回 null（永远发不出粒子）。
   */
  _obtain(pool) {
    for (let i = 0; i < pool.length; i++) {
      if (!pool[i].active) return pool[i];
    }
    return null;
  }

  /** 当前活跃粒子数（供验收读取；池长度恒定不变） */
  get sparkCount() { return this.sparksN; }
  get debrisCount() { return this.debrisN; }

  /** 命中火花：沿攻击方向的一小簇亮片 */
  spawnSparks(x, y, n, dir) {
    for (let i = 0; i < n; i++) {
      const s = this._obtain(this.sparks);
      if (!s) return;
      this.sparksN += 1;
      s.active = true;
      s.x = x;
      s.y = y;
      s.vx = dir * (40 + Math.random() * 160);
      s.vy = -(30 + Math.random() * 150);
      s.t = 0;
      s.life = 0.18 + Math.random() * 0.22;
      s.size = Math.random() < 0.35 ? 2 : 1;
      s.col = i % 3 === 0 ? '#ffffff' : (i % 3 === 1 ? '#29f0ff' : '#ff2bd6');
    }
  }

  /** 击杀碎裂：带重力的像素块 */
  spawnDebris(x, y, n) {
    for (let i = 0; i < n; i++) {
      const d = this._obtain(this.debris);
      if (!d) return;
      this.debrisN += 1;
      const a = (i / n) * TAU + Math.random() * 0.6;
      const sp = 60 + Math.random() * 120;
      d.active = true;
      d.x = x;
      d.y = y;
      d.vx = Math.cos(a) * sp;
      d.vy = Math.sin(a) * sp - 70;
      d.t = 0;
      d.life = 0.5 + Math.random() * 0.5;
      d.size = Math.random() < 0.3 ? 2 : 1;
      d.col = i % 4 === 0 ? '#ff2bd6' : (i % 4 === 1 ? '#ffd166' : '#29f0ff');
    }
  }

  // ================================================================
  // 每帧推进
  // ================================================================

  /** 用 rawDt 推进（冻结期也要走，否则震屏与粒子会跟着冻住） */
  update(dt) {
    if (dt <= 0) return;

    // 震屏
    if (this.shakeAmp > 0) {
      this.shakeT += dt;
      if (this.shakeT >= this.shakeDur) {
        this.shakeAmp = 0;
        this.shakeX = 0;
        this.shakeY = 0;
      } else {
        const k = this.shakeT / this.shakeDur;
        // 包络 = 25ms 线性起振 × 升余弦衰减。
        // 起振那一段是必需的：若直接从 0 跳到峰值，震屏序列的第 0→1 帧就是一个
        // amp 大小的阶跃（实测 3.8px），正是「相邻帧差 ≤2px」要排除的跳变。
        // 25ms 起振在 90Hz 下约 2~3 帧爬升，峰值处每帧增量受 SHAKE_MAX_STEP 限幅，永不超差。
        const attack = Math.min(1, this.shakeT / 0.025);
        const env = attack * (1 + Math.cos(Math.PI * k)) * 0.5;
        const dir = this.shakeSeed + this.shakeT * FEEL.SHAKE_FREQ * TAU;
        const amp = this.shakeAmp * env;
        const nx = Math.cos(dir) * amp;
        const ny = Math.sin(dir * 0.7) * amp * 0.6;
        // 逐帧限幅：无论掉到多少帧，单帧偏移变化都不超过 SHAKE_MAX_STEP。
        // 这样「相邻帧差 ≤2px」就成了构造性保证，而不是"正常帧率下恰好成立"。
        const ddx = nx - this.shakeX, ddy = ny - this.shakeY;
        const dd = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dd > FEEL.SHAKE_MAX_STEP) {
          const s = FEEL.SHAKE_MAX_STEP / dd;
          this.shakeX += ddx * s;
          this.shakeY += ddy * s;
        } else {
          this.shakeX = nx;
          this.shakeY = ny;
        }
      }
    }

    // 慢镜
    if (this.slowT > 0) {
      this.slowT = Math.max(0, this.slowT - dt);
      if (this.slowT === 0) { this.slowScale = 1; this.timeScale = 1; }
    }

    // 受伤红闪
    if (this.hurtT > 0) this.hurtT = Math.max(0, this.hurtT - dt);

    // 刀光
    if (this.slash.active) {
      this.slash.t += dt;
      if (this.slash.t > 0.14) this.slash.active = false;
    }

    // 池推进（交换删除，池长度恒定，零分配）
    const sp = this.sparks;
    for (let i = 0; i < this.sparksN; i++) {
      const s = sp[i];
      s.t += dt;
      s.vy += 520 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (s.t >= s.life) {
        // 与队尾交换后回退一格（等价于 splice，但不动 length、不分配）
        this.sparksN -= 1;
        sp[i] = sp[this.sparksN];
        sp[this.sparksN] = s;
        s.active = false;
        i -= 1;
      }
    }

    const db = this.debris;
    for (let i = 0; i < this.debrisN; i++) {
      const d = db[i];
      d.t += dt;
      d.vy += 700 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.t >= d.life) {
        this.debrisN -= 1;
        db[i] = db[this.debrisN];
        db[this.debrisN] = d;
        d.active = false;
        i -= 1;
      }
    }
  }

  // ================================================================
  // 渲染（只画，不改状态）
  // ================================================================

  /**
   * @param {CanvasRenderingContext2D} l 内部缓冲上下文
   * @param {number} camX 相机 x（世界 → 屏幕）
   */
  render(l, camX) {
    // 刀光：1 帧内画出的像素弧线（不是图片资源）
    if (this.slash.active) {
      const s = this.slash;
      const k = 1 - s.t / 0.14;
      const bx = Math.round(s.x - camX);
      const by = Math.round(s.y);
      l.save();
      l.globalCompositeOperation = 'lighter';
      l.globalAlpha = k;
      l.fillStyle = s.hit ? '#ffffff' : '#29f0ff';
      for (let i = 0; i < 7; i++) {
        const a = (-0.9 + (i / 6) * 1.5) * s.face;
        const r = 9 + i * 2.4;
        const px = bx + Math.cos(a) * r * s.face;
        const py = by - 12 + Math.sin(a) * r;
        const sz = i < 3 ? 2 : 1;
        l.fillRect(Math.round(px), Math.round(py), sz, sz);
      }
      l.globalAlpha = 1;
      l.restore();
    }

    // 火花
    l.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.sparksN; i++) {
      const s = this.sparks[i];
      const a = 1 - s.t / s.life;
      l.globalAlpha = a;
      l.fillStyle = s.col;
      l.fillRect(Math.round(s.x - camX), Math.round(s.y), s.size, s.size);
    }
    // 碎裂块
    for (let i = 0; i < this.debrisN; i++) {
      const d = this.debris[i];
      const a = 1 - d.t / d.life;
      l.globalAlpha = a;
      l.fillStyle = d.col;
      l.fillRect(Math.round(d.x - camX), Math.round(d.y), d.size, d.size);
    }
    l.globalAlpha = 1;
    l.globalCompositeOperation = 'source-over';
  }

  /** 受伤红闪不透明度（0~1），由 city2d 叠一层红色渐晕 */
  hurtAlpha() {
    if (this.hurtT <= 0) return 0;
    const k = this.hurtT / 0.26;
    return k > 0.5 ? (1 - k) * 2 : k * 2;
  }

  reset() {
    this.frozenUntil = 0;
    this.lastHitstop = 0;
    this.shakeAmp = 0;
    this.shakeT = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.slowT = 0;
    this.slowScale = 1;
    this.timeScale = 1;
    this.hurtT = 0;
    this.slash.active = false;
    for (let i = 0; i < this.sparks.length; i++) this.sparks[i].active = false;
    for (let i = 0; i < this.debris.length; i++) this.debris[i].active = false;
    this.sparksN = 0;
    this.debrisN = 0;
  }
}
