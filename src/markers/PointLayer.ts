/**
 * Point marker layer (点位): loads point data (GeoJSON, record arrays or a
 * `{ points, style, rules }` document, from an object, JSON text or a URL),
 * styles every point from the layer style plus property rules, anchors HTML
 * markers on the terrain (or at the point's own height), and can merge nearby
 * points into cluster markers.
 *
 * Scales to thousands of points (docs/agents/markers.md §5):
 * - Markers (DOM) are created lazily, the first time a point is drawn; points
 *   that are clustered or out of view cost no DOM.
 * - Clustering uses a hierarchy built once per data / style / radius
 *   (`clusterTree.ts`, Supercluster-like; in a Worker for large inputs); each
 *   frame only walks the visible branches. Cluster markers are kept per tree
 *   node and pooled, so panning reuses them unchanged.
 *
 * Parsing and rules are pure functions in `points.ts`; drawing, projection and
 * decluttering are done by `MarkerManager`.
 */
import { Frustum, Matrix4, Vector3, type PerspectiveCamera } from 'three';
import type { Ellipsoid } from '../core/Ellipsoid';
import { EventEmitter } from '../core/EventEmitter';
import { isScaledSpacePointVisible, WGS84_A, WGS84_B } from '../core/geodesy';
import { DEG2RAD } from '../core/math';
import { createCard, createClusterCard, setClusterCount } from './cards';
import { buildClusterTree, ClusterSelector, clusterLeaves, type ClusterTree, type ClusterTreeInput, type ClusterTreeOptions } from './clusterTree';
import type { Marker, MarkerManager } from './MarkerManager';
import { defaultTitle, fillTemplate, parsePoints, pointsBBox, resolvePointStyle, type PointRecord, type PointRule, type PointStyle } from './points';

export interface ClusterOptions {
  /** Points closer than this on screen (CSS pixels) merge. Default 56. */
  radius?: number;
  /** Smallest group drawn as a cluster; smaller groups show their points. Default 3. */
  minPoints?: number;
  /** Finest zoom level that still clusters (web-map zoom, ~0.6 m/px at 18). Default 18. */
  maxZoom?: number;
}

export interface PointLayerOptions {
  name?: string;
  /** Parsed JSON or JSON text (see `parsePoints`). */
  data?: unknown;
  /** Fetched when `data` is not given. */
  url?: string;
  /** Layer defaults; a document's own `style` / `rules` are used when these are omitted. */
  style?: PointStyle;
  rules?: PointRule[];
  cluster?: boolean | ClusterOptions;
  visible?: boolean;
}

export interface PointLayerEvents extends Record<string, unknown> {
  ready: { count: number; skipped: number; warnings: string[]; bbox: [number, number, number, number] | null };
  error: { message: string };
  click: { point: PointRecord; layer: PointLayer; event: MouseEvent };
  clusterclick: { points: PointRecord[]; layer: PointLayer; event: MouseEvent };
}

/** What the layer needs from the viewer. */
export interface PointLayerHost {
  readonly ellipsoid: Ellipsoid;
  readonly markers: MarkerManager;
  /**
   * Terrain height in meters at a position (radians), or null while unknown;
   * with `maxCellSize`, only from terrain at least that detailed (see `Globe.getHeight`).
   */
  groundHeight(longitude: number, latitude: number, maxCellSize?: number): number | null;
  /** Flies to fit [west, south, east, north] in degrees. */
  flyToBBox(bbox: [number, number, number, number]): void;
}

/** Per-frame counters (`layer.stats`). */
export interface PointLayerStats {
  /** Points and cluster markers selected for drawing this frame (before decluttering). */
  points: number;
  clusters: number;
  /** DOM markers created so far (points + cluster pool). */
  elements: number;
  /** Cluster tree nodes (0 while not built). */
  treeNodes: number;
  /** Time to build the cluster tree, ms. */
  buildMs: number;
  /** CPU time of the last `update`, ms. */
  ms: number;
}

