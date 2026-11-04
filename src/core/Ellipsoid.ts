import { Matrix4, Ray, Vector3 } from 'three';

/** Geodetic position. Angles are in radians, height in meters above the ellipsoid. */
export interface Cartographic {
  longitude: number;
  latitude: number;
  height: number;
}

export function cartographic(longitude = 0, latitude = 0, height = 0): Cartographic {
  return { longitude, latitude, height };
}

const EPSILON12 = 1e-12;

const _n = new Vector3();
const _k = new Vector3();
const _p = new Vector3();
const _h = new Vector3();
const _east = new Vector3();
const _north = new Vector3();
const _up = new Vector3();
const _origin = new Vector3();
const _dir = new Vector3();

/**
 * Ellipsoid of revolution centered at the origin, using the Earth-Centered
 * Earth-Fixed (ECEF) frame: +Z is the north pole, +X crosses lon 0 / lat 0.
 * All math is done in float64 on the CPU; only tile-relative offsets ever
 * reach the GPU.
 */
export class Ellipsoid {
  static readonly WGS84 = new Ellipsoid(6378137.0, 6378137.0, 6356752.314245179);

  readonly radii: Vector3;
  readonly radiiSquared: Vector3;
  readonly oneOverRadii: Vector3;
  readonly oneOverRadiiSquared: Vector3;
  readonly maximumRadius: number;
  readonly minimumRadius: number;
  private readonly centerToleranceSquared = 0.1;

  constructor(x: number, y: number, z: number) {
    this.radii = new Vector3(x, y, z);
    this.radiiSquared = new Vector3(x * x, y * y, z * z);
    this.oneOverRadii = new Vector3(1 / x, 1 / y, 1 / z);
    this.oneOverRadiiSquared = new Vector3(1 / (x * x), 1 / (y * y), 1 / (z * z));
    this.maximumRadius = Math.max(x, y, z);
    this.minimumRadius = Math.min(x, y, z);
  }

  geodeticSurfaceNormal(cartesian: Vector3, result = new Vector3()): Vector3 {
    return result.copy(cartesian).multiply(this.oneOverRadiiSquared).normalize();
  }

  geodeticSurfaceNormalCartographic(longitude: number, latitude: number, result = new Vector3()): Vector3 {
    const cosLat = Math.cos(latitude);
    return result.set(cosLat * Math.cos(longitude), cosLat * Math.sin(longitude), Math.sin(latitude));
  }

  cartographicToCartesian(longitude: number, latitude: number, height: number, result = new Vector3()): Vector3 {
    const n = this.geodeticSurfaceNormalCartographic(longitude, latitude, _n);
    const k = _k.copy(this.radiiSquared).multiply(n);
    const gamma = Math.sqrt(n.dot(k));
    k.divideScalar(gamma);
    n.multiplyScalar(height);
    return result.copy(k).add(n);
  }

  toCartesian(c: Cartographic, result = new Vector3()): Vector3 {
    return this.cartographicToCartesian(c.longitude, c.latitude, c.height, result);
  }

  /** Returns null for points too close to the center to have a defined surface projection. */
  cartesianToCartographic(cartesian: Vector3, result: Cartographic = cartographic()): Cartographic | null {
    const p = this.scaleToGeodeticSurface(cartesian, _p);
    if (!p) return null;
    const n = this.geodeticSurfaceNormal(p, _n);
    const h = _h.subVectors(cartesian, p);
    result.longitude = Math.atan2(n.y, n.x);
    result.latitude = Math.asin(Math.max(-1, Math.min(1, n.z)));
    result.height = Math.sign(h.dot(cartesian)) * h.length();
    return result;
  }

