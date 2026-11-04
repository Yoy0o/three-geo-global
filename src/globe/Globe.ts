import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  Frustum,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Ray,
  SRGBColorSpace,
  Texture,
  Vector3,
  Vector4,
} from 'three';
import { Ellipsoid, cartographic, type Cartographic } from '../core/Ellipsoid';
import { geodeticNormal, geodeticToEcef, isScaledSpacePointVisible, WGS84_A } from '../core/geodesy';
import { clamp, wrapPi } from '../core/math';
import { GlobeTile, SharedTexture, type LoadChannel } from './GlobeTile';
import { createTileMaterial, EMPTY_OVERLAY, type TileMaterial } from './TileMaterial';
import type { TileOverlaySource } from './overlay';
import { MERCATOR_MAX_LATITUDE, WebMercatorTilingScheme } from './TilingScheme';
import { isAbortError, TileWorkerPool } from './TileWorkerPool';
import type { ImageryProvider } from './imagery/ImageryProvider';
import { isQuantizedMesh, type TerrainSource } from './terrain/TerrainSource';
import { rasterSourceTile, terrainLevelOffset } from './terrain/terrainTiling';
import type { BuiltTile, UpsampleSource } from './workerProtocol';

export interface GlobeOptions {
  imagery: ImageryProvider;
  terrain?: TerrainSource | null;
  terrainExaggeration?: number;
  /** Refine until one imagery texel covers at most this many CSS pixels. */
  maxScreenSpaceError?: number;
  maxCachedTiles?: number;
  /** Concurrent imagery downloads (HTTP/2 tile servers handle 20-30 well). */
  maxConcurrentLoads?: number;
  /** Concurrent terrain mesh jobs. */
  maxConcurrentGeometry?: number;
  /** Grid cells per tile edge. */
  segments?: number;
  maxAnisotropy?: number;
  /** Seconds to cross-fade from a magnified ancestor to a tile's own imagery (0 = pop in). */
  fadeDuration?: number;
}

export interface GlobeStats {
  rendered: number;
  cached: number;
  /** Requests in flight (all channels). */
  loading: number;
  /** Requests waiting for a free slot. */
  queued: number;
  maxLevel: number;
  /** Rendered tiles still showing a magnified ancestor or the placeholder. */
  waitingImagery: number;
}

type ChannelKind = 'geo' | 'img' | 'ovl';

interface ReadyItem {
  tile: GlobeTile;
  kind: ChannelKind;
  controller: AbortController;
  epoch: number;
  apply: () => void;
  discard: () => void;
}

const IMAGERY_TILE_SIZE = 256;
const MIN_LEVEL = 2;
const MAX_LEVEL = 22;
const TERRAIN_MAX_HEIGHT = 8900;
/** Lowest ellipsoidal height of the geoid-corrected sea surface (EGM96 minimum is about -107 m). */
const TERRAIN_MIN_HEIGHT = -120;

// Request priority buckets (lower loads first). See docs/agents/tile-loading.md.
/** Geometry of a tile that blocks refinement. */
const B_REFINE = 0;
/** Imagery of an intermediate ancestor: a cheap, sharper fallback for many tiles at once. */
const B_ANCHOR = 1;
/** Imagery of a rendered tile that currently shows a much coarser fallback. */
const B_URGENT = 2;
/** Imagery / overlay / exact terrain of rendered tiles. */
const B_RENDERED = 3;
/** Ancestors kept current as fallbacks; limited to a third of the slots. */
const B_LOW = 4;

/** Rendered tiles whose fallback is this many levels coarser get an intermediate ancestor loaded first. */
const ANCHOR_GAP = 3;
/**
 * Interim meshes are interpolated from an ancestor with real terrain at most
 * this many levels up; deeper tiles wait for their data (coarser estimates are
 * too far off in mountains and produce visible steps).
 */
const MAX_UPSAMPLE_LEVELS = 3;
/** Finished loads applied (and uploaded) per frame; keeps frame times flat while streaming. */
const APPLY_BUDGET = 16;
const APPLY_BUDGET_MS = 6;
/** In-flight loads no longer wanted for this many frames are cancelled. */
const STALE_FRAMES = 20;

const _projScreen = new Matrix4();
const _p = [0, 0, 0];
const _v = new Vector3();
const _localRay = new Ray();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _hit = new Vector3();
const _prevTransform = new Vector4();

function channelOf(tile: GlobeTile, kind: ChannelKind): LoadChannel {
  return kind === 'geo' ? tile.geo : kind === 'img' ? tile.img : tile.ovl;
}

/** Routes tiles that read the same terrain data to the same worker (its cache holds the decoded tile). */
function terrainAffinity(terrain: TerrainSource, level: number, x: number, y: number, segments: number): string | undefined {
  if (isQuantizedMesh(terrain)) {
    const g = Math.max(0, Math.min(terrain.geographicMaxZoom, level - 1));
    const shift = level - 1 - g;
    return shift > 0 ? `qm:${g}/${x >> shift}` : undefined;
  }
  const t = rasterSourceTile(level, x, y, terrain.maxZoom, terrainLevelOffset(terrain.tileSize ?? 256, segments));
  return t.dz > 0 ? `${t.z}/${t.x}/${t.y}` : undefined;
}

/**
 * Quadtree globe surface: Web Mercator tiles with terrain, imagery and a
 * draped overlay.
 *
 * Loading model (docs/agents/tile-loading.md):
 * - geometry, imagery and overlay are independent channels with their own
 *   concurrency limits, so slow terrain never holds back imagery;
 * - a tile is renderable as soon as it has a mesh; imagery falls back to the
 *   closest ancestor (magnified) or a placeholder, and cross-fades in when the
 *   tile's own texture arrives;
 * - child meshes can be upsampled from the parent's heights, so refinement
 *   does not wait on the network; the exact terrain replaces them later;
 * - requests are sorted into priority buckets, then by distance from the view
 *   center (foveated), so what the user looks at loads first;
 * - finished loads are applied under a per-frame budget.
 */
