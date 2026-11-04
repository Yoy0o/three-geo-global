import { Box3, DoubleSide, Matrix4, Mesh, Sphere, Vector3, type Material, type Object3D } from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { CesiumIonAuthPlugin, GLTFExtensionsPlugin, GoogleCloudAuthPlugin, TilesFadePlugin, UnloadTilesPlugin } from '3d-tiles-renderer/plugins';
import { EventEmitter } from '../core/EventEmitter';
import type { Ellipsoid } from '../core/Ellipsoid';
import { NodeFadeMaterialManager, NodeMaterialPlugin, type NodeMaterialLibrary } from './nodeMaterials';

export type TilesetSource =
  | { type: 'url'; url: string }
  | { type: 'ion'; assetId: number; token: string }
  | { type: 'google'; apiKey: string };

export interface Tiles3DLayerOptions {
  source: TilesetSource;
  name?: string;
  /** Target screen-space error in pixels (lower = more detail). */
  errorTarget?: number;
  /** Vertical offset in meters along the local up axis at the tileset center. */
  heightOffset?: number;
  /** Dithered cross-fade between levels of detail, in milliseconds (0 disables). */
  fadeDuration?: number;
}

export interface Tiles3DLayerEvents extends Record<string, unknown> {
  ready: { sphere: Sphere };
  error: { message: string };
  change: void;
}

/** Loader dependencies shared by all tilesets (decoders are heavy). */
export interface LoaderKit {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dracoLoader: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ktxLoader: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meshoptDecoder: any;
  /** Renderer node library; enables node materials (and with them the WebGPU fade). */
  nodeLibrary?: NodeMaterialLibrary;
}

/** GPU memory hidden tiles may keep before they are unloaded (re-uploading is what makes turning around stutter). */
const HIDDEN_TILE_GPU_BUDGET = 192 * 2 ** 20;

let nextId = 1;

/**
 * An OGC 3D Tiles tileset (b3dm / i3dm / pnts / cmpt / glTF content, implicit
 * tiling) driven by NASA-AMMOS 3DTilesRendererJS. Tile selection, caching and
 * parsing come from the library; this wrapper handles placement on the globe,
 * credentials, node materials, the WebGPU LOD fade and lifecycle.
 */
export class Tiles3DLayer {
  readonly id = nextId++;
  readonly name: string;
  readonly tiles: TilesRenderer;
  readonly events = new EventEmitter<Tiles3DLayerEvents>();
  readonly source: TilesetSource;
  ready = false;
  /** Bounding sphere in world (ECEF) space once the root tileset is loaded. */
  readonly boundingSphere = new Sphere();
  private _heightOffset: number;
  private _visible = true;
  private _suppressed = false;
  private readonly baseMatrix = new Matrix4();

