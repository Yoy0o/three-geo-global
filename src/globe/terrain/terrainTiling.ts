/**
 * Terrain tile selection shared by the main thread (worker routing) and the
 * mesh worker. Dependency-free so worker bundles stay small.
 */

/** A raster terrain tile and how many levels below it the mesh tile sits. */
export interface SourceTile {
  z: number;
  x: number;
  y: number;
  /** Mesh level minus source level (the mesh covers 1 / 2^dz of the source tile). */
  dz: number;
}

/**
 * How many levels coarser the terrain tile can be than the mesh tile without
 * losing samples. A 256 px elevation tile has 256 samples per edge while a
 * mesh tile uses `segments` (32) grid cells, so the tile 3 levels up covers
 * 8 x 8 mesh tiles at exactly one sample per grid cell. Fetching that tile
 * instead of one per mesh tile cuts terrain requests by 64x with no loss of
 * detail.
 */
export function terrainLevelOffset(tileSize: number, segments: number): number {
  return Math.max(0, Math.round(Math.log2(Math.max(1, tileSize) / Math.max(1, segments))));
}

/** Raster terrain tile used for a mesh tile. */
export function rasterSourceTile(level: number, x: number, y: number, maxZoom: number, levelOffset: number): SourceTile {
  const z = Math.max(0, Math.min(maxZoom, level - levelOffset));
  const dz = level - z;
  return { z, x: x >> dz, y: y >> dz, dz };
}

/**
 * Bilinear sample of a mesh height grid ((n + 1)^2 samples, row 0 = north
 * edge) at normalized tile coordinates (u east, v south, both 0..1).
 */
export function sampleHeightGrid(grid: ArrayLike<number>, segments: number, u: number, v: number): number {
  const n = segments;
  const fx = Math.min(n, Math.max(0, u * n));
  const fy = Math.min(n, Math.max(0, v * n));
  const x0 = Math.min(n - 1, Math.floor(fx));
  const y0 = Math.min(n - 1, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const row = n + 1;
  const a = grid[y0 * row + x0] * (1 - tx) + grid[y0 * row + x0 + 1] * tx;
  const b = grid[(y0 + 1) * row + x0] * (1 - tx) + grid[(y0 + 1) * row + x0 + 1] * tx;
  return a * (1 - ty) + b * ty;
}

/**
 * Resamples the part of an ancestor's height grid covered by a descendant
 * tile onto the descendant's grid. Lets a child tile become renderable right
 * away (Cesium-style "upsampled" terrain) while its own terrain downloads.
 */
export function upsampleHeightGrid(
  parent: ArrayLike<number>,
  parentSegments: number,
  parentLevel: number,
  parentX: number,
  parentY: number,
  level: number,
  x: number,
  y: number,
  segments: number,
): Float32Array {
  const dl = level - parentLevel;
  const scale = 1 / 2 ** dl;
  const offU = (x - parentX * 2 ** dl) * scale;
  const offV = (y - parentY * 2 ** dl) * scale;
  const row = segments + 1;
  const out = new Float32Array(row * row);
  for (let j = 0; j <= segments; j++) {
    const v = offV + (j / segments) * scale;
    for (let i = 0; i <= segments; i++) {
      out[j * row + i] = sampleHeightGrid(parent, parentSegments, offU + (i / segments) * scale, v);
    }
  }
  return out;
}