interface Entry {
  readonly index: number;
  point: PointRecord;
  style: PointStyle;
  /** Created the first time the point is drawn. */
  marker: Marker | null;
  /** ECEF anchor, updated in place while the terrain under it refines. */
  readonly position: Vector3;
  /** 0 = no ground height yet, 1 = coarse estimate, 2 = detailed terrain (or own height). */
  grounded: 0 | 1 | 2;
  /** Frame stamp of the last selection that drew this point. */
  drawn: number;
}

interface ClusterSlot {
  marker: Marker;
  element: HTMLElement;
  /** Tree node shown by this marker, -1 while pooled. */
  node: number;
  drawn: number;
}

/** Ground clamping: detailed terrain means cells of at most this many meters (same as buildings). */
const GROUND_CELL = 150;
/** Points re-sampled against the terrain per frame (round robin). */
const GROUND_BUDGET = 256;
/** Point markers (DOM) created per frame at most; the rest follow on the next frames. */
const CREATE_BUDGET = 200;
/** Inputs this large build their cluster tree in a Worker. */
const WORKER_THRESHOLD = 10_000;
/** Terrain clamping may still move points by up to this much (m): kept in the tree's bounding spheres. */
const HEIGHT_MARGIN = 9_000;
/** Markers are kept for anchors up to this far outside the viewport (NDC), like `MarkerManager`. */
const NDC_MARGIN = 1.2;

const _vp = new Matrix4();
const _cullVp = new Matrix4();
const _cam = new Vector3();
const _frustum = new Frustum();
const _planes = new Float64Array(24);
let nextId = 1;

export class PointLayer {
  readonly id = `points-${nextId++}`;
  readonly name: string;
  readonly events = new EventEmitter<PointLayerEvents>();
  readonly stats: PointLayerStats = { points: 0, clusters: 0, elements: 0, treeNodes: 0, buildMs: 0, ms: 0 };
  ready = false;
  error: string | null = null;
  /** Points skipped while parsing (not points, invalid coordinates). */
  skipped = 0;
  private styleBase: PointStyle;
  private ruleList: PointRule[];
  private records: PointRecord[] = [];
  private entries: Entry[] = [];
  private readonly byId = new Map<string, Entry>();
  /** Live ECEF anchors (xyz per point), mirrored from `Entry.position` for the cluster tree. */
  private positions = new Float64Array(0);
  private clusterOptions: Required<ClusterOptions> | null;
  private tree: ClusterTree | null = null;
  private selector: ClusterSelector | null = null;
  /** Radius / max zoom the current tree was built for; bumped `treeVersion` drops stale Worker results. */
  private treeKey = '';
  private treeVersion = 0;
  private readonly slots = new Map<number, ClusterSlot>();
  private readonly pool: ClusterSlot[] = [];
  private readonly drawPoints: number[] = [];
  private readonly drawClusters: number[] = [];
  private frame = 1;
  /** Point markers created so far. */
  private markerCount = 0;
  private _visible: boolean;
  private selected: Entry | null = null;
  private groundCursor = 0;
  private readonly lastVp = new Matrix4();
  private dirty = true;
  private disposed = false;

  constructor(
    options: PointLayerOptions,
    private readonly host: PointLayerHost,
  ) {
    this.name = options.name ?? (options.url ? decodeURIComponent(options.url.split('/').pop() ?? '点位') : '点位');
    this.styleBase = { ...options.style };
    this.ruleList = options.rules ?? [];
    this.clusterOptions = normalizeCluster(options.cluster);
    this._visible = options.visible ?? true;
    void this.load(options);
  }

  /** Parsed points (degrees / meters). */
  get points(): readonly PointRecord[] {
    return this.records;
  }

  get count(): number {
    return this.records.length;
  }

  get bbox(): [number, number, number, number] | null {
    return pointsBBox(this.records);
  }

  get style(): PointStyle {
    return this.styleBase;
  }

  get rules(): readonly PointRule[] {
    return this.ruleList;
  }

  get visible(): boolean {
    return this._visible;
  }

  set visible(v: boolean) {
    this._visible = v;
    this.dirty = true;
  }

  get cluster(): Required<ClusterOptions> | null {
    return this.clusterOptions;
  }

  /** Turns clustering on (optionally with options) or off. The tree is rebuilt only if radius / maxZoom change. */
  setCluster(cluster: boolean | ClusterOptions): void {
    this.clusterOptions = normalizeCluster(cluster);
    this.dirty = true;
    if (this.ready) this.ensureTree();
  }

