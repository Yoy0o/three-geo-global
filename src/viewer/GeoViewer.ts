import {
  Color,
  DirectionalLight,
  HemisphereLight,
  NeutralToneMapping,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
  Vector3,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { float, positionWorldDirection, vec3 } from 'three/tsl';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { atmosphereUniforms, skyColorNode, Z_SCALE } from '../atmosphere/AtmosphereNodes';
import { StarField } from '../atmosphere/Stars';
import { cartographic, Ellipsoid, type Cartographic } from '../core/Ellipsoid';
import { EventEmitter } from '../core/EventEmitter';
import { clamp, DEG2RAD, smoothstep } from '../core/math';
import { greenwichMeanSiderealTime, sunDirectionECEF } from '../core/SunPosition';
import { Globe, type GlobeOptions } from '../globe/Globe';
import { Tiles3DLayer, type LoaderKit, type Tiles3DLayerOptions } from '../tiles3d/Tiles3DLayer';
import { cameraDirection, getHeadingPitch, lookAtHeadingPitchRange } from './cameraMath';
import { GlobeCameraController, type ControllerHost } from './GlobeCameraController';

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
}

const _ndc = new Vector2();
const _v = new Vector3();
const _dir = new Vector3();

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
    this.scene.add(this.globe.group);
    this.scene.add(this.stars.mesh);
    this.scene.add(this.sunLight, this.sunLight.target, this.skyLight);
    this.scene.background = new Color(0x000000);
    this.scene.backgroundNode = skyColorNode(positionWorldDirection).add(vec3(0.0006, 0.0008, 0.0016)).mul(float(1));

    const host: ControllerHost = {
      camera: this.camera,
      ellipsoid: this.ellipsoid,
      domElement: renderer.domElement,
      pick: (ndc) => this.pick(ndc)?.point ?? null,
      groundHeight: (lon, lat) => (this._showGlobe ? (this.globe.getHeight(lon, lat) ?? 0) : 0),
    };
    this.controller = new GlobeCameraController(host);

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

  /** Fly so that a bounding sphere fills the view, looking at it from the south-east at 35 degrees. */
  flyToSphere(sphere: Sphere, heading = -30, pitch = -35, duration?: number): Promise<void> {
    const fov = this.camera.getEffectiveFOV() * DEG2RAD;
    const range = Math.max(sphere.radius / Math.sin(fov / 2), 50) * 1.15;
    const position = new Vector3();
    const q = this.camera.quaternion.clone();
    lookAtHeadingPitchRange(this.ellipsoid, sphere.center, heading * DEG2RAD, pitch * DEG2RAD, range, position, q);
    return this.controller.flyTo({ position, heading: heading * DEG2RAD, pitch: pitch * DEG2RAD }, duration);
  }

  /** Rotates the view back to north-up around the point at the screen center. */
  resetNorth(): void {
    const { heading } = this.getView();
    const delta = -(((heading + 180) % 360) - 180) * DEG2RAD;
    const pivot = this.pick(new Vector2(0, 0))?.point;
    if (pivot) {
      this.controller.rotateHeadingAround(pivot, delta);
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

  /** Surface hit (3D Tiles or globe) at normalized device coordinates. */
  pick(ndc: Vector2): { point: Vector3; source: 'globe' | 'tiles' } | null {
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.raycaster as any).firstHitOnly = true;
    let best: { point: Vector3; source: 'globe' | 'tiles' } | null = null;
    let bestDist = Infinity;
    for (const layer of this.tilesets) {
      if (!layer.visible || !layer.ready) continue;
      const hits = this.raycaster.intersectObject(layer.group, true);
      if (hits.length > 0 && hits[0].distance < bestDist) {
        bestDist = hits[0].distance;
        best = { point: hits[0].point.clone(), source: 'tiles' };
      }
    }
    if (this._showGlobe) {
      const g = this.globe.raycast(this.raycaster.ray);
      if (g && g.distance < bestDist) best = { point: g.point, source: 'globe' };
    }
    return best;
  }

  /** Cartographic position (radians) under a client-space pixel. */
  pickCartographic(clientX: number, clientY: number): Cartographic | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const hit = this.pick(_ndc);
    return hit ? this.ellipsoid.cartesianToCartographic(hit.point) : null;
  }

  // ---------------------------------------------------------------------------
  // 3D Tiles

  addTileset(options: Tiles3DLayerOptions): Tiles3DLayer {
    const layer = new Tiles3DLayer(options, this.getLoaders(), this.ellipsoid);
    layer.tiles.setCamera(this.camera);
    layer.tiles.setResolutionFromRenderer(this.camera, this.renderer as never);
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

  private getLoaders(): LoaderKit {
    if (!this.loaders) {
      // Decoder binaries ship with three.js and are bundled by Vite (default paths).
      const dracoLoader = new DRACOLoader();
      const ktxLoader = new KTX2Loader();
      ktxLoader.detectSupport(this.renderer as never);
      this.loaders = { dracoLoader, ktxLoader, meshoptDecoder: MeshoptDecoder };
    }
    return this.loaders;
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

    this.renderer.render(this.scene, this.camera);
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
    const up = this.ellipsoid.geodeticSurfaceNormal(cam.position, new Vector3());
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

    // Lights for 3D Tiles (globe tiles shade themselves).
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
    for (const layer of [...this.tilesets]) this.removeTileset(layer);
    this.globe.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
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
