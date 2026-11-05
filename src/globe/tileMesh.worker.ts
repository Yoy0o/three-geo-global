/**
 * Builds globe tile meshes off the main thread: fetches and decodes raster
 * elevation tiles, samples them onto a regular grid in Web Mercator space,
 * converts to ECEF, adds skirts and computes culling volumes.
 *
 * Raster terrain is read from the tile `terrainLevelOffset` levels up (one
 * 256 px tile serves 8 x 8 mesh tiles at full resolution). Requests carrying
 * an `upsample` grid are answered at once from the ancestor's heights while
 * the exact terrain tile is prefetched for the follow-up request.
 *
 * Downloads are shared by every job that needs the same terrain tile and are
 * aborted when the last waiting job is cancelled, so requests the view no
 * longer needs do not hold the server's connections.
 */
import { computeHorizonCullingPoint, geodeticNormal, geodeticToEcef, mercatorVToLatitude, WGS84_A } from '../core/geodesy';
import { geoidUndulation } from '../core/Geoid';
import type { BuildTileRequest, BuiltTile, WorkerRequest, WorkerResponse } from './workerProtocol';
import { isQuantizedMesh, type QuantizedMeshTerrainSource, type RasterTerrainSource, type TerrainSource } from './terrain/TerrainSource';
import { decodeQuantizedMesh, geographicTileRect, isTileAvailable, rasterizeQuantizedMesh, sampleGrid } from './terrain/quantizedMesh';
import { rasterSourceTile, terrainLevelOffset, upsampleHeightGrid } from './terrain/terrainTiling';
import { buildTileIndices, edgeVertices } from './tileMeshLayout';

