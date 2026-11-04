import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  LinearFilter,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  Fn,
  materialReference,
  mix,
  renderGroup,
  screenDPR,
  uniform,
  vec2,
  vec4,
  viewportSize,
} from 'three/tsl';
import type { TSLNode } from '../atmosphere/AtmosphereNodes';
import type { Ellipsoid } from '../core/Ellipsoid';
import { isScaledSpacePointVisible, WGS84_A, WGS84_B } from '../core/geodesy';
import type { FeatureKind, LabelCandidate, LabelStyle } from './types';

const FONT_STACK =
  '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC",system-ui,-apple-system,"Segoe UI",sans-serif';
const MIN_PAGE = 512;
const MAX_PAGE = 2048;
const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;
const DEG = Math.PI / 180;
/** Labels float this far above the sampled ground (meters). */
const LIFT = 2;

/** Splits a float64 into an exactly representable float32 high part and a small low part (CesiumJS-style RTE). */
export function splitDouble(v: number): [number, number] {
  const high = v >= 0 ? Math.floor(v / 65536) * 65536 : -Math.floor(-v / 65536) * 65536;
  return [high, v - high];
}

const labelUniforms = {
  cameraHigh: uniform(new Vector3()).setGroup(renderGroup),
  cameraLow: uniform(new Vector3()).setGroup(renderGroup),
};

let sharedNodes: { vertexNode: TSLNode; colorNode: TSLNode; opacityNode: TSLNode } | null = null;

/**
 * Node graph shared by all label atlas pages (one GPU pipeline). Positions use
 * relative-to-eye emulated doubles: (high - cameraHigh) + (low - cameraLow) is
 * exact to a few millimeters anywhere on Earth, unlike a float32 ECEF position.
 */
function labelNodes(): NonNullable<typeof sharedNodes> {
  if (sharedNodes) return sharedNodes;
  const posHigh = attribute('position', 'vec3');
  const posLow = attribute('posLow', 'vec3');
  const corner = attribute('corner', 'vec2');
  const box = attribute('box', 'vec4');
  const uvRect = attribute('uvRect', 'vec4');
  const opacity = attribute('labelOpacity', 'float');

  const vertexNode = Fn(() => {
    const rel = posHigh.sub(labelUniforms.cameraHigh).add(posLow.sub(labelUniforms.cameraLow));
    const viewPos = cameraViewMatrix.mul(vec4(rel, 0)).xyz;
    const clip = cameraProjectionMatrix.mul(vec4(viewPos, 1));
    const px = vec2(corner.x.mul(box.x).sub(box.z), corner.y.mul(box.y).sub(box.w));
    const offset = px.mul(screenDPR).mul(2).div(viewportSize);
    return vec4(clip.xy.add(offset.mul(clip.w)), clip.z, clip.w);
  })();

  const atlasUV = vec2(mix(uvRect.x, uvRect.z, corner.x), mix(uvRect.w, uvRect.y, corner.y));
  const atlas: TSLNode = (materialReference('atlasMap', 'texture') as TSLNode).context({ getUV: () => atlasUV });
  sharedNodes = { vertexNode, colorNode: atlas.rgb, opacityNode: atlas.a.mul(opacity) };
  return sharedNodes;
}

interface LabelItem {
  layerId: number;
  featureId: number;
  kind: FeatureKind;
  lon: number;
  lat: number;
  cosLat: number;
  priority: number;
  minZoom: number;
  sizeMeters: number;
  height: number;
  ecef: Vector3;
  page: AtlasPage;
  slot: number;
  /** Atlas rect in atlas pixels. */
  ax0: number;
  ay0: number;
  ax1: number;
  ay1: number;
  /** Size and anchor offset in CSS pixels (anchor measured from the bottom-left corner, y up). */
  w: number;
  h: number;
  anchorX: number;
  anchorY: number;
  opacity: number;
  target: number;
  inView: boolean;
  occluded: boolean;
  sx: number;
  sy: number;
}

class AtlasPage {
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  readonly ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  readonly material: MeshBasicNodeMaterial & { atlasMap: Texture };
  readonly mesh: Mesh;
  items: LabelItem[] = [];
  opacity = new Float32Array(0);
  posHigh = new Float32Array(0);
  posLow = new Float32Array(0);
  textureDirty = false;
  private shelves: { y: number; h: number; x: number }[] = [];
  private nextY = 0;

