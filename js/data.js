export const PIXEL_FONT = '"FusionPixel", "PingFang SC", "Microsoft YaHei", monospace';

export const DISTRICTS = [
  { zh: '歌舞伎町', en: 'KABUKI-CHO', a: '#ff2bd6', b: '#29f0ff', c: '#ffd166', sky: ['#07031a', '#2a0b4a', '#a3246f'], haze: '#6a1f66', body: '#1b1030' },
  { zh: '九龙寨城', en: 'KOWLOON STACK', a: '#ffb020', b: '#3dff9e', c: '#ff4d4d', sky: ['#05060f', '#221838', '#7a3b2a'], haze: '#5a3326', body: '#1a1320' },
  { zh: '霓虹港湾', en: 'NEON HARBOR', a: '#29f0ff', b: '#7a5cff', c: '#ff5ea8', sky: ['#020617', '#0c1f4f', '#1f6690'], haze: '#164a6c', body: '#0e1428' },
  { zh: '义体市场', en: 'CHROME BAZAAR', a: '#c04dff', b: '#c6ff3d', c: '#29f0ff', sky: ['#06030f', '#26104a', '#6a2a9a'], haze: '#46226e', body: '#170f2c' },
  { zh: '天穹露台', en: 'SKYHIGH TERRACE', a: '#ff3860', b: '#2de2c8', c: '#fff275', sky: ['#080312', '#320d30', '#b0304e'], haze: '#6e2238', body: '#1c0e22' },
  { zh: '数据坟场', en: 'DATA CEMETERY', a: '#39ff6a', b: '#00c2ff', c: '#e0ff4f', sky: ['#010805', '#06301e', '#127050'], haze: '#10493a', body: '#0a1a16' },
];

export const districtAt = (i) => DISTRICTS[((i % DISTRICTS.length) + DISTRICTS.length) % DISTRICTS.length];

export const SHOPS = [
  { sign: '拉麺', en: 'RAMEN', interior: '#ffb46b' },
  { sign: '酒吧', en: 'NIGHT BAR', interior: '#ff5ea8' },
  { sign: 'ゲーム', en: 'ARCADE', interior: '#7a6cff' },
  { sign: '义体诊所', en: 'CHROME CLINIC', interior: '#29f0ff' },
  { sign: '薬局', en: 'PHARMACY', interior: '#3dff9e' },
  { sign: 'ホテル', en: 'CAPSULE HOTEL', interior: '#ffd166' },
  { sign: '面馆', en: 'NOODLE HOUSE', interior: '#ff8a3d' },
  { sign: 'カラオケ', en: 'KARAOKE', interior: '#ff2bd6' },
  { sign: '网吧', en: 'NET CAFE', interior: '#00c2ff' },
  { sign: '寿司', en: 'SUSHI BAR', interior: '#ff4d4d' },
  { sign: '占卜', en: 'FORTUNE', interior: '#c04dff' },
  { sign: '电子', en: 'ELECTRONICS', interior: '#6ff7ff' },
];

export const VERTICAL_WORDS = ['霓虹', '电脑', '未来', '酒', '夜市', '龍', '梦', '爱', '電脳', '赛博', '极乐', '天堂', '无限', '数据', '幻影', '银翼', '机械', '量子', '东京', '香港', '上海', '深夜', '禁区'];
export const BIG_WORDS = ['CYBER', 'NEON', '2077', 'OPEN', 'HOTEL', 'SYNTH', 'DREAM', 'NOVA', 'ZERO', 'VOID', '24H', 'NEXUS'];

export const ADS = [
  { t1: '电子梦', t2: 'E-DREAM', c1: '#ff2bd6', c2: '#29f0ff' },
  { t1: '量子可乐', t2: 'Q-COLA', c1: '#ff3860', c2: '#fff275' },
  { t1: '义体升级', t2: 'UPGRADE', c1: '#29f0ff', c2: '#c04dff' },
  { t1: '极乐天堂', t2: 'PARADISE', c1: '#ffd166', c2: '#ff2bd6' },
  { t1: '神经链接', t2: 'NEURALINK', c1: '#39ff6a', c2: '#00c2ff' },
  { t1: '龍の酒', t2: 'DRAGON SAKE', c1: '#ffb020', c2: '#ff4d4d' },
  { t1: '无限记忆', t2: 'INFINITE', c1: '#7a5cff', c2: '#6ff7ff' },
  { t1: '夜之城', t2: 'NIGHT CITY', c1: '#ff5ea8', c2: '#2de2c8' },
];