  /** Replaces the layer style (and optionally the rules) and rebuilds the markers. */
  setStyle(style: PointStyle, rules?: PointRule[]): void {
    this.styleBase = { ...style };
    if (rules) this.ruleList = rules;
    if (this.ready) this.build();
  }

  /** Highlights a point (null clears); it wins collisions while selected. */
  select(id: string | null): void {
    const entry = id === null ? null : (this.byId.get(id) ?? null);
    if (entry === this.selected) return;
    this.selected?.marker?.element.classList.remove('selected');
    this.selected = entry;
    entry?.marker?.element.classList.add('selected');
    // The selection wins collisions: re-place now rather than at the next interval.
    this.host.markers.requestPlacement();
  }

  /** World (ECEF) anchor of a point, or null if it is not in this layer. */
  positionOf(id: string): Vector3 | null {
    return this.byId.get(id)?.position ?? null;
  }

  private async load(options: PointLayerOptions): Promise<void> {
    // In-memory data would otherwise load synchronously inside the constructor, before the
    // caller could subscribe to 'ready'.
    await Promise.resolve();
    try {
      let data = options.data;
      if (data === undefined && options.url) {
        const res = await fetch(options.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      } else if (typeof data === 'string') {
        data = JSON.parse(data);
      }
      if (this.disposed) return;
      const parsed = parsePoints(data);
      if (parsed.points.length === 0) throw new Error(parsed.warnings[0] ?? '没有点要素');
      // A document's own defaults apply unless the caller overrides them.
      this.styleBase = { ...parsed.style, ...options.style };
      if (!options.rules && parsed.rules) this.ruleList = parsed.rules;
      this.records = parsed.points;
      this.skipped = parsed.skipped;
      this.build();
      this.ready = true;
      this.events.emit('ready', { count: this.records.length, skipped: parsed.skipped, warnings: parsed.warnings, bbox: this.bbox });
    } catch (err) {
      if (this.disposed) return;
      this.error = err instanceof Error ? err.message : String(err);
      this.events.emit('error', { message: this.error });
    }
  }

  /** (Re)resolves every point's style; markers are created when first drawn. */
  private build(): void {
    const selectedId = this.selected?.point.id ?? null;
    this.removeMarkers();
    const ell = this.host.ellipsoid;
    const n = this.records.length;
    this.positions = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const point = this.records[i];
      const style = resolvePointStyle(point, this.styleBase, this.ruleList);
      const own = point.height !== null;
      const position = ell.cartographicToCartesian(point.longitude * DEG2RAD, point.latitude * DEG2RAD, (point.height ?? 0) + (style.heightOffset ?? 0));
      this.positions[i * 3] = position.x;
      this.positions[i * 3 + 1] = position.y;
      this.positions[i * 3 + 2] = position.z;
      const entry: Entry = { index: i, point, style, marker: null, position, grounded: own ? 2 : 0, drawn: 0 };
      this.entries.push(entry);
      this.byId.set(point.id, entry);
    }
    this.groundCursor = 0;
    this.dirty = true;
    this.treeKey = '';
    this.ensureTree();
    this.select(selectedId);
  }

  /** Builds the cluster tree if clustering is on and the current one does not match the options. */
  private ensureTree(): void {
    const opts = this.clusterOptions;
    if (!opts) return;
    const key = `${opts.radius}|${opts.maxZoom}`;
    if (key === this.treeKey) return;
    this.treeKey = key;
    this.tree = null;
    this.selector = null;
    this.stats.treeNodes = 0;
    const version = ++this.treeVersion;
    const n = this.entries.length;
    const priorities = new Float64Array(n);
    const minDistances = new Float64Array(n);
    const maxDistances = new Float64Array(n);
    for (const e of this.entries) {
      priorities[e.index] = e.style.priority ?? 0;
      minDistances[e.index] = e.style.minDistance ?? 0;
      maxDistances[e.index] = e.style.maxDistance ?? Infinity;
    }
    const input: ClusterTreeInput = { positions: this.positions.slice(), priorities, minDistances, maxDistances, heightMargin: HEIGHT_MARGIN };
    const options: ClusterTreeOptions = { radius: opts.radius, maxZoom: opts.maxZoom };
    const t0 = performance.now();
    const done = (tree: ClusterTree) => {
      if (this.disposed || version !== this.treeVersion) return;
      this.tree = tree;
      this.selector = new ClusterSelector(tree);
      this.stats.treeNodes = tree.nodeCount;
      this.stats.buildMs = performance.now() - t0;
      this.dirty = true;
    };
    if (n >= WORKER_THRESHOLD && typeof Worker !== 'undefined') {
      // The positions buffer is transferred; a fallback build uses a fresh copy.
      buildInWorker(input, options).then(done, () => done(buildClusterTree({ ...input, positions: this.positions.slice() }, options)));
    } else {
      done(buildClusterTree(input, options));
    }
  }

