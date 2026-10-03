const BLOCK = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

export class Input {
  constructor(stage) {
    this.keys = new Set();
    this.pressed = new Set();
    this.drag = { dx: 0, dy: 0, active: false };
    this.wheel = 0;
    this.joy = { x: 0, y: 0, active: false };
    this.btn = { up: false, down: false, boost: false, atk: false };
    this.touchJump = false;
    this.touchAtk = false;   // 触屏攻击键的边沿标记，与 touchJump 同范式

    addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'INPUT') return;
      if (BLOCK.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    let last = null;
    stage.addEventListener('pointerdown', (e) => {
      last = { x: e.clientX, y: e.clientY, id: e.pointerId };
      this.drag.active = true;
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
      if (!last || e.pointerId !== last.id) return;
      this.drag.dx += e.clientX - last.x;
      this.drag.dy += e.clientY - last.y;
      last.x = e.clientX; last.y = e.clientY;
    });
    const up = (e) => {
      if (last && e.pointerId === last.id) { last = null; this.drag.active = false; }
    };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', (e) => { this.wheel += e.deltaY; e.preventDefault(); }, { passive: false });

    this.setupTouch();
  }

  setupTouch() {
    const joy = document.getElementById('joy');
    const knob = document.getElementById('joyKnob');
    if (!joy) return;
    let id = null, cx = 0, cy = 0;
    const R = 46;
    const move = (x, y) => {
      let dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx *= R / d; dy *= R / d; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.joy.x = dx / R; this.joy.y = dy / R;
    };
    joy.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      id = e.pointerId;
      const r = joy.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      joy.setPointerCapture(id);
      this.joy.active = true;
      move(e.clientX, e.clientY);
    });
    joy.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e.clientX, e.clientY); });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null; this.joy.x = this.joy.y = 0; this.joy.active = false;
      knob.style.transform = '';
    };
    joy.addEventListener('pointerup', end);
    joy.addEventListener('pointercancel', end);

    document.querySelectorAll('[data-btn]').forEach((b) => {
      const k = b.dataset.btn;
      const on = (e) => { e.stopPropagation(); e.preventDefault(); this.btn[k] = true; if (k === 'up') this.touchJump = true; if (k === 'atk') this.touchAtk = true; b.classList.add('on'); };
      const off = () => { this.btn[k] = false; b.classList.remove('on'); };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointerleave', off);
      b.addEventListener('pointercancel', off);
    });
  }

  down(...codes) {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  hit(...codes) {
    for (const c of codes) if (this.pressed.has(c)) return true;
    return false;
  }

  /**
   * 帧末清理。
   *
   * keepPressed：顿帧冻结期传 true，此时不清 pressed。
   * 原因：顿帧期间 simDt=0 但 endFrame 照常执行，玩家在 60ms 冻结期内按下的 J 会被丢弃。
   * 不清的话，下一个非冻结帧会消费到它（input 层无需知道"什么是顿帧"，只接收一个布尔）。
   */
  endFrame(keepPressed) {
    if (!keepPressed) this.pressed.clear();
    this.drag.dx = this.drag.dy = 0;
    this.wheel = 0;
    this.touchJump = false;
    this.touchAtk = false;
  }
}
