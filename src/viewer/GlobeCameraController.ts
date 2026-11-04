import { PerspectiveCamera, Quaternion, Ray, Vector2, Vector3 } from 'three';
import { cartographic, type Ellipsoid } from '../core/Ellipsoid';
import { clamp } from '../core/math';
import { CameraFlight, type FlightTarget } from './CameraFlight';
import { getHeadingPitch, levelOrientation, orientationFromHeadingPitch } from './cameraMath';

export interface ControllerHost {
  readonly camera: PerspectiveCamera;
  readonly ellipsoid: Ellipsoid;
  readonly domElement: HTMLElement;
  /** World position of the surface (globe or 3D Tiles) under a point in NDC, or null. */
  pick(ndc: Vector2): Vector3 | null;
  /** Ground height in meters at a position, 0 when unknown. */
  groundHeight(longitude: number, latitude: number): number;
}

type DragMode = 'none' | 'rotate' | 'orbit' | 'look' | 'touch';

interface Sample {
  time: number;
  axis: Vector3;
  angle: number;
}

const _ray = new Ray();
const _q = new Quaternion();
const _v = new Vector3();
const _w = new Vector3();
const _up = new Vector3();
const _axis = new Vector3();
const _carto = cartographic();

/**
 * Google-Earth-style globe navigation:
 * - left drag: grab and spin the globe (point under the cursor stays under it)
 * - wheel / pinch: zoom towards the cursor
 * - right / middle drag, or Ctrl/Shift + left drag: orbit (heading + tilt) around the point under the cursor
 * - double click: fly closer to a point
 * - WASD / arrows: move, Q/E rotate, R/F tilt
 */
export class GlobeCameraController {
  enabled = true;
  inertia = true;
  zoomSpeed = 1;
  rotateSpeed = 1;
  /** Minimum camera height above the ground (meters). */
  minimumAltitude = 1.5;
  /** Maximum distance from the earth's center (meters). */
  maximumDistance = 6e7;

  private readonly camera: PerspectiveCamera;
  private readonly ellipsoid: Ellipsoid;
  private readonly dom: HTMLElement;

  private mode: DragMode = 'none';
  private readonly pointers = new Map<number, Vector2>();
  private readonly grab = new Vector3();
  private dragRadius = 0;
  private pivot: Vector3 | null = null;
  private readonly last = new Vector2();
  private samples: Sample[] = [];
  private readonly spinAxis = new Vector3();
  private spinVelocity = 0;

  private zoomPending = 0;
  private readonly zoomTarget = new Vector3();
  private hasZoomTarget = false;
  private lastWheelTime = 0;

  private touchStart = { dist: 0, angle: 0, midY: 0 };
  private readonly keys = new Set<string>();
  private flight: CameraFlight | null = null;
  private orbitAnim: { pivot: Vector3; total: number; applied: number; duration: number; elapsed: number } | null = null;
  private flightTarget: FlightTarget | null = null;
  private flightDone: (() => void) | null = null;
  private changed = true;

