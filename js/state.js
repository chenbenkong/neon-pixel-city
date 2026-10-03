/**
 * state.js —— GameState 状态机 + RunStats（局数据）
 *
 * 存在的唯一理由：主理人 / 架构师都要求「状态转移必须集中管理」。
 * 改造前 main.js 用 mode / busy / entered 三个裸布尔驱动流程，
 * 任何新状态（暂停、结算、死亡）都要往那三个布尔上加分支，必然失控。
 *
 * 本文件不碰 canvas、不碰 audio、不 import city2d.js —— 只管流程真相。
 * 状态以字符串形式传给 hud.js，同理 state.js 不知道 DOM 存在。
 */

export class RunStats {
  constructor() {
    this.maxHp = 3;
    this.hp = 3;
    this.survive = 0;      // 存活秒数
    this.kills = 0;        // 击杀数
    this.shards = 0;       // 碎片收集数（本局）
    this.swings = 0;       // 挥击次数
    this.hits = 0;         // 命中次数
    this.combo = 0;        // 当前连击
    this.comboT = 0;       // 连击剩余窗口
    this.score = 0;        // 本局得分
    this.maxCombo = 0;
  }

  reset() {
    this.hp = this.maxHp;
    this.survive = 0;
    this.kills = 0;
    this.shards = 0;
    this.swings = 0;
    this.hits = 0;
    this.combo = 0;
    this.comboT = 0;
    this.score = 0;
    this.maxCombo = 0;
  }

  /** 命中率 = 命中 / 挥击（分母至少 1，避免 NaN） */
  hitRate() {
    return this.swings > 0 ? this.hits / this.swings : 0;
  }

  /** 评级：S ≥3000 / A ≥1800 / B ≥900 / C 其他（胜利失败共用公式，仅底色不同） */
  grade() {
    const s = this.score;
    if (s >= 3000) return 'S';
    if (s >= 1800) return 'A';
    if (s >= 900) return 'B';
    return 'C';
  }
}

export class GameState {
  constructor() {
    this.cur = 'BOOT';        // BOOT|MENU|PLAYING|PAUSED|RESULT
    this.mode = '2d';         // 2d|3d
    this.shifting = false;    // 2D/3D 转场中
    this.payload = {};        // 转移附带数据（如 {win, stats}）
    this.stats = new RunStats();
    this.pausedFrom = 'PLAYING';
    this.listeners = new Map();
    this.timeScale = 1;       // 慢镜时间倍率（T03 的 Feedback 写入）
    this.frozen = false;      // 顿帧中（T03 的 Feedback 写入）
    this.runSeed = 0;

    // 唯一允许改 cur 的地方：go()
    this.TRANSITIONS = {
      BOOT:    ['MENU'],
      MENU:    ['PLAYING'],
      PLAYING: ['PAUSED', 'RESULT', 'MENU'],
      PAUSED:  ['PLAYING', 'MENU', 'RESULT'],
      RESULT:  ['PLAYING', 'MENU'],
    };
  }

  /** 目标状态是否可达 */
  can(next) {
    const list = this.TRANSITIONS[this.cur];
    if (!list) return false;
    return list.indexOf(next) >= 0;
  }

  is() {
    for (let i = 0; i < arguments.length; i++) {
      if (this.cur === arguments[i]) return true;
    }
    return false;
  }

  /**
   * 状态转移。**全项目唯一改 cur 的入口**。
   * 非法转移返回 false 并 console.warn —— 绝不静默吞掉。
   * payload 可含 { fresh: true }（重开新局）、{ win, stats }（结算）。
   */
  go(next, payload) {
    if (next === this.cur) return false;
    if (!this.can(next)) {
      console.warn(`[GameState] 非法转移 ${this.cur} → ${next}`);
      return false;
    }
    const prev = this.cur;
    this.emit('exit:' + prev, payload);
    this.cur = next;
    this.payload = payload || {};
    if (next === 'PAUSED') this.pausedFrom = prev;
    this.emit('enter:' + next, this.payload);
    return true;
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  emit(event, payload) {
    const list = this.listeners.get(event);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (e) { console.error('[GameState] listener error', event, e); }
    }
  }

  setMode(m) {
    if (this.mode === m) return;
    this.mode = m;
    this.emit('mode:' + m);
  }

  /**
   * 开始 2D/3D 转场。返回 false 表示当前不允许切换（主理人 Q4 裁决的门控）。
   *
   * Q4 门控理由：现有 2D/3D 往返是惩罚式的 ——
   *   transition.js T_END=2.35s 全程无输入权
   *   + city2d.enter() 每次切回强制 player.y = FEET-170 从高空重砸 + 1.9s 入场动画
   * ≈ 5~6 秒不能操作。在波次进行中切换会直接毁掉战斗节奏。
   * 所以只在波次间歇（未开始 / intermission）允许，此时玩家本就在等待。
   *
   * gatePhase 由 main.js 注入（WaveDirector.phase），避免 state.js 依赖 waves.js。
   */
  beginShift() {
    if (this.shifting) return false;
    const phase = this.gatePhase ? this.gatePhase() : null;
    // phase 为 null 表示没有战斗系统（如 T03 未接入 / MENU 下），不门控
    if (phase !== null && phase !== 'idle' && phase !== 'intermission') {
      return 'blocked';   // 特殊返回值：告诉调用方"被门控拒绝，去给玩家提示"
    }
    this.shifting = true;
    this.emit('shift:start');
    return true;
  }

  endShift() {
    this.shifting = false;
    this.emit('shift:end');
  }

  /** 是否处于可切换 2D/3D 的窗口（波次间歇或未开始） */
  canShift() {
    const phase = this.gatePhase ? this.gatePhase() : null;
    if (phase === null) return true;
    return phase === 'idle' || phase === 'intermission';
  }
}
