/**
 * Demo point sets for the "点位标注" panel, generated in code (no network):
 * Beijing landmarks as map pins, monitoring stations styled by property rules
 * (alarms pulse, offline stations grey out), and a few thousand random points
 * to show clustering. Coordinates are approximate WGS84 degrees.
 */
import type { PointLayerOptions } from './PointLayer';
import type { PointRule } from './points';

export interface PointDemo {
  name: string;
  note: string;
  options: () => PointLayerOptions;
}

const LANDMARKS: [string, string, number, number, string][] = [
  ['天安门', '古迹', 116.3975, 39.9087, '🏛'],
  ['故宫太和殿', '古迹', 116.3972, 39.9163, '🏛'],
  ['天坛祈年殿', '古迹', 116.4074, 39.8822, '🏛'],
  ['颐和园佛香阁', '古迹', 116.2734, 39.9998, '🏛'],
  ['国家体育场（鸟巢）', '场馆', 116.3966, 39.9929, '🏟'],
  ['国家游泳中心（水立方）', '场馆', 116.3903, 39.993, '🏟'],
  ['中央电视台总部', '商务', 116.4637, 39.9147, '🏢'],
  ['中信大厦（中国尊）', '商务', 116.4627, 39.9113, '🏢'],
  ['北京南站', '交通', 116.3786, 39.8652, '🚉'],
  ['北京西站', '交通', 116.3214, 39.8949, '🚉'],
  ['首都国际机场 T3', '交通', 116.6127, 40.0525, '✈'],
  ['北京大学', '高校', 116.3105, 39.9928, '🎓'],
  ['清华大学', '高校', 116.3264, 40.0034, '🎓'],
  ['奥林匹克森林公园', '公园', 116.3897, 40.0185, '🌳'],
];

const CATEGORY_COLORS: Record<string, string> = {
  古迹: '#f59e0b',
  场馆: '#22d3ee',
  商务: '#818cf8',
  交通: '#34d399',
  高校: '#f472b6',
  公园: '#84cc16',
};

/** Deterministic PRNG (mulberry32) so demos look the same on every load. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal deviate (Box-Muller). */
function gauss(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
}

function landmarks(): PointLayerOptions {
  return {
    name: '北京地标',
    data: {
      type: 'FeatureCollection',
      features: LANDMARKS.map(([name, category, lon, lat, icon], i) => ({
        type: 'Feature',
        id: `lm${i}`,
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { name, 类别: category, icon },
      })),
    },
    style: { style: 'poi', title: '{name}', icon: '{icon}', heightOffset: 2, maxDistance: 120_000 },
    rules: Object.entries(CATEGORY_COLORS).map(([category, color]) => ({ when: { 类别: category }, style: { color } })),
  };
}

const STATION_TYPES: [string, string][] = [
  ['水质', '💧'],
  ['空气', '🌫'],
  ['视频', '📷'],
  ['气象', '🌡'],
];

function stations(): PointLayerOptions {
  const rand = random(20261105);
  const points = Array.from({ length: 48 }, (_, i) => {
    const [type, icon] = STATION_TYPES[Math.floor(rand() * STATION_TYPES.length)];
    const r = rand();
    const status = r < 0.12 ? '告警' : r < 0.22 ? '离线' : '正常';
    return {
      id: `st${String(i + 1).padStart(3, '0')}`,
      lon: 116.25 + rand() * 0.32,
      lat: 39.82 + rand() * 0.26,
      name: `${type}站 ${String(i + 1).padStart(2, '0')}`,
      type,
      icon,
      status,
      value: Math.round(rand() * 1000) / 10,
    };
  });
  const rules: PointRule[] = [
    { when: { type: '视频' }, style: { color: '#a78bfa' } },
    { when: { type: '水质' }, style: { color: '#38bdf8' } },
    { when: { type: '空气' }, style: { color: '#2dd4bf' } },
    { when: { type: '气象' }, style: { color: '#fbbf24' } },
    { when: { status: '离线' }, style: { color: '#8a94a6', subtitle: '离线' } },
    // Alarms last: they override the type colors, pulse, and win collisions.
    { when: { status: '告警' }, style: { style: 'pulse', color: '#ff5d5d', badge: '告警', subtitle: '读数 {value}', priority: 10, declutter: false } },
  ];
  return {
    name: '监测站点（规则样式）',
    data: { points },
    style: { style: 'badge', title: '{name}', icon: '{icon}', maxDistance: 80_000 },
    rules,
  };
}

function scattered(count: number): PointLayerOptions {
  const rand = random(7);
  const centers = Array.from({ length: 14 }, () => [116.1 + rand() * 0.6, 39.7 + rand() * 0.45, 0.01 + rand() * 0.04] as const);
  const kinds = ['餐饮', '零售', '医疗', '教育'];
  const points = Array.from({ length: count }, (_, i) => {
    const [cx, cy, s] = centers[Math.floor(rand() * centers.length)];
    return { id: `s${i}`, lon: cx + gauss(rand) * s, lat: cy + gauss(rand) * s * 0.8, name: `网点 ${i + 1}`, kind: kinds[Math.floor(rand() * kinds.length)] };
  });
  return {
    name: `随机网点 ${count}（聚合）`,
    data: points,
    style: { style: 'poi', title: '', color: '#60a5fa', heightOffset: 1 },
    rules: [
      { when: { kind: '医疗' }, style: { color: '#f87171' } },
      { when: { kind: '教育' }, style: { color: '#facc15' } },
      { when: { kind: '零售' }, style: { color: '#4ade80' } },
    ],
    cluster: { radius: 56, minPoints: 3 },
  };
}

export const POINT_DEMOS: PointDemo[] = [
  { name: '北京地标', note: '图钉样式，按类别着色', options: landmarks },
  { name: '监测站点', note: '徽章样式；告警站点为红色呼吸点、离线站点置灰（规则样式）', options: stations },
  { name: '随机网点 3000', note: '屏幕空间聚合，点击聚合点放大', options: () => scattered(3000) },
];