  /**
   * Projects a point onto the ellipsoid surface along the geodetic normal
   * (Newton-Raphson iteration, as in CesiumJS).
   */
  scaleToGeodeticSurface(cartesian: Vector3, result = new Vector3()): Vector3 | null {
    const { x: px, y: py, z: pz } = cartesian;
    const { x: rx, y: ry, z: rz } = this.oneOverRadii;
    const x2 = px * px * rx * rx;
    const y2 = py * py * ry * ry;
    const z2 = pz * pz * rz * rz;
    const squaredNorm = x2 + y2 + z2;
    const ratio = Math.sqrt(1 / squaredNorm);

    const ix = px * ratio;
    const iy = py * ratio;
    const iz = pz * ratio;

    if (squaredNorm < this.centerToleranceSquared) {
      return Number.isFinite(ratio) ? result.set(ix, iy, iz) : null;
    }

    const { x: sx, y: sy, z: sz } = this.oneOverRadiiSquared;
    const gx = ix * sx * 2;
    const gy = iy * sy * 2;
    const gz = iz * sz * 2;

    let lambda = ((1 - ratio) * cartesian.length()) / (0.5 * Math.sqrt(gx * gx + gy * gy + gz * gz));
    let correction = 0;
    let func: number;
    let xm: number;
    let ym: number;
    let zm: number;

    let iterations = 0;
    do {
      lambda -= correction;
      xm = 1 / (1 + lambda * sx);
      ym = 1 / (1 + lambda * sy);
      zm = 1 / (1 + lambda * sz);
      const xm2 = xm * xm;
      const ym2 = ym * ym;
      const zm2 = zm * zm;
      func = x2 * xm2 + y2 * ym2 + z2 * zm2 - 1;
      const denominator = x2 * xm2 * xm * sx + y2 * ym2 * ym * sy + z2 * zm2 * zm * sz;
      correction = func / (-2 * denominator);
    } while (Math.abs(func) > EPSILON12 && ++iterations < 32);

    return result.set(px * xm, py * ym, pz * zm);
  }

  /** Local east-north-up frame at `origin` (columns: east, north, up, origin). */
  eastNorthUpToFixedFrame(origin: Vector3, result = new Matrix4()): Matrix4 {
    this.geodeticSurfaceNormal(origin, _up);
    _east.set(-origin.y, origin.x, 0);
    if (_east.lengthSq() < 1e-20) _east.set(0, 1, 0);
    _east.normalize();
    _north.crossVectors(_up, _east);
    return result.makeBasis(_east, _north, _up).setPosition(origin);
  }

  /** East / north / up unit vectors at an ECEF position. */
  eastNorthUp(position: Vector3, east: Vector3, north: Vector3, up: Vector3): void {
    this.geodeticSurfaceNormal(position, up);
    east.set(-position.y, position.x, 0);
    if (east.lengthSq() < 1e-20) east.set(0, 1, 0);
    east.normalize();
    north.crossVectors(up, east);
  }

  /**
   * Nearest intersection distance of a ray with this ellipsoid (optionally
   * inflated by `height` meters), or null. Rays starting inside return the
   * exit distance.
   */
  intersectRay(ray: Ray, height = 0): number | null {
    const ir = this.oneOverRadii;
    const sx = height === 0 ? ir.x : 1 / (this.radii.x + height);
    const sy = height === 0 ? ir.y : 1 / (this.radii.y + height);
    const sz = height === 0 ? ir.z : 1 / (this.radii.z + height);
    _origin.set(ray.origin.x * sx, ray.origin.y * sy, ray.origin.z * sz);
    _dir.set(ray.direction.x * sx, ray.direction.y * sy, ray.direction.z * sz);
    const a = _dir.dot(_dir);
    const b = 2 * _origin.dot(_dir);
    const c = _origin.dot(_origin) - 1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t0 = (-b - sq) / (2 * a);
    const t1 = (-b + sq) / (2 * a);
    if (t0 > 0) return t0;
    if (t1 > 0) return t1;
    return null;
  }

  /** Great-circle (spherical) distance in meters between two cartographic positions. */
  surfaceDistance(a: Cartographic, b: Cartographic): number {
    const dLat = b.latitude - a.latitude;
    const dLon = b.longitude - a.longitude;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude) * Math.cos(b.latitude) * Math.sin(dLon / 2) ** 2;
    return 2 * this.maximumRadius * Math.asin(Math.min(1, Math.sqrt(s)));
  }
}
