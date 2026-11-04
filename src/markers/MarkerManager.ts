import { Matrix4, Vector3, type PerspectiveCamera } from 'three';
import { isScaledSpacePointVisible, WGS84_A, WGS84_B } from '../core/geodesy';

export interface MarkerOptions {
  /** World (ECEF) anchor, or a function evaluated every frame (null hides the marker). */
  position: Vector3 | (() => Vector3 | null);
  /** Content; positioned with CSS transforms inside the marker layer. */
  element: HTMLElement;
  /** Point of the element placed on the anchor, as fractions of its size. Default bottom center [0.5, 1]. */
  pivot?: [number, number];
  /** Extra screen offset in CSS pixels (x right, y down). */
  offsetPx?: [number, number];
  /** Hide closer / farther than these camera distances (meters). */
  minDistance?: number;
  maxDistance?: number;
  /** Hide anchors behind the globe's horizon (default true). */
  horizonCulling?: boolean;
  /** Static or computed visibility (e.g. "only while this floor is entered"). */
  visible?: boolean | (() => boolean);
  /** Shrink with distance: scale 1 up to `near`, `minScale` from `far` on. */
  scaleByDistance?: [near: number, far: number, minScale: number];
  /** Stacking order; nearer markers are drawn on top within the same value. */
  zIndex?: number;
  /**
   * Hide this marker when it would overlap a more important one (screen-space
   * collision test). Markers without it are always shown and act as obstacles.
   */
  declutter?: boolean;
  /** Collision priority (higher wins; ties go to the nearer marker). May change per frame. */
  priority?: number | (() => number);
  onClick?: (event: MouseEvent, marker: Marker) => void;
  onDoubleClick?: (event: MouseEvent, marker: Marker) => void;
  userData?: Record<string, unknown>;
}

const _vp = new Matrix4();
const _cam = new Vector3();

/** A DOM element pinned to a point on the globe (ThingJS `CSS2DComponent` / UIAnchor). */
export class Marker {
  readonly element: HTMLElement;
  /** Whether the marker was shown in the last frame. */
  shown = false;
  /** Screen position (CSS px) of the anchor in the last frame. */
  screenX = 0;
  screenY = 0;
  distance = 0;
  private width = -1;
  private height = -1;
  private readonly wrapper: HTMLElement;
  private readonly onClick: (e: MouseEvent) => void;
  private readonly onDoubleClick: (e: MouseEvent) => void;

  constructor(
    readonly options: MarkerOptions,
    private readonly manager: MarkerManager,
  ) {
    this.element = options.element;
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'marker';
    this.wrapper.style.display = 'none';
    this.wrapper.append(this.element);
    this.onClick = (e: MouseEvent) => options.onClick?.(e, this);
    this.onDoubleClick = (e: MouseEvent) => options.onDoubleClick?.(e, this);
    if (options.onClick || options.onDoubleClick) {
      this.wrapper.classList.add('interactive');
      this.wrapper.addEventListener('click', this.onClick);
      this.wrapper.addEventListener('dblclick', this.onDoubleClick);
    }
  }

  get root(): HTMLElement {
    return this.wrapper;
  }

  /** Re-measure the element on the next frame (call after changing its content). */
  invalidateSize(): void {
    this.width = -1;
  }

  remove(): void {
    this.manager.remove(this);
  }

  /** @internal Element size in CSS pixels (measured once, or after `invalidateSize`). */
  measure(): [number, number] {
    if (this.width < 0) {
      const hidden = this.wrapper.style.display === 'none';
      if (hidden) this.wrapper.style.display = '';
      this.width = this.element.offsetWidth;
      this.height = this.element.offsetHeight;
      if (hidden) this.wrapper.style.display = 'none';
    }
    return [this.width, this.height];
  }

  /** @internal Screen rectangle [x0, y0, x1, y1] the element would cover with its anchor at (x, y). */
  rect(x: number, y: number, scale: number): [number, number, number, number] {
    const [w, h] = this.measure();
    const [px, py] = this.options.pivot ?? [0.5, 1];
    const [ox, oy] = this.options.offsetPx ?? [0, 0];
    const ax = x + ox;
    const ay = y + oy;
    return [ax - px * w * scale, ay - py * h * scale, ax + (1 - px) * w * scale, ay + (1 - py) * h * scale];
  }

