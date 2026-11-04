/** How elevation is packed into RGB pixels. */
export type TerrainEncoding = 'terrarium' | 'mapbox';

interface TerrainSourceBase {
  id: string;
  name: string;
  /** Deepest Web Mercator level with real data; deeper tiles are upsampled. */
  maxZoom: number;
  /**
   * Vertical datum of the samples. 'msl' heights are converted to ellipsoidal
   * heights with the EGM96 geoid so they line up with 3D Tiles and GNSS data.
   */
  heightReference: 'msl' | 'ellipsoid';
  attribution: string;
}

/**
 * Raster elevation tiles in the Web Mercator XYZ scheme (Terrarium or
 * Mapbox Terrain-RGB encoding). Decoded in the mesh worker.
 */
export interface RasterTerrainSource extends TerrainSourceBase {
  kind?: 'raster';
  encoding: TerrainEncoding;
  /** URL template with {z} {x} {y} placeholders. */
  url: string;
}

/**
 * Cesium quantized-mesh terrain (geographic EPSG:4326 tiling, TMS rows).
 * The worker resamples the triangulated tiles onto the globe's mercator grid.
 */
export interface QuantizedMeshTerrainSource extends TerrainSourceBase {
  kind: 'quantized-mesh';
  /** Absolute tile URL template with {z} {x} {y} (y counted from the south). */
  url: string;
  headers: Record<string, string>;
  /** Deepest geographic level advertised by layer.json. */
  geographicMaxZoom: number;
  /** layer.json availability per level: [startX, startY, endX, endY] ranges. */
  available: number[][][] | null;
}

export type TerrainSource = RasterTerrainSource | QuantizedMeshTerrainSource;

export function isQuantizedMesh(src: TerrainSource): src is QuantizedMeshTerrainSource {
  return src.kind === 'quantized-mesh';
}

/** Free global DEM (SRTM / GMTED / ETOPO1 bathymetry) hosted on AWS Open Data. Heights are MSL (geoid-corrected in the worker). */
export const AWS_TERRARIUM: RasterTerrainSource = {
  id: 'aws-terrarium',
  name: 'AWS Terrain Tiles',
  encoding: 'terrarium',
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  maxZoom: 15,
  heightReference: 'msl',
  attribution: 'Terrain © Mapzen, AWS Open Data (SRTM, GMTED2010, ETOPO1)',
};

export function mapboxTerrain(token: string): RasterTerrainSource {
  return {
    id: 'mapbox-terrain-rgb',
    name: 'Mapbox Terrain-RGB',
    encoding: 'mapbox',
    url: `https://api.mapbox.com/v4/mapbox.terrain-rgb/{z}/{x}/{y}.pngraw?access_token=${encodeURIComponent(token)}`,
    maxZoom: 15,
    heightReference: 'msl',
    attribution: 'Terrain © Mapbox',
  };
}

export function maptilerTerrain(key: string): RasterTerrainSource {
  return {
    id: 'maptiler-terrain-rgb',
    name: 'MapTiler Terrain',
    encoding: 'mapbox',
    url: `https://api.maptiler.com/tiles/terrain-rgb-v2/{z}/{x}/{y}.webp?key=${encodeURIComponent(key)}`,
    maxZoom: 14,
    heightReference: 'msl',
    attribution: 'Terrain © MapTiler © OpenStreetMap contributors',
  };
}

interface LayerJson {
  tiles?: string[];
  version?: string;
  scheme?: string;
  maxzoom?: number;
  projection?: string;
  format?: string;
  available?: { startX: number; startY: number; endX: number; endY: number }[][];
  attribution?: string;
}

const QM_ACCEPT = 'application/vnd.quantized-mesh,application/octet-stream;q=0.9,*/*;q=0.01';

/** Reads a quantized-mesh tileset description (layer.json) and builds a terrain source. */
export async function quantizedMeshFromLayerJson(
  baseUrl: string,
  options: { name?: string; id?: string; headers?: Record<string, string>; attribution?: string } = {},
): Promise<QuantizedMeshTerrainSource> {
  const base = baseUrl.replace(/layer\.json(\?.*)?$/, '').replace(/\/?$/, '/');
  const headers = { Accept: QM_ACCEPT, ...options.headers };
  const res = await fetch(`${base}layer.json`, { headers, mode: 'cors' });
  if (!res.ok) throw new Error(`layer.json HTTP ${res.status}`);
  const layer = (await res.json()) as LayerJson;
  if (layer.format && !layer.format.startsWith('quantized-mesh')) throw new Error(`不支持的地形格式 ${layer.format}`);
  if (layer.projection && layer.projection !== 'EPSG:4326') throw new Error(`只支持 EPSG:4326 的 quantized-mesh（当前 ${layer.projection}）`);
  const template = (layer.tiles?.[0] ?? '{z}/{x}/{y}.terrain?v={version}').replace('{version}', layer.version ?? '1.0.0');
  // Keep the {z}/{x}/{y} braces literal (the URL constructor would percent-encode them).
  const url = /^https?:/i.test(template) ? template : base + template.replace(/^\//, '');
  const available = layer.available?.map((ranges) => ranges.map((r) => [r.startX, r.startY, r.endX, r.endY])) ?? null;
  const geographicMaxZoom = layer.maxzoom ?? (available ? available.length - 1 : 15);
  return {
    kind: 'quantized-mesh',
    id: options.id ?? `qm:${base}`,
    name: options.name ?? 'Quantized-mesh terrain',
    url,
    headers,
    geographicMaxZoom,
    // Geographic level g has the same tile width as Web Mercator level g + 1.
    maxZoom: geographicMaxZoom + 1,
    available,
    heightReference: 'ellipsoid',
    attribution: options.attribution ?? layer.attribution ?? '',
  };
}

/** Resolves a Cesium ion terrain asset (Cesium World Terrain is asset 1). */
export async function cesiumIonTerrain(token: string, assetId = 1): Promise<QuantizedMeshTerrainSource> {
  const res = await fetch(`https://api.cesium.com/v1/assets/${assetId}/endpoint?access_token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`Cesium ion HTTP ${res.status}`);
  const endpoint = (await res.json()) as { type?: string; url: string; accessToken: string; attributions?: { html?: string }[] };
  if (endpoint.type && endpoint.type !== 'TERRAIN') throw new Error(`ion 资产 ${assetId} 不是地形（${endpoint.type}）`);
  const attribution = (endpoint.attributions ?? []).map((a) => (a.html ?? '').replace(/<[^>]+>/g, '')).filter(Boolean).join(' ') || 'Terrain © Cesium';
  return quantizedMeshFromLayerJson(endpoint.url, {
    id: `cesium-ion-${assetId}`,
    name: assetId === 1 ? 'Cesium World Terrain' : `Cesium ion #${assetId}`,
    headers: { Authorization: `Bearer ${endpoint.accessToken}` },
    attribution,
  });
}