  constructor(private readonly host: ControllerHost) {
    this.camera = host.camera;
    this.ellipsoid = host.ellipsoid;
    this.dom = host.domElement;
    this.dom.style.touchAction = 'none';
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    this.dom.addEventListener('pointermove', this.onPointerMove);
    this.dom.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('pointercancel', this.onPointerUp);
    this.dom.addEventListener('wheel', this.onWheel, { passive: false });
    this.dom.addEventListener('dblclick', this.onDoubleClick);
    this.dom.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('pointercancel', this.onPointerUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('dblclick', this.onDoubleClick);
    this.dom.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  get isFlying(): boolean {
    return this.flight !== null;
  }

  /** True when the camera moved since the last call (used for render-on-demand). */
  consumeChanged(): boolean {
    const c = this.changed;
    this.changed = false;
    return c;
  }

  // ---------------------------------------------------------------------------
  // Public camera API

  setView(position: Vector3, heading: number, pitch: number): void {
    this.cancelMotion();
    this.camera.position.copy(position);
    orientationFromHeadingPitch(this.ellipsoid, position, heading, pitch, this.camera.quaternion);
    this.changed = true;
  }

  flyTo(target: FlightTarget, duration?: number): Promise<void> {
    this.cancelMotion();
    this.flight = new CameraFlight(this.ellipsoid, this.camera.position, this.camera.quaternion, target, duration);
    this.flightTarget = { position: target.position.clone(), heading: target.heading, pitch: target.pitch };
    return new Promise((resolve) => {
      this.flightDone = resolve;
    });
  }

  /**
   * Animates a heading change of `deltaHeading` radians while orbiting around
   * `pivot` (keeps the pivot fixed on screen).
   */
  rotateHeadingAround(pivot: Vector3, deltaHeading: number, duration = 0.7): void {
    this.cancelMotion();
    // Orbiting by +a about the local up turns the camera heading by -a.
    this.orbitAnim = { pivot: pivot.clone(), total: -deltaHeading, applied: 0, duration, elapsed: 0 };
  }

  cancelFlight(): void {
    if (!this.flight) return;
    this.flight = null;
    this.flightTarget = null;
    const done = this.flightDone;
    this.flightDone = null;
    done?.();
  }

  // ---------------------------------------------------------------------------
  // Per-frame update

  update(dt: number): void {
    dt = Math.min(dt, 0.1);
    if (this.flight) {
      const running = this.flight.update(dt, this.camera.position, this.camera.quaternion);
      this.changed = true;
      if (!running) {
        const t = this.flightTarget!;
        this.camera.position.copy(t.position);
        orientationFromHeadingPitch(this.ellipsoid, t.position, t.heading, t.pitch, this.camera.quaternion);
        this.cancelFlight();
      }
      return;
    }

    if (this.orbitAnim) {
      const a = this.orbitAnim;
      a.elapsed = Math.min(a.duration, a.elapsed + dt);
      const t = a.elapsed / a.duration;
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const target = a.total * eased;
      this.orbit(a.pivot, target - a.applied, 0);
      a.applied = target;
      if (t >= 1) this.orbitAnim = null;
      return;
    }

    if (Math.abs(this.zoomPending) > 1e-5) {
      const step = this.zoomPending * (1 - Math.exp(-dt * 14));
      this.zoomPending -= step;
      this.applyZoom(step);
    } else {
      this.zoomPending = 0;
    }

    if (this.spinVelocity > 1e-5 && this.mode === 'none') {
      _q.setFromAxisAngle(this.spinAxis, this.spinVelocity * dt);
      this.rotateAboutCenter(_q);
      this.spinVelocity *= Math.exp(-dt * 3.5);
    }

    if (this.keys.size > 0) this.applyKeyboard(dt);
    this.enforceLimits();
  }

  // ---------------------------------------------------------------------------
  // Pointer handling

  private ndc(clientX: number, clientY: number, out = new Vector2()): Vector2 {
    const rect = this.dom.getBoundingClientRect();
    return out.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  private rayFromNdc(ndc: Vector2, out: Ray): Ray {
    this.camera.updateMatrixWorld();
    out.origin.setFromMatrixPosition(this.camera.matrixWorld);
    out.direction.set(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(out.origin).normalize();
    return out;
  }

  private cancelMotion(): void {
    this.cancelFlight();
    this.orbitAnim = null;
    this.spinVelocity = 0;
    this.zoomPending = 0;
  }

  private readonly onContextMenu = (e: Event) => e.preventDefault();

  private readonly onPointerDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.dom.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, new Vector2(e.clientX, e.clientY));
    this.cancelMotion();
    this.dom.focus?.();

    if (e.pointerType === 'touch' && this.pointers.size >= 2) {
      this.beginTouchGesture();
      return;
    }
    this.last.set(e.clientX, e.clientY);
    const ndc = this.ndc(e.clientX, e.clientY);
    const orbit = e.button === 1 || e.button === 2 || e.ctrlKey || e.shiftKey || e.metaKey;
    if (orbit) {
      this.pivot = this.host.pick(ndc) ?? this.host.pick(new Vector2(0, 0));
      this.mode = this.pivot ? 'orbit' : 'look';
    } else {
      this.beginRotate(ndc);
    }
  };

  private beginRotate(ndc: Vector2): void {
    const hit = this.host.pick(ndc);
    if (hit) {
      this.grab.copy(hit);
    } else {
      // Missed the globe: grab the closest point of the ray, lifted onto a sphere.
      this.rayFromNdc(ndc, _ray);
      _ray.closestPointToPoint(_v.set(0, 0, 0), this.grab);
      if (this.grab.lengthSq() < 1) return;
      this.grab.setLength(Math.max(this.grab.length(), this.ellipsoid.minimumRadius));
    }
    this.dragRadius = this.grab.length();
    this.samples = [];
    this.mode = 'rotate';
  }

  private readonly onPointerMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.enabled) return;
    p.set(e.clientX, e.clientY);

    if (this.mode === 'touch') {
      this.updateTouchGesture();
      return;
    }
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.last.set(e.clientX, e.clientY);
    if (dx === 0 && dy === 0) return;

    if (this.mode === 'rotate') {
      this.dragTo(this.ndc(e.clientX, e.clientY));
    } else if (this.mode === 'orbit' && this.pivot) {
      const w = this.dom.clientWidth || 1;
      const h = this.dom.clientHeight || 1;
      this.orbit(this.pivot, (-dx / w) * Math.PI * this.rotateSpeed, (dy / h) * Math.PI * 0.6 * this.rotateSpeed);
    } else if (this.mode === 'look') {
      this.look(dx, dy);
    }
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);