  constructor(
    options: Tiles3DLayerOptions,
    loaders: LoaderKit,
    private readonly ellipsoid: Ellipsoid,
  ) {
    this.source = options.source;
    this.name = options.name ?? defaultName(options.source);
    this._heightOffset = options.heightOffset ?? 0;

    const src = options.source;
    const tiles = src.type === 'url' ? new TilesRenderer(src.url) : new TilesRenderer();
    if (src.type === 'ion') {
      tiles.registerPlugin(new CesiumIonAuthPlugin({ apiToken: src.token, assetId: String(src.assetId), autoRefreshToken: true }));
    } else if (src.type === 'google') {
      tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: src.apiKey, autoRefreshToken: true }));
    }
    tiles.registerPlugin(
      new GLTFExtensionsPlugin({
        dracoLoader: loaders.dracoLoader,
        ktxLoader: loaders.ktxLoader,
        meshoptDecoder: loaders.meshoptDecoder,
        rtc: true,
        // Metadata texture reads rely on a WebGL renderer internally; keep tiles WebGPU-only.
        metadata: false,
        autoDispose: false,
      }),
    );
    if (loaders.nodeLibrary) {
      tiles.registerPlugin(new NodeMaterialPlugin(loaders.nodeLibrary));
      const fadeDuration = options.fadeDuration ?? 300;
      if (fadeDuration > 0) {
        const fade = new TilesFadePlugin({ fadeDuration, fadeRootTiles: true, maximumFadeOutTiles: 60 });
        // The stock material manager patches GLSL through onBeforeCompile (a no-op under
        // WebGPU); swap in the TSL one. Its interface is the same three methods.
        (fade as unknown as { _fadeMaterialManager: NodeFadeMaterialManager })._fadeMaterialManager = new NodeFadeMaterialManager();
        tiles.registerPlugin(fade);
      }
    }
    // Free GPU memory of hidden tiles only beyond a budget, and not right away.
    tiles.registerPlugin(new UnloadTilesPlugin({ delay: 3000, bytesTarget: HIDDEN_TILE_GPU_BUDGET }));
    tiles.errorTarget = options.errorTarget ?? 12;
    tiles.group.name = `3D Tiles: ${this.name}`;
    this.tiles = tiles;

    tiles.addEventListener('load-root-tileset', () => this.onRootLoaded());
    if (!loaders.nodeLibrary) tiles.addEventListener('load-model', (e: { scene: Object3D }) => this.onModelLoaded(e.scene));
    tiles.addEventListener('load-error', (e: { error: Error; url: string | URL }) => {
      const message = `${e.error?.message ?? e.error} (${String(e.url)})`;
      console.warn('[3D Tiles]', message);
      if (!this.ready) this.events.emit('error', { message });
    });
    tiles.addEventListener('needs-update', () => this.events.emit('change', undefined));
  }

  get group(): Object3D {
    return this.tiles.group;
  }

  get visible(): boolean {
    return this._visible;
  }

  set visible(v: boolean) {
    this._visible = v;
    this.tiles.group.visible = v && !this._suppressed;
  }

  /** Temporarily hidden by the viewer (e.g. while inside a building), independent of `visible`. */
  get suppressed(): boolean {
    return this._suppressed;
  }

  set suppressed(v: boolean) {
    this._suppressed = v;
    this.tiles.group.visible = this._visible && !v;
  }

  /** Visible and not suppressed: drawn, updated and pickable. */
  get active(): boolean {
    return this._visible && !this._suppressed;
  }

  get heightOffset(): number {
    return this._heightOffset;
  }

  set heightOffset(meters: number) {
    this._heightOffset = meters;
    this.applyPlacement();
  }

  /** Call once per frame after the camera has been updated. */
  update(): void {
    if (this.active) this.tiles.update();
  }

  private onRootLoaded(): void {
    const sphere = new Sphere();
    if (!this.tiles.getBoundingSphere(sphere)) {
      const box = new Box3();
      if (this.tiles.getBoundingBox(box)) box.getBoundingSphere(sphere);
    }
    this.baseMatrix.identity();
    this.boundingSphere.copy(sphere);
    this.applyPlacement();
    this.ready = true;
    this.events.emit('ready', { sphere: this.boundingSphere });
  }

  private applyPlacement(): void {
    const group = this.tiles.group;
    group.matrix.copy(this.baseMatrix);
    const center = this.boundingSphere.center;
    if (this._heightOffset !== 0 && center.lengthSq() > 1) {
      const up = this.ellipsoid.geodeticSurfaceNormal(center, new Vector3());
      group.matrix.premultiply(new Matrix4().makeTranslation(up.multiplyScalar(this._heightOffset)));
    }
    group.matrix.decompose(group.position, group.quaternion, group.scale);
    group.updateMatrixWorld(true);
  }

  /** Fallback without node materials: just make every material double sided. */
  private onModelLoaded(scene: Object3D): void {
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[];
      for (const m of materials) m.side = DoubleSide;
    });
  }

  dispose(): void {
    this.tiles.group.removeFromParent();
    this.tiles.dispose();
  }
}

function defaultName(src: TilesetSource): string {
  if (src.type === 'google') return 'Google Photorealistic 3D Tiles';
  if (src.type === 'ion') return `Cesium ion #${src.assetId}`;
  try {
    const u = new URL(src.url, location.href);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : u.hostname;
  } catch {
    return src.url;
  }
}