  constructor(readonly size: number) {
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    const ctx = this.canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.texture = new CanvasTexture(this.canvas as never);
    this.texture.flipY = false;
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;

    const nodes = labelNodes();
    const material = new MeshBasicNodeMaterial() as MeshBasicNodeMaterial & { atlasMap: Texture };
    material.name = 'Labels';
    material.atlasMap = this.texture;
    material.vertexNode = nodes.vertexNode;
    material.colorNode = nodes.colorNode;
    material.opacityNode = nodes.opacityNode;
    material.transparent = true;
    material.depthWrite = false;
    // Visibility is decided per label on the CPU (horizon + terrain line of sight):
    // a per-pixel depth test would clip labels against the curved ground around them.
    material.depthTest = false;
    material.side = DoubleSide;
    material.fog = false;
    this.material = material;
    this.mesh = new Mesh(new BufferGeometry(), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 100;
    this.mesh.name = 'LabelPage';
  }

  allocate(w: number, h: number): [number, number] | null {
    if (w > this.size || h > this.size) return null;
    for (const s of this.shelves) {
      if (h <= s.h && h >= s.h * 0.7 && s.x + w <= this.size) {
        const x = s.x;
        s.x += w + 2;
        return [x, s.y];
      }
    }
    if (this.nextY + h > this.size) return null;
    const shelf = { y: this.nextY, h, x: w + 2 };
    this.shelves.push(shelf);
    this.nextY += h + 2;
    return [0, shelf.y];
  }

  /** Rebuilds the sprite geometry from `items` (4 vertices per label). */
  rebuild(): void {
    const n = this.items.length;
    const posHigh = new Float32Array(n * 12);
    const posLow = new Float32Array(n * 12);
    const corner = new Float32Array(n * 8);
    const uvRect = new Float32Array(n * 16);
    const box = new Float32Array(n * 16);
    const opacity = new Float32Array(n * 4);
    const index = new Uint32Array(n * 6);
    const corners = [0, 0, 1, 0, 1, 1, 0, 1];
    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      it.slot = i;
      const u0 = it.ax0 / this.size;
      const v0 = it.ay0 / this.size;
      const u1 = it.ax1 / this.size;
      const v1 = it.ay1 / this.size;
      for (let k = 0; k < 4; k++) {
        const vi = i * 4 + k;
        corner.set([corners[k * 2], corners[k * 2 + 1]], vi * 2);
        uvRect.set([u0, v0, u1, v1], vi * 4);
        box.set([it.w, it.h, it.anchorX, it.anchorY], vi * 4);
        opacity[vi] = it.opacity;
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    this.posHigh = posHigh;
    this.posLow = posLow;
    this.opacity = opacity;
    for (const it of this.items) this.writePosition(it);

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(posHigh, 3));
    g.setAttribute('posLow', new BufferAttribute(posLow, 3));
    g.setAttribute('corner', new BufferAttribute(corner, 2));
    g.setAttribute('uvRect', new BufferAttribute(uvRect, 4));
    g.setAttribute('box', new BufferAttribute(box, 4));
    g.setAttribute('labelOpacity', new BufferAttribute(opacity, 1));
    g.setIndex(new BufferAttribute(index, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  writePosition(it: LabelItem): void {
    const [hx, lx] = splitDouble(it.ecef.x);
    const [hy, ly] = splitDouble(it.ecef.y);
    const [hz, lz] = splitDouble(it.ecef.z);
    for (let k = 0; k < 4; k++) {
      const o = (it.slot * 4 + k) * 3;
      this.posHigh[o] = hx;
      this.posHigh[o + 1] = hy;
      this.posHigh[o + 2] = hz;
      this.posLow[o] = lx;
      this.posLow[o + 1] = ly;
      this.posLow[o + 2] = lz;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/** Uniform screen grid for label collision tests. */
class CollisionGrid {
  private cells: number[][] = [];
  private rects: number[] = [];
  private cols = 0;
  private rows = 0;
  private readonly size = 64;

  reset(width: number, height: number): void {
    this.cols = Math.max(1, Math.ceil(width / this.size));
    this.rows = Math.max(1, Math.ceil(height / this.size));
    const n = this.cols * this.rows;
    if (this.cells.length !== n) this.cells = Array.from({ length: n }, () => []);
    else for (const c of this.cells) c.length = 0;
    this.rects.length = 0;
  }

  /** Inserts the rect unless it overlaps an existing one. */
  tryInsert(x0: number, y0: number, x1: number, y1: number): boolean {
    const cx0 = Math.max(0, Math.floor(x0 / this.size));
    const cy0 = Math.max(0, Math.floor(y0 / this.size));
    const cx1 = Math.min(this.cols - 1, Math.floor(x1 / this.size));
    const cy1 = Math.min(this.rows - 1, Math.floor(y1 / this.size));
    const r = this.rects;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (const i of this.cells[cy * this.cols + cx]) {
          if (x0 < r[i + 2] && x1 > r[i] && y0 < r[i + 3] && y1 > r[i + 1]) return false;
        }
      }
    }
    const idx = r.length;
    r.push(x0, y0, x1, y1);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.cells[cy * this.cols + cx].push(idx);
    return true;
  }
}

interface LayerLabels {
  visible: boolean;
  style: LabelStyle;
  candidates: LabelCandidate[];
  pointOffsetPx: number;
}

let scratch: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
function scratchContext(): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  if (!scratch) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
    scratch = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  }
  return scratch;
}

const _vp = new Matrix4();
const _cam = new Vector3();
const _p = new Vector3();
const _carto = { longitude: 0, latitude: 0, height: 0 };

/**
 * Screen-space text labels anchored to the globe: atlas-backed sprites,
 * priority-based decluttering, min-zoom / size filtering, fade in/out and
 * ground height sampling.
 */
export class LabelManager {
  readonly group = new Group();
  /** Ground height lookup (meters above the ellipsoid), null when unknown. */
  heightProvider: (lon: number, lat: number) => number | null = () => 0;

  private readonly pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  private pages: AtlasPage[] = [];
  private items: LabelItem[] = [];
  private readonly layers = new Map<number, LayerLabels>();
  private readonly grid = new CollisionGrid();
  private frame = 0;

  constructor(private readonly ellipsoid: Ellipsoid) {
    this.group.name = 'Labels';
  }

  get count(): number {
    return this.items.length;
  }

  get visibleCount(): number {
    let n = 0;
    for (const it of this.items) if (it.opacity > 0.5) n++;
    return n;
  }

  setLabels(layerId: number, candidates: LabelCandidate[], style: LabelStyle, pointOffsetPx = 8): void {
    const prev = this.layers.get(layerId);
    this.layers.set(layerId, { visible: prev?.visible ?? true, style, candidates, pointOffsetPx });
    this.removeItems(layerId);
    if (style.enabled) this.addItems(layerId, candidates, style, pointOffsetPx);
  }

  setLayerVisible(layerId: number, visible: boolean): void {
    const l = this.layers.get(layerId);
    if (l) l.visible = visible;
  }

  setLayerStyle(layerId: number, style: LabelStyle): void {
    const l = this.layers.get(layerId);
    if (l) this.setLabels(layerId, l.candidates, style, l.pointOffsetPx);
  }

  removeLayer(layerId: number): void {
    this.layers.delete(layerId);
    this.removeItems(layerId);
  }

  private removeItems(layerId: number): void {
    if (!this.items.some((it) => it.layerId === layerId)) return;
    this.items = this.items.filter((it) => it.layerId !== layerId);
    for (const page of [...this.pages]) {
      const before = page.items.length;
      page.items = page.items.filter((it) => it.layerId !== layerId);
      if (page.items.length === before) continue;
      if (page.items.length === 0) {
        page.dispose();
        this.pages.splice(this.pages.indexOf(page), 1);
      } else {
        page.rebuild();
      }
    }
  }

  private addItems(layerId: number, candidates: LabelCandidate[], style: LabelStyle, pointOffsetPx: number): void {
    const touched = new Set<AtlasPage>();
    const scale = this.pixelRatio;
    const halo = 2 * scale;
    // Measure first so new atlas pages are only as large as needed.
    const measure = scratchContext();
    const sized = candidates.map((c) => {
      const polygonLike = c.kind !== 'point';
      const fontPx = Math.round((polygonLike ? style.size + 1 : style.size) * scale);
      const font = `${polygonLike ? 600 : 500} ${fontPx}px ${FONT_STACK}`;
      measure.font = font;
      const w = Math.ceil(measure.measureText(c.text).width) + Math.ceil(halo * 2) + 2;
      const h = Math.ceil(fontPx * 1.35 + halo * 2);
      return { c, font, fontPx, w, h, polygonLike };
    });
    let remaining = sized.reduce((a, s) => a + (s.w + 2) * (s.h + 2), 0);

    for (const { c, font, w, h, polygonLike } of sized) {
      remaining -= (w + 2) * (h + 2);
      let page = this.pages[this.pages.length - 1];
      let at = page ? page.allocate(w, h) : null;
      if (!at) {
        const needed = Math.sqrt((remaining + (w + 2) * (h + 2)) * 1.3);
        page = this.newPage(Math.min(MAX_PAGE, Math.max(MIN_PAGE, 2 ** Math.ceil(Math.log2(Math.max(needed, w + 4))))));
        at = page.allocate(w, h);
        if (!at) continue;
      }
      const ctx = page.ctx;
      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeStyle = style.haloColor;
      ctx.lineWidth = halo * 2;
      ctx.strokeText(c.text, at[0] + halo + 1, at[1] + h / 2);
      ctx.fillStyle = style.color;
      ctx.fillText(c.text, at[0] + halo + 1, at[1] + h / 2);
      page.textureDirty = true;
      touched.add(page);

      const lon = c.lon * DEG;
      const lat = c.lat * DEG;
      const height = this.heightProvider(lon, lat) ?? 0;
      const wCss = w / scale;
      const hCss = h / scale;
      const item: LabelItem = {
        layerId,
        featureId: c.featureId,
        kind: c.kind,
        lon,
        lat,
        cosLat: Math.cos(lat),
        priority: c.priority,
        minZoom: style.useMinZoom ? c.minZoom : 0,
        sizeMeters: c.sizeMeters,
        height,
        ecef: this.ellipsoid.cartographicToCartesian(lon, lat, height + LIFT),
        page,
        slot: 0,
        ax0: at[0],
        ay0: at[1],
        ax1: at[0] + w,
        ay1: at[1] + h,
        w: wCss,
        h: hCss,
        // Point labels sit to the right of the symbol, others are centered.
        anchorX: polygonLike ? wCss / 2 : -pointOffsetPx,
        anchorY: hCss / 2,
        opacity: 0,
        target: 0,
        inView: false,
        occluded: false,
        sx: 0,
        sy: 0,
      };
      page.items.push(item);
      this.items.push(item);
    }
    for (const page of touched) {
      page.rebuild();
      page.texture.needsUpdate = true;
      page.textureDirty = false;
    }
  }

  private newPage(size: number): AtlasPage {
    const page = new AtlasPage(size);
    this.pages.push(page);
    this.group.add(page.mesh);
    return page;
  }

  /** Declutters, fades and re-anchors labels. Call once per frame before rendering. */
  update(camera: PerspectiveCamera, width: number, height: number, dt: number): void {
    if (this.items.length === 0) return;
    this.frame++;
    camera.updateMatrixWorld();
    _cam.setFromMatrixPosition(camera.matrixWorld);
    const [hx, lx] = splitDouble(_cam.x);
    const [hy, ly] = splitDouble(_cam.y);
    const [hz, lz] = splitDouble(_cam.z);
    labelUniforms.cameraHigh.value.set(hx, hy, hz);
    labelUniforms.cameraLow.value.set(lx, ly, lz);

    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = _vp.elements;
    const sse = height / (2 * Math.tan((camera.getEffectiveFOV() * DEG) / 2));
    const csx = _cam.x / WGS84_A;
    const csy = _cam.y / WGS84_A;
    const csz = _cam.z / WGS84_B;
    // Terrain can hide labels only when the camera is reasonably low.
    const camCarto = this.ellipsoid.cartesianToCartographic(_cam);
    const lowCamera = !!camCarto && camCarto.height < 150_000;

    const candidates: LabelItem[] = [];
    for (const it of this.items) {
      it.inView = false;
      const layer = this.layers.get(it.layerId);
      if (!layer?.visible) continue;
      const p = it.ecef;
      if (!isScaledSpacePointVisible(p.x / WGS84_A, p.y / WGS84_A, p.z / WGS84_B, csx, csy, csz)) continue;
      const dist = Math.max(1, p.distanceTo(_cam));
      const metersPerPx = dist / sse;
      if (it.minZoom > 0 && Math.log2((EARTH_CIRCUMFERENCE * it.cosLat) / (256 * metersPerPx)) < it.minZoom) continue;
      // Without a curated min zoom, only label features that are reasonably large on screen.
      if (it.kind !== 'point' && it.minZoom <= 0 && it.sizeMeters / metersPerPx < Math.max(it.w * 0.5, 24)) continue;
      const x = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12];
      const y = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
      const w = e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15];
      if (w <= 0) continue;
      const nx = x / w;
      const ny = y / w;
      if (nx < -1.15 || nx > 1.15 || ny < -1.15 || ny > 1.15) continue;
      if (lowCamera && (this.frame + it.slot) % 4 === 0) it.occluded = this.terrainOccludes(it.ecef, dist);
      else if (!lowCamera) it.occluded = false;
      if (it.occluded) continue;
      it.sx = (nx + 1) * 0.5 * width;
      it.sy = (1 - ny) * 0.5 * height;
      it.inView = true;
      candidates.push(it);
    }

    // Greedy placement by priority; labels already shown get a bonus to avoid flicker.
    candidates.sort((a, b) => a.priority - (a.target > 0 ? 0.75 : 0) - (b.priority - (b.target > 0 ? 0.75 : 0)));
    this.grid.reset(width, height);
    for (const it of candidates) {
      const x0 = it.sx - it.anchorX - 2;
      const y0 = it.sy - (it.h - it.anchorY) - 2;
      it.target = this.grid.tryInsert(x0, y0, x0 + it.w + 4, y0 + it.h + 4) ? 1 : 0;
    }

    const k = Math.min(1, dt * 9);
    const dirty = new Set<AtlasPage>();
    for (const it of this.items) {
      let o = it.opacity;
      if (!it.inView) {
        it.target = 0;
        o = 0;
      } else {
        o += (it.target - o) * k;
        if (Math.abs(it.target - o) < 0.02) o = it.target;
      }
      if (o !== it.opacity) {
        it.opacity = o;
        it.page.opacity.fill(o, it.slot * 4, it.slot * 4 + 4);
        dirty.add(it.page);
      }
      // Refine the ground height as finer terrain arrives (staggered).
      if (it.inView && (this.frame + it.slot) % 24 === 0) {
        const h = this.heightProvider(it.lon, it.lat);
        if (h !== null && Math.abs(h - it.height) > 0.5) {
          it.height = h;
          this.ellipsoid.cartographicToCartesian(it.lon, it.lat, h + LIFT, it.ecef);
          it.page.writePosition(it);
          const g = it.page.mesh.geometry;
          g.getAttribute('position').needsUpdate = true;
          g.getAttribute('posLow').needsUpdate = true;
        }
      }
    }
    for (const page of dirty) page.mesh.geometry.getAttribute('labelOpacity').needsUpdate = true;
  }

  /** Whether terrain blocks the line of sight from the camera to a label anchor. */
  private terrainOccludes(target: Vector3, dist: number): boolean {
    const margin = Math.max(3, dist * 0.0015);
    for (let i = 1; i <= 10; i++) {
      const t = i / 11;
      _p.lerpVectors(_cam, target, t);
      const c = this.ellipsoid.cartesianToCartographic(_p, _carto);
      if (!c) continue;
      const ground = this.heightProvider(c.longitude, c.latitude);
      if (ground !== null && c.height < ground - margin) return true;
    }
    return false;
  }

  /** Label under a CSS-pixel position (relative to the canvas), most important first. */
  hitTest(x: number, y: number): { layerId: number; featureId: number } | null {
    let best: LabelItem | null = null;
    for (const it of this.items) {
      if (!it.inView || it.opacity < 0.5) continue;
      const x0 = it.sx - it.anchorX;
      const y0 = it.sy - (it.h - it.anchorY);
      if (x >= x0 && x <= x0 + it.w && y >= y0 && y <= y0 + it.h && (!best || it.priority < best.priority)) best = it;
    }
    return best ? { layerId: best.layerId, featureId: best.featureId } : null;
  }

  dispose(): void {
    for (const page of this.pages) page.dispose();
    this.pages = [];
    this.items = [];
    this.layers.clear();
  }
}