  /** Per frame, before `MarkerManager.update`: ground clamping, then the points / clusters to draw. */
  update(camera: PerspectiveCamera, _width: number, height: number): void {
    if (!this.ready || this.entries.length === 0) return;
    const t0 = performance.now();
    // Markers read `Entry.position` every frame; terrain clamping does not change what is drawn.
    this.clampToGround();
    camera.updateMatrixWorld();
    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!this.dirty && _vp.equals(this.lastVp)) return;
    this.lastVp.copy(_vp);
    this.dirty = false;
    this.frame++;
    if (this._visible) {
      if (this.clusterOptions) this.selectClustered(camera, height);
      else this.selectInView(camera);
    } else {
      this.drawPoints.length = 0;
      this.drawClusters.length = 0;
    }
    this.applySelection();
    this.stats.points = this.drawPoints.length;
    this.stats.clusters = this.drawClusters.length;
    this.stats.ms = performance.now() - t0;
  }

  /**
   * Moves points without their own height onto the terrain as it loads: a
   * coarse estimate first, detailed terrain (cells <= 150 m) once available,
   * then re-checked slowly while the terrain keeps refining.
   */
  private clampToGround(): void {
    const n = this.entries.length;
    const ell = this.host.ellipsoid;
    for (let k = 0; k < Math.min(GROUND_BUDGET, n); k++) {
      const entry = this.entries[this.groundCursor];
      this.groundCursor = (this.groundCursor + 1) % n;
      if (entry.point.height !== null) continue;
      const lon = entry.point.longitude * DEG2RAD;
      const lat = entry.point.latitude * DEG2RAD;
      let h = this.host.groundHeight(lon, lat, GROUND_CELL);
      let level: 1 | 2 = 2;
      if (h === null) {
        if (entry.grounded === 2) continue;
        h = this.host.groundHeight(lon, lat);
        level = 1;
        if (h === null) continue;
      }
      const target = h + (entry.style.heightOffset ?? 0);
      const current = ell.cartesianToCartographic(entry.position)?.height ?? Number.NaN;
      if (entry.grounded === 0 || !(Math.abs(current - target) < 0.05)) {
        const p = ell.cartographicToCartesian(lon, lat, target, entry.position);
        const i = entry.index * 3;
        this.positions[i] = p.x;
        this.positions[i + 1] = p.y;
        this.positions[i + 2] = p.z;
      }
      entry.grounded = level;
    }
  }

  /** Clustering off: every point whose anchor is in view (exact culling is done by `MarkerManager`). */
  private selectInView(camera: PerspectiveCamera): void {
    const out = this.drawPoints;
    out.length = 0;
    this.drawClusters.length = 0;
    _cam.setFromMatrixPosition(camera.matrixWorld);
    const m = _vp.elements;
    const csx = _cam.x / WGS84_A;
    const csy = _cam.y / WGS84_A;
    const csz = _cam.z / WGS84_B;
    for (const e of this.entries) {
      const p = e.position;
      const s = e.style;
      if (s.maxDistance !== undefined || s.minDistance !== undefined) {
        const dist = p.distanceTo(_cam);
        if ((s.maxDistance !== undefined && dist > s.maxDistance) || (s.minDistance !== undefined && dist < s.minDistance)) continue;
      }
      const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
      if (w <= 0) continue;
      const nx = (m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / w;
      const ny = (m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / w;
      if (nx < -NDC_MARGIN || nx > NDC_MARGIN || ny < -NDC_MARGIN || ny > NDC_MARGIN) continue;
      if (!isScaledSpacePointVisible(p.x / WGS84_A, p.y / WGS84_A, p.z / WGS84_B, csx, csy, csz)) continue;
      out.push(e.index);
    }
  }

  /** Clustering on: walk the cluster tree (nothing is drawn until it is built). */
  private selectClustered(camera: PerspectiveCamera, height: number): void {
    const selector = this.selector;
    const opts = this.clusterOptions!;
    if (!selector) {
      this.drawPoints.length = 0;
      this.drawClusters.length = 0;
      return;
    }
    _cam.setFromMatrixPosition(camera.matrixWorld);
    // Frustum widened to the NDC margin, as six planes for the tree's sphere tests.
    _cullVp.makeScale(1 / NDC_MARGIN, 1 / NDC_MARGIN, 1).multiply(_vp);
    _frustum.setFromProjectionMatrix(_cullVp);
    const planes = _planes;
    _frustum.planes.forEach((pl, i) => {
      planes[i * 4] = pl.normal.x;
      planes[i * 4 + 1] = pl.normal.y;
      planes[i * 4 + 2] = pl.normal.z;
      planes[i * 4 + 3] = pl.constant;
    });
    selector.select(
      this.positions,
      {
        cameraX: _cam.x,
        cameraY: _cam.y,
        cameraZ: _cam.z,
        pixelSize: (2 * Math.tan((camera.fov * DEG2RAD) / 2)) / Math.max(1, height),
        planes,
        minPoints: opts.minPoints,
      },
      this.drawPoints,
      this.drawClusters,
    );
    // Drop anchors behind the horizon before any DOM is created for them.
    const csx = _cam.x / WGS84_A;
    const csy = _cam.y / WGS84_A;
    const csz = _cam.z / WGS84_B;
    const pos = this.positions;
    const tree = selector.tree;
    const front = (point: number) => isScaledSpacePointVisible(pos[point * 3] / WGS84_A, pos[point * 3 + 1] / WGS84_A, pos[point * 3 + 2] / WGS84_B, csx, csy, csz);
    filterInPlace(this.drawPoints, front);
    filterInPlace(this.drawClusters, (node) => front(tree.seed[node]));
  }

  /** Stamps the selected points, creates their markers, and binds cluster markers to tree nodes. */
  private applySelection(): void {
    const frame = this.frame;
    let budget = CREATE_BUDGET;
    for (const i of this.drawPoints) {
      const e = this.entries[i];
      e.drawn = frame;
      if (e.marker) continue;
      if (budget > 0) {
        this.createMarker(e);
        budget--;
      } else {
        // Over budget: keep selecting next frame even if the camera stays still.
        this.dirty = true;
      }
    }
    const tree = this.tree;
    if (tree) {
      for (const node of this.drawClusters) {
        let slot = this.slots.get(node);
        if (!slot) {
          slot = this.pool.pop() ?? this.createSlot();
          this.bindSlot(slot, node, tree);
          this.slots.set(node, slot);
        }
        slot.drawn = frame;
      }
    }
    for (const [node, slot] of this.slots) {
      if (slot.drawn === frame) continue;
      slot.node = -1;
      this.slots.delete(node);
      this.pool.push(slot);
    }
    this.stats.elements = this.markerCount + this.slots.size + this.pool.length;
  }

  private createMarker(entry: Entry): void {
    const { point, style } = entry;
    const props = point.properties;
    const element = createCard({
      style: style.style ?? 'poi',
      title: style.title !== undefined ? fillTemplate(style.title, props) : defaultTitle(point),
      subtitle: style.subtitle !== undefined ? fillTemplate(style.subtitle, props) : undefined,
      color: style.color,
      icon: style.icon !== undefined ? fillTemplate(style.icon, props) : undefined,
      badge: style.badge !== undefined ? fillTemplate(style.badge, props) || undefined : undefined,
      badgeColor: style.badgeColor,
    });
    if (this.selected === entry) element.classList.add('selected');
    this.markerCount++;
    entry.marker = this.host.markers.add({
      element,
      position: entry.position,
      visible: () => this._visible && entry.drawn === this.frame,
      minDistance: style.minDistance,
      maxDistance: style.maxDistance,
      scaleByDistance: style.scaleByDistance,
      declutter: style.declutter ?? true,
      priority: () => (style.priority ?? 0) + (this.selected === entry ? 100 : 0),
      zIndex: style.zIndex ?? 2,
      onClick: (event) => {
        this.select(point.id);
        this.events.emit('click', { point, layer: this, event });
      },
      onDoubleClick: () => this.host.flyToBBox([point.longitude, point.latitude, point.longitude, point.latitude]),
      userData: { point, layer: this },
    });
  }

  private createSlot(): ClusterSlot {
    const element = createClusterCard(0);
    const slot = { element, node: -1, drawn: 0 } as ClusterSlot;
    slot.marker = this.host.markers.add({
      element,
      position: () => (slot.node >= 0 && this.tree ? this.entries[this.tree.seed[slot.node]].position : null),
      visible: () => this._visible && slot.node >= 0 && slot.drawn === this.frame,
      // Clusters stand for many points: never hidden by decluttering, drawn above them.
      declutter: false,
      zIndex: 3,
      onClick: (event) => {
        const tree = this.tree;
        if (!tree || slot.node < 0) return;
        const points = clusterLeaves(tree, slot.node).map((i) => this.entries[i].point);
        this.events.emit('clusterclick', { points, layer: this, event });
        const bbox = pointsBBox(points);
        if (bbox) this.host.flyToBBox(bbox);
      },
      userData: { layer: this, cluster: true },
    });
    return slot;
  }

  /** Points a pooled cluster marker at a tree node (count and the seed's color). */
  private bindSlot(slot: ClusterSlot, node: number, tree: ClusterTree): void {
    slot.node = node;
    const count = tree.count[node];
    if (slot.element.dataset.count !== String(count)) {
      slot.element.dataset.count = String(count);
      setClusterCount(slot.element, count);
      slot.marker.invalidateSize();
    }
    const color = this.entries[tree.seed[node]].style.color ?? this.styleBase.color;
    if (color) slot.element.style.setProperty('--accent', color);
    else slot.element.style.removeProperty('--accent');
  }

  private removeMarkers(): void {
    for (const e of this.entries) e.marker?.remove();
    this.entries = [];
    this.markerCount = 0;
    this.byId.clear();
    for (const s of this.slots.values()) s.marker.remove();
    for (const s of this.pool) s.marker.remove();
    this.slots.clear();
    this.pool.length = 0;
    this.selected = null;
  }

  dispose(): void {
    this.disposed = true;
    this.treeVersion++;
    this.removeMarkers();
  }
}

function normalizeCluster(cluster: boolean | ClusterOptions | undefined): Required<ClusterOptions> | null {
  if (!cluster) return null;
  const o = cluster === true ? {} : cluster;
  return { radius: o.radius ?? 56, minPoints: Math.max(2, o.minPoints ?? 3), maxZoom: o.maxZoom ?? 18 };
}

function filterInPlace(list: number[], keep: (v: number) => boolean): void {
  let j = 0;
  for (const v of list) if (keep(v)) list[j++] = v;
  list.length = j;
}

// One shared Worker for cluster tree builds of large layers.
let worker: Worker | null = null;
let workerSeq = 0;
const pending = new Map<number, { resolve: (tree: ClusterTree) => void; reject: (err: unknown) => void }>();

function buildInWorker(input: ClusterTreeInput, options: ClusterTreeOptions): Promise<ClusterTree> {
  if (!worker) {
    worker = new Worker(new URL('./clusterTree.worker.ts', import.meta.url), { type: 'module', name: 'cluster-tree' });
    worker.onmessage = (e: MessageEvent<{ id: number; tree: ClusterTree }>) => {
      pending.get(e.data.id)?.resolve(e.data.tree);
      pending.delete(e.data.id);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(e);
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  const id = ++workerSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, input, options }, [input.positions.buffer as ArrayBuffer]);
  });
}
