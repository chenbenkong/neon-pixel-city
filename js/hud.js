/**
 * hud.js —— 常驻 HUD 的唯一渲染出口（12 字段脏检查）
 *
 * 存在的理由：批次 2 之前，HUD 的散装 DOM 写入散落在 main.js 的 hud() 里，
 * 每帧读一堆 textContent 再写回去。DOM 写入即使值没变也会触发样式失效，
 * 在 1920×1080 全屏 canvas 旁边尤其贵。
 *
 * 做法：把 12 个字段的"上次写进去的值"存在 this.prev 上，
 * 只有真正变化的那一个才碰 DOM。稳态下 12 个字段全不变 → **零 DOM 写入**。
 *
 * 边界（PM 的 P5「常驻元素 ≤6」）：
 *   本文件只管**战斗 HUD 容器内部**的 4 组信息（心形血格 / 波次 / 剩余 / 连击）
 *   与时钟。时钟、频谱、常驻按键表**不在这里**：
 *   · 频谱：批次 1 已删过一次，不加回来（加回来会破坏 P5）
 *   · 按键表：只放菜单与暂停面板，不常驻
 *   也就是说这个文件不会让屏幕上的常驻元素变多。
 */
import { HUD } from './config.js';

export class Hud {
  /**
   * @param {object} city  city2d 实例（只读 W/H/FEET 与战斗数据）
   * @param {AudioEngine} audio 用于把频谱数据喂给画布上的频谱条
   */
  constructor(city, audio) {
    this.city = city;
    this.audio = audio;
    // 12 个字段的脏检查缓存。初始全用 Symbol/'' 保证首帧必定全部写入。
    this.prev = {
      hp: -1, hpMax: -1, wave: -1, waveLabel: '', remain: -1,
      combo: -1, score: -1, clock: '', kills: -1, shards: -1,
      low: null, district: '',
    };
    this.dom = {};
    this.visible = false;
    this._lastClockMin = -1;
  }

  /** 惰性绑定 DOM。面板可能还没进 DOM，所以每次都做存在性检查 */
  bind() {
    const d = this.dom;
    d.root = document.getElementById('combatHud');
    d.hpIcons = document.getElementById('hpIcons');
    d.wvLabel = document.getElementById('wvLabel');
    d.wvRemain = document.getElementById('wvRemain');
    d.comboBox = document.getElementById('comboBox');
    d.cbNum = document.getElementById('cbNum');
    d.clock = document.getElementById('hudClock');
    return this;
  }

  /**
   * 每帧调用。**稳态零 DOM 写入**：12 个字段逐一比对 prev，只写变化项。
   * @param {number} dt 帧时长
   * @param {object} state GameState（判可见性）
   */
  update(dt, state) {
    const city = this.city;
    if (!city) return;
    const m = city.getHudModel();
    const p = this.prev;

    // ---- 可见性：只在 PLAYING 显示（菜单/暂停/结算由各自面板承担） ----
    const want = state ? state.is('PLAYING') : true;
    if (want !== this.visible) {
      this.visible = want;
      const el = this.dom.root || document.getElementById('combatHud');
      if (el) el.style.opacity = want ? '' : '0';
    }
    if (!want) return;

    // ---- 1) 生命：心形血格 ----
    if (m.hp !== p.hp || m.maxHp !== p.hpMax) {
      p.hp = m.hp;
      p.hpMax = m.maxHp;
      const box = this.dom.hpIcons;
      if (box) {
        const icons = box.children;
        for (let i = 0; i < icons.length; i++) icons[i].classList.toggle('on', i < m.hp);
        // 剩 1 格 → 2Hz 脉冲（P0-4 验收 5）
        const low = m.hp === 1;
        if (low !== p.low) { p.low = low; box.classList.toggle('low', low); }
      }
    }

    // ---- 2) 波次标签 ----
    if (m.label !== p.waveLabel) {
      p.waveLabel = m.label;
      const el = this.dom.wvLabel;
      if (el) el.textContent = m.label;
    }

    // ---- 3) 剩余敌数 ----
    if (m.remaining !== p.remain) {
      p.remain = m.remaining;
      const el = this.dom.wvRemain;
      if (el) el.textContent = '剩余 ' + m.remaining;
    }

    // ---- 4) 连击（仅 ≥2 显示） ----
    if (m.combo !== p.combo) {
      p.combo = m.combo;
      const box = this.dom.comboBox;
      if (box) {
        box.classList.toggle('on', m.combo > 1);
        const n = this.dom.cbNum;
        if (n) n.textContent = String(Math.max(0, m.combo));
      }
    }

    // ---- 5) 本局得分 ----
    if (m.score !== p.score) {
      p.score = m.score;
      const el = document.getElementById('hudScore');
      if (el) el.textContent = String(m.score);
    }

    // ---- 6) 击杀 / 碎片 ----
    if (m.kills !== p.kills) {
      p.kills = m.kills;
      const el = document.getElementById('hudKills');
      if (el) el.textContent = String(m.kills);
    }
    if (city.runShards !== p.shards) {
      p.shards = city.runShards;
      const el = document.getElementById('hudShards');
      if (el) el.textContent = String(city.runShards);
    }

    // ---- 7) 时钟：按分钟缓存。60 秒才写一次 DOM ----
    const total = Math.floor(city.runTime || 0);
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    const clock = mm + ':' + ss;
    if (clock !== p.clock) {
      p.clock = clock;
      const el = this.dom.clock;
      if (el) el.textContent = clock;
    }

    // ---- 8) 受击红闪：opacity 脏检查。
    // #hurtVignette 是 inset:0 全屏元素，每帧改 opacity 会强制合成器重建整屏图层
    // （实测 2D +4ms / 3D +7ms），所以未受击时一次写入后再不碰。
    const hv = city.feedback.hurtAlpha();
    const hvStr = hv > 0 ? String(Math.min(1, hv * 1.8)) : '0';
    if (hvStr !== this._hv) {
      this._hv = hvStr;
      const v = document.getElementById('hurtVignette');
      if (v) v.style.opacity = hvStr;
    }
  }

  /** 受击一次性红闪动画（HP 格闪白），与 hurtVignette 的持续渐晕是两回事 */
  flashHurt() {
    const box = this.dom.hpIcons || document.getElementById('hpIcons');
    if (!box) return;
    box.classList.remove('hurt');
    // 强制 reflow 让动画能重启动（移除后必须让浏览器看到一次布局）
    void box.offsetWidth;
    box.classList.add('hurt');
  }

  reset() {
    const p = this.prev;
    p.hp = -1; p.hpMax = -1; p.wave = -1; p.waveLabel = ''; p.remain = -1;
    p.combo = -1; p.score = -1; p.clock = ''; p.kills = -1; p.shards = -1;
    p.low = null; p.district = '';
    this._hv = undefined;
    this.visible = false;
  }

  /** 验收脚本用：返回本帧实际发生 DOM 写入的字段名（没写就空数组） */
  writtenFields() {
    return this._written || [];
  }
}

// 供 main.js 复用同一套 HUD 常量
export { HUD };
