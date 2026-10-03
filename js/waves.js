/**
 * waves.js —— 波次推进（唯一的"时间 → 事件"映射）
 *
 * 边界：不直接操作 Drone，只调 enemies.spawn()；不知道玩家是谁（通过 ctx 传入）。
 * 调平衡全在这里，调波次不用碰 AI。
 *
 * 状态机：
 *   idle → spawning（按 gapMs 间隔吐敌）→ clearing（等清空）→ intermission(2.5s) → spawning
 *   第 3 波清空 → done（触发 RESULT）
 */
import { WAVE } from './config.js';
import { hash } from './util.js';

export class WaveDirector {
  constructor(enemies, audio) {
    this.enemies = enemies;
    this.audio = audio;
    this.reset();
  }

  reset() {
    this.wave = 1;              // 1..3
    this.phase = 'idle';        // idle|spawning|clearing|intermission|done
    this.spawned = 0;
    this.alive = 0;
    this.timer = 0;
    this.frozen = false;
    this.runSeed = (Math.random() * 1e9) | 0;
    this._labelSig = '';
    this.tickT = 0;             // 间歇期滴答计时
    this.onDone = null;         // done 时回调（main.js 接 RESULT）
    this._labelSig = '';        // label() 的缓存签名
    this._labelText = '';
    this.totalKills = 0;
  }

  /** 剩余敌数 = 存活 + 还没吐出来的（HUD 显示"剩余敌 N"） */
  remaining() {
    const cfg = WAVE.LIST[this.wave - 1];
    if (!cfg) return 0;
    const pending = Math.max(0, cfg.count - this.spawned);
    return this.enemies.aliveCount + pending;
  }

  /**
   * HUD 文案：'WAVE 2/3' 或间歇期 'WAVE 2 IN 2.5'。
   * 结果缓存：只在 (phase, wave, 0.1s 粒度的 timer) 变化时重建字符串。
   * HUD 每帧都读这个值，不缓存就是每帧一个模板字符串 → 每帧一次 GC 压力。
   */
  label() {
    const bucket = Math.ceil(this.timer * 10) / 10;   // 0.1s 粒度，够 HUD 用且大幅减少重建
    const sig = this.phase + '|' + this.wave + '|' + bucket;
    if (sig === this._labelSig) return this._labelText;
    let t;
    if (this.phase === 'intermission') {
      t = `WAVE ${this.wave + 1} IN ${Math.max(0, bucket).toFixed(1)}`;
    } else if (this.phase === 'done') {
      t = `WAVE ${WAVE.LIST.length} CLEAR`;
    } else {
      t = `WAVE ${this.wave}/${WAVE.LIST.length}`;
    }
    this._labelSig = sig;
    this._labelText = t;
    return t;
  }

  /**
   * 刷怪锚点：同一波内位置确定（由 runSeed 决定），玩家可以学习"第 2 波从左边来"。
   * 第 1 只取 +1 方向、第 2 只取 -1，之后交替。
   */
  _anchorX(ctx) {
    const dir = (this.spawned % 2 === 0) ? 1 : -1;
    const h = hash(this.runSeed, this.wave * 97, this.spawned);
    let x = ctx.player.x + dir * (WAVE.SPAWN_ANCHOR_MIN + h * 240);
    // 极端情况：落在玩家 ±60 内则再往外推 200px
    if (Math.abs(x - ctx.player.x) < 60) x = ctx.player.x + dir * (WAVE.SPAWN_ANCHOR_MIN + 200);
    return x;
  }

  /** 每帧推进。ctx = { player, camX, W, FEET } */
  update(dt, ctx) {
    if (this.frozen) return;   // 2D/3D 切换、PAUSED、RESULT 时冻结（连 timer 都不减）
    const cfg = WAVE.LIST[this.wave - 1];
    if (!cfg) { this._finish(); return; }

    switch (this.phase) {
      case 'idle':
        this.phase = 'spawning';
        this.timer = 0;
        break;

      case 'spawning': {
        this.alive = this.enemies.aliveCount;
        if (this.spawned < cfg.count) {
          this.timer -= dt;
          if (this.timer <= 0) {
            const x = this._anchorX(ctx);
            this.enemies.spawn(x, { hp: WAVE.DRONE_HP });
            this.enemies.waveSpeedMul = cfg.speedMul;
            this.spawned += 1;
            this.timer = cfg.gapMs / 1000;
          }
        } else {
          this.phase = 'clearing';
        }
        break;
      }

      case 'clearing':
        this.alive = this.enemies.aliveCount;
        if (this.alive === 0) {
          if (this.wave >= WAVE.LIST.length) {
            this._finish();
          } else {
            this.phase = 'intermission';
            this.timer = WAVE.INTERMISSION;
            this.tickT = 0;
            if (this.onWaveClear) this.onWaveClear(this.wave);
          }
        }
        break;

      case 'intermission': {
        this.timer -= dt;
        // 每 0.5s 播一次滴答音
        this.tickT += dt;
        if (this.tickT >= 0.5) {
          this.tickT -= 0.5;
          if (this.audio && this.audio.sfxTick) this.audio.sfxTick();
        }
        if (this.timer <= 0) {
          this.wave += 1;
          this.spawned = 0;
          this.phase = 'spawning';
          this.timer = 0;
          if (this.onWaveStart) this.onWaveStart(this.wave);
        }
        break;
      }

      default:
        break;
    }
  }

  /** 击杀回调（由 city2d 在 enemy.kill 时调） */
  onKill() {
    this.totalKills += 1;
  }

  freeze() { this.frozen = true; }
  thaw() { this.frozen = false; }

  _finish() {
    if (this.phase === 'done') return;
    this.phase = 'done';
    if (this.onDone) this.onDone();
  }
}
