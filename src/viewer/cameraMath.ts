import { Matrix4, PerspectiveCamera, Quaternion, Ray, Vector2, Vector3 } from 'three';
import type { Ellipsoid } from '../core/Ellipsoid';

const _e = new Vector3();
const _n = new Vector3();
const _u = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _dir = new Vector3();
const _camUp = new Vector3();
const _back = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _ray = new Ray();
const _a = new Vector3();
const _b = new Vector3();

export interface HeadingPitch {
  heading: number;
  pitch: number;
}

/** Camera view direction (-Z) in world space. */
export function cameraDirection(q: Quaternion, out = new Vector3()): Vector3 {
  return out.set(0, 0, -1).applyQuaternion(q);
}

export function cameraUp(q: Quaternion, out = new Vector3()): Vector3 {
  return out.set(0, 1, 0).applyQuaternion(q);
}

export function cameraRight(q: Quaternion, out = new Vector3()): Vector3 {
  return out.set(1, 0, 0).applyQuaternion(q);
}

/**
 * Heading (clockwise from north) and pitch (negative looks down) of a camera
 * relative to the local east-north-up frame at its position.
 *
 * The heading comes from `H = f_h·cos(p) − up_h·sin(p)` (f = view direction,
 * up = camera up, `_h` = horizontal part). For a roll-free camera this is
 * exactly the horizontal heading vector, and unlike the horizontal part of the
 * view direction alone it stays well defined when looking straight down or up.
 * Using only the view direction made the heading jump by 180° whenever a
 * top-down camera drifted a hair past the nadir (e.g. while zooming), which
 * flipped the whole view upside down.
 */
export function getHeadingPitch(ellipsoid: Ellipsoid, position: Vector3, q: Quaternion, out: HeadingPitch = { heading: 0, pitch: 0 }): HeadingPitch {
  ellipsoid.eastNorthUp(position, _e, _n, _u);
  const f = cameraDirection(q, _dir);
  const up = cameraUp(q, _camUp);
  const sp = Math.max(-1, Math.min(1, f.dot(_u)));
  const cp = Math.sqrt(Math.max(0, 1 - sp * sp));
  out.pitch = Math.asin(sp);
  const he = f.dot(_e) * cp - up.dot(_e) * sp;
  const hn = f.dot(_n) * cp - up.dot(_n) * sp;
  out.heading = he === 0 && hn === 0 ? 0 : Math.atan2(he, hn);
  return out;
}

/** Zero-roll orientation for a heading/pitch at a position. */
export function orientationFromHeadingPitch(ellipsoid: Ellipsoid, position: Vector3, heading: number, pitch: number, out = new Quaternion()): Quaternion {
  ellipsoid.eastNorthUp(position, _e, _n, _u);
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // forward = cp * (sh e + ch n) + sp u ; right = ch e - sh n ; up = right x forward
  _dir.set(0, 0, 0).addScaledVector(_e, cp * sh).addScaledVector(_n, cp * ch).addScaledVector(_u, sp);
  _right.set(0, 0, 0).addScaledVector(_e, ch).addScaledVector(_n, -sh);
  _up.crossVectors(_right, _dir).normalize();
  _back.copy(_dir).negate();
  _m.makeBasis(_right, _up, _back);
  return out.setFromRotationMatrix(_m);
}

/** Zero-roll orientation looking along `direction`; `headingHint` is used when looking straight down. */
export function orientationFromDirection(ellipsoid: Ellipsoid, position: Vector3, direction: Vector3, headingHint: number, out = new Quaternion()): Quaternion {
  ellipsoid.eastNorthUp(position, _e, _n, _u);
  const d = _dir.copy(direction).normalize();
  const de = d.dot(_e);
  const dn = d.dot(_n);
  const du = d.dot(_u);
  const pitch = Math.asin(Math.max(-1, Math.min(1, du)));
  const heading = Math.hypot(de, dn) > 1e-6 ? Math.atan2(de, dn) : headingHint;
  return orientationFromHeadingPitch(ellipsoid, position, heading, pitch, out);
}

