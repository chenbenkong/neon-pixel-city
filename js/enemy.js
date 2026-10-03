/**
 * enemy.js —— 追踪无人机 Drone 的三态 AI + 分离 + 视口剔除
 *
 * 边界（PM 硬约束）：
 *   · 池在构造函数一次性分配 12 个槽，之后只改字段，永不 push/splice
 *   · queryHit 返回**复用的 _hitBuf**，不 filter 不 push（一次挥击若分配数组，
 *     60 次/秒挥击 = 60 个数组/秒，会把战斗粒子池的收益全部抵消）
 *   · 不 import city2d.js —— 需要 player 时通过 ctx 参数传入（否则循环依赖）
 *
 * 三态：patrol（巡逻）→ chase（感知到玩家）→ recover（被击退，原地抖动 0.4s）
 * 一维地面，不追 y。
 */
import { DRONE } from './config.js';

export class EnemyManager {
  /**
   * @param {Feedback} feedback
   * @param {object} audio
   * @param {object} city  city2d 实例（只用于取 W / cam.x / FEET，禁止反向 import）
   */
  constructor(feedback, audio, city) {
    this.feedback = feedback;
    this.audio = audio;
    this.city = city;
    this.waveSpeedMul = 1;

    /** Drone 池：固定 12 个槽，长度创建后永不改变（验收判据 11） */
    this.drones = new Array(DRONE.MAX);
    for (let i = 0; i < DRONE.MAX; i++) {
      this.drones[i] = {
        idx: i, active: false,
        x: 0, y: 0, vx: 0, face: -1,
        hp: 0, state: 'patrol', stateT: 0,
        flashT: 0, invulnT: 0, lastHitSwing: -1,
        seed: 0, wobble: 0, dieT: 0, scoreValue: 0,
        loseT: 0,  // 脱离感知持续时间 → 回 patrol
      };
    }
    /** 命中查询结果复用数组：长度预分配，queryHit 每次把 count 归零后写入 */
    this._hitBuf = new Array(DRONE.MAX);
    this._count = 0;
    /** 分离用的下标数组：预分配，插入排序复用（零分配） */
    this._order = new Array(DRONE.MAX);
    this.kills = 0;          // 本局击杀数（结算面板用）
  }

  get aliveCount() {
    let n = 0;
    for (let i = 0; i < this.drones.length; i++) if (this.drones[i].active) n += 1;
    return n;
  }

  /** 取一个空闲槽，池满返回 null */
  spawn(x, opts) {
    const o = opts || {};
    let slot = null;
    for (let i = 0; i < this.drones.length; i++) {
      if (!this.drones[i].active) { slot = this.drones[i]; break; }
    }
    if (!slot) return null;
    slot.active = true;
    slot.x = x;
    slot.y = this.city.FEET;
    slot.vx = 0;
    slot.face = x > this.city.player.x ? -1 : 1;
    slot.hp = o.hp || DRONE.HP;
    slot.state = 'patrol';
    slot.stateT = 0;
    slot.flashT = 0;
    slot.invulnT = 0;
    slot.lastHitSwing = -1;
    slot.seed = Math.random() * 6.28;
    slot.wobble = Math.random() * 1.2;
    slot.dieT = 0;
    slot.scoreValue = 120;
    slot.loseT = 0;
    return slot;
  }

