/**
 * combat.js —— 玩家攻击三段状态机（前摇 → 判定 → 后摇）
 *
 * 边界：只管玩家自己的攻击。不画任何像素（刀光交给 Feedback.render），
 * 不做伤害结算（伤害由 EnemyManager.damage 施加），不做击退物理。
 *
 * 为什么要三段而不是瞬发：瞬发攻击没有"挥空"的概念，玩家会因为不确定是否打中
 * 而反复乱按；有了前摇与后摇，"我这一下没打到"本身就是反馈。
 */
import { ATK, MOVE, DRONE, FEEL } from './config.js';

export class PlayerCombat {
  /**
   * @param {object} player city2d.player 的**同一引用**（不是拷贝）
   * @param {EnemyManager} enemies
   * @param {Feedback} feedback
   * @param {object} audio AudioEngine 实例（T05 接入战斗音色后使用）
   */
  constructor(player, enemies, feedback, audio) {
    this.player = player;
    this.enemies = enemies;
    this.feedback = feedback;
    this.audio = audio;

    this.phase = 'idle';   // idle | windup | active | recover
    this.phaseT = 0;       // 当前段已耗时（s）
    this.swingId = 0;      // 每次挥击自增，用于命中去重
    this.lastHit = false;  // 本次挥击是否命中（决定刀光颜色与是否播命中音）
    this.hitCount = 0;     // 本次挥击的命中数（供统计）
    // 攻击输入缓冲：按早了也要打出来
    this.bufferT = 0;
    // 判定框复用对象：每次 hitbox() 返回同一引用，零分配
    this._box = { x: 0, y: 0, w: ATK.BOX_W, h: ATK.BOX_H };
    this.audioReady = false;
    // 回调（由 city2d 注入）：挥击计数与命中统计/连击归场景管，combat 只管时序与判定
    this.onSwing = null;
    this.onHit = null;
  }

  get busy() {
    return this.phase !== 'idle';
  }

  /**
   * 每帧推进。输入读取表达式对键盘与触屏完全等价（PRD P0-6 验收 6）：
   *   键盘 = KeyJ 的边沿；触屏 = input.btn.atk（同样是边沿，由 input.js 在 pointerdown 置位）
   */
  update(dt, input) {
    const p = this.player;

    // 输入缓冲：先衰减再置位，保证按下的那一帧拿到完整窗口
    this.bufferT = Math.max(0, this.bufferT - dt);
    const atkPressed = input.hit('KeyJ') || input.touchAtk === true || input.btn.atk === true;
    if (atkPressed) this.bufferT = ATK.BUFFER;

    if (this.phase === 'idle') {
      if (this.bufferT > 0) this.start();
      return;
    }

    this.phaseT += dt;

    // 后摇的移动取消窗口：phaseT > 45ms 后按方向键即可取消（PRD P0-6 验收 7）
    if (this.phase === 'recover' && this.phaseT >= ATK.CANCEL_RECOVER_AT) {
      const moving = input.down('KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight');
      if (moving) {
        this.cancel();
        return;
      }
    }

    // 状态推进
    if (this.phase === 'windup' && this.phaseT >= ATK.WINDUP) {
      this.phase = 'active';
      this.phaseT -= ATK.WINDUP;
    } else if (this.phase === 'active' && this.phaseT >= ATK.ACTIVE) {
      this.phase = 'recover';
      this.phaseT -= ATK.ACTIVE;
      // 挥击音：无论命中与否都出（挥空是独立音色，PRD P0-6 验收 5）
      this._playSwing();
    } else if (this.phase === 'recover' && this.phaseT >= ATK.RECOVER) {
      this.phase = 'idle';
      this.phaseT = 0;
    }

    // 判定查询放在 active 段，且必须在 enemy.update 之后（由 city2d 的调用顺序保证）
    if (this.phase === 'active') {
      const box = this.hitbox();
      if (box) {
        // queryHit 返回复用的 _hitBuf，有效长度看 enemies.hitCount（数组本身不截断）
        const hits = this.enemies.queryHit(box, this.swingId);
        const n = this.enemies.hitCount;
        for (let i = 0; i < n; i++) {
          const d = hits[i];
          const kind = d.hp <= 1 ? 'kill' : 'hit';
          this.enemies.damage(d, { dir: p.face, kind });
          this.hitCount += 1;
          this.lastHit = true;
          this.feedback.hit({ x: d.x, y: d.y - DRONE.BODY_H * 0.5, dir: p.face, kind });
          if (this.onHit) this.onHit(kind);
          if (kind === 'kill') {
            this.feedback.slowmo(FEEL.SLOWMO_HIT[0], FEEL.SLOWMO_HIT[1]);
            this._playKill();
          } else {
            this._playHit();
          }
        }
        // 本次挥击的判定帧跑完后，把刀光标记为"命中过"（影响刀光颜色）
        this.feedback.slash.hit = this.lastHit;
      }
    }
  }

  /**
   * 当前判定框。返回**复用的同一对象**，调用方不得持有引用跨帧。
   * 位置：玩家身前 BOX_OFF=4px 起，宽 26 高 18（PRD P0-6 验收 2）。
   */
  hitbox() {
    if (this.phase !== 'active') return null;
    const p = this.player;
    const b = this._box;
    b.w = ATK.BOX_W;
    b.h = ATK.BOX_H;
    b.x = p.x + ATK.BOX_OFF * p.face;
    b.y = p.y - 26;   // 以角色身高 26px 为准，判定框覆盖躯干中段
    return b;
  }

  /** 起手。swingId 自增是命中去重的唯一依据（Uint8 环形，256 次后自然回绕） */
  start() {
    if (this.phase !== 'idle') return;
    this.phase = 'windup';
    this.phaseT = 0;
    this.swingId = (this.swingId + 1) & 255;
    this.lastHit = false;
    this.hitCount = 0;
    this.bufferT = 0;
    this.feedback.swing(this.player.x, this.player.y, this.player.face, false);
    if (this.onSwing) this.onSwing();
  }

  /** 取消（后摇的移动取消窗口用） */
  cancel() {
    this.phase = 'idle';
    this.phaseT = 0;
  }

  reset() {
    this.phase = 'idle';
    this.phaseT = 0;
    this.swingId = 0;
    this.lastHit = false;
    this.hitCount = 0;
    this.bufferT = 0;
  }

  /**
   * 攻击期对移动的限制：前摇期间水平速度上限 ×0.35（PRD 允许"轻攻击微调位置"），
   * 判定期间速度锁定（不允许挥砍时滑行）。
   * 返回对目标速度的倍率，city2d 在算 target 时乘上。
   */
  moveMul() {
    if (this.phase === 'windup') return MOVE.atkWindupMul;
    if (this.phase === 'active') return 0;   // 锁定
    return 1;
  }

  // ---- 音色（T05 会把这里换成独立音色；本批次先走已有的 blip 占位）----
  _playSwing() {
    if (this.audio && this.audio.sfxSwing) this.audio.sfxSwing();
    else if (this.audio) this.audio.blip(760, 0.07, 0.05, 'triangle');
  }
  _playHit() {
    if (this.audio && this.audio.sfxHit) this.audio.sfxHit(false);
    else if (this.audio) this.audio.blip(880, 0.06, 0.06, 'square');
  }
  _playKill() {
    if (this.audio && this.audio.sfxKill) this.audio.sfxKill();
    else if (this.audio) this.audio.blip(180, 0.16, 0.07, 'sawtooth');
  }
}