/** Removes roll from an orientation, keeping heading and pitch (stable at the nadir). */
export function levelOrientation(ellipsoid: Ellipsoid, position: Vector3, q: Quaternion): void {
  const hp = getHeadingPitch(ellipsoid, position, q);
  orientationFromHeadingPitch(ellipsoid, position, hp.heading, hp.pitch, q);
}

/**
 * Camera placement that looks at `target` from `range` meters away with the
 * given heading and pitch (Cesium's HeadingPitchRange convention).
 */
export function lookAtHeadingPitchRange(
  ellipsoid: Ellipsoid,
  target: Vector3,
  heading: number,
  pitch: number,
  range: number,
  outPosition: Vector3,
  outQuaternion: Quaternion,
): void {
  ellipsoid.eastNorthUp(target, _e, _n, _u);
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const dir = new Vector3().addScaledVector(_e, cp * sh).addScaledVector(_n, cp * ch).addScaledVector(_u, sp);
  outPosition.copy(target).addScaledVector(dir, -range);
  orientationFromDirection(ellipsoid, outPosition, dir, heading, outQuaternion);
}

/** World-space ray through a point in normalized device coordinates. */
export function rayFromNdc(camera: PerspectiveCamera, ndc: Vector2, out = new Ray()): Ray {
  camera.updateMatrixWorld();
  out.origin.setFromMatrixPosition(camera.matrixWorld);
  out.direction.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(out.origin).normalize();
  return out;
}

/** Nearest positive intersection distance of a ray with a sphere centered at the origin. */
export function intersectSphere(ray: Ray, radius: number): number | null {
  const b = ray.origin.dot(ray.direction);
  const c = ray.origin.lengthSq() - radius * radius;
  const d = b * b - c;
  if (d < 0) return null;
  const s = Math.sqrt(d);
  const t0 = -b - s;
  if (t0 > 0) return t0;
  const t1 = -b + s;
  return t1 > 0 ? t1 : null;
}

/** Rotates a camera (position and orientation) about the earth's center. */
export function rotateCameraAboutCenter(ellipsoid: Ellipsoid, position: Vector3, quaternion: Quaternion, q: Quaternion): void {
  position.applyQuaternion(q);
  quaternion.premultiply(q);
  levelOrientation(ellipsoid, position, quaternion);
}

/**
 * Rotates the camera about the earth's center so that `anchor` (a world point)
 * lies on the view ray through `ndc` again. Returns false when the ray misses
 * the sphere through the anchor (the camera is left unchanged).
 */
export function reanchor(ellipsoid: Ellipsoid, camera: PerspectiveCamera, anchor: Vector3, ndc: Vector2): boolean {
  const radius = anchor.length();
  if (radius < 1) return false;
  rayFromNdc(camera, ndc, _ray);
  const t = intersectSphere(_ray, radius);
  if (t === null) return false;
  _ray.at(t, _a).normalize();
  _b.copy(anchor).normalize();
  _q.setFromUnitVectors(_a, _b);
  if (Math.abs(1 - Math.abs(_q.w)) < 1e-15) return true;
  rotateCameraAboutCenter(ellipsoid, camera.position, camera.quaternion, _q);
  camera.updateMatrixWorld();
  return true;
}

export interface ZoomOptions {
  /** Distance factor: the camera ends `exp(-amount)` times as far from the target. */
  amount: number;
  /** Closest allowed distance to the target in meters. */
  minDistance?: number;
  /**
   * Keep the target under the cursor by rotating about the earth's center.
   * Disable for targets in the sky (not on the globe).
   */
  anchored?: boolean;
}