  /**
   * 每帧推进。ctx = { player, camX, W, FEET }
   * 视口外的敌人不更新（PRD P0-5 验收 5）
   */
  update(dt, ctx) {
    const L = ctx.camX - DRONE.CULL_PAD;
    const R = ctx.camX + ctx.W + DRONE.CULL_PAD;
    const p = ctx.player;

    for (let i = 0; i < this.drones.length; i++) {
      const d = this.drones[i];
      if (!d.active) continue;
      // 视口外不更新
      if (d.x < L || d.x > R) continue;

      // 死亡动画：0.28s 后回收
      if (d.state === 'dying') {
        d.dieT += dt;
        if (d.dieT >= 0.28) d.active = false;
        continue;
      }

      // 计时器
      if (d.flashT > 0) d.flashT = Math.max(0, d.flashT - dt);
      if (d.invulnT > 0) d.invulnT = Math.max(0, d.invulnT - dt);
      d.stateT += dt;
      d.wobble -= dt;

      const dx = p.x - d.x;
      const adx = Math.abs(dx);
      const dy = p.y - d.y;
      const ady = Math.abs(dy);

      // ---- 状态迁移 ----
      if (d.state === 'recover') {
        // 被击退：原地抖动 0.4s，vx 按 exp 衰减（提供 ≥12px 位移）
        d.x += Math.sin(d.stateT * 38) * 1.2;
        d.vx *= Math.exp(-dt / DRONE.KNOCK_TAU);
        d.x += d.vx * dt;
        if (d.stateT >= DRONE.RECOVER_T) {
          d.state = (adx < 200) ? 'chase' : 'patrol';
          d.stateT = 0;
        }
      } else if (adx <= DRONE.SENSE_X && ady <= DRONE.SENSE_Y) {
        // 感知到玩家 → chase
        if (d.state !== 'chase') { d.state = 'chase'; d.stateT = 0; }
        d.loseT = 0;
        // 追击时不要全部挤在同一个点：按 seed 分配一个**站位**（玩家两侧的横向偏移），
        // 让敌人包围玩家而不是叠在一起。
        // 这既是玩法上正确的（玩家应该有走位空间），也解决了「多个敌人重叠」——
        // 原来所有 chase 的目标都是玩家脚下，必然堆叠，分离算法只能反复拉扯。
        // 注意：站位要用「趋近站位点」的方式实现，若把它加到方向判断上
        // （want = dx + spread 再判正负），spread 为负时反而会让敌人朝玩家挤。
        // 站位范围要够宽：5 个敌人同时追击时，站位跨度必须 > 4×SEPARATION(12)=48px，
        // 否则站位本身就会互相重叠。±38px 共 76px 跨度，5 只分下来约 15px > 12px。
        const spread = adx < 100 ? (d.seed - Math.PI) * 12 : 0;
        const wantX = p.x + spread;
        const err = wantX - d.x;
        const spd = DRONE.CHASE_SPD * this.waveSpeedMul * (adx < 46 ? 0.4 : 1);
        const target = Math.max(-spd, Math.min(spd, err * 5));
        d.vx += (target - d.vx) * Math.min(1, 8 * dt);
        d.x += d.vx * dt;
        d.face = err > 0 ? 1 : -1;
      } else {
        // ---- patrol：沿街慢速游走 ----
        d.loseT += dt;
        if (d.loseT >= DRONE.LOSE_SIGHT_T && d.state === 'chase') {
          d.state = 'patrol';
          d.stateT = 0;
        }
        if (d.wobble <= 0) {
          d.wobble = 0.5 + Math.random() * 1.0;
          d.face = -d.face;
        }
        // 到街道 slot 边界折返：x % 184 落在 [8,176] 外时转向
        const m = ((d.x % 184) + 184) % 184;
        if (m < 8 || m > 176) d.face = m < 8 ? 1 : -1;
        d.vx += (d.face * DRONE.PATROL_SPD - d.vx) * Math.min(1, 6 * dt);
        d.x += d.vx * dt;
      }
    }

    // 分离 + 玩家排斥（两者互相拉扯，在 separate 内部跑两遍收敛）
    this.separate(p);
  }

