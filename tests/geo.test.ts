import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { computeHorizonCullingPoint, geodeticToEcef, isScaledSpacePointVisible, WGS84_A, WGS84_B } from '../src/core/geodesy';
import { geoidUndulation } from '../src/core/Geoid';
import { DEG2RAD } from '../src/core/math';
import { sunDirectionECEF } from '../src/core/SunPosition';
import { MERCATOR_MAX_LATITUDE, WebMercatorTilingScheme } from '../src/globe/TilingScheme';
import { CameraFlight } from '../src/viewer/CameraFlight';
import { getHeadingPitch, lookAtHeadingPitchRange, orientationFromHeadingPitch } from '../src/viewer/cameraMath';

const E = Ellipsoid.WGS84;

describe('Ellipsoid', () => {
  it('maps known points', () => {
    expect(E.cartographicToCartesian(0, 0, 0).distanceTo(new Vector3(WGS84_A, 0, 0))).toBeLessThan(1e-6);
    expect(E.cartographicToCartesian(0, Math.PI / 2, 0).distanceTo(new Vector3(0, 0, WGS84_B))).toBeLessThan(1e-6);
    expect(E.cartographicToCartesian(Math.PI / 2, 0, 100).distanceTo(new Vector3(0, WGS84_A + 100, 0))).toBeLessThan(1e-6);
  });

  it('round-trips cartographic <-> cartesian with sub-millimeter error', () => {
    for (let i = 0; i < 2000; i++) {
      const lon = (Math.random() * 2 - 1) * Math.PI;
      const lat = (Math.random() * 2 - 1) * (Math.PI / 2 - 1e-6);
      const h = Math.random() * 2e7 - 1e4;
      const p = E.cartographicToCartesian(lon, lat, h);
      const c = E.cartesianToCartographic(p)!;
      expect(Math.abs(c.height - h)).toBeLessThan(1e-3);
      expect(E.cartographicToCartesian(c.longitude, c.latitude, c.height).distanceTo(p)).toBeLessThan(1e-3);
    }
  });

  it('agrees with the worker-side geodesy helper', () => {
    const out = [0, 0, 0];
    for (let i = 0; i < 200; i++) {
      const lon = (Math.random() * 2 - 1) * Math.PI;
      const lat = (Math.random() * 2 - 1) * 1.5;
      const h = Math.random() * 9000;
      geodeticToEcef(lon, lat, h, out);
      expect(E.cartographicToCartesian(lon, lat, h).distanceTo(new Vector3(...out))).toBeLessThan(1e-6);
    }
  });

  it('intersects rays with the surface', () => {
    const t = E.intersectRay({ origin: new Vector3(2e7, 0, 0), direction: new Vector3(-1, 0, 0) } as never);
    expect(t).toBeCloseTo(2e7 - WGS84_A, 3);
  });
});

describe('WebMercatorTilingScheme', () => {
  const s = new WebMercatorTilingScheme();
  it('covers the world at level 0', () => {
    const r = s.tileRect(0, 0, 0);
    expect(r.west).toBeCloseTo(-Math.PI);
    expect(r.east).toBeCloseTo(Math.PI);
    expect(r.north).toBeCloseTo(MERCATOR_MAX_LATITUDE);
    expect(r.south).toBeCloseTo(-MERCATOR_MAX_LATITUDE);
  });

  it('finds the tile containing a position', () => {
    // Tiananmen (116.4074E, 39.9042N) at z=10 is x=843, y=388 in the XYZ scheme.
    expect(s.positionToTile(10, 116.4074 * DEG2RAD, 39.9042 * DEG2RAD)).toEqual({ x: 843, y: 388 });
    const { x, y } = s.positionToTile(7, -0.4, 0.3);
    const r = s.tileRect(7, x, y);
    expect(-0.4).toBeGreaterThanOrEqual(r.west);
    expect(-0.4).toBeLessThanOrEqual(r.east);
    expect(0.3).toBeGreaterThanOrEqual(r.south);
    expect(0.3).toBeLessThanOrEqual(r.north);
  });
});