  /** @internal */
  place(x: number, y: number, scale: number, z: number): void {
    this.measure();
    const [px, py] = this.options.pivot ?? [0.5, 1];
    const [ox, oy] = this.options.offsetPx ?? [0, 0];
    const tx = x - px * this.width + ox;
    const ty = y - py * this.height + oy;
    this.wrapper.style.transformOrigin = `${px * 100}% ${py * 100}%`;
    this.wrapper.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0)${scale !== 1 ? ` scale(${scale.toFixed(3)})` : ''}`;
    this.wrapper.style.zIndex = String(z);
    if (!this.shown) {
      this.wrapper.style.display = '';
      this.shown = true;
    }
  }

  /** @internal */
  hide(): void {
    if (!this.shown) return;
    this.wrapper.style.display = 'none';
    this.shown = false;
  }

  /** @internal */
  detach(): void {
    this.wrapper.removeEventListener('click', this.onClick);
    this.wrapper.removeEventListener('dblclick', this.onDoubleClick);
    this.wrapper.remove();
  }
}

/**
 * Screen-space HTML markers anchored to world positions: top cards (顶牌),
 * info panels and pins. Positions are projected on the CPU in float64 every
 * frame, so markers stay glued to their anchor at any scale; culled when
 * behind the camera, beyond the horizon, outside the viewport or outside
 * their distance range.
 */
export class MarkerManager {
  readonly root: HTMLElement;
  private readonly markers = new Set<Marker>();

  /**
   * @param eventTarget Element that receives wheel events over interactive
   * markers (the canvas), so zooming keeps working with the cursor on a label.
   */
  constructor(container: HTMLElement, eventTarget?: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'marker-layer';
    container.append(this.root);
    if (eventTarget) {
      this.root.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          eventTarget.dispatchEvent(new WheelEvent('wheel', e));
        },
        { passive: false },
      );
    }
    // Right clicks on labels should not open the browser menu over the map.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get count(): number {
    return this.markers.size;
  }

  add(options: MarkerOptions): Marker {
    const marker = new Marker(options, this);
    this.markers.add(marker);
    this.root.append(marker.root);
    return marker;
  }

  remove(marker: Marker): void {
    if (!this.markers.delete(marker)) return;
    marker.detach();
  }

  clear(): void {
    for (const m of [...this.markers]) this.remove(m);
  }

  /** Positions all markers for this frame. */
  update(camera: PerspectiveCamera, width: number, height: number): void {
    if (this.markers.size === 0) return;
    camera.updateMatrixWorld();
    _cam.setFromMatrixPosition(camera.matrixWorld);
    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = _vp.elements;
    const csx = _cam.x / WGS84_A;
    const csy = _cam.y / WGS84_A;
    const csz = _cam.z / WGS84_B;
    const candidates: { m: Marker; scale: number; z: number; priority: number }[] = [];
    for (const m of this.markers) {
      const o = m.options;
      const visible = typeof o.visible === 'function' ? o.visible() : o.visible !== false;
      const p = visible ? (typeof o.position === 'function' ? o.position() : o.position) : null;
      if (!p) {
        m.hide();
        continue;
      }
      const dist = p.distanceTo(_cam);
      if ((o.maxDistance !== undefined && dist > o.maxDistance) || (o.minDistance !== undefined && dist < o.minDistance)) {
        m.hide();
        continue;
      }
      if (o.horizonCulling !== false && !isScaledSpacePointVisible(p.x / WGS84_A, p.y / WGS84_A, p.z / WGS84_B, csx, csy, csz)) {
        m.hide();
        continue;
      }
      const w = e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15];
      if (w <= 0) {
        m.hide();
        continue;
      }
      const nx = (e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12]) / w;
      const ny = (e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13]) / w;
      if (nx < -1.2 || nx > 1.2 || ny < -1.2 || ny > 1.2) {
        m.hide();
        continue;
      }
      let scale = 1;
      if (o.scaleByDistance) {
        const [near, far, minScale] = o.scaleByDistance;
        const t = Math.min(1, Math.max(0, (dist - near) / Math.max(1e-6, far - near)));
        scale = 1 + (minScale - 1) * t;
      }
      m.screenX = (nx + 1) * 0.5 * width;
      m.screenY = (1 - ny) * 0.5 * height;
      m.distance = dist;
      // Nearer markers on top: z-index band per option, ordered by distance inside it.
      const z = (o.zIndex ?? 0) * 100_000 + Math.max(0, 99_999 - Math.round(Math.log2(1 + dist) * 3000));
      const priority = typeof o.priority === 'function' ? o.priority() : (o.priority ?? 0);
      candidates.push({ m, scale, z, priority });
    }

    // Obstacles (non-decluttered) first, then by priority, then nearest first; a decluttered
    // marker is hidden when its box overlaps one already placed.
    candidates.sort(
      (a, b) =>
        Number(a.m.options.declutter === true) - Number(b.m.options.declutter === true) ||
        b.priority - a.priority ||
        a.m.distance - b.m.distance,
    );
    const placed: [number, number, number, number][] = [];
    for (const c of candidates) {
      const r = c.m.rect(c.m.screenX, c.m.screenY, c.scale);
      if (c.m.options.declutter && placed.some((p) => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1])) {
        c.m.hide();
        continue;
      }
      placed.push([r[0] - 2, r[1] - 2, r[2] + 2, r[3] + 2]);
      c.m.place(c.m.screenX, c.m.screenY, c.scale, c.z);
    }
  }

  dispose(): void {
    this.clear();
    this.root.remove();
  }
}