export class Globe {
  readonly group = new Group();
  readonly scheme = new WebMercatorTilingScheme();
  readonly ellipsoid = Ellipsoid.WGS84;
  readonly stats: GlobeStats = { rendered: 0, cached: 0, loading: 0, queued: 0, maxLevel: 0, waitingImagery: 0 };

  maxScreenSpaceError: number;
  maxCachedTiles: number;
  maxConcurrentLoads: number;
  maxConcurrentGeometry: number;
  fadeDuration: number;
  /** Stop refining and loading (debug). */
  freeze = false;
  /** Called (at most a few times per provider) when imagery requests fail. */
  onImageryError: ((message: string) => void) | null = null;
  /** Last reported imagery failure for the current provider (null when healthy). */
  imageryErrorMessage: string | null = null;
  private imageryErrors = 0;
  private wireframe = false;

  private imagery: ImageryProvider;
  private terrain: TerrainSource | null;
  private exaggeration: number;
  private readonly segments: number;
  private readonly maxAnisotropy: number;
  private readonly workers = new TileWorkerPool();
  private readonly roots: GlobeTile[] = [];
  private readonly loaded = new Set<GlobeTile>();
  private readonly queues: Record<ChannelKind, GlobeTile[]> = { geo: [], img: [], ovl: [] };
  private readonly active: Record<ChannelKind, Set<GlobeTile>> = { geo: new Set(), img: new Set(), ovl: new Set() };
  private ready: ReadyItem[] = [];
  private readonly fading = new Set<GlobeTile>();
  private renderList: GlobeTile[] = [];
  private prevRenderList: GlobeTile[] = [];
  private frame = 0;
  private now = 0;
  private imageryGen = 0;
  private geometryGen = 0;
  private placeholder: SharedTexture;
  private overlaySource: TileOverlaySource | null = null;
  private readonly emptyOverlay: SharedTexture;

  // Per-frame camera state.
  private readonly frustum = new Frustum();
  private readonly cameraPosition = new Vector3();
  private readonly cameraForward = new Vector3();
  private readonly cameraCarto: Cartographic = cartographic();
  private readonly cameraScaled = new Vector3();
  private horizonCulling = true;
  private sseFactor = 1;
  private halfFovDiagonal = 0.6;

  // Polar caps.
  private readonly caps: Mesh[] = [];
  private readonly capTextures: DataTexture[] = [];
  private readonly capColors = [new Map<number, number[]>(), new Map<number, number[]>()];

