export interface Bookmark {
  name: string;
  /** Target on the ground: [lon deg, lat deg, height m]. */
  target: [number, number, number];
  heading: number;
  pitch: number;
  range: number;
}

export const BOOKMARKS: Bookmark[] = [
  { name: '全球', target: [105, 25, 0], heading: 0, pitch: -90, range: 1.8e7 },
  { name: '北京 · 故宫', target: [116.3972, 39.9163, 45], heading: 0, pitch: -42, range: 3800 },
  { name: '上海 · 陆家嘴', target: [121.5014, 31.2397, 5], heading: -70, pitch: -32, range: 5200 },
  { name: '香港 · 维港', target: [114.1694, 22.2895, 5], heading: 170, pitch: -24, range: 9000 },
  { name: '珠穆朗玛峰', target: [86.925, 27.9881, 8000], heading: 20, pitch: -16, range: 32000 },
  { name: '黄山', target: [118.1667, 30.1333, 1400], heading: -20, pitch: -22, range: 14000 },
  { name: '马特洪峰', target: [7.6586, 45.9763, 3800], heading: 250, pitch: -14, range: 13000 },
  { name: '美国大峡谷', target: [-112.113, 36.0986, 1800], heading: 10, pitch: -24, range: 22000 },
  { name: '纽约 · 曼哈顿', target: [-74.0059, 40.7128, 5], heading: 25, pitch: -33, range: 9000 },
];

export interface TilesetPreset {
  id: string;
  name: string;
  kind: 'url' | 'ion' | 'google';
  url?: string;
  assetId?: number;
  note?: string;
  /** Modeled on the bare ellipsoid (height 0): lift it onto the terrain when terrain is on. */
  ellipsoidAligned?: boolean;
}

const SAMPLES = 'https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main';

export const TILESET_PRESETS: TilesetPreset[] = [
  {
    id: 'sample-city',
    name: 'Cesium 样例 · 城市建筑',
    kind: 'url',
    url: `${SAMPLES}/1.0/TilesetWithRequestVolume/tileset.json`,
    note: '免 key，费城附近的示例街区（b3dm + pnts）',
    ellipsoidAligned: true,
  },
  {
    id: 'sample-dragon',
    name: 'Cesium 样例 · 离散 LOD',
    kind: 'url',
    url: `${SAMPLES}/1.0/TilesetWithDiscreteLOD/tileset.json`,
    note: '免 key，三级 LOD 切换的龙模型',
    ellipsoidAligned: true,
  },
  {
    id: 'google-photorealistic',
    name: 'Google 真实感 3D Tiles',
    kind: 'google',
    note: '需要开通 Map Tiles API 的 Google Cloud API Key',
  },
  {
    id: 'ion-osm-buildings',
    name: 'Cesium OSM Buildings',
    kind: 'ion',
    assetId: 96188,
    note: '需要 Cesium ion access token',
  },
];
