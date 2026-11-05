/**
 * Vertex and index layout of globe tile meshes, shared by the mesh worker
 * (which builds them) and the main thread (which draws quadrants of them as
 * stand-ins for children that have no mesh yet). Dependency-free.
 *
 * Vertices: (N + 1)^2 grid vertices row by row from the north edge (row j,
 * column i at j * (N + 1) + i), then one skirt row of N + 1 vertices per edge,
 * edges in the order of `edgeVertices`.
 *
 * Indices: one quad (two triangles, 6 indices) per grid cell, row by row from
 * the north-west cell; then N quads per skirt, edges in the same order.
 */

/**
 * Grid vertex indices along the four edges, in skirt order: north (east to
 * west), south (west to east), west (north to south), east (south to north).
 * Each runs so that its skirt faces outward.
 */
export function edgeVertices(segments: number): number[][] {
  const N = segments;
  const row = N + 1;
  const edges: number[][] = [[], [], [], []];
  for (let i = N; i >= 0; i--) edges[0].push(i);
  for (let i = 0; i <= N; i++) edges[1].push(N * row + i);
  for (let j = 0; j <= N; j++) edges[2].push(j * row);
  for (let j = N; j >= 0; j--) edges[3].push(j * row + N);
  return edges;
}

/** Index buffer of a tile mesh with `vertexCount` vertices (grid + 4 skirts). */
export function buildTileIndices(segments: number, vertexCount: number): Uint16Array | Uint32Array {
  const N = segments;
  const row = N + 1;
  const indices = vertexCount > 65535 ? new Uint32Array(N * N * 6 + 4 * N * 6) : new Uint16Array(N * N * 6 + 4 * N * 6);
  let p = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * row + i;
      const b = a + row;
      const c = a + 1;
      const d = b + 1;
      indices[p++] = a;
      indices[p++] = b;
      indices[p++] = c;
      indices[p++] = c;
      indices[p++] = b;
      indices[p++] = d;
    }
  }
  const edges = edgeVertices(N);
  let skirt = row * row;
  for (const edge of edges) {
    for (let k = 0; k < N; k++) {
      const e0 = edge[k];
      const e1 = edge[k + 1];
      const s0 = skirt + k;
      const s1 = skirt + k + 1;
      indices[p++] = e0;
      indices[p++] = s0;
      indices[p++] = e1;
      indices[p++] = e1;
      indices[p++] = s0;
      indices[p++] = s1;
    }
    skirt += row;
  }
  return indices;
}

/**
 * Quads covering one quadrant of a tile, grid cells first (row by row), then
 * the skirt quads along the tile's outer edges inside the quadrant. The four
 * quadrants partition all quads of the mesh.
 *
 * @param segments Grid cells per edge (even).
 * @param qx 0 = west half, 1 = east half.
 * @param qy 0 = north half, 1 = south half.
 */
export function quadrantQuads(segments: number, qx: number, qy: number): number[] {
  const N = segments;
  const half = N >> 1;
  const c0 = qx * half;
  const r0 = qy * half;
  const quads: number[] = [];
  for (let r = r0; r < r0 + half; r++) for (let c = c0; c < c0 + half; c++) quads.push(r * N + c);
  const skirt = (edge: number, k: number) => N * N + edge * N + k;
  // North skirt quad k spans grid columns N - k .. N - k - 1; east skirt quad k spans rows N - k .. N - k - 1.
  if (qy === 0) for (let c = c0; c < c0 + half; c++) quads.push(skirt(0, N - 1 - c));
  else for (let c = c0; c < c0 + half; c++) quads.push(skirt(1, c));
  if (qx === 0) for (let r = r0; r < r0 + half; r++) quads.push(skirt(2, r));
  else for (let r = r0; r < r0 + half; r++) quads.push(skirt(3, N - 1 - r));
  return quads;
}

/** Copies the given quads (groups of 6 indices) out of an index buffer. */
export function extractQuads<T extends Uint16Array | Uint32Array>(indices: T, quads: readonly number[]): T {
  const out = new (indices.constructor as { new (n: number): T })(quads.length * 6);
  for (let q = 0; q < quads.length; q++) out.set(indices.subarray(quads[q] * 6, quads[q] * 6 + 6), q * 6);
  return out;
}

/** Vertices of a tile mesh: the grid, then one skirt row per edge. */
export function tileVertexCount(segments: number): number {
  return (segments + 1) * (segments + 1) + 4 * (segments + 1);
}

/**
 * Per-vertex height offsets (meters, along the ellipsoid normal) that make a
 * tile mesh start out as the surface that was on screen before and morph into
 * its own heights: vertex `k` is drawn at its height minus `deltas[k]` at the
 * start. Skirt vertices move with their edge vertex.
 *
 * @param heights The mesh's (segments + 1)^2 grid heights, row by row from the north edge.
 * @param oldHeight Height of the previous surface at grid vertex (column i, row j), or null where unknown (no offset).
 * @param out Reused when it has the right length.
 * @returns The offsets and the largest absolute offset.
 */
export function morphDeltas(
  segments: number,
  heights: ArrayLike<number>,
  oldHeight: (i: number, j: number) => number | null,
  out?: Float32Array,
): { deltas: Float32Array; max: number } {
  const N = segments;
  const row = N + 1;
  const count = tileVertexCount(N);
  const deltas = out && out.length === count ? out : new Float32Array(count);
  let max = 0;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const k = j * row + i;
      const old = oldHeight(i, j);
      const d = old === null || !Number.isFinite(old) ? 0 : heights[k] - old;
      deltas[k] = d;
      max = Math.max(max, Math.abs(d));
    }
  }
  let s = row * row;
  for (const edge of edgeVertices(N)) for (const k of edge) deltas[s++] = deltas[k];
  return { deltas, max };
}
