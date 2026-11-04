import type { LabelStyle, VectorStyle } from '../vector/types';

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

export interface GeoJsonPreset {
  id: string;
  name: string;
  url: string;
  note?: string;
  style?: Partial<VectorStyle>;
  label?: Partial<LabelStyle>;
}

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

/** Natural Earth (public domain) sample datasets; boundaries are de facto, for demonstration only. */
export const GEOJSON_PRESETS: GeoJsonPreset[] = [
  {
    id: 'ne-countries',
    name: '世界国家',
    url: `${NE}/ne_110m_admin_0_countries.geojson`,
    note: 'Natural Earth 1:1.1 亿国界（0.8 MB），按 MAPCOLOR7 分色，中文注记',
    style: { colorBy: 'MAPCOLOR7', fillOpacity: 0.22, stroke: '#ffffff', strokeWidth: 1, strokeOpacity: 0.7 },
    label: { size: 13 },
  },
  {
    id: 'ne-admin1',
    name: '省级行政区',
    url: `${NE}/ne_50m_admin_1_states_provinces.geojson`,
    note: 'Natural Earth 1:5000 万省级区划（部分国家，2.3 MB）',
    style: { fillOpacity: 0, stroke: '#fda4af', strokeWidth: 1, strokeOpacity: 0.85 },
    label: { size: 12, color: '#ffe4e6' },
  },
  {
    id: 'ne-places',
    name: '世界城市',
    url: `${NE}/ne_110m_populated_places.geojson`,
    note: 'Natural Earth 人口聚居地（点 + 注记，按 LABELRANK 避让）',
    style: { pointColor: '#fbbf24', pointRadius: 3.5 },
    label: { size: 12.5 },
  },
  {
    id: 'ne-rivers',
    name: '主要河流',
    url: `${NE}/ne_50m_rivers_lake_centerlines.geojson`,
    note: 'Natural Earth 河流与湖泊中心线（线 + 注记）',
    style: { stroke: '#7dd3fc', strokeWidth: 1.4, strokeOpacity: 0.95 },
    label: { size: 12, color: '#e0f2fe' },
  },
  {
    id: 'ne-countries-chn',
    name: '国界（中国视角 10m）',
    url: `${NE}/ne_10m_admin_0_countries_chn.geojson`,
    note: 'Natural Earth 中国视角 1:1000 万国界（13 MB，加载较慢）；非审定地图，仅供演示',
    style: { fillOpacity: 0, stroke: '#facc15', strokeWidth: 1.2, strokeOpacity: 0.9 },
    label: { size: 13 },
  },
];