/**
 * Zooms towards (amount > 0) or away from a world point under the cursor
 * while keeping the camera's heading and pitch. Moving along the cursor ray
 * would otherwise tilt the camera (the local vertical turns as the camera
 * travels over the curved earth), so the orientation is rebuilt from the
 * original heading/pitch and the globe is turned to bring the target back
 * under the cursor. Top-down views stay top-down, tilted views keep their tilt.
 */
export function zoomTowards(ellipsoid: Ellipsoid, camera: PerspectiveCamera, target: Vector3, ndc: Vector2, options: ZoomOptions): void {
  const hp = getHeadingPitch(ellipsoid, camera.position, camera.quaternion);
  const toTarget = _a.subVectors(target, camera.position);
  const dist = toTarget.length();
  if (dist < 1e-6) return;
  const newDist = Math.max(dist * Math.exp(-options.amount), options.minDistance ?? 1);
  camera.position.copy(target).addScaledVector(toTarget.normalize(), -newDist);
  orientationFromHeadingPitch(ellipsoid, camera.position, hp.heading, hp.pitch, camera.quaternion);
  camera.updateMatrixWorld();
  if (options.anchored !== false && reanchor(ellipsoid, camera, target, ndc)) {
    // Turning about the center of an ellipsoid (not a sphere) nudges the pitch by up to
    // ~0.02°; restore it exactly so repeated zooms cannot accumulate a tilt.
    orientationFromHeadingPitch(ellipsoid, camera.position, hp.heading, hp.pitch, camera.quaternion);
    camera.updateMatrixWorld();
  }
}

/**
 * Orbits the camera around `pivot`: `dHeading` changes the camera heading by
 * turning about the pivot's local vertical, `dElevation` raises (positive) or
 * lowers the camera about the screen's horizontal axis through the pivot. Any
 * rotation about an axis through the pivot keeps the pivot at the same screen
 * position.
 *
 * The tilt angle is measured in the plane perpendicular to the camera's right
 * axis and clamped to [minElevation, maxElevation] (radians above the pivot's
 * horizon). Keeping it below 90° means the camera can never swing over the top
 * of the pivot, which is what used to flip the view. Returns the tilt angle
 * after the move.
 */
export function orbitAround(
  ellipsoid: Ellipsoid,
  position: Vector3,
  quaternion: Quaternion,
  pivot: Vector3,
  dHeading: number,
  dElevation: number,
  minElevation: number,
  maxElevation: number,
): number {
  const up = ellipsoid.geodeticSurfaceNormal(pivot, _u);
  if (dHeading !== 0) {
    // Turning the camera about the vertical by -a changes its heading by +a.
    _q.setFromAxisAngle(up, -dHeading);
    position.sub(pivot).applyQuaternion(_q).add(pivot);
    quaternion.premultiply(_q);
  }
  const right = cameraRight(quaternion, _b);
  right.addScaledVector(up, -right.dot(up));
  let tilt = Math.PI / 2;
  if (right.lengthSq() > 1e-12) {
    right.normalize();
    const offset = _a.subVectors(position, pivot);
    // forward = up x right; the camera normally sits behind the pivot (-forward side).
    const forward = _dir.crossVectors(up, right);
    tilt = Math.atan2(offset.dot(up), -offset.dot(forward));
    if (offset.lengthSq() > 1e-12) {
      // Clamp only in the direction of motion, so a camera that starts outside the
      // range (e.g. below a rooftop pivot) is not snapped into it.
      const target =
        dElevation > 0 ? Math.min(tilt + dElevation, Math.max(tilt, maxElevation)) : Math.max(tilt + dElevation, Math.min(tilt, minElevation));
      const delta = target - tilt;
      if (delta !== 0) {
        _q.setFromAxisAngle(right, -delta);
        position.sub(pivot).applyQuaternion(_q).add(pivot);
        quaternion.premultiply(_q);
        tilt = target;
      }
    }
  }
  levelOrientation(ellipsoid, position, quaternion);
  return tilt;
}
