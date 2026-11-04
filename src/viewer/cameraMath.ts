import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Ellipsoid } from '../core/Ellipsoid';

const _e = new Vector3();
const _n = new Vector3();
const _u = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _dir = new Vector3();
const _back = new Vector3();
const _m = new Matrix4();

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

/**
 * Heading (clockwise from north) and pitch (negative looks down) of a camera
 * relative to the local east-north-up frame at its position.
 */
export function getHeadingPitch(ellipsoid: Ellipsoid, position: Vector3, q: Quaternion, out: HeadingPitch = { heading: 0, pitch: 0 }): HeadingPitch {
  ellipsoid.eastNorthUp(position, _e, _n, _u);
  const d = cameraDirection(q, _dir);
  const de = d.dot(_e);
  const dn = d.dot(_n);
  const du = d.dot(_u);
  out.pitch = Math.asin(Math.max(-1, Math.min(1, du)));
  if (Math.hypot(de, dn) > 1e-4) {
    out.heading = Math.atan2(de, dn);
  } else {
    // Looking straight down/up: the camera's up vector carries the heading.
    const up = cameraUp(q, _up);
    const s = du < 0 ? 1 : -1;
    out.heading = Math.atan2(up.dot(_e) * s, up.dot(_n) * s);
  }
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

/** Zero-roll orientation looking along `direction`; `heading` is used when looking straight down. */
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

/** Removes roll from an orientation, keeping the view direction. */
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