export const TRACKS = ['霓虹夜雨 · Neon Rain', '数据之海 · Data Ocean', '午夜飞行 · Midnight Flight', '电子梦境 · Electric Dreams'];

// ---------------- 玩法扩展数据 ----------------

// NPC 对话文案（赛博朋克风味，随机弹出）
export const NPC_LINES = [
  '雨里的霓虹比白天诚实。',
  '我的义眼又在漏电……第三只了。',
  '别信任何免费升级，尤其是记忆。',
  '今晚的酸雨腐蚀性不错，适合洗掉过去。',
  '公司塔顶那盏灯，是给死人照的。',
  '我在这条街站了三十年，招牌换了六轮。',
  '碎片？那是旧网络的残渣，捡了会上瘾。',
  '你身上有股数据坟场的味道。',
  '拉面还是那家拉面，汤底换了三次老板。',
  '他们卖梦，按小时计费，醒来另收费。',
  '楼上那小子把自己上传了，房租还挂在名下。',
  '小心自动贩卖机，它认得通缉犯的脸。',
  '我的义体是二手的，前任死在巷子里。',
  '霓虹不会灭，只会换更便宜的颜色。',
  '警用的无人机刚飞过去，别抬头。',
  '这条街的猫都比人有编制。',
  '竞速的人晚上都往天上去，像萤火虫。',
  '我存了二十年钱，只为买回自己的名字。',
  '天际线每天都在长高，压得人喘不过气。',
  '听说港湾那边有 ship 在卖假芯片。',
  '广告牌上的女孩对我笑了一整夜。',
  '赛后别看成绩单，看看天就行。',
  '旧城的服务器还在跑，跑的是谁没人知道。',
  '收起你的好奇，好奇在这是奢侈品。',
  '再过一小时，这里的灯会比星星亮。',
];

// 任务模板（循环派发；visit 的 {zone} 在派发时随机填充）
export const QUEST_TEMPLATES = [
  { type: 'collect', n: 5, title: '碎片回收 I', desc: '回收 5 枚霓虹碎片', reward: 50 },
  { type: 'visit', title: '区域巡查', desc: '前往 {zone} 打卡', reward: 80 },
  { type: 'collect', n: 10, title: '碎片回收 II', desc: '回收 10 枚霓虹碎片', reward: 100 },
  { type: 'race', n: 4, time: 75, title: '天空竞速 I', desc: '限时穿越 4 个天空检查点', reward: 150 },
  { type: 'collect', n: 15, title: '碎片回收 III', desc: '回收 15 枚霓虹碎片', reward: 160 },
  { type: 'visit', title: '跨区快递', desc: '把货物送到 {zone}', reward: 100 },
  { type: 'race', n: 6, time: 90, title: '天空竞速 II', desc: '限时穿越 6 个天空检查点', reward: 240 },
];

// 成就定义表（触发判定分布在收集/任务/切模式等事件点）
export const ACHIEVEMENTS = [
  { id: 'first_shard', name: '初拾微光', desc: '收集第一枚霓虹碎片' },
  { id: 'shard_10', name: '拾荒者', desc: '累计收集 10 枚碎片' },
  { id: 'shard_50', name: '碎片猎手', desc: '累计收集 50 枚碎片' },
  { id: 'shard_100', name: '霓虹收藏家', desc: '累计收集 100 枚碎片' },
  { id: 'first_quest', name: '街头新人', desc: '完成第一个任务' },
  { id: 'quest_5', name: '夜之城跑腿', desc: '完成 5 个任务' },
  { id: 'quest_15', name: '传奇中间人', desc: '完成 15 个任务' },
  { id: 'all_districts', name: '六区通缉', desc: '跑遍全部 6 大区域' },
  { id: 'first_flight', name: '展翅高飞', desc: '首次进入 3D 天际线' },
  { id: 'race_record', name: '竞速之王', desc: '刷新天空竞速最佳纪录' },
  { id: 'rich', name: '赛博富豪', desc: '积分达到 1000' },
];
