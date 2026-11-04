import { describe, expect, it } from 'vitest';
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
