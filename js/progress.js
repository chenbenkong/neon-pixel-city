import { ACHIEVEMENTS } from './data.js';

// 存档键：v1。localStorage 可能被隐私模式/扩展禁用，所有读写都包 try/catch，
// 失败时静默降级为纯内存态，绝不因存档报错卡死游戏。
const SAVE_KEY = 'neon-city-save-v1';

export class Progress {
  constructor() {
    this.mem = this.defaults();
    this.storageOk = true;
    this.load();
  }

  defaults() {
    // bestScore/runs/wins/bestWave 是批次 2 新增（PM Q6 决策：沿用 v1 不升版本，
    // 缺字段走默认值，零迁移风险）。score 仍是历史累计语义，bestScore 是单局最佳。
    return {
      v: 1, score: 0, shards: 0, questsDone: 0, raceBest: null,
      districts: {}, achievements: {},
      bestScore: 0, runs: 0, wins: 0, bestWave: 0,
    };
  }

  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      // 白名单合并，防止脏数据把数值型字段污染成对象
      if (typeof d.score === 'number' && d.score >= 0) this.mem.score = Math.floor(d.score);
      if (typeof d.shards === 'number' && d.shards >= 0) this.mem.shards = Math.floor(d.shards);
      if (typeof d.questsDone === 'number' && d.questsDone >= 0) this.mem.questsDone = Math.floor(d.questsDone);
      if (typeof d.raceBest === 'number' && d.raceBest > 0) this.mem.raceBest = d.raceBest;
      if (d.districts && typeof d.districts === 'object') this.mem.districts = d.districts;
      if (d.achievements && typeof d.achievements === 'object') this.mem.achievements = d.achievements;
      // 批次 2 新增的 4 个字段：旧存档没有它们，直接走 defaults() 的 0，无报错
      if (typeof d.bestScore === 'number' && d.bestScore >= 0) this.mem.bestScore = Math.floor(d.bestScore);
      if (typeof d.runs === 'number' && d.runs >= 0) this.mem.runs = Math.floor(d.runs);
      if (typeof d.wins === 'number' && d.wins >= 0) this.mem.wins = Math.floor(d.wins);
      if (typeof d.bestWave === 'number' && d.bestWave >= 0) this.mem.bestWave = Math.floor(d.bestWave);
    } catch (e) {
      this.storageOk = false; // 读取失败：从零开始，仅内存态
    }
  }

  save() {
    if (!this.storageOk) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.mem));
    } catch (e) {
      this.storageOk = false; // 写入失败（配额/禁用）：静默切内存态
    }
  }

  addScore(n) {
    this.mem.score += n;
    this.save();
  }

  addShard() {
    this.mem.shards += 1;
    this.save();
  }

  questDone() {
    this.mem.questsDone += 1;
    this.save();
  }

  visitDistrict(zh) {
    if (this.mem.districts[zh]) return;
    this.mem.districts[zh] = 1;
    this.save();
  }

  districtCount() {
    return Object.keys(this.mem.districts).length;
  }

  /** 记录竞速用时（秒）。返回 true 表示刷新了最佳纪录 */
  setRaceBest(sec) {
    if (this.mem.raceBest !== null && sec >= this.mem.raceBest) return false;
    this.mem.raceBest = sec;
    this.save();
    return true;
  }

  /** 记录单局最佳得分。返回 true 表示刷新了纪录（结算面板显示"★ 新纪录"） */
  setBestScore(n) {
    if (typeof n !== 'number' || n <= 0) return false;
    if (n <= this.mem.bestScore) return false;
    this.mem.bestScore = Math.floor(n);
    this.save();
    return true;
  }

  /** 记录一局：局数 +1，胜场 +1（若胜），最远波次取最大 */
  addRun(win, wave) {
    this.mem.runs += 1;
    if (win) this.mem.wins += 1;
    const w = typeof wave === 'number' ? wave : 0;
    if (w > this.mem.bestWave) this.mem.bestWave = w;
    this.save();
  }

  isUnlocked(id) {
    return !!this.mem.achievements[id];
  }

  /** 解锁成就。返回 true 表示是首次解锁（用于触发提示） */
  unlock(id) {
    if (this.mem.achievements[id]) return false;
    this.mem.achievements[id] = 1;
    this.save();
    return true;
  }

  achievement(id) {
    for (const a of ACHIEVEMENTS) if (a.id === id) return a;
    return null;
  }
}
