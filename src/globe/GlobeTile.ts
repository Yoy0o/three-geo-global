/**
 * One node of the globe quadtree: culling volume, content (mesh, imagery,
 * overlay) and per-channel load state. Scheduling lives in `Globe`.
 */
import { type BufferAttribute, Mesh, Sphere, Texture, Vector3 } from 'three';
import { computeHorizonCullingPoint, geodeticToEcef } from '../core/geodesy';
import { sampleHeightGrid } from './terrain/terrainTiling';
import type { GeoRect, WebMercatorTilingScheme } from './TilingScheme';
import { createTileMaterial, MORPH_ATTRIBUTE, type TileMaterial } from './TileMaterial';
import { TileSelection, type SelectionNode } from './tileSelection';

/** Reference-counted texture shared between a tile and descendants that magnify it. */
export class SharedTexture {
  private refs = 0;
  constructor(
    readonly texture: Texture,
    readonly level: number,
    readonly x: number,
    readonly y: number,
    readonly bytes: number,
  ) {}

  acquire(): this {
    this.refs++;
    return this;
  }

  release(): void {
    if (--this.refs > 0) return;
    this.texture.dispose();
    const image = this.texture.image as { close?: () => void } | null;
    image?.close?.();
  }
}

/** Load state of one kind of tile content (geometry, imagery or overlay). */
export class LoadChannel {
  /** In-flight request (kept until its result has been applied or discarded). */
  loading: AbortController | null = null;
  retryAt = 0;
  failures = 0;
  /** Sort key for this frame's queue (lower loads first). */
  priority = 0;
  /** Priority bucket for this frame's queue. */
  bucket = 0;
  /** Last frame the content was wanted; in-flight loads not wanted for a while are cancelled. */
  wantedFrame = -1;
  /** In-flight geometry is built from loaded heights (no download); such jobs have their own concurrency budget. */
  local = false;

  fail(now: number): void {
    this.failures++;
    this.retryAt = now + Math.min(30_000, 1000 * 2 ** this.failures);
  }

  succeed(): void {
    this.failures = 0;
    this.retryAt = 0;
  }
}

const _pts = new Float64Array(5 * 5 * 2 * 3);
const _p = [0, 0, 0];
const _v = new Vector3();

export class GlobeTile implements SelectionNode<GlobeTile> {
  readonly key: string;
  readonly rect: GeoRect;
  children: GlobeTile[] | null = null;

  // Selection memory (CesiumJS `TileSelectionResult`): what the last traversal that visited this tile did with it.
  selection: TileSelection = TileSelection.NONE;
  selectionFrame = -1;
  /**
   * Drawn only so that detail on screen does not vanish while an ancestor
   * that should replace it is still loading; such tiles load nothing.
   */
  keptForDetail = false;
  /** Last frame the parent's quadrant was drawn in place of this tile (a fill, see `fills`). */
  filledFrame = -1;
  /** Start (ms) of the running geometry morph (`material.morph` < 1). */
  morphStart = 0;
  /** Frame of the cached visibility test (`inView`). */
  cullFrame = -1;
  inView = false;

  // Culling volume (ECEF). Estimated until geometry arrives.
  minHeight: number;
  maxHeight: number;
  readonly boundingSphere = new Sphere();
  horizonPoint: Vector3 | null = null;
  /** Equator-most latitude, used for ground resolution. */
  readonly latForResolution: number;

  // Content.
  mesh: Mesh | null = null;
  /**
   * Quadrants of `mesh` (index = qy * 2 + qx), created on demand: drawn in
   * place of a child that has no mesh yet so this tile can stay refined
   * (CesiumJS "fill" tiles). They share the mesh's vertex buffers and material.
   */
  fills: (Mesh | null)[] | null = null;
  heights: Float32Array | null = null;
  segments = 0;
  geometryGen = -1;
  /** Mesh was built from an ancestor's heights; the exact terrain is still to come. */
  upsampled = false;
  /** Level whose terrain data the mesh was built from (-1 = none, e.g. the flat start-up mesh). */
  dataLevel = -1;
  imageryGen = -1;
  /** Imagery fetched for this exact tile (null when magnifying an ancestor). */
  ownImagery: SharedTexture | null = null;
  /** Imagery currently used for rendering (own, an ancestor's, or the placeholder). */
  imagery: SharedTexture | null = null;
  /** Previous imagery while cross-fading to `imagery`. */
  fadeFrom: SharedTexture | null = null;
  fadeStart = 0;
  /** Since when (ms) better imagery has been available but held back (0 = none; see `Globe.updateShownImagery`). */
  imageryPendingSince = 0;
  /** Overlay (e.g. rasterized vectors) produced for this exact tile. */
  ownOverlay: SharedTexture | null = null;
  /** Overlay used for rendering: own, a magnified ancestor's, or the empty texture. */
  overlay: SharedTexture | null = null;
  overlayGen = -1;
  /** Per-tile material instance; all tiles share one node graph / GPU pipeline. */
  readonly material: TileMaterial;

