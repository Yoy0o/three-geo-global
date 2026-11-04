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
} from 'three';
import { Ellipsoid, cartographic, type Cartographic } from '../core/Ellipsoid';
import { geodeticNormal, geodeticToEcef, isScaledSpacePointVisible, WGS84_A } from '../core/geodesy';
import { clamp, wrapPi } from '../core/math';
import { GlobeTile, SharedTexture } from './GlobeTile';
import { createTileMaterial, EMPTY_OVERLAY, type TileMaterial } from './TileMaterial';
import type { TileOverlaySource } from './overlay';
import { MERCATOR_MAX_LATITUDE, WebMercatorTilingScheme } from './TilingScheme';
import { isAbortError, TileWorkerPool } from './TileWorkerPool';
import type { ImageryProvider } from './imagery/ImageryProvider';
import { isQuantizedMesh, type TerrainSource } from './terrain/TerrainSource';
import type { BuiltTile } from './workerProtocol';

export interface GlobeOptions {
  imagery: ImageryProvider;
  terrain?: TerrainSource | null;
  terrainExaggeration?: number;
  /** Refine until one imagery texel covers at most this many CSS pixels. */
  maxScreenSpaceError?: number;
  maxCachedTiles?: number;
  maxConcurrentLoads?: number;
  /** Grid cells per tile edge. */
  segments?: number;
  maxAnisotropy?: number;
}

export interface GlobeStats {
  rendered: number;
  cached: number;
  loading: number;
  queued: number;
  maxLevel: number;
}

const IMAGERY_TILE_SIZE = 256;
const MIN_LEVEL = 2;
const MAX_LEVEL = 22;
const TERRAIN_MAX_HEIGHT = 8900;
/** Lowest ellipsoidal height of the geoid-corrected sea surface (EGM96 minimum is about -107 m). */
const TERRAIN_MIN_HEIGHT = -120;

const _projScreen = new Matrix4();
const _p = [0, 0, 0];
const _v = new Vector3();
const _localRay = new Ray();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _hit = new Vector3();

/** Routes tiles that share cached source data (same terrain ancestor / column) to the same worker. */
function terrainAffinity(terrain: TerrainSource, tile: GlobeTile): string | undefined {
  if (isQuantizedMesh(terrain)) {
    const g = Math.max(0, Math.min(terrain.geographicMaxZoom, tile.level - 1));
    const shift = tile.level - 1 - g;
    return shift > 0 ? `qm:${g}/${tile.x >> shift}` : undefined;
  }
  if (tile.level <= terrain.maxZoom) return undefined;
  const dz = tile.level - terrain.maxZoom;
  return `${dz}:${tile.x >> dz}/${tile.y >> dz}`;
}

export class Globe {
  readonly group = new Group();
  readonly scheme = new WebMercatorTilingScheme();
  readonly ellipsoid = Ellipsoid.WGS84;
  readonly stats: GlobeStats = { rendered: 0, cached: 0, loading: 0, queued: 0, maxLevel: 0 };

  maxScreenSpaceError: number;
  maxCachedTiles: number;
  maxConcurrentLoads: number;
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
  private readonly loadingTiles = new Set<GlobeTile>();
  private requests: GlobeTile[] = [];
  private renderList: GlobeTile[] = [];
  private prevRenderList: GlobeTile[] = [];
  private frame = 0;
  private imageryGen = 0;
  private geometryGen = 0;
  private placeholder: SharedTexture;
  private overlaySource: TileOverlaySource | null = null;
  private readonly emptyOverlay: SharedTexture;

  // Per-frame camera state.
  private readonly frustum = new Frustum();
  private readonly cameraPosition = new Vector3();
  private readonly cameraCarto: Cartographic = cartographic();
  private readonly cameraScaled = new Vector3();
  private horizonCulling = true;
  private sseFactor = 1;

  // Polar caps.
  private readonly caps: Mesh[] = [];
  private readonly capTextures: DataTexture[] = [];
  private readonly capColors = [new Map<number, number[]>(), new Map<number, number[]>()];