// Minimal worker scope typing (the project compiles against the DOM lib).
declare const self: {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

interface HeightImage {
  width: number;
  height: number;
  data: Float32Array;
}

/** A download shared by the jobs that need it (and kept as a small LRU cache once done). */
interface SharedLoad<T> {
  promise: Promise<T>;
  controller: AbortController;
  /** Jobs currently waiting for it; prefetches do not count. */
  waiters: number;
  settled: boolean;
}

const HEIGHT_CACHE_SIZE = 64;
const heightCache = new Map<string, SharedLoad<HeightImage>>();
/** In-flight build jobs by request id. */
const jobs = new Map<number, AbortController>();
const sources = new Map<string, TerrainSource>();

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

/** The cached load for `key` (refreshing its LRU position), or a new one. */
function sharedLoad<T>(cache: Map<string, SharedLoad<T>>, key: string, start: (signal: AbortSignal) => Promise<T>): SharedLoad<T> {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const controller = new AbortController();
  const entry: SharedLoad<T> = { promise: start(controller.signal), controller, waiters: 0, settled: false };
  entry.promise.then(
    () => {
      entry.settled = true;
    },
    () => {
      entry.settled = true;
      if (cache.get(key) === entry) cache.delete(key);
    },
  );
  cache.set(key, entry);
  while (cache.size > HEIGHT_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return entry;
}

/**
 * Waits for a shared load on behalf of a job. If the job is cancelled while
 * no other job waits for the same data, the download is aborted as well
 * (HTTP/1.1 servers allow only about 6 connections per host).
 */
function waitFor<T>(cache: Map<string, SharedLoad<T>>, key: string, entry: SharedLoad<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return entry.promise;
  if (signal.aborted) return Promise.reject(abortError());
  entry.waiters++;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const release = (): boolean => {
      if (done) return false;
      done = true;
      entry.waiters--;
      signal.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = (): void => {
      if (!release()) return;
      if (entry.waiters === 0 && !entry.settled) {
        entry.controller.abort();
        if (cache.get(key) === entry) cache.delete(key);
      }
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      (value) => {
        if (release()) resolve(value);
      },
      (err: unknown) => {
        if (release()) reject(err);
      },
    );
  });
}

function fillTemplate(url: string, z: number, x: number, y: number): string {
  return url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

async function fetchHeightImage(src: RasterTerrainSource, z: number, x: number, y: number, signal: AbortSignal): Promise<HeightImage> {
  const res = await fetch(fillTemplate(src.url, z, x, y), { mode: 'cors', credentials: 'omit', signal });
  if (!res.ok) throw new Error(`terrain HTTP ${res.status}`);
  const blob = await res.blob();
  // Keep raw bytes: no color management or premultiplication, or the decoded heights drift.
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable in worker');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const data = new Float32Array(width * height);
  if (src.encoding === 'terrarium') {
    for (let i = 0, p = 0; i < data.length; i++, p += 4) {
      data[i] = rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
    }
  } else {
    for (let i = 0, p = 0; i < data.length; i++, p += 4) {
      data[i] = -10000 + (rgba[p] * 65536 + rgba[p + 1] * 256 + rgba[p + 2]) * 0.1;
    }
  }
  return { width, height, data };
}

/** Decoded elevation tile; `signal` is the waiting job's (omit for prefetches). */
function getHeightImage(src: RasterTerrainSource, z: number, x: number, y: number, signal?: AbortSignal): Promise<HeightImage> {
  const key = `${src.id}/${z}/${x}/${y}`;
  const entry = sharedLoad(heightCache, key, (s) => fetchHeightImage(src, z, x, y, s));
  return waitFor(heightCache, key, entry, signal);
}

/** Bilinear sample of a height image at normalized coordinates (0,0 = north-west corner). */
function sampleHeight(img: HeightImage, u: number, v: number): number {
  const fx = Math.min(img.width - 1, Math.max(0, u * img.width - 0.5));
  const fy = Math.min(img.height - 1, Math.max(0, v * img.height - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const d = img.data;
  const w = img.width;
  const a = d[y0 * w + x0] * (1 - tx) + d[y0 * w + x1] * tx;
  const b = d[y1 * w + x0] * (1 - tx) + d[y1 * w + x1] * tx;
  return a * (1 - ty) + b * ty;
}

function sourceTileFor(req: BuildTileRequest, src: RasterTerrainSource) {
  return rasterSourceTile(req.level, req.x, req.y, src.maxZoom, terrainLevelOffset(src.tileSize ?? 256, req.segments));
}

async function sampleTerrainGrid(req: BuildTileRequest, src: RasterTerrainSource, signal: AbortSignal): Promise<Float32Array> {
  const N = req.segments;
  const { x, y } = req;
  // Each mesh tile samples a sub-rectangle of a coarser elevation tile.
  const { z: sz, x: sx, y: sy, dz } = sourceTileFor(req, src);
  const scale = 1 / 2 ** dz;
  const offU = (x - sx * 2 ** dz) * scale;
  const offV = (y - sy * 2 ** dz) * scale;
  const img = await getHeightImage(src, sz, sx, sy, signal);

  const heights = new Float32Array((N + 1) * (N + 1));
  for (let j = 0; j <= N; j++) {
    const v = offV + (j / N) * scale;
    for (let i = 0; i <= N; i++) {
      const u = offU + (i / N) * scale;
      let h = sampleHeight(img, u, v);
      if (req.clampToSeaLevel && h < 0) h = 0;
      heights[j * (N + 1) + i] = h * req.exaggeration;
    }
  }
  return heights;
}

// -----------------------------------------------------------------------------
// Quantized-mesh terrain (geographic tiles resampled onto the mercator grid)

const QM_GRID = 65;

interface GeoTile {
  level: number;
  x: number;
  y: number;
  grid: Float32Array;
}

const geoCache = new Map<string, SharedLoad<GeoTile | null>>();

/**
 * Loads a geographic terrain tile, falling back to ancestors when it is not
 * available. `signal` is the waiting job's (omit for prefetches).
 */
function loadGeoTile(src: QuantizedMeshTerrainSource, level: number, x: number, y: number, signal?: AbortSignal): Promise<GeoTile | null> {
  const key = `${src.id}/${level}/${x}/${y}`;
  const entry = sharedLoad(geoCache, key, async (s): Promise<GeoTile | null> => {
    // The fallback waits on behalf of this load, so cancelling it releases the parent too.
    const parent = () => (level > 0 ? loadGeoTile(src, level - 1, x >> 1, y >> 1, s) : Promise.resolve(null));
    if (!isTileAvailable(src.available, level, x, y)) return parent();
    const res = await fetch(fillTemplate(src.url, level, x, y), { headers: src.headers, mode: 'cors', credentials: 'omit', signal: s });
    if (res.status === 404 || res.status === 204) return parent();
    if (!res.ok) throw new Error(`terrain HTTP ${res.status}`);
    const tile = decodeQuantizedMesh(await res.arrayBuffer());
    return { level, x, y, grid: rasterizeQuantizedMesh(tile, QM_GRID) };
  });
  return waitFor(geoCache, key, entry, signal);
}

/** Geographic tiles (level, column, row range) covering a mercator mesh tile. */
function geoTilesFor(req: BuildTileRequest, src: QuantizedMeshTerrainSource) {
  const n = 2 ** req.level;
  const west = (req.x / n) * 360 - 180;
  const toDeg = 180 / Math.PI;
  const latN = mercatorVToLatitude(req.y / n) * toDeg;
  const latS = mercatorVToLatitude((req.y + 1) / n) * toDeg;
  // A geographic tile at level g is as wide as a mercator tile at level g + 1,
  // so one column covers this tile; it spans at most a couple of rows.
  const g = Math.max(0, Math.min(src.geographicMaxZoom, req.level - 1));
  const size = 180 / 2 ** g;
  const gx = Math.min(2 ** (g + 1) - 1, Math.max(0, Math.floor((west + 180) / size + 1e-9)));
  const maxRow = 2 ** g - 1;
  const rowOf = (lat: number) => Math.min(maxRow, Math.max(0, Math.floor((lat + 90) / size)));
  return { g, gx, rowOf, r0: rowOf(latS), r1: rowOf(latN - 1e-9) };
}

async function sampleQuantizedMesh(req: BuildTileRequest, src: QuantizedMeshTerrainSource, signal: AbortSignal): Promise<Float32Array> {
  const N = req.segments;
  const row = N + 1;
  const n = 2 ** req.level;
  const west = (req.x / n) * 360 - 180;
  const east = ((req.x + 1) / n) * 360 - 180;
  const vNorth = req.y / n;
  const vSouth = (req.y + 1) / n;
  const toDeg = 180 / Math.PI;

  const { g, gx, rowOf, r0, r1 } = geoTilesFor(req, src);
  const tiles = new Map<number, GeoTile | null>();
  await Promise.all(
    Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i).map(async (r) => tiles.set(r, await loadGeoTile(src, g, gx, r, signal))),
  );

  const heights = new Float32Array(row * row);
  for (let j = 0; j <= N; j++) {
    const lat = mercatorVToLatitude(vNorth + ((vSouth - vNorth) * j) / N) * toDeg;
    const tile = tiles.get(Math.min(r1, Math.max(r0, rowOf(lat))));
    for (let i = 0; i <= N; i++) {
      const lon = west + ((east - west) * i) / N;
      let h = 0;
      if (tile) {
        const rect = geographicTileRect(tile.level, tile.x, tile.y);
        h = sampleGrid(tile.grid, QM_GRID, (lon - rect.west) / rect.size, (lat - rect.south) / rect.size);
      }
      if (req.exaggeration !== 1) {
        // Exaggerate relative to sea level, not to the ellipsoid.
        const n0 = geoidUndulation(lon / toDeg, lat / toDeg);
        h = (h - n0) * req.exaggeration + n0;
      }
      heights[j * row + i] = h;
    }
  }
  return heights;
}

/**
 * `ellipsoidal`: heights are already ellipsoidal and exaggerated (upsampled
 * from an ancestor mesh), so no geoid correction is applied.
 */
function buildMesh(req: BuildTileRequest, heights: Float32Array | null, src: TerrainSource | null, ellipsoidal = false): BuiltTile {
  const N = req.segments;
  const row = N + 1;
  const gridCount = row * row;
  const skirtCount = 4 * row;
  const vertexCount = gridCount + skirtCount;
  const n = 2 ** req.level;
  const west = (req.x / n) * 2 * Math.PI - Math.PI;
  const east = ((req.x + 1) / n) * 2 * Math.PI - Math.PI;
  const vNorth = req.y / n;
  const vSouth = (req.y + 1) / n;

  const lats = new Float64Array(row);
  for (let j = 0; j <= N; j++) lats[j] = mercatorVToLatitude(vNorth + ((vSouth - vNorth) * j) / N);

  // MSL -> ellipsoidal heights (EGM96), so terrain and 3D Tiles share one datum.
  if (heights && !ellipsoidal && src?.heightReference === 'msl') {
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        heights[j * row + i] += geoidUndulation(west + ((east - west) * i) / N, lats[j]);
      }
    }
  }

  let minHeight = 0;
  let maxHeight = 0;
  if (heights) {
    minHeight = Infinity;
    maxHeight = -Infinity;
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
  }

  const ecef = new Float64Array(vertexCount * 3);
  const normals64 = new Float64Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const k = j * row + i;
      const lon = west + ((east - west) * i) / N;
      geodeticToEcef(lon, lats[j], heights ? heights[k] : 0, ecef, k * 3);
      geodeticNormal(lon, lats[j], normals64, k * 3);
      uvs[k * 2] = i / N;
      uvs[k * 2 + 1] = j / N;
    }
  }

  // Terrain normals from central differences of the ECEF grid (east x north = up).
  if (heights && maxHeight - minHeight > 0.01) {
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const k = j * row + i;
        const ie = Math.min(N, i + 1);
        const iw = Math.max(0, i - 1);
        const jn = Math.max(0, j - 1);
        const js = Math.min(N, j + 1);
        const e = (j * row + ie) * 3;
        const w = (j * row + iw) * 3;
        const no = (jn * row + i) * 3;
        const so = (js * row + i) * 3;
        const ax = ecef[e] - ecef[w];
        const ay = ecef[e + 1] - ecef[w + 1];
        const az = ecef[e + 2] - ecef[w + 2];
        const bx = ecef[no] - ecef[so];
        const by = ecef[no + 1] - ecef[so + 1];
        const bz = ecef[no + 2] - ecef[so + 2];
        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-9) {
          nx /= len;
          ny /= len;
          nz /= len;
          // Guard against degenerate cells near the poles flipping the normal.
          const gx = normals64[k * 3];
          const gy = normals64[k * 3 + 1];
          const gz = normals64[k * 3 + 2];
          if (nx * gx + ny * gy + nz * gz > 0.05) {
            normals64[k * 3] = nx;
            normals64[k * 3 + 1] = ny;
            normals64[k * 3 + 2] = nz;
          }
        }
      }
    }
  }

  // Skirts hide cracks between neighbors at different levels of detail.
  const latC = mercatorVToLatitude((vNorth + vSouth) / 2);
  const lonSpan = (east - west) * WGS84_A * Math.cos(latC);
  const latSpan = Math.abs(lats[0] - lats[N]) * WGS84_A;
  const segment = Math.max(lonSpan, latSpan) / N;
  const sagitta = (segment * segment) / (8 * WGS84_A);
  const skirtDepth = Math.max(20, segment * 0.15, sagitta * 3) + (heights ? 0.5 * (maxHeight - minHeight) : 0);

  // Edge vertex indices, each traversed so the skirt faces outward (layout: tileMeshLayout.ts).
  const edges = edgeVertices(N);

  let s = gridCount;
  for (const edge of edges) {
    for (const k of edge) {
      ecef[s * 3] = ecef[k * 3] - normals64[k * 3] * skirtDepth;
      ecef[s * 3 + 1] = ecef[k * 3 + 1] - normals64[k * 3 + 1] * skirtDepth;
      ecef[s * 3 + 2] = ecef[k * 3 + 2] - normals64[k * 3 + 2] * skirtDepth;
      normals64[s * 3] = normals64[k * 3];
      normals64[s * 3 + 1] = normals64[k * 3 + 1];
      normals64[s * 3 + 2] = normals64[k * 3 + 2];
      uvs[s * 2] = uvs[k * 2];
      uvs[s * 2 + 1] = uvs[k * 2 + 1];
      s++;
    }
  }

  // RTC center at the middle of the tile, mid-height.
  const center: [number, number, number] = [0, 0, 0];
  geodeticToEcef((west + east) / 2, latC, (minHeight + maxHeight) / 2, center);

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  let radiusSq = 0;
  for (let k = 0; k < vertexCount; k++) {
    const dx = ecef[k * 3] - center[0];
    const dy = ecef[k * 3 + 1] - center[1];
    const dz = ecef[k * 3 + 2] - center[2];
    positions[k * 3] = dx;
    positions[k * 3 + 1] = dy;
    positions[k * 3 + 2] = dz;
    normals[k * 3] = normals64[k * 3];
    normals[k * 3 + 1] = normals64[k * 3 + 1];
    normals[k * 3 + 2] = normals64[k * 3 + 2];
    radiusSq = Math.max(radiusSq, dx * dx + dy * dy + dz * dz);
  }

  const indices = buildTileIndices(N, vertexCount);

  const horizonPoint = computeHorizonCullingPoint(center[0], center[1], center[2], ecef, gridCount);

  return {
    type: 'built',
    id: req.id,
    center,
    positions,
    normals,
    uvs,
    indices,
    gridVertexCount: gridCount,
    minHeight,
    maxHeight,
    boundingRadius: Math.sqrt(radiusSq),
    horizonPoint,
    heights,
    upsampled: false,
  };
}