  /**
   * 分离算法：**把玩家当作不可穿越的墙**，左右两组各自排序推开。
   *
   * 为什么不用成对推挤（Gauss-Seidel）：单遍对「一簇挤在一起的敌人」收敛不了 ——
   * 推完 a-b 再推 a-c，a 被反复拉回，最后仍有 3~5px 重叠（实测 5 敌人挤在 3.3px，
   * 跑 4 遍松弛也只到 11.3px）。而「每个至少比前一个远 SEPARATION」的顺序推开
   * 是一遍收敛的，且给出**硬保证**，不是近似。
   *
   * 以玩家为墙是关键：不分左右两组的话，从左往右推会把玩家左侧的敌人推到玩家身上
   * （实测与玩家间距 0.1px，等于穿模）。分两组后：
   *   左组从右往左推，保证 d.x ≤ p.x − PLAYER_SEPARATION，且组内右→左间隔 ≥ SEPARATION
   *   右组从左往右推，保证 d.x ≥ p.x + PLAYER_SEPARATION，且组内左→右间隔 ≥ SEPARATION
   * 两个约束同时是硬保证。
   */
  separate(p) {
    const ds = this.drones;
    const order = this._order;
    let n = 0;
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i];
      if (d.active && d.state !== 'dying') order[n++] = i;
    }
    if (n === 0) return;
    // 按 x 插入排序（n ≤ 12，插入排序常数最小且零分配）
    for (let i = 1; i < n; i++) {
      const k = order[i];
      const kx = ds[k].x;
      let j = i - 1;
      while (j >= 0 && ds[order[j]].x > kx) { order[j + 1] = order[j]; j -= 1; }
      order[j + 1] = k;
    }
    if (!p) {
      let prev = ds[order[0]].x;
      for (let i = 1; i < n; i++) {
        const d = ds[order[i]];
        if (d.x < prev + DRONE.SEPARATION) d.x = prev + DRONE.SEPARATION;
        prev = d.x;
      }
      return;
    }
    // 以玩家为界分组：左组（x < 玩家）从右往左推，右组从左往右推。
    // recover 态的敌人不受玩家排斥约束（它正在被击退，本来就要穿过玩家位置后退），
    // 但仍参与组内间距。
    let split = 0;
    while (split < n && ds[order[split]].x < p.x) split += 1;
    // 左组：右→左
    let prev = p.x - DRONE.PLAYER_SEPARATION;
    for (let i = split - 1; i >= 0; i--) {
      const d = ds[order[i]];
      const maxX = prev - DRONE.SEPARATION;
      if (d.x > maxX) d.x = maxX;
      prev = d.x;
    }
    // 右组：左→右
    prev = p.x + DRONE.PLAYER_SEPARATION;
    for (let i = split; i < n; i++) {
      const d = ds[order[i]];
      const minX = prev + DRONE.SEPARATION;
      if (d.x < minX) d.x = minX;
      prev = d.x;
    }
  }

    /**
     * 判定框查询。返回**复用的 this._hitBuf**（同一引用），调用方立即遍历，不得跨帧持有。
     * 一次挥击对同一敌人只命中一次：用 lastHitSwing 记录本次挥击的 swingId。
     * 有效长度由 _count 给出，数组长度恒为 12（不截断 —— 截断会让"预分配"名存实亡）。
     */
  queryHit(box, swingId) {
    this._count = 0;
    for (let i = 0; i < this.drones.length; i++) {
      const d = this.drones[i];
      if (!d.active || d.state === 'dying') continue;
      if (d.invulnT > 0) continue;              // 无敌中（recover）不参与碰撞
      if (d.lastHitSwing === swingId) continue;  // 本次挥击已命中过
      const cx = d.x;
      const cy = d.y - 6;                        // drone 中心
      // AABB 重叠：判定框在玩家身前
      if (cx < box.x - DRONE.BODY_W * 0.5) continue;
      if (cx > box.x + box.w + DRONE.BODY_W * 0.5) continue;
      if (cy < box.y - DRONE.BODY_H * 0.5) continue;
      if (cy > box.y + box.h + DRONE.BODY_H * 0.5) continue;
      d.lastHitSwing = swingId;
      this._hitBuf[this._count++] = d;
    }
    return this._hitBuf;
  }

  /** 命中结果的有效长度（配合 queryHit 返回的复用数组） */
  get hitCount() { return this._count; }

  /**
   * 施加伤害。
   * kind='hit'  → 扣 1 血，闪白 0.25s，击退，进入 recover 0.4s（无敌）
   * kind='kill' → 直接死，碎裂 + 掉碎片
   */
  damage(d, info) {
    if (!d.active || d.state === 'dying') return;
    const dir = info && info.dir ? info.dir : 1;
    d.hp -= 1;
    if (d.hp <= 0) {
      this.kill(d, info);
      return;
    }
    // 第一刀：闪白 + 击退 + recover（无敌 0.4s）
    d.flashT = DRONE.HIT_FLASH;   // 100ms 纯白 + 150ms 淡出
    d.invulnT = DRONE.RECOVER_T;
    d.state = 'recover';
    d.stateT = 0;
    d.vx = dir * DRONE.KNOCK_V;  // 165px/s × 0.12s ≈ 19.8px ≥ 12px
    d.face = -dir;
  }

  /** 击杀：进入 dying 动画，0.28s 后回收；掉 1 枚霓虹碎片 */
  kill(d, info) {
    d.hp = 0;
    d.state = 'dying';
    d.dieT = 0;
    d.flashT = 0;
    this.kills += 1;
    // 掉碎片：直接把碎片放到 drone 位置（由 city2d 的碎片系统接收）
    if (this.city && this.city.dropShard) this.city.dropShard(d.x, d.y - 8);
  }

  reset() {
    for (let i = 0; i < this.drones.length; i++) this.drones[i].active = false;
    this._count = 0;
    this.kills = 0;
  }
}
