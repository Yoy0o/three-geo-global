/**
 * Cesium quantized-mesh-1.0 decoding and resampling helpers (no DOM, usable
 * in workers and tests). Spec: https://github.com/CesiumGS/quantized-mesh
 */

export interface QuantizedMeshTile {
  minHeight: number;
  maxHeight: number;
  /** Quantized 0..32767 coordinates; u east, v north. */
  u: Uint16Array;
  v: Uint16Array;
  h: Uint16Array;
  indices: Uint16Array | Uint32Array;
}

const HEADER_BYTES = 88;
const MAX_Q = 32767;

const zigZagDecode = (n: number) => (n >> 1) ^ -(n & 1);
const zigZagEncode = (n: number) => ((n << 1) ^ (n >> 31)) >>> 0;

export function decodeQuantizedMesh(buffer: ArrayBuffer): QuantizedMeshTile {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER_BYTES + 4) throw new Error('quantized-mesh: buffer too small');
  const minHeight = view.getFloat32(24, true);
  const maxHeight = view.getFloat32(28, true);
  let pos = HEADER_BYTES;
  const vertexCount = view.getUint32(pos, true);
  pos += 4;

  const u = new Uint16Array(vertexCount);
  const v = new Uint16Array(vertexCount);
  const h = new Uint16Array(vertexCount);
  let uu = 0;
  let vv = 0;
  let hh = 0;
  for (let i = 0; i < vertexCount; i++) {
    uu += zigZagDecode(view.getUint16(pos + i * 2, true));
    vv += zigZagDecode(view.getUint16(pos + (vertexCount + i) * 2, true));
    hh += zigZagDecode(view.getUint16(pos + (vertexCount * 2 + i) * 2, true));
    u[i] = uu;
    v[i] = vv;
    h[i] = hh;
  }
  pos += vertexCount * 6;

  const wide = vertexCount > 65536;
  if (wide && pos % 4 !== 0) pos += 4 - (pos % 4);
  else if (pos % 2 !== 0) pos += 1;
  const triangleCount = view.getUint32(pos, true);
  pos += 4;
  const count = triangleCount * 3;
  const indices = wide ? new Uint32Array(count) : new Uint16Array(count);
  // High-water-mark encoding.
  let highest = 0;
  for (let i = 0; i < count; i++) {
    const code = wide ? view.getUint32(pos + i * 4, true) : view.getUint16(pos + i * 2, true);
    indices[i] = highest - code;
    if (code === 0) highest++;
  }
  return { minHeight, maxHeight, u, v, h, indices };
}

/** Builds a minimal quantized-mesh buffer (no edge indices or extensions); used by tests. */
export function encodeQuantizedMesh(tile: QuantizedMeshTile): ArrayBuffer {
  const n = tile.u.length;
  const triCount = tile.indices.length / 3;
  let size = HEADER_BYTES + 4 + n * 6;
  if (size % 2 !== 0) size += 1;
  size += 4 + triCount * 6 + 16;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  view.setFloat32(24, tile.minHeight, true);
  view.setFloat32(28, tile.maxHeight, true);
  let pos = HEADER_BYTES;
  view.setUint32(pos, n, true);
  pos += 4;
  let pu = 0;
  let pv = 0;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    view.setUint16(pos + i * 2, zigZagEncode(tile.u[i] - pu), true);
    view.setUint16(pos + (n + i) * 2, zigZagEncode(tile.v[i] - pv), true);
    view.setUint16(pos + (n * 2 + i) * 2, zigZagEncode(tile.h[i] - ph), true);
    pu = tile.u[i];
    pv = tile.v[i];
    ph = tile.h[i];
  }
  pos += n * 6;
  if (pos % 2 !== 0) pos += 1;
  view.setUint32(pos, triCount, true);
  pos += 4;
  let highest = 0;
  for (let i = 0; i < tile.indices.length; i++) {
    const idx = tile.indices[i];
    view.setUint16(pos + i * 2, highest - idx, true);
    if (idx === highest) highest++;
  }
  return buf;
}

