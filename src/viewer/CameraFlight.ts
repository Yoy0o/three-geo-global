import { Quaternion, Vector3 } from 'three';
import type { Ellipsoid } from '../core/Ellipsoid';
import { angleDelta, clamp, easeInOutCubic, lerp } from '../core/math';
import { getHeadingPitch, orientationFromHeadingPitch } from './cameraMath';

export interface FlightTarget {
  position: Vector3;
  heading: number;
  pitch: number;
}

/**
 * Animated camera transition along a great-circle arc, rising to an altitude
 * proportional to the travel distance (similar to Google Earth / Cesium).
 */
export class CameraFlight {
  readonly duration: number;
  private elapsed = 0;
  private readonly n0 = new Vector3();
  private readonly n1 = new Vector3();
  private readonly angle: number;
  private readonly logH0: number;
  private readonly logH1: number;
  private readonly arc: number;
  private readonly heading0: number;
  private readonly headingDelta: number;
  private readonly pitch0: number;
  private readonly pitch1: number;
  private readonly tmpN = new Vector3();

  constructor(
    private readonly ellipsoid: Ellipsoid,
    fromPosition: Vector3,
    fromQuaternion: Quaternion,
    target: FlightTarget,
    duration?: number,
  ) {
    const c0 = ellipsoid.cartesianToCartographic(fromPosition)!;
    const c1 = ellipsoid.cartesianToCartographic(target.position)!;
    ellipsoid.geodeticSurfaceNormalCartographic(c0.longitude, c0.latitude, this.n0);
    ellipsoid.geodeticSurfaceNormalCartographic(c1.longitude, c1.latitude, this.n1);
    this.angle = Math.acos(clamp(this.n0.dot(this.n1), -1, 1));
    const surfaceDistance = this.angle * ellipsoid.maximumRadius;

    this.logH0 = Math.log(Math.max(c0.height, 1));
    this.logH1 = Math.log(Math.max(c1.height, 1));
    const peak = Math.min(surfaceDistance * 0.4, 2.2e7);
    this.arc = Math.max(0, Math.log(Math.max(peak, 1)) - (this.logH0 + this.logH1) / 2);

    const hp = getHeadingPitch(ellipsoid, fromPosition, fromQuaternion);
    this.heading0 = hp.heading;
    this.pitch0 = hp.pitch;
    this.headingDelta = angleDelta(hp.heading, target.heading);
    this.pitch1 = target.pitch;

    const auto = 1.2 + 0.75 * Math.log10(1 + surfaceDistance / 1000 + Math.abs(this.logH1 - this.logH0) * 2);
    this.duration = duration ?? clamp(auto, 1.2, 5.5);
  }

  /** Advances the flight; returns false once finished. */
  update(dt: number, outPosition: Vector3, outQuaternion: Quaternion): boolean {
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
    const t = this.duration > 0 ? this.elapsed / this.duration : 1;
    const e = easeInOutCubic(t);

    // Great-circle position.
    const n = this.tmpN;
    if (this.angle < 1e-9) {
      n.copy(this.n1);
    } else {
      const s = Math.sin(this.angle);
      n.copy(this.n0)
        .multiplyScalar(Math.sin((1 - e) * this.angle) / s)
        .addScaledVector(this.n1, Math.sin(e * this.angle) / s)
        .normalize();
    }
    const lon = Math.atan2(n.y, n.x);
    const lat = Math.asin(clamp(n.z, -1, 1));
    const bump = Math.sin(Math.PI * t);
    const height = Math.exp(lerp(this.logH0, this.logH1, e) + this.arc * bump);
    this.ellipsoid.cartographicToCartesian(lon, lat, height, outPosition);

    // Look down while high up in the arc.
    const lookDown = Math.min(1, this.arc / 2) * bump;
    const pitch = lerp(lerp(this.pitch0, this.pitch1, e), -Math.PI / 2 + 0.001, lookDown);
    const heading = this.heading0 + this.headingDelta * e;
    orientationFromHeadingPitch(this.ellipsoid, outPosition, heading, pitch, outQuaternion);
    return t < 1;
  }
}
