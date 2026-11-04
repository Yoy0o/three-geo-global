import { describe, expect, it } from 'vitest';
import {
  GridIndex,
  lonLatToMerc,
  mercToLonLat,
  pathMidpoint,
  pointInRings,
  polylabel,
  projectPath,
  ringArea,
} from '../src/vector/geometry';
import { splitDouble } from '../src/vector/LabelManager';

describe('mercator helpers', () => {
  it('round-trips lon/lat', () => {
    for (const [lon, lat] of [
      [0, 0],
      [116.4, 39.9],
      [-75.6, 40.0],
      [179.9, -60],
    ]) {
      const [u, v] = lonLatToMerc(lon, lat);
      const [lon2, lat2] = mercToLonLat(u, v);
      expect(lon2).toBeCloseTo(lon, 9);
      expect(lat2).toBeCloseTo(lat, 9);
    }
    expect(lonLatToMerc(0, 0)).toEqual([0.5, 0.5]);
  });

  it('unwraps paths that cross the antimeridian', () => {
    const p = projectPath([
      [179, 10],
      [-179, 10],
      [-178, 11],
    ]);
    // Continuous in u: the second point continues east past u = 1.
    expect(p[2]).toBeGreaterThan(1);
    expect(p[2] - p[0]).toBeCloseTo(2 / 360, 9);
    expect(p[4] - p[2]).toBeCloseTo(1 / 360, 9);
  });

  it('keeps RFC 7946 seam edges (both ends at +-180) untouched', () => {
    const p = projectPath([
      [170, -80],
      [180, -80],
      [180, -90],
      [-180, -90],
      [-180, -80],
    ]);
    expect(p[6]).toBeCloseTo(0, 9); // -180 maps to u = 0, not 1
  });
});

describe('polygon helpers', () => {
  const square = projectPath([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ]);
  const hole = projectPath([
    [4, 4],
    [6, 4],
    [6, 6],
    [4, 6],
    [4, 4],
  ]);

  it('tests point in polygon with holes (even-odd)', () => {
    const [u1, v1] = lonLatToMerc(2, 2);
    const [u2, v2] = lonLatToMerc(5, 5);
    const [u3, v3] = lonLatToMerc(12, 5);
    expect(pointInRings(u1, v1, [square, hole])).toBe(true);
    expect(pointInRings(u2, v2, [square, hole])).toBe(false);
    expect(pointInRings(u3, v3, [square, hole])).toBe(false);
  });

  it('computes signed ring area', () => {
    expect(Math.abs(ringArea(square))).toBeGreaterThan(0);
  });

  it('puts polylabel inside, away from holes', () => {
    const [u, v] = polylabel([square, hole]);
    expect(pointInRings(u, v, [square, hole])).toBe(true);
    // An L-shape: the centroid falls outside, polylabel must not.
    const l = projectPath([
      [0, 0],
      [10, 0],
      [10, 2],
      [2, 2],
      [2, 10],
      [0, 10],
      [0, 0],
    ]);
    const [lu, lv] = polylabel([l]);
    expect(pointInRings(lu, lv, [l])).toBe(true);
  });

  it('finds line midpoints', () => {
    const line = new Float64Array([0, 0, 1, 0, 1, 1]);
    expect(pathMidpoint(line)).toEqual([1, 0]);
  });
});

describe('GridIndex', () => {
  it('returns unique overlapping keys', () => {
    const g = new GridIndex(16);
    g.insert(1, 0.1, 0.1, 0.4, 0.4);
    g.insert(2, 0.6, 0.6, 0.9, 0.9);
    g.insert(3, 0.0, 0.0, 1.0, 1.0);
    expect(g.query(0.2, 0.2, 0.3, 0.3).sort()).toEqual([1, 3]);
    expect(g.query(0.7, 0.7, 0.8, 0.8).sort()).toEqual([2, 3]);
    // Wide query: each key once.
    expect(g.query(0, 0, 1, 1).sort()).toEqual([1, 2, 3]);
  });
});

describe('relative-to-eye encoding', () => {
  it('splits doubles into float32-exact high parts and small low parts', () => {
    for (const v of [6378137.123456, -4736682.902037748, 4081926.095098698, 12.5, -0.25]) {
      const [high, low] = splitDouble(v);
      expect(Math.fround(high)).toBe(high);
      expect(Math.abs(low)).toBeLessThan(65536);
      expect(high + low).toBeCloseTo(v, 9);
    }
  });

  it('keeps millimeter precision after float32 rounding', () => {
    const cam = [-2187110.12345, 4380650.98765, 4041241.54321];
    const pt = [-2187100.5, 4380660.25, 4041250.75];
    for (let k = 0; k < 3; k++) {
      const [ph, pl] = splitDouble(pt[k]);
      const [ch, cl] = splitDouble(cam[k]);
      const gpu = Math.fround(Math.fround(ph) - Math.fround(ch)) + Math.fround(Math.fround(pl) - Math.fround(cl));
      expect(Math.abs(gpu - (pt[k] - cam[k]))).toBeLessThan(0.01);
    }
  });
});