/**
 * Rasterizes the triangulated tile onto an n x n height grid in meters
 * (row 0 = south edge, column 0 = west edge), by barycentric interpolation.
 */
export function rasterizeQuantizedMesh(tile: QuantizedMeshTile, n = 65): Float32Array {
  const grid = new Float32Array(n * n).fill(Number.NaN);
  const s = (n - 1) / MAX_Q;
  const hs = (tile.maxHeight - tile.minHeight) / MAX_Q;
  const { u, v, h, indices } = tile;
  const eps = 1e-6;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    const xa = u[a] * s;
    const ya = v[a] * s;
    const xb = u[b] * s;
    const yb = v[b] * s;
    const xc = u[c] * s;
    const yc = v[c] * s;
    const denom = (yb - yc) * (xa - xc) + (xc - xb) * (ya - yc);
    if (Math.abs(denom) < 1e-12) continue;
    const ha = tile.minHeight + h[a] * hs;
    const hb = tile.minHeight + h[b] * hs;
    const hc = tile.minHeight + h[c] * hs;
    const x0 = Math.max(0, Math.ceil(Math.min(xa, xb, xc) - eps));
    const x1 = Math.min(n - 1, Math.floor(Math.max(xa, xb, xc) + eps));
    const y0 = Math.max(0, Math.ceil(Math.min(ya, yb, yc) - eps));
    const y1 = Math.min(n - 1, Math.floor(Math.max(ya, yb, yc) + eps));
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const w1 = ((yb - yc) * (ix - xc) + (xc - xb) * (iy - yc)) / denom;
        const w2 = ((yc - ya) * (ix - xc) + (xa - xc) * (iy - yc)) / denom;
        const w3 = 1 - w1 - w2;
        if (w1 >= -eps && w2 >= -eps && w3 >= -eps) grid[iy * n + ix] = w1 * ha + w2 * hb + w3 * hc;
      }
    }
  }
  // Grid points missed by degenerate data take their nearest filled neighbour on the row.
  for (let iy = 0; iy < n; iy++) {
    let last = Number.NaN;
    for (let ix = 0; ix < n; ix++) {
      const k = iy * n + ix;
      if (Number.isNaN(grid[k])) grid[k] = last;
      else last = grid[k];
    }
    last = Number.NaN;
    for (let ix = n - 1; ix >= 0; ix--) {
      const k = iy * n + ix;
      if (Number.isNaN(grid[k])) grid[k] = last;
      else last = grid[k];
    }
  }
  for (let k = 0; k < grid.length; k++) if (Number.isNaN(grid[k])) grid[k] = tile.minHeight;
  return grid;
}

/** Bilinear sample of a south-up n x n grid at normalized (fx east, fy north) in [0, 1]. */
export function sampleGrid(grid: Float32Array, n: number, fx: number, fy: number): number {
  const x = Math.min(n - 1, Math.max(0, fx * (n - 1)));
  const y = Math.min(n - 1, Math.max(0, fy * (n - 1)));
  const x0 = Math.min(n - 2, Math.floor(x));
  const y0 = Math.min(n - 2, Math.floor(y));
  const tx = x - x0;
  const ty = y - y0;
  const a = grid[y0 * n + x0] * (1 - tx) + grid[y0 * n + x0 + 1] * tx;
  const b = grid[(y0 + 1) * n + x0] * (1 - tx) + grid[(y0 + 1) * n + x0 + 1] * tx;
  return a * (1 - ty) + b * ty;
}

/** Geographic (EPSG:4326, 2 x 1 root tiles, TMS rows) tile extent in degrees. */
export function geographicTileRect(level: number, x: number, y: number): { west: number; south: number; size: number } {
  const size = 180 / 2 ** level;
  return { west: -180 + x * size, south: -90 + y * size, size };
}

/** Whether layer.json availability ranges list a tile (true when the level is not described). */
export function isTileAvailable(available: number[][][] | null, level: number, x: number, y: number): boolean {
  if (!available || level >= available.length) return true;
  for (const [x0, y0, x1, y1] of available[level]) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
  return false;
}