    if (this.mode === 'rotate' && this.inertia) this.startInertia();
    if (this.mode === 'touch' && this.pointers.size === 1) {
      // Continue as a one-finger rotate with the remaining pointer.
      const [remaining] = this.pointers.values();
      this.last.copy(remaining);
      this.beginRotate(this.ndc(remaining.x, remaining.y));
      return;
    }
    if (this.pointers.size === 0) {
      this.mode = 'none';
      this.pivot = null;
    }
  };

  private dragTo(ndc: Vector2): void {
    this.rayFromNdc(ndc, _ray);
    const target = _v;
    const t = intersectSphere(_ray, this.dragRadius);
    if (t !== null) {
      _ray.at(t, target);
    } else {
      _ray.closestPointToPoint(_w.set(0, 0, 0), target);
      if (target.lengthSq() < 1) return;
      target.setLength(this.dragRadius);
    }
    const from = _w.copy(target).normalize();
    const to = _up.copy(this.grab).normalize();
    _q.setFromUnitVectors(from, to);
    const angle = 2 * Math.acos(clamp(Math.abs(_q.w), -1, 1));
    if (angle < 1e-12) return;
    this.rotateAboutCenter(_q);

    _axis.set(_q.x, _q.y, _q.z);
    if (_axis.lengthSq() > 0) {
      _axis.normalize();
      if (_q.w < 0) _axis.negate();
      this.samples.push({ time: performance.now(), axis: _axis.clone(), angle });
      if (this.samples.length > 8) this.samples.shift();
    }
  }

  private startInertia(): void {
    const now = performance.now();
    const recent = this.samples.filter((s) => now - s.time < 90);
    if (recent.length < 2) return;
    const span = Math.max(16, now - recent[0].time);
    const axis = new Vector3();
    let total = 0;
    for (const s of recent) {
      axis.addScaledVector(s.axis, s.angle);
      total += s.angle;
    }
    if (axis.lengthSq() === 0 || total === 0) return;
    this.spinAxis.copy(axis).normalize();
    this.spinVelocity = Math.min(total / (span / 1000), 3);
  }

  private rotateAboutCenter(q: Quaternion): void {
    this.camera.position.applyQuaternion(q);
    this.camera.quaternion.premultiply(q);
    levelOrientation(this.ellipsoid, this.camera.position, this.camera.quaternion);
    this.changed = true;
  }

  /** Orbit around `pivot`: heading about its local up, tilt in the vertical plane. */
  private orbit(pivot: Vector3, dHeading: number, dTilt: number): void {
    const cam = this.camera;
    this.ellipsoid.geodeticSurfaceNormal(pivot, _up);

    _q.setFromAxisAngle(_up, dHeading);
    rotateAroundPoint(cam.position, cam.quaternion, pivot, _q);

    const offset = _v.subVectors(cam.position, pivot);
    const range = offset.length();
    if (range > 1e-6) {
      const elevation = Math.asin(clamp(offset.dot(_up) / range, -1, 1));
      const target = clamp(elevation + dTilt, 0.035, Math.PI / 2 - 0.0005);
      _axis.crossVectors(_up, offset);
      if (_axis.lengthSq() < 1e-12) _axis.set(1, 0, 0).applyQuaternion(cam.quaternion);
      _axis.normalize();
      _q.setFromAxisAngle(_axis, -(target - elevation));
      const savedPos = cam.position.clone();
      const savedQ = cam.quaternion.clone();
      rotateAroundPoint(cam.position, cam.quaternion, pivot, _q);
      if (this.altitudeAboveGround() < this.minimumAltitude) {
        cam.position.copy(savedPos);
        cam.quaternion.copy(savedQ);
      }
    }
    levelOrientation(this.ellipsoid, cam.position, cam.quaternion);
    this.changed = true;
  }

  /** Free look: turn the camera in place. */
  private look(dx: number, dy: number): void {
    const hp = getHeadingPitch(this.ellipsoid, this.camera.position, this.camera.quaternion);
    const k = (Math.PI / (this.dom.clientHeight || 1)) * 0.6;
    orientationFromHeadingPitch(
      this.ellipsoid,
      this.camera.position,
      hp.heading - dx * k,
      clamp(hp.pitch + dy * k, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001),
      this.camera.quaternion,
    );
    this.changed = true;
  }

  // ---------------------------------------------------------------------------
  // Zoom

  private readonly onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.cancelFlight();
    this.spinVelocity = 0;
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= 120;
    delta = clamp(delta, -300, 300);
    const now = performance.now();
    if (!this.hasZoomTarget || now - this.lastWheelTime > 250) this.setZoomTarget(this.ndc(e.clientX, e.clientY));
    this.lastWheelTime = now;
    this.zoomPending += -delta * 0.0022 * this.zoomSpeed;
  };

  private setZoomTarget(ndc: Vector2): void {
    const hit = this.host.pick(ndc);
    if (hit) {
      this.zoomTarget.copy(hit);
    } else {
      // Sky: zoom along the view ray towards a point at the current altitude distance.
      this.rayFromNdc(ndc, _ray);
      const alt = Math.max(this.altitude(), 10);
      _ray.at(alt * 2, this.zoomTarget);
    }
    this.hasZoomTarget = true;
  }

  private applyZoom(amount: number): void {
    const cam = this.camera;
    const toTarget = _v.subVectors(this.zoomTarget, cam.position);
    const dist = toTarget.length();
    if (dist < 1e-6) return;
    let newDist = dist * Math.exp(-amount);
    newDist = Math.max(newDist, 1);
    const prev = _w.copy(cam.position);
    cam.position.copy(this.zoomTarget).addScaledVector(toTarget.normalize(), -newDist);
    if (cam.position.length() > this.maximumDistance) cam.position.copy(prev);
    if (amount > 0 && this.altitudeAboveGround() < this.minimumAltitude) {
      // Hit the ground: stop the zoom here.
      this.zoomPending = 0;
    }
    levelOrientation(this.ellipsoid, cam.position, cam.quaternion);
    this.changed = true;
  }

  private readonly onDoubleClick = (e: MouseEvent) => {
    if (!this.enabled) return;
    const hit = this.host.pick(this.ndc(e.clientX, e.clientY));
    if (!hit) return;
    const hp = getHeadingPitch(this.ellipsoid, this.camera.position, this.camera.quaternion);
    const range = this.camera.position.distanceTo(hit) * 0.35;
    const dir = new Vector3().subVectors(hit, this.camera.position).normalize();
    const position = hit.clone().addScaledVector(dir, -range);
    void this.flyTo({ position, heading: hp.heading, pitch: Math.min(hp.pitch, -0.2) }, 1.2);
  };

  // ---------------------------------------------------------------------------
  // Touch gestures

  private touchMetrics(): { dist: number; angle: number; mid: Vector2 } {
    const [a, b] = [...this.pointers.values()];
    return {
      dist: Math.max(1, a.distanceTo(b)),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      mid: new Vector2((a.x + b.x) / 2, (a.y + b.y) / 2),
    };
  }

  private beginTouchGesture(): void {
    const m = this.touchMetrics();
    this.mode = 'touch';
    this.touchStart = { dist: m.dist, angle: m.angle, midY: m.mid.y };
    const ndc = this.ndc(m.mid.x, m.mid.y);
    this.pivot = this.host.pick(ndc);
    this.setZoomTarget(ndc);
  }

  private updateTouchGesture(): void {
    if (this.pointers.size < 2) return;
    const m = this.touchMetrics();
    const s = this.touchStart;
    const zoom = Math.log(m.dist / s.dist);
    if (Math.abs(zoom) > 1e-4) this.applyZoom(zoom);
    if (this.pivot) {
      let dAngle = m.angle - s.angle;
      dAngle = Math.atan2(Math.sin(dAngle), Math.cos(dAngle));
      const dy = m.mid.y - s.midY;
      this.orbit(this.pivot, dAngle, (dy / (this.dom.clientHeight || 1)) * Math.PI * 0.6);
    }
    this.touchStart = { dist: m.dist, angle: m.angle, midY: m.mid.y };
  }

  // ---------------------------------------------------------------------------
  // Keyboard

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled || isTyping(e)) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      this.keys.add(k);
      this.cancelMotion();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };

  private readonly onBlur = () => this.keys.clear();

  private applyKeyboard(dt: number): void {
    const k = this.keys;
    const forward = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const strafe = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    const turn = (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0);
    const tilt = (k.has('r') ? 1 : 0) - (k.has('f') ? 1 : 0);
    const cam = this.camera;

    if (forward || strafe) {
      const hp = getHeadingPitch(this.ellipsoid, cam.position, cam.quaternion);
      const speed = Math.max(this.altitudeAboveGround(), 20) * 0.9;
      const dist = speed * dt;
      const radius = cam.position.length();
      // Move along the surface by rotating about the earth's center.
      const e = new Vector3();
      const n = new Vector3();
      const u = new Vector3();
      this.ellipsoid.eastNorthUp(cam.position, e, n, u);
      const dir = new Vector3()
        .addScaledVector(e, Math.sin(hp.heading) * forward + Math.cos(hp.heading) * strafe)
        .addScaledVector(n, Math.cos(hp.heading) * forward - Math.sin(hp.heading) * strafe);
      if (dir.lengthSq() > 0) {
        const axis = new Vector3().crossVectors(u, dir).normalize();
        _q.setFromAxisAngle(axis, dist / radius);
        this.rotateAboutCenter(_q);
      }
    }
    if (turn || tilt) {
      const hp = getHeadingPitch(this.ellipsoid, cam.position, cam.quaternion);
      orientationFromHeadingPitch(
        this.ellipsoid,
        cam.position,
        hp.heading + turn * dt * 0.9,
        clamp(hp.pitch + tilt * dt * 0.7, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001),
        cam.quaternion,
      );
      this.changed = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Limits

  private altitude(): number {
    const c = this.ellipsoid.cartesianToCartographic(this.camera.position, _carto);
    return c ? c.height : this.camera.position.length() - this.ellipsoid.maximumRadius;
  }

  altitudeAboveGround(): number {
    const c = this.ellipsoid.cartesianToCartographic(this.camera.position, _carto);
    if (!c) return 0;
    return c.height - this.host.groundHeight(c.longitude, c.latitude);
  }

  private enforceLimits(): void {
    const cam = this.camera;
    const len = cam.position.length();
    if (len > this.maximumDistance) {
      cam.position.setLength(this.maximumDistance);
      this.changed = true;
    }
    const c = this.ellipsoid.cartesianToCartographic(cam.position, _carto);
    if (!c) return;
    const ground = this.host.groundHeight(c.longitude, c.latitude);
    if (c.height < ground + this.minimumAltitude) {
      this.ellipsoid.cartographicToCartesian(c.longitude, c.latitude, ground + this.minimumAltitude, cam.position);
      this.changed = true;
    }
  }
}

function rotateAroundPoint(position: Vector3, quaternion: Quaternion, pivot: Vector3, q: Quaternion): void {
  position.sub(pivot).applyQuaternion(q).add(pivot);
  quaternion.premultiply(q);
}

/** Nearest positive ray/sphere (centered at origin) intersection distance. */
function intersectSphere(ray: Ray, radius: number): number | null {
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

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
