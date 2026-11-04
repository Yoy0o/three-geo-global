import { PerspectiveCamera, Quaternion, Ray, Vector2, Vector3 } from 'three';
import { cartographic, type Ellipsoid } from '../core/Ellipsoid';
import { EventEmitter } from '../core/EventEmitter';
import { clamp, DEG2RAD } from '../core/math';
import { CameraFlight, type FlightTarget } from './CameraFlight';
import {
  getHeadingPitch,
  intersectSphere,
  orbitAround,
  orientationFromHeadingPitch,
  rayFromNdc,
  rotateCameraAboutCenter,
  zoomTowards,
} from './cameraMath';

export interface ControllerHost {
  readonly camera: PerspectiveCamera;
  readonly ellipsoid: Ellipsoid;
  readonly domElement: HTMLElement;
  /** World position of the surface (globe, 3D Tiles or scene objects) under a point in NDC, or null. */
  pick(ndc: Vector2): Vector3 | null;
  /**
   * Ground height in meters for collision, or null while it is unknown or only
   * a coarse estimate (the camera is then not pushed up).
   */
  groundHeight(longitude: number, latitude: number): number | null;
}

export interface ControllerEvents extends Record<string, unknown> {
  /** A user gesture (drag, wheel, key, touch) started; animations were cancelled. */
  interactionstart: void;
  /** The camera moved this frame. */
  change: void;
}

export interface AutoOrbitOptions {
  /** Point to orbit around (defaults to the surface point at the screen center). */
  pivot?: Vector3;
  /** Heading change per second in degrees (positive turns clockwise as seen from above). */
  degreesPerSecond?: number;
  /** Stop after turning this many degrees (default: keep orbiting until interrupted). */
  totalDegrees?: number;
}

type DragMode = 'none' | 'pan' | 'orbit' | 'look' | 'touch';

interface Sample {
  time: number;
  axis: Vector3;
  angle: number;
}

interface OrbitAnimation {
  pivot: Vector3;
  /** Total heading change (radians), Infinity for an endless orbit. */
  total: number;
  applied: number;
  /** Eased animation duration; 0 for constant speed. */
  duration: number;
  speed: number;
  elapsed: number;
  done?: () => void;
}

const _ray = new Ray();
const _q = new Quaternion();
const _v = new Vector3();
const _w = new Vector3();
const _up = new Vector3();
const _axis = new Vector3();
const _prevPos = new Vector3();
const _prevQ = new Quaternion();
const _ndc = new Vector2();
const _carto = cartographic();
const CENTER = new Vector2(0, 0);

/**
 * Globe navigation (Google Earth / Mapbox style):
 * - left drag: grab and spin the globe (the point under the cursor stays under it)
 * - wheel / pinch: zoom towards the cursor, keeping heading and pitch
 * - right / middle drag, or Ctrl/Shift + left drag: horizontal = heading,
 *   vertical = pitch, orbiting the point at the screen center
 * - double click: fly closer to a point (can be overridden by `doubleClickHandler`)
 * - WASD / arrows: move, Q/E rotate, R/F tilt
 *
 * Invariants: the camera never rolls (the horizon stays level), heading is
 * continuous through the nadir, and gestures never swing the camera over the
 * top of the orbit pivot. See docs/agents/camera-controller.md.
 */
export class GlobeCameraController {
  enabled = true;
  /** Left drag grabs and spins the globe. */
  enablePan = true;
  /** Right drag (horizontal) changes the heading. */
  enableRotate = true;
  /** Right drag (vertical) changes the pitch. */
  enableTilt = true;
  enableZoom = true;
  enableKeyboard = true;
  inertia = true;
  zoomSpeed = 1;
  rotateSpeed = 1;
  /** Pivot for right-drag orbiting: the surface point at the screen center or under the cursor. */
  orbitPivot: 'center' | 'cursor' = 'center';
  /**
   * Allowed pitch for orbit / tilt gestures in degrees, [most top-down, closest to level].
   * Like ThingJS `camera.vertAngleLimit`, expressed as camera pitch (negative looks down).
   */
  pitchRangeDeg: [number, number] = [-90, -2];
  /** Minimum camera height above the ground (meters). */
  minimumAltitude = 1.5;
  /** Maximum distance from the earth's center (meters). */
  maximumDistance = 6e7;
  /**
   * Called on double click before the default "fly closer" behavior; return
   * true to consume the event (e.g. to enter a building level).
   */
  doubleClickHandler: ((event: MouseEvent) => boolean) | null = null;
  readonly events = new EventEmitter<ControllerEvents>();

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
  private readonly zoomNdc = new Vector2();
  private readonly zoomClient = new Vector2();
  private zoomAnchored = true;
  private hasZoomTarget = false;
  private lastWheelTime = 0;