describe('horizon culling', () => {
  function tilePoints(lon: number, lat: number, size: number): Float64Array {
    const pts = new Float64Array(9 * 3);
    let k = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) geodeticToEcef(lon + i * size, lat + j * size, 0, pts, 3 * k++);
    return pts;
  }

  it('keeps the near side and culls the far side', () => {
    const camera = E.cartographicToCartesian(0, 0, 2_000_000).multiply(E.oneOverRadii);
    for (const [lon, visible] of [
      [0, true],
      [0.3, true],
      [Math.PI, false],
      [Math.PI / 2 + 0.4, false],
    ] as const) {
      const pts = tilePoints(lon, 0, 0.02);
      const c = new Vector3(pts[12], pts[13], pts[14]);
      const hp = computeHorizonCullingPoint(c.x, c.y, c.z, pts, 9)!;
      expect(hp).not.toBeNull();
      expect(isScaledSpacePointVisible(hp[0], hp[1], hp[2], camera.x, camera.y, camera.z)).toBe(visible);
    }
  });
});

describe('camera math', () => {
  it('round-trips heading and pitch', () => {
    const q = new Quaternion();
    for (const [lon, lat] of [
      [0, 0],
      [2, 0.7],
      [-1.2, -1.3],
    ]) {
      const pos = E.cartographicToCartesian(lon, lat, 5000);
      for (const heading of [0, 0.5, -2.5, 3]) {
        for (const pitch of [-Math.PI / 2, -1, -0.2, 0, 0.6]) {
          orientationFromHeadingPitch(E, pos, heading, pitch, q);
          const hp = getHeadingPitch(E, pos, q);
          expect(hp.pitch).toBeCloseTo(pitch, 6);
          expect(Math.cos(hp.heading - heading)).toBeCloseTo(1, 6);
        }
      }
    }
  });

  it('looks at the target with heading/pitch/range', () => {
    const target = E.cartographicToCartesian(2, 0.5, 100);
    const pos = new Vector3();
    const q = new Quaternion();
    lookAtHeadingPitchRange(E, target, 0.3, -0.6, 1000, pos, q);
    expect(pos.distanceTo(target)).toBeCloseTo(1000, 6);
    const dir = new Vector3(0, 0, -1).applyQuaternion(q);
    const toTarget = target.clone().sub(pos).normalize();
    expect(dir.dot(toTarget)).toBeCloseTo(1, 9);
  });

  it('flies exactly to the destination', () => {
    const from = E.cartographicToCartesian(0, 0, 1e7);
    const q0 = orientationFromHeadingPitch(E, from, 0, -Math.PI / 2);
    const to = E.cartographicToCartesian(2, 0.6, 1200);
    const flight = new CameraFlight(E, from, q0, { position: to, heading: 1, pitch: -0.4 });
    const p = new Vector3();
    const q = new Quaternion();
    let steps = 0;
    while (flight.update(1 / 60, p, q) && steps < 10_000) steps++;
    expect(p.distanceTo(to)).toBeLessThan(0.01);
    const hp = getHeadingPitch(E, p, q);
    expect(hp.heading).toBeCloseTo(1, 6);
    expect(hp.pitch).toBeCloseTo(-0.4, 6);
  });
});

describe('environment', () => {
  it('puts the June solstice sun over the tropic of Cancer at noon UTC', () => {
    const d = sunDirectionECEF(new Date('2026-06-21T12:00:00Z'));
    const lat = Math.asin(d.z) / DEG2RAD;
    const lon = Math.atan2(d.y, d.x) / DEG2RAD;
    expect(lat).toBeGreaterThan(23.2);
    expect(lat).toBeLessThan(23.6);
    expect(Math.abs(lon)).toBeLessThan(2);
  });

  it('samples the EGM96 geoid', () => {
    expect(geoidUndulation(0, 0)).toBeCloseTo(17.2, 0);
    expect(geoidUndulation(-75.61 * DEG2RAD, 40.04 * DEG2RAD)).toBeCloseTo(-34.4, 0);
    // Deepest geoid low, south of India (about -106 m).
    expect(geoidUndulation(78 * DEG2RAD, 5 * DEG2RAD)).toBeLessThan(-90);
  });
});