  constructor(options: GlobeOptions) {
    this.imagery = options.imagery;
    this.terrain = options.terrain ?? null;
    this.exaggeration = options.terrainExaggeration ?? 1;
    this.maxScreenSpaceError = options.maxScreenSpaceError ?? 1.25;
    this.maxCachedTiles = options.maxCachedTiles ?? 700;
    this.maxConcurrentLoads = options.maxConcurrentLoads ?? 24;
    this.maxConcurrentGeometry = options.maxConcurrentGeometry ?? 12;
    this.segments = options.segments ?? 32;
    this.maxAnisotropy = options.maxAnisotropy ?? 8;
    this.fadeDuration = options.fadeDuration ?? 0.3;
    this.group.name = 'Globe';

    const placeholderTex = new DataTexture(new Uint8Array([28, 46, 72, 255]), 1, 1);
    placeholderTex.colorSpace = SRGBColorSpace;
    placeholderTex.needsUpdate = true;
    this.placeholder = new SharedTexture(placeholderTex, -1, 0, 0, 4).acquire();
    this.emptyOverlay = new SharedTexture(EMPTY_OVERLAY, -1, 0, 0, 4).acquire();

    const n = this.scheme.tilesAtLevel(MIN_LEVEL);
    const lo = this.terrain ? TERRAIN_MIN_HEIGHT : 0;
    const hi = this.terrain ? TERRAIN_MAX_HEIGHT : 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) this.roots.push(new GlobeTile(MIN_LEVEL, x, y, null, this.scheme, lo, hi));
    }
    this.createPolarCaps();
  }

  // ---------------------------------------------------------------------------
  // Configuration

  get imageryProvider(): ImageryProvider {
    return this.imagery;
  }

  get terrainSource(): TerrainSource | null {
    return this.terrain;
  }

  get terrainExaggeration(): number {
    return this.exaggeration;
  }

  setImagery(provider: ImageryProvider): void {
    if (provider === this.imagery) return;
    this.imagery.dispose?.();
    this.imagery = provider;
    this.imageryGen++;
    this.imageryErrors = 0;
    this.imageryErrorMessage = null;
    this.capColors[0].clear();
    this.capColors[1].clear();
    for (const t of this.active.img) t.img.loading?.abort();
  }

  /** Drapes a tile overlay source (e.g. rasterized vector layers) over the imagery. */
  setOverlaySource(source: TileOverlaySource | null): void {
    if (source === this.overlaySource) return;
    this.overlaySource = source;
    this.forEachTile((t) => {
      t.ovl.loading?.abort();
      t.ownOverlay?.release();
      t.ownOverlay = null;
      t.overlayGen = -1;
      this.resolveOverlay(t);
    });
  }

  setTerrain(source: TerrainSource | null, exaggeration = this.exaggeration): void {
    if (source === this.terrain && exaggeration === this.exaggeration) return;
    this.terrain = source;
    this.exaggeration = exaggeration;
    this.geometryGen++;
    for (const t of this.active.geo) t.geo.loading?.abort();
    if (!source) {
      // Flat globe: bounds are exact without waiting for data.
      this.forEachTile((t) => {
        if (!t.mesh || t.geometryGen !== this.geometryGen) {
          t.minHeight = 0;
          t.maxHeight = 0;
          t.estimateBounds();
        }
      });
    } else {
      for (const r of this.roots) {
        if (r.geometryGen !== this.geometryGen) {
          r.minHeight = Math.min(r.minHeight, TERRAIN_MIN_HEIGHT);
          r.maxHeight = Math.max(r.maxHeight, TERRAIN_MAX_HEIGHT * exaggeration);
          r.estimateBounds();
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame update

  update(camera: PerspectiveCamera, viewportHeightCss: number): void {
    // Frozen: keep the previous selection so it can be inspected from elsewhere.
    if (this.freeze) return;
    this.frame++;
    this.now = performance.now();
    this.prepareCamera(camera, viewportHeightCss);
    // Upload what finished since the last frame first, so this traversal can use it.
    this.applyReady();

    this.renderList = [];
    for (const q of Object.values(this.queues)) q.length = 0;
    for (const root of this.roots) this.visit(root);

    // Toggle visibility instead of re-parenting meshes.
    for (const t of this.prevRenderList) if (t.mesh) t.mesh.visible = false;
    let maxLevel = 0;
    let waiting = 0;
    for (const t of this.renderList) {
      if (t.mesh) t.mesh.visible = true;
      t.lastRenderedFrame = this.frame;
      if (!t.ownImagery || t.imageryGen !== this.imageryGen) this.resolveImagery(t);
      if (this.overlaySource && (t.overlayGen !== this.overlaySource.version || t.overlay !== (t.ownOverlay ?? this.emptyOverlay))) {
        this.resolveOverlay(t);
      }
      if (this.queueRenderedContent(t)) waiting++;
      maxLevel = Math.max(maxLevel, t.level);
    }
    this.prevRenderList = this.renderList;

    this.cancelStaleLoads();
    this.dispatch('geo', this.maxConcurrentGeometry);
    this.dispatch('img', this.maxConcurrentLoads);
    this.dispatch('ovl', Math.max(4, Math.floor(this.maxConcurrentLoads / 3)));
    this.updateFades();
    if (this.frame % 30 === 0) this.evict();

    this.stats.rendered = this.renderList.length;
    this.stats.cached = this.loaded.size;
    this.stats.loading = this.active.geo.size + this.active.img.size + this.active.ovl.size;
    this.stats.queued = this.queues.geo.length + this.queues.img.length + this.queues.ovl.length - this.stats.loading;
    this.stats.queued = Math.max(0, this.stats.queued);
    this.stats.maxLevel = maxLevel;
    this.stats.waitingImagery = waiting;
  }

  private prepareCamera(camera: PerspectiveCamera, viewportHeightCss: number): void {
    camera.updateMatrixWorld();
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(_projScreen, camera.coordinateSystem, camera.reversedDepth);
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.cameraForward.set(0, 0, -1).transformDirection(camera.matrixWorld);
    this.ellipsoid.cartesianToCartographic(this.cameraPosition, this.cameraCarto);
    this.cameraScaled.copy(this.cameraPosition).multiply(this.ellipsoid.oneOverRadii);
    // Below/near the ellipsoid (e.g. with terrain under sea level) the occluder is unreliable.
    this.horizonCulling = this.cameraCarto.height > 100;
    const fov = (camera.getEffectiveFOV() * Math.PI) / 180;
    this.sseFactor = viewportHeightCss / (2 * Math.tan(fov / 2));
    this.halfFovDiagonal = Math.atan(Math.tan(fov / 2) * Math.hypot(1, camera.aspect));
  }

  private get maxLevel(): number {
    return Math.min(MAX_LEVEL, Math.max(this.imagery.maxZoom, this.terrain ? this.terrain.maxZoom : 0));
  }

  private isVisible(tile: GlobeTile): boolean {
    if (!this.frustum.intersectsSphere(tile.boundingSphere)) return false;
    const hp = tile.horizonPoint;
    if (!this.horizonCulling || !hp) return true;
    const cs = this.cameraScaled;
    return isScaledSpacePointVisible(hp.x, hp.y, hp.z, cs.x, cs.y, cs.z);
  }

  /** Approximate distance from the camera to the closest point of the tile. */
  private tileDistance(tile: GlobeTile): number {
    const c = this.cameraCarto;
    const sphereDist = this.cameraPosition.distanceTo(tile.boundingSphere.center) - tile.boundingSphere.radius;
    if (sphereDist > tile.boundingSphere.radius * 2) return sphereDist;
    const { west, east, south, north } = tile.rect;
    const cx = (west + east) / 2;
    const half = (east - west) / 2;
    const lon = cx + clamp(wrapPi(c.longitude - cx), -half, half);
    const lat = clamp(c.latitude, south, north);
    const h = clamp(c.height, tile.minHeight, tile.maxHeight);
    geodeticToEcef(lon, lat, h, _p);
    return Math.max(1, _v.set(_p[0], _p[1], _p[2]).distanceTo(this.cameraPosition));
  }

  private computeSSE(tile: GlobeTile): number {
    const groundSize = (2 * Math.PI * WGS84_A * Math.cos(tile.latForResolution)) / 2 ** tile.level;
    const texel = groundSize / IMAGERY_TILE_SIZE;
    return (texel * this.sseFactor) / tile.distance;
  }

  /** Angle between the view direction and the tile, in units of the half diagonal FOV (0 = view center). */
  private foveation(tile: GlobeTile): number {
    const s = tile.boundingSphere;
    _v.subVectors(s.center, this.cameraPosition);
    const d = _v.length();
    if (d <= s.radius) return 0;
    const cos = _v.dot(this.cameraForward) / d;
    const angle = Math.acos(clamp(cos, -1, 1)) - Math.asin(Math.min(1, s.radius / d));
    return Math.max(0, angle) / this.halfFovDiagonal;
  }

  // ---------------------------------------------------------------------------
  // Selection

  private visit(tile: GlobeTile): void {
    tile.lastVisitedFrame = this.frame;
    if (!this.isVisible(tile)) return;
    tile.distance = this.tileDistance(tile);
    const wantRefine = tile.level < this.maxLevel && this.computeSSE(tile) > this.maxScreenSpaceError;

    if (wantRefine && tile.renderable) {
      const children = tile.createChildren(this.scheme, this.childHeightRange(tile));
      let ready = true;
      for (const child of children) {
        child.lastVisitedFrame = this.frame;
        if (!this.isVisible(child)) continue;
        if (!child.renderable) {
          ready = false;
          child.distance = this.tileDistance(child);
          this.queue('geo', child, B_REFINE);
        }
      }
      if (ready) {
        // Ancestors double as fallbacks for their descendants: keep them current at low priority.
        if (this.needsImagery(tile)) this.queue('img', tile, B_LOW);
        // Interim ancestors still need their real terrain: descendants are estimated from it
        // and culled with its height range.
        if (this.needsGeometry(tile)) this.queue('geo', tile, B_RENDERED);
        for (const child of children) this.visit(child);
        return;
      }
    }

    if (tile.renderable) {
      this.renderList.push(tile);
      if (this.needsGeometry(tile)) this.queue('geo', tile, tile.geometryGen === this.geometryGen ? B_RENDERED : B_URGENT);
    } else {
      this.queue('geo', tile, B_REFINE);
    }
  }

  private needsGeometry(tile: GlobeTile): boolean {
    return !tile.mesh || tile.geometryGen !== this.geometryGen || tile.upsampled;
  }

  /** Closest ancestor-or-self with real (not interpolated) terrain for the current source. */
  private exactAncestor(tile: GlobeTile | null): GlobeTile | null {
    for (let t = tile; t; t = t.parent) {
      if (t.heights && !t.upsampled && t.geometryGen === this.geometryGen) return t;
    }
    return null;
  }

  /**
   * Height range children of `tile` assume for culling until their own mesh
   * arrives. Interim heights are only estimates, so their children use the
   * range of the closest tile with real terrain (or the global range).
   */
  private childHeightRange(tile: GlobeTile): [number, number] {
    if (!this.terrain || (tile.geometryGen === this.geometryGen && !tile.upsampled)) return [tile.minHeight, tile.maxHeight];
    // Interim or left over from another terrain source: only an estimate.
    const exact = this.exactAncestor(tile);
    if (exact) return [Math.min(exact.minHeight, tile.minHeight), Math.max(exact.maxHeight, tile.maxHeight)];
    return [TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT * this.exaggeration];
  }

  /** Whether imagery must be requested; tiles outside the provider's zoom range are settled on the spot. */
  private needsImagery(tile: GlobeTile): boolean {
    if (tile.imageryGen === this.imageryGen) return false;
    if (tile.level > this.imagery.maxZoom || tile.level < this.imagery.minZoom) {
      tile.ownImagery?.release();
      tile.ownImagery = null;
      tile.imageryGen = this.imageryGen;
      return false;
    }
    return true;
  }

  /** Level of the imagery a tile currently shows (-Infinity for the placeholder). */
  private fallbackLevel(tile: GlobeTile): number {
    let src: GlobeTile | null = tile;
    while (src) {
      if (src.ownImagery && src.imageryGen === this.imageryGen) return src.level;
      src = src.parent;
    }
    return -Infinity;
  }

  /**
   * Queues imagery / overlay for a rendered tile. When the tile shows a much
   * coarser fallback, an intermediate ancestor ("anchor") is loaded first: one
   * request that sharpens many tiles at once while their own imagery streams in.
   * Returns whether the tile is still waiting for its own imagery.
   */
  private queueRenderedContent(t: GlobeTile): boolean {
    let waiting = false;
    if (this.needsImagery(t)) {
      waiting = true;
      const effective = Math.min(t.level, this.imagery.maxZoom);
      const fallback = this.fallbackLevel(t);
      const gap = effective - fallback;
      this.queue('img', t, gap >= ANCHOR_GAP ? B_URGENT : B_RENDERED);
      if (gap > ANCHOR_GAP) {
        const targetLevel = Math.max(this.imagery.minZoom, fallback === -Infinity ? MIN_LEVEL : fallback + ANCHOR_GAP);
        let anchor: GlobeTile = t;
        while (anchor.parent && anchor.level > targetLevel) anchor = anchor.parent;
        if (anchor !== t && anchor.level === targetLevel && this.needsImagery(anchor)) this.queue('img', anchor, B_ANCHOR);
      }
    }
    if (this.overlaySource && this.overlayNeedsRequest(t)) this.queue('ovl', t, B_RENDERED);
    return waiting;
  }

  /**
   * Whether the tile's overlay must be (re)requested. Tiles outside changed
   * regions or without any content are brought up to date on the spot.
   */
  private overlayNeedsRequest(tile: GlobeTile): boolean {
    const src = this.overlaySource;
    if (!src || tile.overlayGen === src.version) return false;
    if (tile.overlayGen >= 0 && src.isCurrent(tile.level, tile.x, tile.y, tile.overlayGen)) {
      tile.overlayGen = src.version;
      return false;
    }
    if (!src.hasContent(tile.level, tile.x, tile.y)) {
      this.applyOverlay(tile, null, src.version);
      return false;
    }
    return true;
  }

  private queue(kind: ChannelKind, tile: GlobeTile, bucket: number): void {
    const ch = channelOf(tile, kind);
    // Buckets dominate; anchors load coarse-to-fine; then by distance from the view center.
    const priority =
      bucket * 1e8 + (bucket === B_ANCHOR ? tile.level * 1e6 : 0) + Math.min(this.foveation(tile), 9.99) * 1e4 + Math.min(Math.log2(1 + tile.distance), 99) * 10;
    if (ch.wantedFrame === this.frame) {
      if (priority < ch.priority) {
        ch.priority = priority;
        ch.bucket = bucket;
      }
      return;
    }
    ch.wantedFrame = this.frame;
    ch.priority = priority;
    ch.bucket = bucket;
    this.queues[kind].push(tile);
  }

  // ---------------------------------------------------------------------------
  // Loading

  private dispatch(kind: ChannelKind, limit: number): void {
    const queue = this.queues[kind];
    if (queue.length === 0) return;
    const active = this.active[kind];
    if (active.size >= limit) return;
    queue.sort((a, b) => channelOf(a, kind).priority - channelOf(b, kind).priority);
    let lowActive = 0;
    for (const t of active) if (channelOf(t, kind).bucket >= B_LOW) lowActive++;
    const lowLimit = Math.max(1, Math.floor(limit / 3));
    for (const tile of queue) {
      if (active.size >= limit) break;
      const ch = channelOf(tile, kind);
      if (ch.loading || this.now < ch.retryAt) continue;
      if (ch.bucket >= B_LOW) {
        if (lowActive >= lowLimit) continue;
        lowActive++;
      }
      if (kind === 'geo') this.startGeometry(tile);
      else if (kind === 'img') this.startImagery(tile);
      else this.startOverlay(tile);
    }
  }

  private cancelStaleLoads(): void {
    for (const kind of ['geo', 'img', 'ovl'] as const) {
      for (const tile of this.active[kind]) {
        const ch = channelOf(tile, kind);
        if (ch.loading && !ch.loading.signal.aborted && this.frame - ch.wantedFrame > STALE_FRAMES) ch.loading.abort();
      }
    }
  }

  /** Marks a load as in flight; returns its controller. */
  private begin(kind: ChannelKind, tile: GlobeTile): AbortController {
    const controller = new AbortController();
    channelOf(tile, kind).loading = controller;
    this.active[kind].add(tile);
    return controller;
  }

  /** Clears the in-flight state of a load (after it was applied, discarded or failed). */
  private finish(kind: ChannelKind, tile: GlobeTile, controller: AbortController): void {
    const ch = channelOf(tile, kind);
    if (ch.loading === controller) {
      ch.loading = null;
      this.active[kind].delete(tile);
    }
  }

  /** Queues a finished load for upload; it keeps its slot until then (backpressure). */
  private enqueueReady(tile: GlobeTile, kind: ChannelKind, controller: AbortController, epoch: number, apply: () => void, discard: () => void): void {
    this.ready.push({ tile, kind, controller, epoch, apply, discard });
  }

  private applyReady(): void {
    if (this.ready.length === 0) return;
    const start = performance.now();
    let applied = 0;
    let i = 0;
    for (; i < this.ready.length; i++) {
      if (applied >= APPLY_BUDGET || performance.now() - start > APPLY_BUDGET_MS) break;
      const item = this.ready[i];
      this.finish(item.kind, item.tile, item.controller);
      if (item.controller.signal.aborted || item.epoch !== item.tile.epoch) {
        item.discard();
        continue;
      }
      item.apply();
      applied++;
    }
    this.ready = i >= this.ready.length ? [] : this.ready.slice(i);
  }

  private startGeometry(tile: GlobeTile): void {
    const controller = this.begin('geo', tile);
    const epoch = tile.epoch;
    const gen = this.geometryGen;
    const terrain = this.terrain;
    if (terrain) this.workers.registerTerrain(terrain);

    // Refinement should not wait on the network: build an interim mesh from the
    // parent's heights while the exact terrain downloads in the worker.
    let upsample: UpsampleSource | null = null;
    const replacingInterim = tile.mesh !== null && tile.geometryGen === gen && tile.upsampled;
    const parent = tile.parent;
    if (terrain && !replacingInterim) {
      // Interpolate from real terrain only (never from another estimate), and not from too far up.
      const src = this.exactAncestor(parent);
      if (src && tile.level - src.level <= MAX_UPSAMPLE_LEVELS) {
        upsample = { heights: src.heights!.slice(), segments: src.segments, level: src.level, x: src.x, y: src.y };
      } else if (!parent && !tile.mesh) {
        // Roots start flat (relief is invisible from orbit) so the globe shows up at once
        // instead of after the first, possibly slow, terrain download.
        const n = this.segments + 1;
        upsample = { heights: new Float32Array(n * n), segments: this.segments, level: tile.level, x: tile.x, y: tile.y };
      }
    }

    this.workers
      .build(
        {
          level: tile.level,
          x: tile.x,
          y: tile.y,
          segments: this.segments,
          terrainId: terrain?.id ?? null,
          exaggeration: this.exaggeration,
          clampToSeaLevel: true,
          upsample,
        },
        controller.signal,
        terrain ? terrainAffinity(terrain, tile.level, tile.x, tile.y, this.segments) : undefined,
      )
      .then((built) => {
        this.enqueueReady(
          tile,
          'geo',
          controller,
          epoch,
          () => {
            if (gen !== this.geometryGen) return;
            this.applyGeometry(tile, built, gen);
            tile.dataLevel = !terrain ? tile.level : upsample ? (upsample.level === tile.level ? -1 : upsample.level) : tile.level;
            tile.geo.succeed();
          },
          () => undefined,
        );
      })
      .catch((err: unknown) => {
        this.finish('geo', tile, controller);
        if (controller.signal.aborted || isAbortError(err)) return;
        tile.geo.fail(performance.now());
        console.warn(`[Globe] geometry ${tile.key} failed:`, (err as Error).message);
      });
  }

  private startImagery(tile: GlobeTile): void {
    const controller = this.begin('img', tile);
    const epoch = tile.epoch;
    const gen = this.imageryGen;
    this.imagery
      .requestImage(tile.level, tile.x, tile.y, controller.signal)
      .then((bitmap) => {
        this.enqueueReady(
          tile,
          'img',
          controller,
          epoch,
          () => {
            if (gen !== this.imageryGen) {
              bitmap?.close();
              return;
            }
            if (bitmap && tile.level === MIN_LEVEL) this.sampleCapColor(tile, bitmap);
            this.applyImagery(tile, bitmap ? this.createTexture(tile, bitmap, false) : null, gen);
            tile.img.succeed();
          },
          () => bitmap?.close(),
        );
      })
      .catch((err: unknown) => {
        this.finish('img', tile, controller);
        if (controller.signal.aborted || isAbortError(err) || gen !== this.imageryGen) return;
        this.reportImageryError(tile, err as Error);
        // Keep showing a magnified ancestor; the tile stays stale and is retried with backoff.
        tile.img.fail(performance.now());
      });
  }

  private startOverlay(tile: GlobeTile): void {
    const source = this.overlaySource;
    if (!source) return;
    const controller = this.begin('ovl', tile);
    const epoch = tile.epoch;
    const version = source.version;
    source
      .requestOverlay(tile.level, tile.x, tile.y, controller.signal)
      .then((bitmap) => {
        this.enqueueReady(
          tile,
          'ovl',
          controller,
          epoch,
          () => {
            if (source !== this.overlaySource) {
              bitmap?.close();
              return;
            }
            this.applyOverlay(tile, bitmap ? this.createTexture(tile, bitmap, true) : null, version);
            tile.ovl.succeed();
          },
          () => bitmap?.close(),
        );
      })
      .catch((err: unknown) => {
        this.finish('ovl', tile, controller);
        if (controller.signal.aborted || isAbortError(err) || source !== this.overlaySource) return;
        console.warn(`[Globe] overlay ${tile.key} failed:`, (err as Error).message);
        this.applyOverlay(tile, null, version);
        tile.ovl.fail(performance.now());
      });
  }

  private reportImageryError(tile: GlobeTile, err: Error): void {
    this.imageryErrors++;
    if (this.imageryErrors <= 3) console.warn(`[Globe] imagery ${tile.key} failed:`, err.message);
    if (this.imageryErrors === 3) {
      console.warn('[Globe] further imagery errors are suppressed');
      this.imageryErrorMessage = `${this.imagery.name} 无法访问（${err.message}）`;
      this.onImageryError?.(this.imageryErrorMessage);
    }
  }

  private createTexture(tile: GlobeTile, bitmap: ImageBitmap, overlay: boolean): SharedTexture {
    const texture = new Texture(bitmap);
    texture.flipY = false;
    if (overlay) texture.premultiplyAlpha = false;
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = this.maxAnisotropy;
    texture.needsUpdate = true;
    return new SharedTexture(texture, tile.level, tile.x, tile.y, bitmap.width * bitmap.height * 4 * 1.33);
  }

  // ---------------------------------------------------------------------------
  // Applying content

  private applyOverlay(tile: GlobeTile, texture: SharedTexture | null, version: number): void {
    tile.ownOverlay?.release();
    tile.ownOverlay = texture ? texture.acquire() : null;
    tile.overlayGen = version;
    this.resolveOverlay(tile);
    this.trackLoaded(tile);
  }

  /** Own overlay, or while it is being refreshed, the closest ancestor's (magnified). */
  private resolveOverlay(tile: GlobeTile): void {
    const source = this.overlaySource;
    let src: GlobeTile | null = null;
    if (source) {
      if (tile.ownOverlay) {
        src = tile;
      } else if (tile.overlayGen !== source.version) {
        src = tile.parent;
        while (src && !src.ownOverlay) src = src.parent;
      }
    }
    const shared = src?.ownOverlay ?? this.emptyOverlay;
    if (tile.overlay !== shared) {
      shared.acquire();
      tile.overlay?.release();
      tile.overlay = shared;
    }
    const material = tile.material;
    material.overlayMap = shared.texture;
    if (src && src !== tile) {
      const dz = tile.level - src.level;
      const scale = 1 / 2 ** dz;
      material.overlayTransform.set((tile.x - src.x * 2 ** dz) * scale, (tile.y - src.y * 2 ** dz) * scale, scale, scale);
    } else {
      material.overlayTransform.set(0, 0, 1, 1);
    }
  }

  private applyImagery(tile: GlobeTile, texture: SharedTexture | null, gen: number): void {
    tile.ownImagery?.release();
    tile.ownImagery = texture ? texture.acquire() : null;
    tile.imageryGen = gen;
    this.resolveImagery(tile);
    this.trackLoaded(tile);
  }

  /**
   * Picks this tile's own imagery or the closest ancestor's (magnified). When
   * the picture changes on a tile that is on screen, the old one cross-fades out.
   */
  private resolveImagery(tile: GlobeTile): void {
    let src: GlobeTile | null = tile;
    let stale: GlobeTile | null = null;
    while (src) {
      if (src.ownImagery) {
        if (src.imageryGen === this.imageryGen) break;
        stale ??= src;
      }
      src = src.parent;
    }
    src ??= stale;
    const shared = src?.ownImagery ?? this.placeholder;
    const material = tile.material;
    if (tile.imagery !== shared) {
      shared.acquire();
      const previous = tile.imagery;
      tile.imagery = shared;
      _prevTransform.copy(material.imageryTransform);
      this.setImageryTransform(tile, src);
      const onScreen = tile.mesh?.visible === true && tile.lastRenderedFrame >= this.frame - 1;
      if (previous && onScreen && this.fadeDuration > 0) {
        this.startFade(tile, previous, _prevTransform);
      } else {
        previous?.release();
      }
    } else {
      this.setImageryTransform(tile, src);
    }
    material.imageryMap = shared.texture;
    if (!tile.fadeFrom) {
      material.fadeMap = shared.texture;
      material.fadeTransform.copy(material.imageryTransform);
      material.fade = 1;
    }
  }

  private setImageryTransform(tile: GlobeTile, src: GlobeTile | null): void {
    const t = tile.material.imageryTransform;
    if (src && src !== tile) {
      const dz = tile.level - src.level;
      const scale = 1 / 2 ** dz;
      t.set((tile.x - src.x * 2 ** dz) * scale, (tile.y - src.y * 2 ** dz) * scale, scale, scale);
    } else {
      t.set(0, 0, 1, 1);
    }
  }

  /** Starts cross-fading from `from` (ownership of one reference passes to the tile). */
  private startFade(tile: GlobeTile, from: SharedTexture, fromTransform: Vector4): void {
    tile.fadeFrom?.release();
    tile.fadeFrom = from;
    tile.fadeStart = this.now;
    const m = tile.material;
    m.fadeMap = from.texture;
    m.fadeTransform.copy(fromTransform);
    m.fade = 0;
    this.fading.add(tile);
  }

  private endFade(tile: GlobeTile): void {
    this.fading.delete(tile);
    tile.fadeFrom?.release();
    tile.fadeFrom = null;
    const m = tile.material;
    m.fade = 1;
    m.fadeMap = m.imageryMap;
    m.fadeTransform.copy(m.imageryTransform);
  }

  private updateFades(): void {
    if (this.fading.size === 0) return;
    const duration = Math.max(1e-3, this.fadeDuration * 1000);
    for (const tile of this.fading) {
      const k = (this.now - tile.fadeStart) / duration;
      if (k >= 1 || !tile.fadeFrom) this.endFade(tile);
      else tile.material.fade = k * k * (3 - 2 * k);
    }
  }

  private applyGeometry(tile: GlobeTile, built: BuiltTile, gen: number): void {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(built.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(built.normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(built.uvs, 2));
    geometry.setIndex(new BufferAttribute(built.indices, 1));
    geometry.computeBoundingSphere();

    let mesh = tile.mesh;
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geometry;
    } else {
      tile.material.wireframe = this.wireframe;
      mesh = new Mesh(geometry, tile.material);
      mesh.name = `tile ${tile.key}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      mesh.userData.globeTile = tile;
      tile.mesh = mesh;
      this.group.add(mesh);
      // Show the best available imagery from the first frame on.
      this.resolveImagery(tile);
      this.resolveOverlay(tile);
    }
    mesh.position.set(built.center[0], built.center[1], built.center[2]);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);

    tile.geometryGen = gen;
    tile.upsampled = built.upsampled;
    tile.segments = this.segments;
    tile.heights = built.heights;
    tile.minHeight = built.minHeight;
    tile.maxHeight = built.maxHeight;
    tile.boundingSphere.center.set(built.center[0], built.center[1], built.center[2]);
    tile.boundingSphere.radius = built.boundingRadius;
    tile.horizonPoint = built.horizonPoint ? new Vector3(...built.horizonPoint) : null;
    if (tile.children) {
      const [lo, hi] = this.childHeightRange(tile);
      for (const c of tile.children) {
        if (!c.mesh || c.geometryGen !== gen) {
          c.minHeight = lo;
          c.maxHeight = hi;
          c.estimateBounds();
        }
      }
    }
    this.trackLoaded(tile);
  }

  private trackLoaded(tile: GlobeTile): void {
    if (tile.mesh || tile.ownImagery || tile.ownOverlay) this.loaded.add(tile);
  }

  // ---------------------------------------------------------------------------
  // Cache eviction

  private evict(): void {
    if (this.loaded.size <= this.maxCachedTiles) return;
    const target = Math.floor(this.maxCachedTiles * 0.9);
    const candidates = [...this.loaded].filter((t) => t.parent !== null && t.lastVisitedFrame < this.frame - 1);
    candidates.sort((a, b) => a.lastVisitedFrame - b.lastVisitedFrame || b.level - a.level);
    for (const tile of candidates) {
      if (this.loaded.size <= target) break;
      if (this.hasContentBelow(tile)) continue;
      this.unload(tile);
    }
  }

  private hasContentBelow(tile: GlobeTile): boolean {
    if (!tile.children) return false;
    for (const c of tile.children) {
      if (c.mesh || c.ownImagery || c.imagery || c.ownOverlay || c.loading || this.hasContentBelow(c)) return true;
    }
    return false;
  }

  private unload(tile: GlobeTile): void {
    tile.abortAll();
    tile.epoch++;
    if (this.fading.has(tile)) this.endFade(tile);
    if (tile.mesh) {
      tile.mesh.geometry.dispose();
      this.group.remove(tile.mesh);
      tile.mesh = null;
    }
    tile.ownImagery?.release();
    tile.ownImagery = null;
    tile.imagery?.release();
    tile.imagery = null;
    tile.ownOverlay?.release();
    tile.ownOverlay = null;
    tile.overlay?.release();
    tile.overlay = null;
    tile.overlayGen = -1;
    tile.material.overlayMap = EMPTY_OVERLAY;
    tile.heights = null;
    tile.upsampled = false;
    tile.geometryGen = -1;
    tile.imageryGen = -1;
    if (tile.children) {
      // Children carry no content at this point (leaf-first eviction); drop the nodes.
      for (const c of tile.children) {
        c.abortAll();
        c.epoch++;
        c.material.dispose();
      }
      tile.children = null;
    }
    this.loaded.delete(tile);
  }

  /** Debug: draw all tiles as wireframes. */
  setWireframe(on: boolean): void {
    this.wireframe = on;
    this.forEachTile((t) => {
      t.material.wireframe = on;
      t.material.needsUpdate = true;
    });
    for (const cap of this.caps) {
      const m = cap.material as TileMaterial;
      m.wireframe = on;
      m.needsUpdate = true;
    }
  }

  private forEachTile(cb: (t: GlobeTile) => void): void {
    const stack = [...this.roots];
    while (stack.length) {
      const t = stack.pop()!;
      cb(t);
      if (t.children) stack.push(...t.children);
    }
  }

  // ---------------------------------------------------------------------------
  // Queries

  /**
   * Terrain height (meters) at a position from the finest loaded tile, or null
   * if unknown. With `maxCellSize`, estimates from data coarser than that grid
   * spacing (meters) count as unknown: camera collision uses this so a coarse
   * or interpolated surface cannot push the camera up by hundreds of meters.
   */
  getHeight(longitude: number, latitude: number, maxCellSize = Infinity): number | null {
    if (!this.terrain) return 0;
    const n = this.scheme.tilesAtLevel(MIN_LEVEL);
    const { x, y } = this.scheme.positionToTile(MIN_LEVEL, longitude, latitude);
    let tile: GlobeTile | null = this.roots[y * n + x];
    let best: GlobeTile | null = null;
    const v = this.scheme.latitudeToMercatorV(latitude);
    const u = (longitude + Math.PI) / (2 * Math.PI);
    while (tile) {
      if (tile.heights && tile.geometryGen === this.geometryGen) best = tile;
      if (!tile.children) break;
      const scale = 2 ** (tile.level + 1);
      const cx = Math.min(1, Math.max(0, Math.floor(u * scale) - tile.x * 2));
      const cy = Math.min(1, Math.max(0, Math.floor(v * scale) - tile.y * 2));
      tile = tile.children[cy * 2 + cx];
    }
    if (!best) return null;
    if (maxCellSize < Infinity) {
      if (best.dataLevel < 0) return null;
      const cell = (2 * Math.PI * WGS84_A * Math.cos(latitude)) / 2 ** best.dataLevel / Math.max(1, best.segments);
      if (cell > maxCellSize) return null;
    }
    const scale = 2 ** best.level;
    return best.sampleHeight(u * scale - best.x, v * scale - best.y);
  }

  /** Nearest intersection of a world-space ray with the rendered globe surface. */
  raycast(ray: Ray): { point: Vector3; distance: number } | null {
    let bestDist = Infinity;
    const best = new Vector3();
    for (const tile of this.renderList) {
      const mesh = tile.mesh;
      if (!mesh || !ray.intersectsSphere(tile.boundingSphere)) continue;
      const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
      const index = mesh.geometry.getIndex()!;
      const triCount = tile.segments * tile.segments * 2;
      _localRay.origin.subVectors(ray.origin, mesh.position);
      _localRay.direction.copy(ray.direction);
      for (let t = 0; t < triCount; t++) {
        _a.fromBufferAttribute(pos, index.getX(t * 3));
        _b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
        _c.fromBufferAttribute(pos, index.getX(t * 3 + 2));
        if (_localRay.intersectTriangle(_a, _b, _c, false, _hit)) {
          const d = _hit.distanceTo(_localRay.origin);
          if (d < bestDist) {
            bestDist = d;
            best.copy(_hit).add(mesh.position);
          }
        }
      }
    }
    if (bestDist < Infinity) return { point: best, distance: bestDist };
    const t = this.ellipsoid.intersectRay(ray);
    return t === null ? null : { point: ray.at(t, new Vector3()), distance: t };
  }

  // ---------------------------------------------------------------------------
  // Polar caps (Web Mercator stops at about 85 degrees)

  private createPolarCaps(): void {
    for (const north of [true, false]) {
      const tex = new DataTexture(new Uint8Array(north ? [214, 226, 236, 255] : [236, 240, 244, 255]), 1, 1);
      tex.colorSpace = SRGBColorSpace;
      tex.needsUpdate = true;
      this.capTextures.push(tex);

      const rings = 8;
      const segs = 96;
      const sign = north ? 1 : -1;
      const lat0 = MERCATOR_MAX_LATITUDE * sign;
      const center = [0, 0, 0];
      geodeticToEcef(0, (Math.PI / 2) * sign, 0, center);
      const positions: number[] = [];
      const normals: number[] = [];
      const n = [0, 0, 0];
      const p = [0, 0, 0];
      const push = (lon: number, lat: number, h: number) => {
        geodeticToEcef(lon, lat, h, p);
        geodeticNormal(lon, lat, n);
        positions.push(p[0] - center[0], p[1] - center[1], p[2] - center[2]);
        normals.push(n[0], n[1], n[2]);
      };
      for (let r = 0; r <= rings; r++) {
        const lat = lat0 + ((Math.PI / 2) * sign - lat0) * (r / rings);
        for (let s = 0; s <= segs; s++) push(-Math.PI + (2 * Math.PI * s) / segs, lat, 0);
      }
      const skirtStart = positions.length / 3;
      for (let s = 0; s <= segs; s++) push(-Math.PI + (2 * Math.PI * s) / segs, lat0, -60_000);

      const indices: number[] = [];
      const row = segs + 1;
      const tri = (a: number, b: number, c: number) => (north ? indices.push(a, b, c) : indices.push(a, c, b));
      for (let r = 0; r < rings; r++) {
        for (let s = 0; s < segs; s++) {
          const a = r * row + s;
          tri(a, a + 1, a + row);
          tri(a + 1, a + row + 1, a + row);
        }
      }
      for (let s = 0; s < segs; s++) {
        // Skirt hanging below the outer ring, facing away from the pole.
        tri(s, skirtStart + s, s + 1);
        tri(s + 1, skirtStart + s, skirtStart + s + 1);
      }

      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
      geometry.setAttribute('uv', new BufferAttribute(new Float32Array((positions.length / 3) * 2).fill(0.5), 2));
      geometry.setIndex(indices);
      geometry.computeBoundingSphere();
      const mesh = new Mesh(geometry, createTileMaterial(tex, 0));
      mesh.name = north ? 'north cap' : 'south cap';
      mesh.position.set(center[0], center[1], center[2]);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.caps.push(mesh);
      this.group.add(mesh);
    }
  }

  /** Averages the outermost pixel row of polar-row tiles to color the caps. */
  private sampleCapColor(tile: GlobeTile, bitmap: ImageBitmap): void {
    const n = this.scheme.tilesAtLevel(tile.level);
    const which = tile.y === 0 ? 0 : tile.y === n - 1 ? 1 : -1;
    if (which < 0) return;
    try {
      const canvas = new OffscreenCanvas(bitmap.width, 1);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(bitmap, 0, which === 0 ? 0 : bitmap.height - 1, bitmap.width, 1, 0, 0, bitmap.width, 1);
      const d = ctx.getImageData(0, 0, bitmap.width, 1).data;
      const sum = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        sum[0] += d[i];
        sum[1] += d[i + 1];
        sum[2] += d[i + 2];
      }
      const count = d.length / 4;
      this.capColors[which].set(tile.x, [sum[0] / count, sum[1] / count, sum[2] / count]);
      const all = [...this.capColors[which].values()];
      const avg = [0, 1, 2].map((k) => all.reduce((s, c) => s + c[k], 0) / all.length);
      const tex = this.capTextures[which];
      (tex.image.data as Uint8Array).set([avg[0], avg[1], avg[2], 255]);
      tex.needsUpdate = true;
    } catch {
      // Cross-origin or canvas failures only affect the cap tint.
    }
  }

  dispose(): void {
    this.forEachTile((t) => t.abortAll());
    for (const item of this.ready) item.discard();
    this.ready = [];
    this.forEachTile((t) => this.unload(t));
    this.forEachTile((t) => t.material.dispose());
    for (const cap of this.caps) {
      cap.geometry.dispose();
      (cap.material as TileMaterial).dispose();
    }
    for (const tex of this.capTextures) tex.dispose();
    this.placeholder.release();
    this.emptyOverlay.release();
    this.workers.dispose();
    this.imagery.dispose?.();
  }
}
