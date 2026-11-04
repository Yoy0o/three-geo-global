import { PerspectiveCamera, Quaternion, Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { angleDelta, DEG2RAD } from '../src/core/math';
import {
  getHeadingPitch,
  intersectSphere,
  levelOrientation,
  orbitAround,
  orientationFromHeadingPitch,
  rayFromNdc,
  rotateCameraAboutCenter,
  zoomTowards,
} from '../src/viewer/cameraMath';

const E = Ellipsoid.WGS84;

function makeCamera(lon: number, lat: number, height: number, heading: number, pitch: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, 16 / 9, 1, 1e8);
  E.cartographicToCartesian(lon * DEG2RAD, lat * DEG2RAD, height, camera.position);
  orientationFromHeadingPitch(E, camera.position, heading * DEG2RAD, pitch * DEG2RAD, camera.quaternion);
  camera.updateMatrixWorld();
  return camera;
}

/** Surface point (ellipsoid) seen through a screen position. */
function pickEllipsoid(camera: PerspectiveCamera, ndc: Vector2): Vector3 {
  const ray = rayFromNdc(camera, ndc);
  const t = E.intersectRay(ray);
  expect(t).not.toBeNull();
  return ray.at(t!, new Vector3());
}

function project(camera: PerspectiveCamera, p: Vector3): Vector2 {
  camera.updateMatrixWorld();
  const v = p.clone().project(camera);
  return new Vector2(v.x, v.y);
}

function hp(camera: PerspectiveCamera): { heading: number; pitch: number } {
  const r = getHeadingPitch(E, camera.position, camera.quaternion);
  return { heading: r.heading / DEG2RAD, pitch: r.pitch / DEG2RAD };
}

describe('getHeadingPitch', () => {
  it('round-trips heading and pitch, including straight down and up', () => {
    const pitches = [-90, -89.999, -60, -10, 0, 25, 89.99, 90];
    for (let i = 0; i < 200; i++) {
      const heading = (Math.random() * 2 - 1) * Math.PI;
      const pitch = pitches[i % pitches.length] * DEG2RAD;
      const lon = (Math.random() * 2 - 1) * Math.PI;
      const lat = (Math.random() * 2 - 1) * 1.4;
      const pos = E.cartographicToCartesian(lon, lat, 1000 + Math.random() * 1e7);
      const q = orientationFromHeadingPitch(E, pos, heading, pitch);
      const r = getHeadingPitch(E, pos, q);
      expect(Math.abs(r.pitch - pitch)).toBeLessThan(1e-7);
      expect(Math.abs(angleDelta(r.heading, heading))).toBeLessThan(1e-6);
    }
  });

  it('keeps the heading of a top-down camera that drifts slightly past the nadir', () => {
    // Camera looking straight down with north up, then tilted 0.5° "backwards".
    const camera = makeCamera(112, 26, 1.75e7, 0, -90);
    const east = new Vector3();
    E.eastNorthUp(camera.position, east, new Vector3(), new Vector3());
    camera.quaternion.premultiply(new Quaternion().setFromAxisAngle(east, -0.5 * DEG2RAD));
    const r = hp(camera);
    expect(Math.abs(angleDelta(r.heading * DEG2RAD, 0))).toBeLessThan(1e-6);
    levelOrientation(E, camera.position, camera.quaternion);
    expect(Math.abs(angleDelta(hp(camera).heading * DEG2RAD, 0))).toBeLessThan(1e-6);
  });
});

describe('zoomTowards', () => {
  const cursors: [number, number][] = [
    [0, -0.6], // south of the center: used to flip the view upside down
    [0, 0.6],
    [0.6, 0],
    [-0.6, 0],
    [0.5, -0.5],
  ];

  it('keeps a top-down global view top-down and north-up', () => {
    for (const [x, y] of cursors) {
      const camera = makeCamera(112, 26, 1.75e7, 0, -90);
      // Stay inside the globe's disk (about 15 degrees around the view center from this far).
      const ndc = new Vector2(x * 0.45, y * 0.75);
      const target = pickEllipsoid(camera, ndc);
      for (let i = 0; i < 40; i++) zoomTowards(E, camera, target, ndc, { amount: 0.08 });
      const r = hp(camera);
      expect(Math.abs(angleDelta(r.heading * DEG2RAD, 0))).toBeLessThan(1e-4);
      expect(r.pitch).toBeLessThan(-89.99);
      // The zoom point stays under the cursor.
      expect(project(camera, target).distanceTo(ndc)).toBeLessThan(2e-3);
      // And the camera really got closer (40 steps of e^-0.08 = 0.04x the distance).
      expect(camera.position.distanceTo(target)).toBeLessThan(0.05 * 1.75e7);
    }
  });

  it('keeps heading and pitch of a tilted view and the target under the cursor', () => {
    for (const [x, y] of cursors) {
      const camera = makeCamera(116.39, 39.9, 3000, 45, -35);
      const ndc = new Vector2(x * 0.8, Math.min(y, 0) - 0.2);
      const target = pickEllipsoid(camera, ndc);
      const before = camera.position.distanceTo(target);
      for (let i = 0; i < 30; i++) zoomTowards(E, camera, target, ndc, { amount: 0.05 });
      const r = hp(camera);
      expect(Math.abs(angleDelta(r.heading * DEG2RAD, 45 * DEG2RAD))).toBeLessThan(1e-4);
      expect(Math.abs(r.pitch + 35)).toBeLessThan(1e-3);
      expect(project(camera, target).distanceTo(ndc)).toBeLessThan(2e-3);
      expect(camera.position.distanceTo(target)).toBeLessThan(before * 0.25);
    }
  });

  it('zooms out symmetrically', () => {
    const camera = makeCamera(-74, 40.7, 2000, 0, -90);
    const ndc = new Vector2(0.3, -0.4);
    const target = pickEllipsoid(camera, ndc);
    for (let i = 0; i < 30; i++) zoomTowards(E, camera, target, ndc, { amount: -0.1 });
    const r = hp(camera);
    expect(Math.abs(angleDelta(r.heading * DEG2RAD, 0))).toBeLessThan(1e-4);
    expect(r.pitch).toBeLessThan(-89.99);
    expect(project(camera, target).distanceTo(ndc)).toBeLessThan(2e-3);
  });
});

