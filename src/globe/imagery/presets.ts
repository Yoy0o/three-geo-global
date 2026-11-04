import { DebugImageryProvider } from './DebugImageryProvider';
import { EquirectangularImageryProvider } from './EquirectangularImageryProvider';
import { XYZImageryProvider, type ImageryProvider } from './ImageryProvider';

export interface ImageryPreset {
  id: string;
  name: string;
  /** Name of a credential the preset needs (looked up via `create(key)`). */
  requiresKey?: 'tianditu';
  create(key?: string): ImageryProvider;
}

export const IMAGERY_PRESETS: ImageryPreset[] = [
  {
    id: 'esri-imagery',
    name: 'ArcGIS 卫星影像',
    create: () =>
      new XYZImageryProvider({
        id: 'esri-imagery',
        name: 'ArcGIS World Imagery',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maxZoom: 19,
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community',
      }),
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    create: () =>
      new XYZImageryProvider({
        id: 'osm',
        name: 'OpenStreetMap',
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors',
      }),
  },
  {
    id: 'carto-voyager',
    name: 'Carto Voyager',
    create: () =>
      new XYZImageryProvider({
        id: 'carto-voyager',
        name: 'Carto Voyager',
        url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        subdomains: ['a', 'b', 'c', 'd'],
        maxZoom: 20,
        attribution: '© OpenStreetMap contributors © CARTO',
      }),
  },
  {
    id: 'carto-dark',
    name: 'Carto 暗色',
    create: () =>
      new XYZImageryProvider({
        id: 'carto-dark',
        name: 'Carto Dark Matter',
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        subdomains: ['a', 'b', 'c', 'd'],
        maxZoom: 20,
        attribution: '© OpenStreetMap contributors © CARTO',
      }),
  },
  {
    id: 'esri-topo',
    name: 'ArcGIS 地形图',
    create: () =>
      new XYZImageryProvider({
        id: 'esri-topo',
        name: 'ArcGIS World Topo',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
        maxZoom: 19,
        attribution: 'Tiles © Esri and contributors',
      }),
  },
  {
    id: 'tianditu-img',
    name: '天地图影像（需 key）',
    requiresKey: 'tianditu',
    create: (key = '') =>
      new XYZImageryProvider({
        id: 'tianditu-img',
        name: '天地图影像',
        url: 'https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}',
        subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
        minZoom: 1,
        maxZoom: 18,
        params: { tk: key },
        attribution: '© 天地图 / 国家地理信息公共服务平台',
      }),
  },
  {
    id: 'blue-marble',
    name: 'Blue Marble 单图（低清）',
    create: () =>
      new EquirectangularImageryProvider({
        id: 'blue-marble',
        name: 'NASA Blue Marble',
        url: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_atmos_2048.jpg',
        maxZoom: 4,
        attribution: 'NASA Blue Marble (via three.js examples)',
      }),
  },
  {
    id: 'debug',
    name: '调试网格（离线）',
    create: () => new DebugImageryProvider(),
  },
];

export function findImageryPreset(id: string): ImageryPreset | undefined {
  return IMAGERY_PRESETS.find((p) => p.id === id);
}