  private touchStart = { dist: 0, angle: 0, midY: 0 };
  private readonly keys = new Set<string>();
  private flight: CameraFlight | null = null;
  private orbitAnim: OrbitAnimation | null = null;
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

  /** True while the user is dragging or touching. */
  get isInteracting(): boolean {
    return this.mode !== 'none';
  }

  get isAutoOrbiting(): boolean {
    return this.orbitAnim !== null && this.orbitAnim.total === Infinity;
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
  rotateHeadingAround(pivot: Vector3, deltaHeading: number, duration = 0.7): Promise<void> {
    this.cancelMotion();
    return new Promise((resolve) => {
      this.orbitAnim = { pivot: pivot.clone(), total: deltaHeading, applied: 0, duration, speed: 0, elapsed: 0, done: resolve };
    });
  }

  /**
   * Orbits around a point at constant speed (ThingJS `camera.rotateAround` /
   * `earthFlyRotateBySpeed`). Any user input stops it.
   */
  startAutoOrbit(options: AutoOrbitOptions = {}): Promise<void> {
    this.cancelMotion();
    const pivot = options.pivot?.clone() ?? this.host.pick(CENTER);
    if (!pivot) return Promise.resolve();
    const speed = (options.degreesPerSecond ?? 12) * DEG2RAD;
    const total = options.totalDegrees !== undefined ? Math.abs(options.totalDegrees) * DEG2RAD * Math.sign(speed || 1) : Infinity;
    return new Promise((resolve) => {
      this.orbitAnim = { pivot, total, applied: 0, duration: 0, speed, elapsed: 0, done: resolve };
    });
  }

  /**
   * Moves the camera (or, while flying, the flight's destination) by a world
   * offset: keeps the view on something that moved, such as a building that
   * was lifted onto the terrain.
   */
  translate(delta: Vector3): void {
    if (this.flight && this.flightTarget) {
      this.flight.endOffset.add(delta);
      this.flightTarget.position.add(delta);
    } else {
      this.camera.position.add(delta);
      this.orbitAnim?.pivot.add(delta);
    }
    this.markChanged();
  }

  stopAutoOrbit(): void {
    if (!this.orbitAnim) return;
    const done = this.orbitAnim.done;
    this.orbitAnim = null;
    done?.();
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
      this.markChanged();
      if (!running) {
        const t = this.flightTarget!;
        this.camera.position.copy(t.position);
        orientationFromHeadingPitch(this.ellipsoid, t.position, t.heading, t.pitch, this.camera.quaternion);
        this.cancelFlight();
      }
      return;
    }

    if (this.orbitAnim) this.updateOrbitAnimation(dt);

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

  private updateOrbitAnimation(dt: number): void {
    const a = this.orbitAnim!;
    a.elapsed += dt;
    let target: number;
    let finished = false;
    if (a.duration > 0) {
      const t = Math.min(1, a.elapsed / a.duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      target = a.total * eased;
      finished = t >= 1;
    } else {
      target = a.speed * a.elapsed;
      if (Math.abs(target) >= Math.abs(a.total)) {
        target = a.total;
        finished = true;
      }
    }
    this.orbit(a.pivot, target - a.applied, 0);
    a.applied = target;
    if (finished) {
      this.orbitAnim = null;
      a.done?.();
    }
  }

  private markChanged(): void {
    this.changed = true;
    this.events.emit('change', undefined);
  }

  // ---------------------------------------------------------------------------
  // Pointer handling

  private ndc(clientX: number, clientY: number, out = new Vector2()): Vector2 {
    const rect = this.dom.getBoundingClientRect();
    return out.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  private cancelMotion(): void {
    this.cancelFlight();
    this.stopAutoOrbit();
    this.spinVelocity = 0;
    this.zoomPending = 0;
  }

  private beginInteraction(): void {
    this.cancelMotion();
    this.events.emit('interactionstart', undefined);
  }

  private readonly onContextMenu = (e: Event) => e.preventDefault();

  private readonly onPointerDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    try {
      this.dom.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already released pointers cannot be captured; dragging still works.
    }
    this.pointers.set(e.pointerId, new Vector2(e.clientX, e.clientY));
    this.beginInteraction();
    this.dom.focus?.();

    if (e.pointerType === 'touch' && this.pointers.size >= 2) {
      this.beginTouchGesture();
      return;
    }
    this.last.set(e.clientX, e.clientY);
    const ndc = this.ndc(e.clientX, e.clientY);
    const orbit = e.button === 1 || e.button === 2 || e.ctrlKey || e.shiftKey || e.metaKey;
    if (orbit) {
      if (!this.enableRotate && !this.enableTilt) return;
      this.pivot = this.pickPivot(ndc);
      this.mode = this.pivot ? 'orbit' : 'look';
    } else if (this.enablePan) {
      this.beginPan(ndc);
    }
  };

  private pickPivot(ndc: Vector2): Vector3 | null {
    if (this.orbitPivot === 'center') return this.host.pick(CENTER) ?? this.host.pick(ndc);
    return this.host.pick(ndc) ?? this.host.pick(CENTER);
  }

  private beginPan(ndc: Vector2): void {
    const hit = this.host.pick(ndc);
    if (hit) {
      this.grab.copy(hit);
    } else {
      // Missed the globe: grab the closest point of the ray, lifted onto a sphere.
      rayFromNdc(this.camera, ndc, _ray);
      _ray.closestPointToPoint(_v.set(0, 0, 0), this.grab);
      if (this.grab.lengthSq() < 1) return;
      this.grab.setLength(Math.max(this.grab.length(), this.ellipsoid.minimumRadius));
    }
    this.dragRadius = this.grab.length();
    this.samples = [];
    this.mode = 'pan';
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

    if (this.mode === 'pan') {
      this.dragTo(this.ndc(e.clientX, e.clientY));
    } else if (this.mode === 'orbit' && this.pivot) {
      const w = this.dom.clientWidth || 1;
      const h = this.dom.clientHeight || 1;
      const dHeading = this.enableRotate ? (dx / w) * Math.PI * this.rotateSpeed : 0;
      // Dragging up tilts towards the horizon (Mapbox convention).
      const dTilt = this.enableTilt ? (dy / h) * Math.PI * 0.6 * this.rotateSpeed : 0;
      this.orbit(this.pivot, dHeading, dTilt);
    } else if (this.mode === 'look') {
      this.look(dx, dy);
    }
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);

    if (this.mode === 'pan' && this.inertia) this.startInertia();
    if (this.mode === 'touch' && this.pointers.size === 1) {
      // Continue as a one-finger pan with the remaining pointer.
      const [remaining] = this.pointers.values();
      this.last.copy(remaining);
      if (this.enablePan) this.beginPan(this.ndc(remaining.x, remaining.y));
      else this.mode = 'none';
      return;
    }
    if (this.pointers.size === 0) {
      this.mode = 'none';
      this.pivot = null;
    }
  };

  private dragTo(ndc: Vector2): void {
    rayFromNdc(this.camera, ndc, _ray);
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
    rotateCameraAboutCenter(this.ellipsoid, this.camera.position, this.camera.quaternion, q);
    this.markChanged();
  }

  /** Orbit around `pivot`: heading change in radians, tilt in radians (positive raises the camera). */
  private orbit(pivot: Vector3, dHeading: number, dTilt: number): void {
    const cam = this.camera;
    _prevPos.copy(cam.position);
    _prevQ.copy(cam.quaternion);
    const [minPitch, maxPitch] = this.pitchRangeDeg;
    // Camera pitch is the negative of its elevation above the pivot's horizon.
    const minElevation = Math.max(0.5 * DEG2RAD, -maxPitch * DEG2RAD);
    const maxElevation = Math.min(Math.PI / 2 - 1e-4, -minPitch * DEG2RAD);
    orbitAround(this.ellipsoid, cam.position, cam.quaternion, pivot, dHeading, dTilt, minElevation, maxElevation);
    if (dTilt < 0 && this.altitudeAboveGround() < this.minimumAltitude) {
      // Tilting would push the camera into the ground: keep the previous pose.
      cam.position.copy(_prevPos);
      cam.quaternion.copy(_prevQ);
      if (dHeading !== 0) orbitAround(this.ellipsoid, cam.position, cam.quaternion, pivot, dHeading, 0, minElevation, maxElevation);
    }
    this.markChanged();
  }

  /** Free look: turn the camera in place. */
  private look(dx: number, dy: number): void {
    const hp = getHeadingPitch(this.ellipsoid, this.camera.position, this.camera.quaternion);
    const k = (Math.PI / (this.dom.clientHeight || 1)) * 0.6;
    orientationFromHeadingPitch(
      this.ellipsoid,
      this.camera.position,
      hp.heading - (this.enableRotate ? dx * k : 0),
      clamp(hp.pitch + (this.enableTilt ? dy * k : 0), -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001),
      this.camera.quaternion,
    );
    this.markChanged();
  }

  // ---------------------------------------------------------------------------
  // Zoom

  private readonly onWheel = (e: WheelEvent) => {
    if (!this.enabled || !this.enableZoom) return;
    e.preventDefault();
    this.cancelFlight();
    this.stopAutoOrbit();
    this.spinVelocity = 0;
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= 120;
    delta = clamp(delta, -300, 300);
    const now = performance.now();
    const moved = Math.hypot(e.clientX - this.zoomClient.x, e.clientY - this.zoomClient.y) > 4;
    if (!this.hasZoomTarget || moved || now - this.lastWheelTime > 250) {
      this.zoomClient.set(e.clientX, e.clientY);
      this.setZoomTarget(this.ndc(e.clientX, e.clientY));
    }
    this.lastWheelTime = now;
    this.zoomPending += -delta * 0.0022 * this.zoomSpeed;
  };

  private setZoomTarget(ndc: Vector2): void {
    this.zoomNdc.copy(ndc);
    const hit = this.host.pick(ndc);
    if (hit) {
      this.zoomTarget.copy(hit);
      this.zoomAnchored = true;
    } else {
      // Sky: zoom along the view ray towards a point at the current altitude distance.
      rayFromNdc(this.camera, ndc, _ray);
      const alt = Math.max(this.altitude(), 10);
      _ray.at(alt * 2, this.zoomTarget);
      this.zoomAnchored = false;
    }
    this.hasZoomTarget = true;
  }

  private applyZoom(amount: number): void {
    const cam = this.camera;
    _prevPos.copy(cam.position);
    _prevQ.copy(cam.quaternion);
    zoomTowards(this.ellipsoid, cam, this.zoomTarget, this.zoomNdc, {
      amount,
      minDistance: Math.max(1, this.minimumAltitude),
      anchored: this.zoomAnchored,
    });
    const tooFar = cam.position.length() > this.maximumDistance;
    const tooLow = amount > 0 && this.altitudeAboveGround() < this.minimumAltitude;
    if (tooFar || tooLow) {
      // Hit a limit: stop here instead of being pushed sideways by the limit enforcement.
      cam.position.copy(_prevPos);
      cam.quaternion.copy(_prevQ);
      this.zoomPending = 0;
    }
    this.markChanged();
  }

  private readonly onDoubleClick = (e: MouseEvent) => {
    if (!this.enabled) return;
    if (this.doubleClickHandler?.(e)) return;
    if (!this.enableZoom) return;
    const hit = this.host.pick(this.ndc(e.clientX, e.clientY, _ndc));
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
    if (this.enableZoom && Math.abs(zoom) > 1e-4) this.applyZoom(zoom);
    if (this.pivot) {
      let dAngle = m.angle - s.angle;
      dAngle = Math.atan2(Math.sin(dAngle), Math.cos(dAngle));
      const dy = m.mid.y - s.midY;
      // Twisting the fingers clockwise turns the map with them.
      this.orbit(this.pivot, this.enableRotate ? -dAngle : 0, this.enableTilt ? (dy / (this.dom.clientHeight || 1)) * Math.PI * 0.6 : 0);
    }
    this.touchStart = { dist: m.dist, angle: m.angle, midY: m.mid.y };
  }

  // ---------------------------------------------------------------------------
  // Keyboard

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled || !this.enableKeyboard || isTyping(e)) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      this.keys.add(k);
      if (this.keys.size === 1) this.beginInteraction();
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

    if ((forward || strafe) && this.enablePan) {
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
    if ((turn && this.enableRotate) || (tilt && this.enableTilt)) {
      const hp = getHeadingPitch(this.ellipsoid, cam.position, cam.quaternion);
      orientationFromHeadingPitch(
        this.ellipsoid,
        cam.position,
        hp.heading + (this.enableRotate ? turn * dt * 0.9 : 0),
        clamp(hp.pitch + (this.enableTilt ? tilt * dt * 0.7 : 0), -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001),
        cam.quaternion,
      );
      this.markChanged();
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
    return c.height - (this.host.groundHeight(c.longitude, c.latitude) ?? 0);
  }

  private enforceLimits(): void {
    const cam = this.camera;
    const len = cam.position.length();
    if (len > this.maximumDistance) {
      cam.position.setLength(this.maximumDistance);
      this.markChanged();
    }
    const c = this.ellipsoid.cartesianToCartographic(cam.position, _carto);
    if (!c) return;
    const ground = this.host.groundHeight(c.longitude, c.latitude);
    if (ground !== null && c.height < ground + this.minimumAltitude) {
      this.ellipsoid.cartographicToCartesian(c.longitude, c.latitude, ground + this.minimumAltitude, cam.position);
      this.markChanged();
    }
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
