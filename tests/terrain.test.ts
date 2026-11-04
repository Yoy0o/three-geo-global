import { describe, expect, it } from 'vitest';
import { rasterSourceTile, sampleHeightGrid, terrainLevelOffset, upsampleHeightGrid } from '../src/globe/terrain/terrainTiling';

describe('terrain tiling', () => {
  it('reads raster terrain from the coarsest tile that still has one sample per grid cell', () => {
    expect(terrainLevelOffset(256, 32)).toBe(3);
    expect(terrainLevelOffset(512, 32)).toBe(4);
    expect(terrainLevelOffset(256, 64)).toBe(2);
    expect(terrainLevelOffset(16, 32)).toBe(0);
    // Mesh tile 12/3301/1520 reads terrain 9/412/190 and covers 1/8 of it.
    expect(rasterSourceTile(12, 3301, 1520, 15, 3)).toEqual({ z: 9, x: 412, y: 190, dz: 3 });
    // Coarse levels clamp to level 0; deep levels clamp to the source's max zoom.
    expect(rasterSourceTile(2, 3, 1, 15, 3)).toEqual({ z: 0, x: 0, y: 0, dz: 2 });
    expect(rasterSourceTile(20, 800_000, 400_000, 15, 3)).toEqual({ z: 15, x: 800_000 >> 5, y: 400_000 >> 5, dz: 5 });
  });

  it('upsamples a parent grid exactly at shared vertices', () => {
    const n = 4;
    const row = n + 1;
    // A bilinear ramp is reproduced exactly by bilinear resampling.
    const parent = new Float32Array(row * row);
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) parent[j * row + i] = 10 * i + 100 * j;
    const child = upsampleHeightGrid(parent, n, 5, 10, 20, 6, 21, 41, n); // south-east quadrant
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const u = 0.5 + i / n / 2;
        const v = 0.5 + j / n / 2;
        expect(child[j * row + i]).toBeCloseTo(10 * u * n + 100 * v * n, 4);
      }
    }
    expect(sampleHeightGrid(parent, n, 1, 1)).toBe(parent[row * row - 1]);
  });
});
import {
  decodeQuantizedMesh,
  encodeQuantizedMesh,
  geographicTileRect,
  isTileAvailable,
  rasterizeQuantizedMesh,
  sampleGrid,
  type QuantizedMeshTile,
} from '../src/globe/terrain/quantizedMesh';

const Q = 32767;

function quad(): QuantizedMeshTile {
  // SW, SE, NW, NE corners; two triangles sharing the SE-NW diagonal.
  return {
    minHeight: 100,
    maxHeight: 300,
    u: new Uint16Array([0, Q, 0, Q]),
    v: new Uint16Array([0, 0, Q, Q]),
    h: new Uint16Array([0, Q, 16383, Q]),
    indices: new Uint16Array([0, 1, 2, 2, 1, 3]),
  };
}

describe('quantized-mesh', () => {
  it('round-trips zig-zag vertices and high-water-mark indices', () => {
    const src = quad();
    const out = decodeQuantizedMesh(encodeQuantizedMesh(src));
    expect(out.minHeight).toBe(100);
    expect(out.maxHeight).toBe(300);
    expect([...out.u]).toEqual([...src.u]);
    expect([...out.v]).toEqual([...src.v]);
    expect([...out.h]).toEqual([...src.h]);
    expect([...out.indices]).toEqual([...src.indices]);
  });

  it('rasterizes triangles onto a south-up height grid', () => {
    const grid = rasterizeQuantizedMesh(quad(), 3);
    expect(grid[0]).toBeCloseTo(100, 3); // SW
    expect(grid[2]).toBeCloseTo(300, 3); // SE
    expect(grid[6]).toBeCloseTo(100 + (16383 / Q) * 200, 3); // NW
    expect(grid[8]).toBeCloseTo(300, 3); // NE
    // Center lies on the SE-NW diagonal.
    expect(grid[4]).toBeCloseTo((300 + 100 + (16383 / Q) * 200) / 2, 2);
    expect(sampleGrid(grid, 3, 0.5, 0.5)).toBeCloseTo(grid[4], 6);
    expect(sampleGrid(grid, 3, 0, 1)).toBeCloseTo(grid[6], 6);
  });

  it('uses EPSG:4326 geographic tiles with two root tiles and TMS rows', () => {
    expect(geographicTileRect(0, 0, 0)).toEqual({ west: -180, south: -90, size: 180 });
    expect(geographicTileRect(0, 1, 0)).toEqual({ west: 0, south: -90, size: 180 });
    expect(geographicTileRect(2, 5, 3)).toEqual({ west: 45, south: 45, size: 45 });
  });

  it('checks layer.json availability ranges', () => {
    const available = [[[0, 0, 1, 0]], [[0, 0, 3, 1]], [[2, 1, 2, 1]]];
    expect(isTileAvailable(available, 0, 1, 0)).toBe(true);
    expect(isTileAvailable(available, 2, 2, 1)).toBe(true);
    expect(isTileAvailable(available, 2, 3, 1)).toBe(false);
    // Levels beyond the list are unknown: try them.
    expect(isTileAvailable(available, 5, 9, 9)).toBe(true);
    expect(isTileAvailable(null, 3, 0, 0)).toBe(true);
  });
});
