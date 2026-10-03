import { QUEST_TEMPLATES } from './data.js';

/**
 * 任务系统：同一时间只挂 1 个任务，完成自动派发下一个，循环不息。
 * 纯规则层 —— 不 import three / city3d。3D 检查点通过 hooks.getCity3d()
 * 拿到实例后调用其窄接口（setRace / clearRace），three 对象不外泄。
 *
 * hooks = {
 *   banner(title, sub), toast(msg), audio, refreshScore(),
 *   getCity3d(): City3D | null
 * }
 */
export class QuestSystem {
  constructor(progress, hooks) {
    this.save = progress;
    this.hooks = hooks;
    this.idx = 0;            // 模板游标（循环取用）
    this.current = null;     // 当前任务实例
    this.raceActive = false; // 竞速进行中（仅在 3D 且玩家已进入时）
    this.el = null;          // HUD DOM 引用，由 init() 注入
    this._acc = 0;
    this._nextTimer = 0;
    // P0-14 软锁死修复：race 任务在 2D 下会永远停在 WAIT（onShard/onDistrict/onCheckpoint
    // 全部因类型不匹配或 !raceActive 而 return，complete 永不触发），
    // 而游戏没有放弃机制 → 玩家被永久卡死。这里用「20 秒自动改派 + 手动放弃按钮」双出口解决。
    this.waitT = 0;            // race-WAIT 态已停留时长
    this._raceLeft = undefined; // 竞速剩余时间（跨 2D/3D 往返保持，不重置为满值）
  }