/** Starts downloading the terrain an exact build of this tile will need (errors are retried then). */
function prefetchTerrain(req: BuildTileRequest, src: TerrainSource): void {
  if (isQuantizedMesh(src)) {
    const { g, gx, r0, r1 } = geoTilesFor(req, src);
    for (let r = r0; r <= r1; r++) loadGeoTile(src, g, gx, r).catch(() => undefined);
  } else {
    const t = sourceTileFor(req, src);
    getHeightImage(src, t.z, t.x, t.y).catch(() => undefined);
  }
}

async function handleBuild(req: BuildTileRequest): Promise<void> {
  const job = new AbortController();
  jobs.set(req.id, job);
  try {
    const src = req.terrainId ? (sources.get(req.terrainId) ?? null) : null;
    if (req.terrainId && !src) throw new Error(`unknown terrain source ${req.terrainId}`);
    let tile: BuiltTile;
    if (src && req.upsample) {
      const u = req.upsample;
      const heights = upsampleHeightGrid(u.heights, u.segments, u.level, u.x, u.y, req.level, req.x, req.y, req.segments);
      if (req.prefetch !== false) prefetchTerrain(req, src);
      tile = buildMesh(req, heights, src, true);
      tile.upsampled = true;
    } else {
      const heights = src ? await (isQuantizedMesh(src) ? sampleQuantizedMesh(req, src, job.signal) : sampleTerrainGrid(req, src, job.signal)) : null;
      if (job.signal.aborted) {
        post({ type: 'error', id: req.id, message: 'cancelled', aborted: true });
        return;
      }
      tile = buildMesh(req, heights, src);
    }
    const transfer: Transferable[] = [tile.positions.buffer, tile.normals.buffer, tile.uvs.buffer, tile.indices.buffer];
    if (tile.heights) transfer.push(tile.heights.buffer);
    post(tile, transfer);
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err), aborted: job.signal.aborted });
  } finally {
    jobs.delete(req.id);
  }
}

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === 'source') sources.set(msg.source.id, msg.source);
  else if (msg.type === 'build') void handleBuild(msg);
  else if (msg.type === 'cancel') jobs.get(msg.id)?.abort();
};