  constructor(options: GlobeOptions) {
    this.imagery = options.imagery;
    this.terrain = options.terrain ?? null;
    this.exaggeration = options.terrainExaggeration ?? 1;
    this.maxScreenSpaceError = options.maxScreenSpaceError ?? 1.25;
    this.maxCachedTiles = options.maxCachedTiles ?? 450;
    this.maxConcurrentLoads = options.maxConcurrentLoads ?? 16;
    this.segments = options.segments ?? 32;
    this.maxAnisotropy = options.maxAnisotropy ?? 8;
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
    this.abortAll();
  }

  /** Drapes a tile overlay source (e.g. rasterized vector layers) over the imagery. */
  setOverlaySource(source: TileOverlaySource | null): void {
    if (source === this.overlaySource) return;
    this.overlaySource = source;
    this.forEachTile((t) => {
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
    this.abortAll();
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
    this.prepareCamera(camera, viewportHeightCss);

    this.renderList = [];
    this.requests = [];
    for (const root of this.roots) this.visit(root);

    // Toggle visibility instead of re-parenting meshes.
    for (const t of this.prevRenderList) if (t.mesh) t.mesh.visible = false;
    let maxLevel = 0;
    for (const t of this.renderList) {
      if (t.mesh) t.mesh.visible = true;
      t.lastRenderedFrame = this.frame;
      if (!t.ownImagery || t.imageryGen !== this.imageryGen) this.resolveImagery(t);
      if (this.overlaySource && (t.overlayGen !== this.overlaySource.version || t.overlay !== (t.ownOverlay ?? this.emptyOverlay))) {
        this.resolveOverlay(t);
      }
      maxLevel = Math.max(maxLevel, t.level);
    }
    this.prevRenderList = this.renderList;

    this.cancelStaleLoads();
    this.processRequests();
    if (this.frame % 30 === 0) this.evict();

    this.stats.rendered = this.renderList.length;
    this.stats.cached = this.loaded.size;
    this.stats.loading = this.loadingTiles.size;
    this.stats.queued = this.requests.length;
    this.stats.maxLevel = maxLevel;
  }

  private prepareCamera(camera: PerspectiveCamera, viewportHeightCss: number): void {
    camera.updateMatrixWorld();
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(_projScreen, camera.coordinateSystem, camera.reversedDepth);
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.ellipsoid.cartesianToCartographic(this.cameraPosition, this.cameraCarto);
    this.cameraScaled.copy(this.cameraPosition).multiply(this.ellipsoid.oneOverRadii);
    // Below/near the ellipsoid (e.g. with terrain under sea level) the occluder is unreliable.
    this.horizonCulling = this.cameraCarto.height > 100;
    const fov = (camera.getEffectiveFOV() * Math.PI) / 180;
    this.sseFactor = viewportHeightCss / (2 * Math.tan(fov / 2));
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

  private isStale(tile: GlobeTile): boolean {
    return (
      !tile.mesh ||
      tile.geometryGen !== this.geometryGen ||
      !tile.imagery ||
      tile.imageryGen !== this.imageryGen ||
      this.overlayNeedsRequest(tile)
    );
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

  private request(tile: GlobeTile, penalty = 0): void {
    tile.lastVisitedFrame = this.frame;
    if (tile.loading) return;
    // Sort key: coarse levels first, then by distance; `penalty` defers optional work.
    tile.priority = penalty + tile.level * 1e9 + Math.min(tile.distance, 1e9 - 1);
    this.requests.push(tile);
  }

  private visit(tile: GlobeTile): void {
    tile.lastVisitedFrame = this.frame;
    if (!this.isVisible(tile)) return;
    tile.distance = this.tileDistance(tile);
    const sse = this.computeSSE(tile);

    const maxLevel = Math.min(MAX_LEVEL, Math.max(this.imagery.maxZoom, this.terrain ? this.terrain.maxZoom : 0));
    const wantRefine = sse > this.maxScreenSpaceError && tile.level < maxLevel;

    if (wantRefine && tile.renderable) {
      const children = tile.createChildren(this.scheme);
      let ready = true;
      for (const child of children) {
        child.lastVisitedFrame = this.frame;
        if (!this.isVisible(child)) continue;
        if (!child.renderable) {
          ready = false;
          child.distance = this.tileDistance(child);
          this.request(child);
        }
      }
      if (ready) {
        // Keep ancestors fresh so they can serve as fallbacks, at lower priority.
        if (this.isStale(tile)) this.request(tile, 1e12);
        for (const child of children) this.visit(child);
        return;
      }
    }

    if (tile.renderable) {
      this.renderList.push(tile);
      if (this.isStale(tile)) this.request(tile);
    } else {
      this.request(tile);
    }
  }

  // ---------------------------------------------------------------------------
  // Loading

  private processRequests(): void {
    if (this.requests.length === 0) return;
    this.requests.sort((a, b) => a.priority - b.priority);
    const now = performance.now();
    for (const tile of this.requests) {
      if (this.loadingTiles.size >= this.maxConcurrentLoads) break;
      if (tile.loading || now < tile.retryAt) continue;
      this.startLoad(tile);
    }
  }

  private cancelStaleLoads(): void {
    for (const tile of this.loadingTiles) {
      if (this.frame - tile.lastVisitedFrame > 15) tile.loading?.abort();
    }
  }

  private abortAll(): void {
    for (const tile of this.loadingTiles) tile.loading?.abort();
  }

  private startLoad(tile: GlobeTile): void {
    const controller = new AbortController();
    tile.loading = controller;
    this.loadingTiles.add(tile);

    const geometryGen = this.geometryGen;
    const imageryGen = this.imageryGen;
    const needGeometry = !tile.mesh || tile.geometryGen !== geometryGen;
    const needImagery = !tile.imagery || tile.imageryGen !== imageryGen;
    const terrain = this.terrain;

    if (terrain && needGeometry) this.workers.registerTerrain(terrain);
    const geometry: Promise<BuiltTile | null> = needGeometry
      ? this.workers.build(
          {
            level: tile.level,
            x: tile.x,
            y: tile.y,
            segments: this.segments,
            terrainId: terrain?.id ?? null,
            exaggeration: this.exaggeration,
            clampToSeaLevel: true,
          },
          controller.signal,
          terrain ? terrainAffinity(terrain, tile) : undefined,
        )
      : Promise.resolve(null);
    const imagery: Promise<SharedTexture | null | undefined> = needImagery ? this.loadImagery(tile, controller.signal) : Promise.resolve(undefined);
    const overlaySource = this.overlaySource;
    const overlayVersion = overlaySource?.version ?? -1;
    const overlay: Promise<SharedTexture | null | undefined> =
      overlaySource && this.overlayNeedsRequest(tile) ? this.loadOverlay(overlaySource, tile, controller.signal) : Promise.resolve(undefined);

    void Promise.allSettled([geometry, imagery, overlay]).then(([g, i, o]) => {
      tile.loading = null;
      this.loadingTiles.delete(tile);
      const aborted = controller.signal.aborted;

      if (o.status === 'fulfilled' && o.value !== undefined) {
        if (!aborted && overlaySource === this.overlaySource) this.applyOverlay(tile, o.value, overlayVersion);
        else o.value?.acquire().release();
      } else if (o.status === 'rejected' && !aborted && !isAbortError(o.reason) && overlaySource === this.overlaySource) {
        console.warn(`[Globe] overlay ${tile.key} failed:`, (o.reason as Error).message);
        this.applyOverlay(tile, null, overlayVersion);
      }

      if (i.status === 'fulfilled' && i.value !== undefined) {
        if (!aborted && imageryGen === this.imageryGen) this.applyImagery(tile, i.value, imageryGen);
        else i.value?.acquire().release();
      } else if (i.status === 'rejected' && !aborted && !isAbortError(i.reason) && imageryGen === this.imageryGen) {
        this.reportImageryError(tile, i.reason as Error);
        // Show a magnified ancestor for now, but stay stale so the tile is retried with backoff.
        if (!tile.ownImagery) this.applyImagery(tile, null, imageryGen);
        tile.imageryGen = -1;
        tile.failures++;
        tile.retryAt = performance.now() + Math.min(30_000, 1000 * 2 ** tile.failures);
      }

      if (aborted) return;
      if (g.status === 'fulfilled') {
        if (g.value && geometryGen === this.geometryGen) this.applyGeometry(tile, g.value, geometryGen);
        if (i.status === 'fulfilled') tile.failures = 0;
      } else if (!isAbortError(g.reason)) {
        tile.failures++;
        tile.retryAt = performance.now() + Math.min(30_000, 1000 * 2 ** tile.failures);
        console.warn(`[Globe] geometry ${tile.key} failed:`, (g.reason as Error).message);
      }
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

  private async loadImagery(tile: GlobeTile, signal: AbortSignal): Promise<SharedTexture | null> {
    const provider = this.imagery;
    if (tile.level > provider.maxZoom || tile.level < provider.minZoom) return null;
    const bitmap = await provider.requestImage(tile.level, tile.x, tile.y, signal);
    if (!bitmap) return null;
    if (signal.aborted) {
      bitmap.close();
      throw new DOMException('Aborted', 'AbortError');
    }
    if (tile.level === MIN_LEVEL) this.sampleCapColor(tile, bitmap);
    const texture = new Texture(bitmap);
    texture.flipY = false;
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = this.maxAnisotropy;
    texture.needsUpdate = true;
    return new SharedTexture(texture, tile.level, tile.x, tile.y, bitmap.width * bitmap.height * 4 * 1.33);
  }

  private async loadOverlay(source: TileOverlaySource, tile: GlobeTile, signal: AbortSignal): Promise<SharedTexture | null> {
    const bitmap = await source.requestOverlay(tile.level, tile.x, tile.y, signal);
    if (!bitmap) return null;
    if (signal.aborted) {
      bitmap.close();
      throw new DOMException('Aborted', 'AbortError');
    }
    const texture = new Texture(bitmap);
    texture.flipY = false;
    texture.premultiplyAlpha = false;
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = this.maxAnisotropy;
    texture.needsUpdate = true;
    return new SharedTexture(texture, tile.level, tile.x, tile.y, bitmap.width * bitmap.height * 4 * 1.33);
  }

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

  /** Picks this tile's own imagery or the closest ancestor's (magnified). */
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
    if (tile.imagery !== shared) {
      shared.acquire();
      tile.imagery?.release();
      tile.imagery = shared;
    }
    const material = tile.material;
    material.imageryMap = shared.texture;
    if (src && src !== tile) {
      const dz = tile.level - src.level;
      const scale = 1 / 2 ** dz;
      material.imageryTransform.set((tile.x - src.x * 2 ** dz) * scale, (tile.y - src.y * 2 ** dz) * scale, scale, scale);
    } else {
      material.imageryTransform.set(0, 0, 1, 1);
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
    }
    mesh.position.set(built.center[0], built.center[1], built.center[2]);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);

    tile.geometryGen = gen;
    tile.segments = this.segments;
    tile.heights = built.heights;
    tile.minHeight = built.minHeight;
    tile.maxHeight = built.maxHeight;
    tile.boundingSphere.center.set(built.center[0], built.center[1], built.center[2]);
    tile.boundingSphere.radius = built.boundingRadius;
    tile.horizonPoint = built.horizonPoint ? new Vector3(...built.horizonPoint) : null;
    if (tile.children) {
      for (const c of tile.children) {
        if (!c.mesh || c.geometryGen !== gen) {
          c.minHeight = built.minHeight;
          c.maxHeight = built.maxHeight;
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
    tile.loading?.abort();
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
    tile.geometryGen = -1;
    tile.imageryGen = -1;
    if (tile.children) {
      // Children carry no content at this point (leaf-first eviction); drop the nodes.
      for (const c of tile.children) c.material.dispose();
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

  /** Terrain height (meters) at a position from the finest loaded tile, or null if unknown. */
  getHeight(longitude: number, latitude: number): number | null {
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
    this.abortAll();
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