describe('orbitAround', () => {
  it('changes heading and pitch directly while the pivot stays put on screen', () => {
    const camera = makeCamera(116.39, 39.9, 2000, 0, -60);
    const pivot = pickEllipsoid(camera, new Vector2(0, 0));
    orbitAround(E, camera.position, camera.quaternion, pivot, 30 * DEG2RAD, -15 * DEG2RAD, 1 * DEG2RAD, 89.99 * DEG2RAD);
    const r = hp(camera);
    expect(Math.abs(angleDelta(r.heading * DEG2RAD, 30 * DEG2RAD))).toBeLessThan(1e-3);
    expect(Math.abs(r.pitch + 45)).toBeLessThan(0.05);
    expect(project(camera, pivot).length()).toBeLessThan(1e-4);
  });

  it('never swings over the top of the pivot', () => {
    const camera = makeCamera(10, 50, 5000, 20, -80);
    const pivot = pickEllipsoid(camera, new Vector2(0, 0));
    for (let i = 0; i < 50; i++) {
      orbitAround(E, camera.position, camera.quaternion, pivot, 0, 5 * DEG2RAD, 2 * DEG2RAD, 89.99 * DEG2RAD);
    }
    const r = hp(camera);
    expect(r.pitch).toBeLessThan(-89.9);
    expect(Math.abs(angleDelta(r.heading * DEG2RAD, 20 * DEG2RAD))).toBeLessThan(1e-3);
    for (let i = 0; i < 50; i++) {
      orbitAround(E, camera.position, camera.quaternion, pivot, 0, -5 * DEG2RAD, 2 * DEG2RAD, 89.99 * DEG2RAD);
    }
    expect(hp(camera).pitch).toBeGreaterThan(-2.1);
    expect(project(camera, pivot).length()).toBeLessThan(1e-3);
  });

  it('works for a global view orbiting the screen center', () => {
    const camera = makeCamera(112, 26, 1.75e7, 0, -90);
    const pivot = pickEllipsoid(camera, new Vector2(0, 0));
    const tilt = orbitAround(E, camera.position, camera.quaternion, pivot, 0, -30 * DEG2RAD, 2 * DEG2RAD, 89.99 * DEG2RAD);
    expect(Math.abs(tilt / DEG2RAD - 60)).toBeLessThan(1e-6);
    // Elevation above the pivot's horizon is 60 degrees; seen from the camera's own
    // vertical the pitch is steeper because the camera moved around the planet.
    const up = E.geodeticSurfaceNormal(pivot, new Vector3());
    const offset = camera.position.clone().sub(pivot).normalize();
    expect(Math.abs(Math.asin(offset.dot(up)) / DEG2RAD - 60)).toBeLessThan(0.05);
    const r = hp(camera);
    expect(Math.abs(angleDelta(r.heading * DEG2RAD, 0))).toBeLessThan(1e-3);
    expect(r.pitch).toBeLessThan(-60);
    expect(project(camera, pivot).length()).toBeLessThan(1e-4);
  });
});

describe('rotateCameraAboutCenter', () => {
  it('keeps a top-down camera north-up while dragging across latitudes', () => {
    const camera = makeCamera(100, 0, 8e6, 0, -90);
    const east = new Vector3();
    E.eastNorthUp(camera.position, east, new Vector3(), new Vector3());
    // A negative turn about the east axis carries the camera north (up to 69 degrees latitude here).
    const step = new Quaternion().setFromAxisAngle(east, -0.01);
    for (let i = 0; i < 120; i++) {
      rotateCameraAboutCenter(E, camera.position, camera.quaternion, step);
      const r = hp(camera);
      expect(Math.abs(angleDelta(r.heading * DEG2RAD, 0))).toBeLessThan(1e-3);
      expect(r.pitch).toBeLessThan(-89.5);
    }
  });
});

describe('intersectSphere', () => {
  it('returns the near hit from outside and the exit from inside', () => {
    const camera = makeCamera(0, 0, 1e7, 0, -90);
    const ray = rayFromNdc(camera, new Vector2(0, 0));
    const t = intersectSphere(ray, 6378137);
    expect(t).toBeCloseTo(1e7, 0);
  });
});
