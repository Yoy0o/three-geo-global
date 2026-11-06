import {
  Color,
  DirectionalLight,
  HemisphereLight,
  NeutralToneMapping,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  type Object3D,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { float, positionWorldDirection, vec3 } from 'three/tsl';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { atmosphereUniforms, skyColorNode, Z_SCALE } from '../atmosphere/AtmosphereNodes';
import { StarField } from '../atmosphere/Stars';
import { cartographic, Ellipsoid, type Cartographic } from '../core/Ellipsoid';
import { EventEmitter } from '../core/EventEmitter';
import { clamp, DEG2RAD, smoothstep } from '../core/math';
import { greenwichMeanSiderealTime, sunDirectionECEF } from '../core/SunPosition';
import { Globe, type GlobeOptions } from '../globe/Globe';
import { OverlayCompositor } from '../globe/OverlayCompositor';
import type { BimEntity } from '../indoor/BimEntity';
import { IndoorManager } from '../indoor/IndoorManager';
import { MarkerManager } from '../markers/MarkerManager';
import { PointLayer, type PointLayerOptions } from '../markers/PointLayer';
import type { PointRecord } from '../markers/points';
import { Tiles3DLayer, type LoaderKit, type Tiles3DLayerOptions } from '../tiles3d/Tiles3DLayer';
import type { NodeMaterialLibrary } from '../tiles3d/nodeMaterials';
import { GeoJsonLayer, type GeoJsonLayerOptions } from '../vector/GeoJsonLayer';
import { lonLatToMerc } from '../vector/geometry';
import { LabelManager } from '../vector/LabelManager';
import type { FeatureHit } from '../vector/types';
import { VectorService } from '../vector/VectorService';
import { cameraDirection, getHeadingPitch, lookAtHeadingPitchRange } from './cameraMath';
import { GlobeCameraController, type AutoOrbitOptions, type ControllerHost } from './GlobeCameraController';
import { InteractionManager, type PickInfo } from './InteractionManager';

export interface ViewPosition {
  /** Degrees. */
  longitude: number;
  /** Degrees. */
  latitude: number;
  /** Meters above the ellipsoid. */
  height: number;
  /** Degrees, clockwise from north. */
  heading?: number;
  /** Degrees, negative looks down. */
  pitch?: number;
}

/** Look at a point from a heading / pitch / range (ThingJS `flyTo({ target, horzAngle, vertAngle })`). */
export interface TargetView {
  /** Degrees / meters, or a world (ECEF) point. */
  target: { longitude: number; latitude: number; height?: number } | Vector3;
  /** Degrees clockwise from north (default: keep the current heading). */
  heading?: number;
  /** Degrees, negative looks down (default -45). */
  pitch?: number;
  /** Meters from the target (default 500). */
  range?: number;
  /** Seconds (default: automatic). */
  duration?: number;
}

export interface SphereFlightOptions {
  /** Multiplies the distance that fits the sphere in view. */
  rangeScale?: number;
  /** Closest distance in meters (default 50). */
  minRange?: number;
}

export interface GeoViewerOptions extends GlobeOptions {
  container: HTMLElement;
  /** Skip WebGPU and use the WebGL 2 backend. */
  forceWebGL?: boolean;
  antialias?: boolean;
  initialView?: ViewPosition;
  maxPixelRatio?: number;
}

export interface RendererInfo {
  backend: 'WebGPU' | 'WebGL2';
  reversedDepth: boolean;
  highPrecision: boolean;
  timestampQuery: boolean;
  adapter: string;
}

export interface FrameStats {
  fps: number;
  frameMs: number;
  gpuMs: number | null;
  drawCalls: number;
  triangles: number;
}

export interface ViewerEvents extends Record<string, unknown> {
  frame: FrameStats;
  'tilesets-changed': Tiles3DLayer[];
  'vectors-changed': GeoJsonLayer[];
  'points-changed': PointLayer[];
  /** A point marker of a point layer was clicked. */
  'point-click': { point: PointRecord; layer: PointLayer; event: MouseEvent };
}

export interface FeaturePick {
  hit: FeatureHit;
  layer: GeoJsonLayer;
  /** Picked ground position (radians / meters), null when picked through a label. */
  position: Cartographic | null;
}

export interface SurfacePick {
  point: Vector3;
  source: 'globe' | 'tiles' | 'entity';
  distance: number;
  entity?: BimEntity;
  tileset?: Tiles3DLayer;
}

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;

const _ndc = new Vector2();
const _v = new Vector3();
const _dir = new Vector3();
const _carto = cartographic();

/**
 * WebGPU-first 3D globe viewer.
 *
 * World space is ECEF (meters, +Z north). `renderer.highPrecision` computes
 * model-view matrices in float64 on the CPU, and each tile carries its own
 * origin (RTC), so geometry stays jitter-free from orbit down to street level.
 * Depth uses a reversed-Z float buffer when available.
 */
export class GeoViewer {
  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly ellipsoid = Ellipsoid.WGS84;
  readonly globe: Globe;
  readonly controller: GlobeCameraController;
  readonly stars = new StarField();
  readonly sunLight = new DirectionalLight(0xffffff, 3);
  readonly skyLight = new HemisphereLight(0xbcd7ff, 0x4a4136, 1.1);
  readonly events = new EventEmitter<ViewerEvents>();
  readonly info: RendererInfo;
  readonly stats: FrameStats = { fps: 0, frameMs: 0, gpuMs: null, drawCalls: 0, triangles: 0 };
  readonly tilesets: Tiles3DLayer[] = [];
  /** Worker-backed vector pipeline (draped rasterization, queries). */
  readonly vectors = new VectorService();
  /** Raster overlay layers + rasterized vectors, draped over the base imagery. */
  readonly overlays = new OverlayCompositor(this.vectors);
  readonly labels: LabelManager;
  readonly vectorLayers: GeoJsonLayer[] = [];
  /** HTML markers / top cards (顶牌) anchored to world positions. */
  readonly markers: MarkerManager;
  /** Data-driven point marker layers (点位), drawn through `markers`. */
  readonly pointLayers: PointLayer[] = [];
  /** Pointer events resolved to scene objects (click / dblclick / hover with selectors). */
  readonly interaction: InteractionManager;
  /** Buildings, floors, rooms and equipment; indoor level navigation. */
  readonly indoor: IndoorManager;

  /** Simulated date driving the sun and star positions. */
  date = new Date();
  /** Simulated seconds per real second (0 = paused). */
  timeMultiplier = 0;

  private _lighting = false;
  private _atmosphere = true;
  private _showGlobe = true;
  private _showStars = true;
  private readonly container: HTMLElement;
  private readonly raycaster = new Raycaster();
  private readonly cameraCarto: Cartographic = cartographic();
  private loaders: LoaderKit | null = null;
  private gltfLoader: GLTFLoader | null = null;
  private tilesetsSuppressed = false;
  private lastTime = -1;
  private fpsFrames = 0;
  private fpsTime = 0;
  private resizeObserver: ResizeObserver;
  private disposed = false;
  private timestampPending = false;

  static async create(options: GeoViewerOptions): Promise<GeoViewer> {
    const renderer = new WebGPURenderer({
      antialias: options.antialias ?? true,
      reversedDepthBuffer: true,
      forceWebGL: options.forceWebGL ?? false,
      trackTimestamp: true,
      powerPreference: 'high-performance',
    } as ConstructorParameters<typeof WebGPURenderer>[0]);
    await renderer.init();
    return new GeoViewer(options, renderer);
  }

  private constructor(options: GeoViewerOptions, renderer: WebGPURenderer) {
    this.container = options.container;
    this.renderer = renderer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backend = renderer.backend as any;
    const isWebGPU = backend.isWebGPUBackend === true;
    // Float64 model-view matrices: required for planet-scale coordinates.
    renderer.highPrecision = true;
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.maxPixelRatio ?? 2));
    renderer.setClearColor(0x000000, 1);
    renderer.domElement.classList.add('viewer-canvas');
    renderer.domElement.tabIndex = 0;
    this.container.appendChild(renderer.domElement);

    this.info = {
      backend: isWebGPU ? 'WebGPU' : 'WebGL2',
      reversedDepth: renderer.reversedDepthBuffer === true,
      highPrecision: renderer.highPrecision,
      timestampQuery: isWebGPU ? backend.trackTimestamp === true : false,
      adapter: describeAdapter(backend),
    };

    this.camera = new PerspectiveCamera(50, 1, 1, 1e8);
    this.camera.name = 'GlobeCamera';

    this.globe = new Globe(options);
    this.globe.setOverlaySource(this.overlays);
    this.scene.add(this.globe.group);
    this.labels = new LabelManager(this.ellipsoid);
    this.labels.heightProvider = (lon, lat) => (this._showGlobe ? this.globe.getHeight(lon, lat) : 0);
    this.scene.add(this.labels.group);
    this.scene.add(this.stars.mesh);
    this.scene.add(this.sunLight, this.sunLight.target, this.skyLight);
    this.scene.background = new Color(0x000000);
    this.scene.backgroundNode = skyColorNode(positionWorldDirection).add(vec3(0.0006, 0.0008, 0.0016)).mul(float(1));

    this.markers = new MarkerManager(this.container, renderer.domElement);
    this.indoor = new IndoorManager({
      ellipsoid: this.ellipsoid,
      camera: this.camera,
      markers: this.markers,
      // Buildings follow the terrain once it is reasonably detailed (no floating on coarse estimates).
      groundHeight: (lon, lat) => (this._showGlobe ? this.globe.getHeight(lon, lat, 150) : 0),
      flyToSphere: (sphere, heading, pitch, rangeScale, duration) => this.flyToSphere(sphere, heading, pitch, duration, { rangeScale, minRange: 4 }),
      cameraHeading: () => this.getView().heading,
      setTilesetsVisible: (visible) => this.setTilesetsSuppressed(!visible),
      loadModel: (uri) => this.loadModel(uri),
      followMove: (delta) => this.controller.translate(delta),
    });
    this.scene.add(this.indoor.root);

    const host: ControllerHost = {
      camera: this.camera,
      ellipsoid: this.ellipsoid,
      domElement: renderer.domElement,
      pick: (ndc) => this.pick(ndc)?.point ?? null,
      groundHeight: (lon, lat) => this.collisionGround(lon, lat),
    };
    this.controller = new GlobeCameraController(host);
    this.interaction = new InteractionManager({ domElement: renderer.domElement, pickAt: (x, y) => this.pickAt(x, y) });
    this.controller.doubleClickHandler = (e) => this.interaction.dispatchDoubleClick(e);
    this.installIndoorBehaviors();

    const v = options.initialView ?? { longitude: 110, latitude: 28, height: 1.8e7 };
    this.setView(v);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    void renderer.setAnimationLoop((t: number) => this.frame(t));
  }

  // ---------------------------------------------------------------------------
  // Scene settings

  get lighting(): boolean {
    return this._lighting;
  }

  /** Real sun position and day/night shading (otherwise imagery is shown unlit). */
  set lighting(v: boolean) {
    this._lighting = v;
  }

  get atmosphere(): boolean {
    return this._atmosphere;
  }

  set atmosphere(v: boolean) {
    this._atmosphere = v;
  }

  get showGlobe(): boolean {
    return this._showGlobe;
  }

  set showGlobe(v: boolean) {
    this._showGlobe = v;
    this.globe.group.visible = v;
  }

  get showStars(): boolean {
    return this._showStars;
  }

  set showStars(v: boolean) {
    this._showStars = v;
    this.stars.mesh.visible = v;
  }

  // ---------------------------------------------------------------------------
  // Camera

  setView(v: ViewPosition): void {
    const pos = this.ellipsoid.cartographicToCartesian(v.longitude * DEG2RAD, v.latitude * DEG2RAD, v.height);
    this.controller.setView(pos, (v.heading ?? 0) * DEG2RAD, (v.pitch ?? -90) * DEG2RAD);
  }

  flyTo(v: ViewPosition, duration?: number): Promise<void> {
    const position = this.ellipsoid.cartographicToCartesian(v.longitude * DEG2RAD, v.latitude * DEG2RAD, v.height);
    return this.controller.flyTo({ position, heading: (v.heading ?? 0) * DEG2RAD, pitch: (v.pitch ?? -90) * DEG2RAD }, duration);
  }

  /** Flies to look at a target from a heading / pitch / range. */
  flyToTarget(view: TargetView): Promise<void> {
    const t = view.target;
    const target = t instanceof Vector3 ? t.clone() : this.ellipsoid.cartographicToCartesian(t.longitude * DEG2RAD, t.latitude * DEG2RAD, t.height ?? 0);
    const heading = (view.heading ?? this.getView().heading) * DEG2RAD;
    const pitch = (view.pitch ?? -45) * DEG2RAD;
    const position = new Vector3();
    lookAtHeadingPitchRange(this.ellipsoid, target, heading, pitch, view.range ?? 500, position, new Quaternion());
    return this.controller.flyTo({ position, heading, pitch }, view.duration);
  }

  /** Fly so that a bounding sphere fills the view, looking at it from the south-east at 35 degrees. */
  flyToSphere(sphere: Sphere, heading = -30, pitch = -35, duration?: number, options: SphereFlightOptions = {}): Promise<void> {
    const fov = this.camera.getEffectiveFOV() * DEG2RAD;
    const range = Math.max((sphere.radius / Math.sin(fov / 2)) * (options.rangeScale ?? 1), options.minRange ?? 50) * 1.15;
    const position = new Vector3();
    const q = this.camera.quaternion.clone();
    lookAtHeadingPitchRange(this.ellipsoid, sphere.center, heading * DEG2RAD, pitch * DEG2RAD, range, position, q);
    return this.controller.flyTo({ position, heading: heading * DEG2RAD, pitch: pitch * DEG2RAD }, duration);
  }

  /** Flies to frame a building, floor, room or thing (ThingJS `camera.fit(obj)`). */
  flyToEntity(entity: BimEntity, options: { heading?: number; pitch?: number; rangeScale?: number; duration?: number } = {}): Promise<void> {
    const sphere = entity.worldBounds();
    if (!sphere) return Promise.resolve();
    return this.flyToSphere(sphere, options.heading ?? this.getView().heading, options.pitch ?? -40, options.duration, {
      rangeScale: options.rangeScale ?? 1.5,
      minRange: 4,
    });
  }

  /** Orbits the camera around the view center (or a point) until interrupted (ThingJS `rotateAround`). */
  startAutoOrbit(options?: AutoOrbitOptions): Promise<void> {
    return this.controller.startAutoOrbit(options);
  }

  stopAutoOrbit(): void {
    this.controller.stopAutoOrbit();
  }

  /** Rotates the view back to north-up around the point at the screen center. */
  resetNorth(): void {
    const { heading } = this.getView();
    const delta = -(((heading + 180) % 360) - 180) * DEG2RAD;
    const pivot = this.pick(new Vector2(0, 0))?.point;
    if (pivot) {
      void this.controller.rotateHeadingAround(pivot, delta);
    } else {
      const v = this.getView();
      void this.flyTo({ ...v, heading: 0 }, 0.8);
    }
  }

  /** Current camera as degrees / meters. */
  getView(): Required<ViewPosition> {
    const c = this.ellipsoid.cartesianToCartographic(this.camera.position) ?? cartographic();
    const hp = getHeadingPitch(this.ellipsoid, this.camera.position, this.camera.quaternion);
    return {
      longitude: c.longitude / DEG2RAD,
      latitude: c.latitude / DEG2RAD,
      height: c.height,
      heading: ((hp.heading / DEG2RAD) % 360 + 360) % 360,
      pitch: hp.pitch / DEG2RAD,
    };
  }

  // ---------------------------------------------------------------------------
  // Picking

  /** Closest surface hit (buildings, 3D Tiles or globe) at normalized device coordinates. */
  pick(ndc: Vector2): SurfacePick | null {
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.raycaster as any).firstHitOnly = true;
    let best: SurfacePick | null = null;
    const entity = this.indoor.pick(this.raycaster);
    if (entity) best = { point: entity.point.clone(), source: 'entity', distance: entity.distance, entity: entity.entity };
    for (const layer of this.tilesets) {
      if (!layer.active || !layer.ready) continue;
      const hits = this.raycaster.intersectObject(layer.group, true);
      if (hits.length > 0 && hits[0].distance < (best?.distance ?? Infinity)) {
        best = { point: hits[0].point.clone(), source: 'tiles', distance: hits[0].distance, tileset: layer };
      }
    }
    if (this._showGlobe) {
      const g = this.globe.raycast(this.raycaster.ray);
      if (g && g.distance < (best?.distance ?? Infinity)) best = { point: g.point, source: 'globe', distance: g.distance };
    }
    return best;
  }

  /** What lies under a client-space pixel (used by the interaction manager). */
  pickAt(clientX: number, clientY: number): PickInfo {
    const rect = this.renderer.domElement.getBoundingClientRect();
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const hit = this.pick(_ndc);
    return {
      kind: hit ? hit.source : 'none',
      entity: hit?.entity ?? null,
      tileset: hit?.tileset ?? null,
      point: hit?.point ?? null,
      cartographic: hit ? this.ellipsoid.cartesianToCartographic(hit.point) : null,
      clientX,
      clientY,
    };
  }

  /** Cartographic position (radians) under a client-space pixel. */
  pickCartographic(clientX: number, clientY: number): Cartographic | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const hit = this.pick(_ndc);
    return hit ? this.ellipsoid.cartesianToCartographic(hit.point) : null;
  }

  /**
   * Ground height for camera collision. Only terrain whose grid spacing is
   * fine relative to the camera's height counts: coarse or interpolated
   * surfaces (common while streaming) would otherwise shove the camera up.
   */
  private collisionGround(lon: number, lat: number): number | null {
    if (!this._showGlobe) return 0;
    const coarse = this.globe.getHeight(lon, lat);
    if (coarse === null) return null;
    const c = this.ellipsoid.cartesianToCartographic(this.camera.position, _carto);
    const above = (c?.height ?? 0) - coarse;
    return this.globe.getHeight(lon, lat, Math.max(50, above * 1.5));
  }

  // ---------------------------------------------------------------------------
  // Indoor defaults (ThingJS level behavior)

  /**
   * Double click enters the next level under the cursor (building → floor →
   * room / thing), right click or Esc goes back, hovering highlights.
   */
  private installIndoorBehaviors(): void {
    const indoor = this.indoor;
    this.interaction.on(
      'dblclick',
      (e) => {
        const next = indoor.nextLevel(e.entity!);
        if (!next) return;
        e.preventDefault();
        void indoor.enter(next);
      },
      { selector: '.building, .floor, .room, .thing, .element', tag: 'indoor' },
    );
    this.interaction.on(
      'rightclick',
      () => {
        if (indoor.current) void indoor.back();
      },
      { tag: 'indoor' },
    );
    this.interaction.on('click', (e) => indoor.select(e.entity ? selectTarget(e.entity, indoor.current) : null), { tag: 'indoor' });
    // Hover picking costs a ray cast per frame of pointer motion: only while buildings exist.
    let hoverOn = false;
    indoor.events.on('buildings-changed', (buildings) => {
      const want = buildings.length > 0;
      if (want === hoverOn) return;
      hoverOn = want;
      if (want) {
        const selector = '.building, .room, .thing, .element';
        this.interaction.on('mouseenter', (e) => indoor.setHovered(hoverTarget(e.object!, indoor.current)), { selector, tag: 'indoor-hover' });
        this.interaction.on('mouseleave', () => indoor.setHovered(null), { selector, tag: 'indoor-hover' });
      } else {
        this.interaction.off('mouseenter', 'indoor-hover');
        this.interaction.off('mouseleave', 'indoor-hover');
        indoor.setHovered(null);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 3D Tiles

  addTileset(options: Tiles3DLayerOptions): Tiles3DLayer {
    const layer = new Tiles3DLayer(options, this.getLoaders(), this.ellipsoid);
    layer.tiles.setCamera(this.camera);
    layer.tiles.setResolutionFromRenderer(this.camera, this.renderer as never);
    layer.suppressed = this.tilesetsSuppressed;
    this.scene.add(layer.group);
    this.tilesets.push(layer);
    this.events.emit('tilesets-changed', this.tilesets);
    return layer;
  }

  removeTileset(layer: Tiles3DLayer): void {
    const i = this.tilesets.indexOf(layer);
    if (i < 0) return;
    this.tilesets.splice(i, 1);
    layer.dispose();
    this.events.emit('tilesets-changed', this.tilesets);
  }

  private setTilesetsSuppressed(suppressed: boolean): void {
    if (suppressed === this.tilesetsSuppressed) return;
    this.tilesetsSuppressed = suppressed;
    for (const layer of this.tilesets) layer.suppressed = suppressed;
  }

  // ---------------------------------------------------------------------------
  // GeoJSON / vector layers

  addGeoJson(options: GeoJsonLayerOptions): GeoJsonLayer {
    const layer = new GeoJsonLayer(options, this.vectors, this.labels);
    this.vectorLayers.push(layer);
    layer.events.on('ready', () => this.events.emit('vectors-changed', this.vectorLayers));
    this.events.emit('vectors-changed', this.vectorLayers);
    return layer;
  }

  removeGeoJson(layer: GeoJsonLayer): void {
    const i = this.vectorLayers.indexOf(layer);
    if (i < 0) return;
    this.vectorLayers.splice(i, 1);
    layer.dispose();
    this.events.emit('vectors-changed', this.vectorLayers);
  }

  // ---------------------------------------------------------------------------
  // Point markers (点位)

  /**
   * Adds a point marker layer: GeoJSON points, record arrays or a
   * `{ points, style, rules }` document (see docs/agents/markers.md).
   */
  addPoints(options: PointLayerOptions): PointLayer {
    const layer = new PointLayer(options, {
      ellipsoid: this.ellipsoid,
      markers: this.markers,
      groundHeight: (lon, lat, maxCellSize) => (this._showGlobe ? this.globe.getHeight(lon, lat, maxCellSize) : 0),
      flyToBBox: (bbox) => void this.flyToBBox(bbox),
    });
    this.pointLayers.push(layer);
    layer.events.on('ready', () => this.events.emit('points-changed', this.pointLayers));
    layer.events.on('error', () => this.events.emit('points-changed', this.pointLayers));
    layer.events.on('click', (e) => this.events.emit('point-click', e));
    this.events.emit('points-changed', this.pointLayers);
    return layer;
  }

  removePoints(layer: PointLayer): void {
    const i = this.pointLayers.indexOf(layer);
    if (i < 0) return;
    this.pointLayers.splice(i, 1);
    layer.dispose();
    this.events.emit('points-changed', this.pointLayers);
  }

  /** Flies to fit a [west, south, east, north] box in degrees (top-down view). */
  flyToBBox(bbox: [number, number, number, number], duration?: number): Promise<void> {
    const [w, s, e, n] = bbox;
    let lon = (w + e) / 2;
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    const lat = Math.max(-80, Math.min(80, (s + n) / 2));
    const widthM = Math.abs(e - w) * 111_320 * Math.cos(lat * DEG2RAD);
    const heightM = Math.abs(n - s) * 110_540;
    const fov = this.camera.getEffectiveFOV() * DEG2RAD;
    const fit = Math.max(heightM, widthM / Math.max(this.camera.aspect, 0.5), 1500);
    const height = Math.min((fit / (2 * Math.tan(fov / 2))) * 1.25, 2.2e7);
    return this.flyTo({ longitude: lon, latitude: lat, height, heading: 0, pitch: -90 }, duration);
  }

  /**
   * Vector feature under a client-space pixel: labels first, then draped
   * geometry at the picked ground position.
   */
  async pickFeature(clientX: number, clientY: number): Promise<FeaturePick | null> {
    if (this.vectorLayers.length === 0) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    let hit: FeatureHit | null = null;
    let position: Cartographic | null = null;
    const label = this.labels.hitTest(clientX - rect.left, clientY - rect.top);
    if (label) hit = await this.vectors.getFeature(label.layerId, label.featureId);
    if (!hit) {
      _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      const p = this.pick(_ndc);
      if (!p) return null;
      position = this.ellipsoid.cartesianToCartographic(p.point);
      if (!position) return null;
      const [u, v] = lonLatToMerc(position.longitude / DEG2RAD, position.latitude / DEG2RAD);
      const sse = rect.height / (2 * Math.tan((this.camera.getEffectiveFOV() * DEG2RAD) / 2));
      const metersPerPx = this.camera.position.distanceTo(p.point) / sse;
      const pixelSize = metersPerPx / (EARTH_CIRCUMFERENCE * Math.max(Math.cos(position.latitude), 0.01));
      hit = await this.vectors.query(u, v, pixelSize, 5);
    }
    if (!hit) return null;
    const layer = this.vectorLayers.find((l) => l.id === hit.layerId);
    return layer ? { hit, layer, position } : null;
  }

  /** Highlights a picked feature (null clears). */
  highlightFeature(hit: FeatureHit | null): void {
    this.vectors.setHighlight(hit);
  }

  private getLoaders(): LoaderKit {
    if (!this.loaders) {
      // Decoder binaries ship with three.js and are bundled by Vite (default paths).
      const dracoLoader = new DRACOLoader();
      const ktxLoader = new KTX2Loader();
      ktxLoader.detectSupport(this.renderer as never);
      this.loaders = {
        dracoLoader,
        ktxLoader,
        meshoptDecoder: MeshoptDecoder,
        nodeLibrary: (this.renderer as unknown as { library: NodeMaterialLibrary }).library,
      };
    }
    return this.loaders;
  }

  /** Loads a glTF / GLB (Draco, KTX2 and meshopt supported) for building and equipment models. */
  async loadModel(uri: string): Promise<Object3D> {
    if (!this.gltfLoader) {
      const kit = this.getLoaders();
      const loader = new GLTFLoader();
      loader.setDRACOLoader(kit.dracoLoader);
      loader.setKTX2Loader(kit.ktxLoader);
      loader.setMeshoptDecoder(kit.meshoptDecoder);
      this.gltfLoader = loader;
    }
    const gltf = await this.gltfLoader.loadAsync(uri);
    return gltf.scene;
  }

  // ---------------------------------------------------------------------------
  // Frame loop

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const layer of this.tilesets) layer.tiles.setResolutionFromRenderer(this.camera, this.renderer as never);
  }

  private frame(time: number): void {
    if (this.disposed) return;
    const dt = this.lastTime < 0 ? 1 / 60 : Math.min((time - this.lastTime) / 1000, 0.25);
    this.lastTime = time;
    if (this.timeMultiplier !== 0) this.date = new Date(this.date.getTime() + dt * 1000 * this.timeMultiplier);

    this.controller.update(dt);
    this.updateClipPlanes();
    this.camera.updateMatrixWorld();
    this.updateEnvironment();

    const t0 = performance.now();
    if (this._showGlobe) this.globe.update(this.camera, this.container.clientHeight);
    for (const layer of this.tilesets) layer.update();
    this.indoor.update(dt);
    this.interaction.update();
    this.labels.update(this.camera, this.container.clientWidth, this.container.clientHeight, dt);

    this.renderer.render(this.scene, this.camera);
    // Point layers clamp to the terrain and cluster before the markers are placed.
    for (const layer of this.pointLayers) layer.update(this.camera, this.container.clientWidth, this.container.clientHeight);
    this.markers.update(this.camera, this.container.clientWidth, this.container.clientHeight);
    this.updateStats(dt, performance.now() - t0);
  }

  private updateClipPlanes(): void {
    const cam = this.camera;
    const c = this.ellipsoid.cartesianToCartographic(cam.position, this.cameraCarto);
    const ground = c && this._showGlobe ? (this.globe.getHeight(c.longitude, c.latitude) ?? 0) : 0;
    const altitude = Math.max(1, (c?.height ?? 0) - ground);
    const r = cam.position.length();
    const rMin = this.ellipsoid.minimumRadius - 500;
    const horizon = Math.sqrt(Math.max(r * r - rMin * rMin, 0));
    // Mountains and tall 3D tiles stay visible a little past the geometric horizon.
    const far = horizon + 400_000 + altitude * 0.5;
    const near = this.info.reversedDepth ? clamp(altitude * 0.002, 0.05, 5_000) : clamp(altitude * 0.05, 0.5, 200_000);
    if (Math.abs(cam.near - near) > near * 0.01 || Math.abs(cam.far - far) > far * 0.01) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  }

  private updateEnvironment(): void {
    const u = atmosphereUniforms;
    const cam = this.camera;
    const sun = sunDirectionECEF(this.date, _v);
    u.lightDirection.value.copy(sun);
    const up = this.ellipsoid.geodeticNormal(cam.position, new Vector3());
    if (this._lighting) {
      u.sunDirection.value.copy(sun);
    } else {
      // "Studio" lighting: a virtual sun above the camera so the whole visible hemisphere glows.
      u.sunDirection.value.copy(cam.position).normalize();
    }
    u.cameraPositionKm.value.set(cam.position.x, cam.position.y, cam.position.z * Z_SCALE).multiplyScalar(0.001);
    const height = this.cameraCarto.height;
    u.cameraAltitudeKm.value = Math.max(height, 0) / 1000;
    u.lightingEnabled.value = this._lighting ? 1 : 0;
    u.uniformLighting.value = this._lighting ? 0 : 1;
    u.atmosphereEnabled.value = this._atmosphere ? 1 : 0;
    u.groundHaze.value = this._lighting ? 0.7 : 0.5;

    // Stars: rotate with sidereal time, fade in when the sky is dark.
    this.stars.uniforms.siderealAngle.value = greenwichMeanSiderealTime(this.date);
    const space = smoothstep(30_000, 120_000, height);
    const sunAltitude = up.dot(sun);
    const night = this._lighting ? smoothstep(0.05, -0.2, sunAltitude) : 0;
    this.stars.uniforms.visibility.value = this._atmosphere ? Math.max(space, night) : 1;

    // Lights for 3D Tiles and buildings (globe tiles shade themselves).
    if (this._lighting) {
      this.sunLight.position.copy(sun);
      const day = smoothstep(-0.15, 0.2, sunAltitude);
      this.sunLight.intensity = 3.2 * day;
      this.skyLight.intensity = 0.25 + 0.9 * day;
    } else {
      // Head light from above and behind the viewer.
      cameraDirection(cam.quaternion, _dir);
      this.sunLight.position.copy(up).addScaledVector(_dir, -0.7).normalize();
      this.sunLight.intensity = 2.4;
      this.skyLight.intensity = 1.2;
    }
    this.sunLight.target.position.set(0, 0, 0);
    this.sunLight.updateMatrixWorld();
    this.sunLight.target.updateMatrixWorld();
    this.skyLight.position.copy(up);
    this.skyLight.updateMatrixWorld();
  }

  private updateStats(dt: number, cpuMs: number): void {
    this.fpsFrames++;
    this.fpsTime += dt;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = this.renderer.info as any;
    this.stats.drawCalls = info.render?.drawCalls ?? info.render?.calls ?? 0;
    this.stats.triangles = info.render?.triangles ?? 0;
    this.stats.frameMs = this.stats.frameMs * 0.9 + cpuMs * 0.1;
    if (this.fpsTime >= 0.5) {
      this.stats.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
      if (this.info.timestampQuery && !this.timestampPending) {
        this.timestampPending = true;
        this.renderer
          .resolveTimestampsAsync('render')
          .then((ms) => {
            if (typeof ms === 'number' && ms > 0) this.stats.gpuMs = ms;
          })
          .catch(() => undefined)
          .finally(() => {
            this.timestampPending = false;
          });
      }
    }
    this.events.emit('frame', this.stats);
  }

  dispose(): void {
    this.disposed = true;
    void this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controller.dispose();
    this.interaction.dispose();
    for (const layer of [...this.tilesets]) this.removeTileset(layer);
    for (const layer of [...this.vectorLayers]) this.removeGeoJson(layer);
    for (const layer of [...this.pointLayers]) this.removePoints(layer);
    this.indoor.dispose();
    this.markers.dispose();
    this.labels.dispose();
    this.vectors.dispose();
    this.globe.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** What a single click selects at the current level. */
function selectTarget(hit: BimEntity, current: BimEntity | null): BimEntity {
  const building = hit.closest('building');
  if (building && current?.closest('building') !== building) return building;
  return hit;
}

/** What hovering should highlight at the current level (whole buildings from outside). */
function hoverTarget(hit: BimEntity, current: BimEntity | null): BimEntity | null {
  const building = hit.closest('building');
  if (building && current?.closest('building') !== building) return building;
  return hit.type === 'building' ? null : hit;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeAdapter(backend: any): string {
  try {
    const info = backend.device?.adapterInfo ?? backend.adapter?.info;
    if (info) return [info.vendor, info.architecture, info.description].filter(Boolean).join(' ').trim() || 'WebGPU adapter';
    const gl = backend.gl as WebGL2RenderingContext | undefined;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    }
  } catch {
    /* ignore */
  }
  return 'unknown';
}
