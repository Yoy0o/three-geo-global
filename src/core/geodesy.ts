/**
 * Dependency-free geodesy helpers that run on the main thread and inside
 * workers (no three.js import, so worker bundles stay small).
 */

export const WGS84_A = 6378137.0;
export const WGS84_B = 6356752.314245179;
const RX2 = WGS84_A * WGS84_A;
const RZ2 = WGS84_B * WGS84_B;

/** Writes the ECEF position of (lon, lat, height) on WGS84 into out[offset..offset+2]. */
export function geodeticToEcef(lon: number, lat: number, height: number, out: Float64Array | number[], offset = 0): void {
  const cosLat = Math.cos(lat);
  const nx = cosLat * Math.cos(lon);
  const ny = cosLat * Math.sin(lon);
  const nz = Math.sin(lat);
  const kx = RX2 * nx;
  const ky = RX2 * ny;
  const kz = RZ2 * nz;
  const gamma = Math.sqrt(nx * kx + ny * ky + nz * kz);
  out[offset] = kx / gamma + nx * height;
  out[offset + 1] = ky / gamma + ny * height;
  out[offset + 2] = kz / gamma + nz * height;
}

/** Geodetic surface normal for a (lon, lat). */
export function geodeticNormal(lon: number, lat: number, out: Float64Array | number[], offset = 0): void {
  const cosLat = Math.cos(lat);
  out[offset] = cosLat * Math.cos(lon);
  out[offset + 1] = cosLat * Math.sin(lon);
  out[offset + 2] = Math.sin(lat);
}

export function mercatorVToLatitude(v: number): number {
  return 2 * Math.atan(Math.exp(Math.PI * (1 - 2 * v))) - Math.PI / 2;
}

/**
 * Horizon culling point (CesiumJS "occludee point" in ellipsoid-scaled space).
 * If this point is below the horizon, every input position is as well.
 * Returns null when no finite point exists (for very large tiles).
 */
export function computeHorizonCullingPoint(
  dirX: number,
  dirY: number,
  dirZ: number,
  positions: Float64Array,
  count: number,
): [number, number, number] | null {
  // Direction in scaled space, normalized.
  let sx = dirX / WGS84_A;
  let sy = dirY / WGS84_A;
  let sz = dirZ / WGS84_B;
  const sl = Math.hypot(sx, sy, sz);
  sx /= sl;
  sy /= sl;
  sz /= sl;

  let maxMagnitude = 0;
  for (let i = 0; i < count; i++) {
    const px = positions[i * 3] / WGS84_A;
    const py = positions[i * 3 + 1] / WGS84_A;
    const pz = positions[i * 3 + 2] / WGS84_B;
    let magSq = px * px + py * py + pz * pz;
    let mag = Math.sqrt(magSq);
    const dx = px / mag;
    const dy = py / mag;
    const dz = pz / mag;
    // Points below the ellipsoid are treated as being on it.
    magSq = Math.max(1, magSq);
    mag = Math.max(1, mag);
    const cosAlpha = dx * sx + dy * sy + dz * sz;
    const cx = dy * sz - dz * sy;
    const cy = dz * sx - dx * sz;
    const cz = dx * sy - dy * sx;
    const sinAlpha = Math.hypot(cx, cy, cz);
    const cosBeta = 1 / mag;
    const sinBeta = Math.sqrt(magSq - 1) * cosBeta;
    const denom = cosAlpha * cosBeta - sinAlpha * sinBeta;
    if (denom <= 1e-9) return null;
    maxMagnitude = Math.max(maxMagnitude, 1 / denom);
  }
  return [sx * maxMagnitude, sy * maxMagnitude, sz * maxMagnitude];
}

/**
 * Horizon test in ellipsoid-scaled space (CesiumJS EllipsoidalOccluder):
 * whether an occludee point (from `computeHorizonCullingPoint`) can be seen
 * from a camera. `cameraScaled` is the camera position divided by the radii.
 */
export function isScaledSpacePointVisible(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
): boolean {
  const vh = cx * cx + cy * cy + cz * cz - 1;
  const vtx = px - cx;
  const vty = py - cy;
  const vtz = pz - cz;
  const vtDotVc = -(vtx * cx + vty * cy + vtz * cz);
  // Below the ellipsoid the culling plane passes through the camera.
  const occluded = vh < 0 ? vtDotVc > 0 : vtDotVc > vh && (vtDotVc * vtDotVc) / (vtx * vtx + vty * vty + vtz * vtz) > vh;
  return !occluded;
}
