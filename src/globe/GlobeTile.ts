import { Mesh, Sphere, Texture, Vector3 } from 'three';
import { computeHorizonCullingPoint, geodeticToEcef } from '../core/geodesy';
import type { GeoRect, WebMercatorTilingScheme } from './TilingScheme';
import { createTileMaterial, type TileMaterial } from './TileMaterial';

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

const _pts = new Float64Array(5 * 5 * 2 * 3);
const _p = [0, 0, 0];
const _v = new Vector3();

export class GlobeTile {
  readonly key: string;
  readonly rect: GeoRect;
  children: GlobeTile[] | null = null;

  // Culling volume (ECEF). Estimated until geometry arrives.
  minHeight: number;
  maxHeight: number;
  readonly boundingSphere = new Sphere();
  horizonPoint: Vector3 | null = null;
  /** Equator-most latitude, used for ground resolution. */
  readonly latForResolution: number;

  // Content.
  mesh: Mesh | null = null;
  heights: Float32Array | null = null;
  segments = 0;
  geometryGen = -1;
  imageryGen = -1;
  /** Imagery fetched for this exact tile (null when magnifying an ancestor). */
  ownImagery: SharedTexture | null = null;
  /** Imagery currently used for rendering (own or ancestor's). */
  imagery: SharedTexture | null = null;
  /** Overlay (e.g. rasterized vectors) produced for this exact tile. */
  ownOverlay: SharedTexture | null = null;
  /** Overlay used for rendering: own, a magnified ancestor's, or the empty texture. */
  overlay: SharedTexture | null = null;
  overlayGen = -1;
  /** Per-tile material instance; all tiles share one node graph / GPU pipeline. */
  readonly material: TileMaterial;

  // Loading.
  loading: AbortController | null = null;
  retryAt = 0;
  failures = 0;
  lastVisitedFrame = -1;
  lastRenderedFrame = -1;

  // Per-frame metrics.
  distance = 0;
  /** Load priority (lower loads first). */
  priority = 0;

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

  /** Whether the tile can be drawn (geometry and some imagery available). */
  get renderable(): boolean {
    return this.mesh !== null && this.imagery !== null;
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

  createChildren(scheme: WebMercatorTilingScheme): GlobeTile[] {
    if (!this.children) {
      const z = this.level + 1;
      const x = this.x * 2;
      const y = this.y * 2;
      // Children inherit the parent's height range (slightly padded) until their own data arrives.
      const pad = (this.maxHeight - this.minHeight) * 0.1;
      const lo = this.minHeight - pad;
      const hi = this.maxHeight + pad;
      this.children = [
        new GlobeTile(z, x, y, this, scheme, lo, hi),
        new GlobeTile(z, x + 1, y, this, scheme, lo, hi),
        new GlobeTile(z, x, y + 1, this, scheme, lo, hi),
        new GlobeTile(z, x + 1, y + 1, this, scheme, lo, hi),
      ];
    }
    return this.children;
  }

  /** Bilinear height sample at normalized tile coordinates (u east, v south). */
  sampleHeight(u: number, v: number): number | null {
    const h = this.heights;
    if (!h) return null;
    const n = this.segments;
    const fx = Math.min(n, Math.max(0, u * n));
    const fy = Math.min(n, Math.max(0, v * n));
    const x0 = Math.min(n - 1, Math.floor(fx));
    const y0 = Math.min(n - 1, Math.floor(fy));
    const tx = fx - x0;
    const ty = fy - y0;
    const row = n + 1;
    const a = h[y0 * row + x0] * (1 - tx) + h[y0 * row + x0 + 1] * tx;
    const b = h[(y0 + 1) * row + x0] * (1 - tx) + h[(y0 + 1) * row + x0 + 1] * tx;
    return a * (1 - ty) + b * ty;
  }
}
