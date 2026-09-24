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