  // Loading.
  readonly geo = new LoadChannel();
  readonly img = new LoadChannel();
  readonly ovl = new LoadChannel();
  /** Bumped when content is unloaded, so late results for the old content are dropped. */
  epoch = 0;
  lastVisitedFrame = -1;
  lastRenderedFrame = -1;

  // Per-frame metrics.
  distance = 0;

  constructor(
    readonly level: number,
    readonly x: number,
    readonly y: number,
    readonly parent: GlobeTile | null,
    scheme: WebMercatorTilingScheme,
    minHeight: number,
    maxHeight: number,
  ) {
    this.key = `${level}/${x}/${y}`;
    this.rect = scheme.tileRect(level, x, y);
    this.minHeight = minHeight;
    this.maxHeight = maxHeight;
    const { south, north } = this.rect;
    this.latForResolution = south <= 0 && north >= 0 ? 0 : Math.min(Math.abs(south), Math.abs(north));
    this.material = createTileMaterial(undefined, level);
    this.estimateBounds();
  }

  /** Whether the tile can be drawn. Imagery always resolves (own, ancestor or placeholder). */
  get renderable(): boolean {
    return this.mesh !== null;
  }

  /** Any request in flight. */
  get loading(): boolean {
    return this.geo.loading !== null || this.img.loading !== null || this.ovl.loading !== null;
  }

  abortAll(): void {
    this.geo.loading?.abort();
    this.img.loading?.abort();
    this.ovl.loading?.abort();
  }

  /** Conservative bounds from a 5x5 sample of the tile at min/max height. */
  estimateBounds(): void {
    const { west, east, south, north } = this.rect;
    let k = 0;
    for (let j = 0; j < 5; j++) {
      const lat = south + ((north - south) * j) / 4;
      for (let i = 0; i < 5; i++) {
        const lon = west + ((east - west) * i) / 4;
        geodeticToEcef(lon, lat, this.minHeight, _pts, k * 3);
        k++;
        geodeticToEcef(lon, lat, this.maxHeight, _pts, k * 3);
        k++;
      }
    }
    geodeticToEcef((west + east) / 2, (south + north) / 2, (this.minHeight + this.maxHeight) / 2, _p);
    const center = this.boundingSphere.center.set(_p[0], _p[1], _p[2]);
    let r2 = 0;
    for (let i = 0; i < k; i++) {
      _v.set(_pts[i * 3], _pts[i * 3 + 1], _pts[i * 3 + 2]);
      r2 = Math.max(r2, _v.distanceToSquared(center));
    }
    this.boundingSphere.radius = Math.sqrt(r2);
    const hp = computeHorizonCullingPoint(center.x, center.y, center.z, _pts, k);
    this.horizonPoint = hp ? new Vector3(hp[0], hp[1], hp[2]) : null;
  }

  /**
   * Creates the four children. They inherit a height range (default: this
   * tile's, slightly padded) for culling until their own data arrives; pass a
   * wider range when this tile's heights are only an estimate.
   */
  createChildren(scheme: WebMercatorTilingScheme, range?: [number, number]): GlobeTile[] {
    if (!this.children) {
      const z = this.level + 1;
      const x = this.x * 2;
      const y = this.y * 2;
      const [min, max] = range ?? [this.minHeight, this.maxHeight];
      const pad = (max - min) * 0.1;
      const lo = min - pad;
      const hi = max + pad;
      this.children = [
        new GlobeTile(z, x, y, this, scheme, lo, hi),
        new GlobeTile(z, x + 1, y, this, scheme, lo, hi),
        new GlobeTile(z, x, y + 1, this, scheme, lo, hi),
        new GlobeTile(z, x + 1, y + 1, this, scheme, lo, hi),
      ];
    }
    return this.children;
  }

  /** Morph offsets of the current mesh (see `TileMaterial.morph`). */
  get morphAttribute(): BufferAttribute | null {
    return (this.mesh?.geometry.getAttribute(MORPH_ATTRIBUTE) as BufferAttribute | undefined) ?? null;
  }

  /**
   * Height the mesh is drawn at right now for grid vertex (i, j): its own
   * height, minus what is left of a running morph.
   */
  shownGridHeight(i: number, j: number): number | null {
    if (!this.heights) return null;
    const k = j * (this.segments + 1) + i;
    const m = this.material.morph;
    const delta = m < 1 ? (this.morphAttribute?.getX(k) ?? 0) : 0;
    return this.heights[k] - delta * (1 - m);
  }

  /** Bilinear height sample at normalized tile coordinates (u east, v south). */
  sampleHeight(u: number, v: number): number | null {
    return this.heights ? sampleHeightGrid(this.heights, this.segments, u, v) : null;
  }
}
