import { describe, expect, it } from 'vitest';
import { buildTileIndices, edgeVertices, extractQuads, morphDeltas, quadrantQuads, tileVertexCount } from '../src/globe/tileMeshLayout';

const N = 8;
const row = N + 1;
const vertexCount = row * row + 4 * row;

/** Grid column / row of a vertex, mapping skirt vertices to the grid vertex they hang from. */
function gridOf(v: number): [number, number] {
  if (v < row * row) return [v % row, Math.floor(v / row)];
  const edges = edgeVertices(N);
  const s = v - row * row;
  const g = edges[Math.floor(s / row)][s % row];
  return [g % row, Math.floor(g / row)];
}

describe('tile mesh layout', () => {
  it('builds grid quads then four outward skirts', () => {
    const indices = buildTileIndices(N, vertexCount);
    expect(indices).toBeInstanceOf(Uint16Array);
    expect(indices.length).toBe((N * N + 4 * N) * 6);
    // First cell: north-west corner, counter-clockwise seen from above (a, b, c) = (0, row, 1).
    expect([...indices.subarray(0, 6)]).toEqual([0, row, 1, 1, row, row + 1]);
    expect(Math.max(...indices)).toBe(vertexCount - 1);
    expect(buildTileIndices(N, 70_000)).toBeInstanceOf(Uint32Array);
  });

  it('splits the mesh into four quadrants that partition all quads', () => {
    const all = new Set<number>();
    for (let q = 0; q < 4; q++) {
      const quads = quadrantQuads(N, q & 1, q >> 1);
      // (N/2)^2 grid quads plus N/2 skirt quads on each of the quadrant's two outer edges.
      expect(quads.length).toBe((N / 2) ** 2 + N);
      for (const quad of quads) {
        expect(all.has(quad)).toBe(false);
        all.add(quad);
      }
    }
    expect(all.size).toBe(N * N + 4 * N);
  });

  it('extracts only triangles inside the quadrant, grid first', () => {
    const indices = buildTileIndices(N, vertexCount);
    const half = N / 2;
    for (let q = 0; q < 4; q++) {
      const qx = q & 1;
      const qy = q >> 1;
      const sub = extractQuads(indices, quadrantQuads(N, qx, qy));
      expect(sub).toBeInstanceOf(Uint16Array);
      for (let k = 0; k < sub.length; k++) {
        const [i, j] = gridOf(sub[k]);
        expect(i).toBeGreaterThanOrEqual(qx * half);
        expect(i).toBeLessThanOrEqual(qx * half + half);
        expect(j).toBeGreaterThanOrEqual(qy * half);
        expect(j).toBeLessThanOrEqual(qy * half + half);
        // The first (N/2)^2 quads are grid cells (the ray cast relies on it).
        if (k < half * half * 6) expect(sub[k]).toBeLessThan(row * row);
      }
    }
  });
});

describe('geometry morph offsets', () => {
  const heights = Float32Array.from({ length: row * row }, (_, k) => 100 + k);

  it('covers grid and skirt vertices', () => {
    expect(tileVertexCount(N)).toBe(vertexCount);
    const { deltas } = morphDeltas(N, heights, () => 0);
    expect(deltas.length).toBe(vertexCount);
  });

  it('is the height change per grid vertex, skirts following their edge vertex', () => {
    const { deltas, max } = morphDeltas(N, heights, (i, j) => 50 + i - j);
    for (let v = 0; v < vertexCount; v++) {
      const [i, j] = gridOf(v);
      expect(deltas[v]).toBeCloseTo(heights[j * row + i] - (50 + i - j));
    }
    let expected = 0;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) expected = Math.max(expected, Math.abs(heights[j * row + i] - (50 + i - j)));
    expect(max).toBeCloseTo(expected);
  });

  it('leaves vertices with an unknown previous height in place', () => {
    const { deltas, max } = morphDeltas(N, heights, (i) => (i === 0 ? null : i === 1 ? NaN : heights[0]));
    expect(deltas[0]).toBe(0);
    expect(deltas[row]).toBe(0);
    expect(deltas[1]).toBe(0);
    expect(deltas[2]).toBeCloseTo(heights[2] - heights[0]);
    expect(max).toBeGreaterThan(0);
  });

  it('reuses an output buffer of the right size', () => {
    const out = new Float32Array(vertexCount);
    expect(morphDeltas(N, heights, () => 0, out).deltas).toBe(out);
    expect(morphDeltas(N, heights, () => 0, new Float32Array(3)).deltas.length).toBe(vertexCount);
  });
});