  /** 注入任务卡 DOM 引用 */
  init(el) {
    this.el = el; // { card, title, desc, bar, prog }
    // 放弃按钮：race-WAIT 态的手动出口，与 20 秒自动改派互补
    this.skipBtn = document.getElementById('questSkip');
    if (this.skipBtn) {
      const self = this;
      this.skipBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        self.abandon();
      });
    }
  }

  /** 派发下一个任务 */
  next() {
    const tpl = QUEST_TEMPLATES[this.idx % QUEST_TEMPLATES.length];
    this.idx += 1;
    const q = {
      type: tpl.type,
      n: tpl.n || 1,
      done: 0,
      title: tpl.title,
      reward: tpl.reward,
      time: tpl.time || 0,
      left: tpl.time || 0,
      desc: tpl.desc,
      zone: null,
    };
    if (tpl.type === 'visit') {
      const d = this.hooks.randomDistrict();
      q.zone = d.zh;
      q.desc = tpl.desc.replace('{zone}', `${d.zh} · ${d.en}`);
    }
    this.current = q;
    if (q.type === 'race') {
      // 竞速任务需要 3D；若当前不在 3D，提示玩家切换，等 onModeChanged 再开跑
      this.raceActive = false;
      this.waitT = 0;
      this._raceLeft = undefined;
      this.hooks.toast('按 TAB 进入 3D 开始竞速 · 20 秒后自动改派');
    } else {
      this.hooks.toast('新任务 · ' + q.title);
    }
    this.renderCard();
  }

  /** 收到碎片（任意模式） */
  onShard() {
    const q = this.current;
    if (!q || q.type !== 'collect') return;
    q.done += 1;
    if (q.done >= q.n) this.complete();
    else this.renderCard();
  }

  /** 进入某区域（2D/3D 通用，zh 与 DISTRICTS 一致） */
  onDistrict(zh) {
    const q = this.current;
    if (!q || q.type !== 'visit' || q.zone !== zh) return;
    this.complete();
  }

  /** 模式切换通知：竞速任务只在 3D 进行，回 2D 即挂起 */
  onModeChanged(mode) {
    if (!this.current || this.current.type !== 'race') return;
    if (mode === '3d') this.startRace(this.current);
    else this.abortRace();
  }

  startRace(q) {
    const c3 = this.hooks.getCity3d();
    if (!c3) return; // 3D 包未就绪：等下次切模式
    c3.setRace(q.n);
    q.done = 0;
    // 剩余时间只在首次设定。原先每次 startRace 都重置为满值，
    // 于是「2D → 3D → 2D → 3D」的往返会把倒计时刷满，玩家实际拥有无限时间。
    if (this._raceLeft === undefined) this._raceLeft = q.time;
    q.left = this._raceLeft;
    this.raceActive = true;
    this.hooks.toast(`竞速开始 · 限时 ${Math.ceil(q.left)} 秒`);
    this.renderCard();
  }

  abortRace() {
    if (!this.raceActive) return;
    this.raceActive = false;
    const c3 = this.hooks.getCity3d();
    if (c3) c3.clearRace();
  }

  /** 3D 检查点回调（idx 从 1 开始） */
  onCheckpoint(idx, total) {
    const q = this.current;
    if (!q || q.type !== 'race' || !this.raceActive) return;
    q.done = Math.min(idx, total);
    if (q.done >= q.n) this.completeRace();
    else {
      this.hooks.audio.blip(2300, 0.06, 0.05);
      this.renderCard();
    }
  }

  /** 竞速计时（每帧调用，代价极低） */
  update(dt) {
    // 结算 / 暂停时冻结所有计时：面板期间不该继续走倒计时
    if (this.hooks.isGameState && this.hooks.isGameState('RESULT', 'PAUSED')) return;
    const q = this.current;
    if (!q) return;
    // P0-14：race 在 2D 下停留超时 → 自动改派为 collect，解除软锁死
    if (q.type === 'race' && !this.raceActive) {
      this.waitT += dt;
      if (this.waitT >= 20) this.requeueAsCollect('竞速超时 · 已改派为碎片回收');
      return;
    }
    if (q.type !== 'race' || !this.raceActive) return;
    q.left -= dt;
    if (q.left <= 0) {
      this.hooks.toast('竞速超时 · 检查点已重置');
      this._raceLeft = undefined;   // 超时后允许重新给满时间（新一轮竞速）
      this.startRace(q);
      return;
    }
    this._acc += dt;
    if (this._acc > 0.25) {
      this._acc = 0;
      this.renderCard();
    }
  }

  /**
   * 把当前 race 任务原地改写为 collect（不走 complete()）。
   * 刻意不给全额奖励：改派不是"完成"。改派后玩家仍可正常完成它并拿到 collect 的奖励。
   */
  requeueAsCollect(msg) {
    const q = this.current;
    if (!q) return;
    this.raceActive = false;
    // 固定回落到 collect#0（5 碎片 / 50 分）：走模板环会再次拿到 race，死循环
    const tpl = QUEST_TEMPLATES[0];
    q.type = 'collect';
    q.n = tpl.n;
    q.done = 0;
    q.title = tpl.title;
    q.desc = tpl.desc;
    q.reward = tpl.reward;
    q.time = 0;
    q.left = 0;
    this.waitT = 0;
    this._raceLeft = undefined;
    this.hooks.toast(msg);
    this.hooks.banner('任务改派 · ' + q.title, q.desc);
    this.renderCard();
  }

  /** 玩家主动放弃（不等 20 秒）。奖励减半作为代价 */
  abandon() {
    const q = this.current;
    if (!q || q.type !== 'race' || this.raceActive) return false;
    this.requeueAsCollect('已放弃竞速 · 改派为碎片回收');
    q.reward = Math.floor(q.reward / 2);
    this.renderCard();
    return true;
  }

  completeRace() {
    const q = this.current;
    this.raceActive = false;
    this._raceLeft = undefined;   // 完成后再开新竞速重新给满时间
    const c3 = this.hooks.getCity3d();
    if (c3) c3.clearRace();
    const used = Math.round((q.time - q.left) * 10) / 10;
    const isRecord = this.save.setRaceBest(used);
    this.complete();
    if (isRecord) {
      this.hooks.banner('NEW RECORD · 竞速之王', `用时 ${used} 秒 · 刷新最佳纪录`);
      this.onAchievement('race_record');
    }
  }

  complete() {
    const q = this.current;
    if (!q) return;
    this.save.addScore(q.reward);
    this.save.questDone();
    this.hooks.banner('QUEST CLEAR · ' + q.title, `+${q.reward} 积分`);
    this.hooks.audio.blip(2600, 0.1, 0.06);
    this.current = null;
    this.renderCard();
    this.hooks.refreshScore();
    // 成就检查
    const n = this.save.mem.questsDone;
    this.onAchievement('first_quest');
    if (n >= 5) this.onAchievement('quest_5');
    if (n >= 15) this.onAchievement('quest_15');
    // 延迟派发下一个，给 banner 留出展示时间
    clearTimeout(this._nextTimer);
    this._nextTimer = setTimeout(() => this.next(), 2600);
  }

  /** 成就统一入口：首次解锁时 toast 立即 + banner 延迟展示（避免覆盖任务 banner） */
  onAchievement(id) {
    if (!this.save.unlock(id)) return;
    const a = this.save.achievement(id);
    if (!a) return;
    this.hooks.toast(`成就解锁 · ${a.name}`);
    setTimeout(() => this.hooks.banner('ACHIEVEMENT · ' + a.name, a.desc), 1400);
    this.hooks.refreshScore();
  }

  /** 渲染任务卡（事件驱动调用，不进 rAF） */
  renderCard() {
    const el = this.el;
    if (!el) return;
    const q = this.current;
    if (!q) {
      el.title.textContent = '待派发…';
      el.desc.textContent = '正在从中间人终端拉取新任务';
      el.bar.style.width = '0%';
      el.prog.textContent = 'STANDBY';
      return;
    }
    el.title.textContent = q.title;
    let prog;
    // 放弃按钮只在 race-WAIT 态出现（玩家正被卡住的那一刻才给出口）
    if (this.skipBtn) this.skipBtn.style.display = (q.type === 'race' && !this.raceActive) ? '' : 'none';
    if (q.type === 'race' && !this.raceActive) {
      const left = Math.max(0, Math.ceil(20 - this.waitT));
      el.desc.textContent = q.desc + `（按 TAB 进入 3D · ${left}s 后自动改派）`;
      prog = 0;
      el.prog.textContent = 'WAIT';
    } else {
      el.desc.textContent = q.desc;
      prog = Math.min(1, q.done / q.n);
      el.prog.textContent = q.type === 'race' && this.raceActive
        ? `${q.done}/${q.n} · 剩 ${Math.max(0, Math.ceil(q.left))}s`
        : `${q.done}/${q.n}`;
    }
    el.bar.style.width = Math.round(prog * 100) + '%';
  }
}
