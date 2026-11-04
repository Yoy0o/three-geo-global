/**
 * Vector data worker: parses GeoJSON, projects it to normalized Web Mercator,
 * indexes it, rasterizes globe tile overlays with Canvas2D and answers
 * feature queries. Feature properties stay here; the main thread only gets
 * summaries, label anchors and query hits.
 */
import {
  bboxIntersects,
  emptyBBox,
  extendBBox,
  GridIndex,
  mercToLonLat,
  pathDistanceSq,
  pathLength,
  pathMidpoint,
  pointInRings,
  polylabel,
  projectPath,
  ringArea,
  type BBox,
} from './geometry';
import type { FeatureHit, FeatureKind, LabelCandidate, LayerSummary, VectorRequest, VectorResponse, VectorSource, VectorStyle } from './types';

declare const self: {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<VectorRequest>) => void) | null;
};

interface Feature {
  id: number;
  kind: FeatureKind;
  polygons: Float64Array[][];
  lines: Float64Array[];
  points: Float64Array;
  bbox: BBox;
  properties: Record<string, unknown>;
  fill: string;
  fillAlpha: number;
  stroke: string;
  strokeAlpha: number;
  strokeWidth: number;
  pointColor: string;
  pointRadius: number;
  pointStroke: string;
  pointStrokeWidth: number;
}

interface Layer {
  id: number;
  features: Feature[];
  grid: GridIndex;
  style: VectorStyle;
  maxMarginPx: number;
  propertyKeys: string[];
  geometryTypes: Record<string, number>;
  bbox: BBox;
}

const layers = new Map<number, Layer>();
type RasterRequest = Extract<VectorRequest, { type: 'raster' }>;
const rasterQueue: RasterRequest[] = [];
let drainScheduled = false;

const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#86bcb6'];
const LABEL_FIELDS = ['name_zh', 'NAME_ZH', 'name:zh', 'name_zh-hans', '名称', '名字', 'name', 'NAME', 'Name', 'name_en', 'NAME_EN', 'title', 'TITLE', 'label', 'LABEL'];
const RANK_ASC = ['labelrank', 'LABELRANK', 'scalerank', 'SCALERANK', 'rank', 'RANK'];
const RANK_DESC = ['rank_max', 'RANK_MAX', 'pop_max', 'POP_MAX', 'population', 'POPULATION'];
const MIN_ZOOM_FIELDS = ['min_label', 'MIN_LABEL', 'min_zoom', 'MIN_ZOOM', 'minzoom'];
const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;

function post(msg: VectorResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

// -----------------------------------------------------------------------------
// Loading

async function readSource(source: VectorSource): Promise<unknown> {
  if ('json' in source) return source.json;
  if ('text' in source) return JSON.parse(source.text);
  const res = await fetch(source.url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

interface RawFeature {
  geometry: { type: string; coordinates?: unknown; geometries?: unknown[] } | null;
  properties: Record<string, unknown> | null;
}

function toFeatures(json: unknown): RawFeature[] {
  const j = json as { type?: string; features?: RawFeature[]; geometry?: unknown; properties?: unknown };
  if (Array.isArray(json)) return json as RawFeature[];
  if (!j || typeof j !== 'object') throw new Error('不是有效的 GeoJSON');
  if (j.type === 'FeatureCollection' && Array.isArray(j.features)) return j.features;
  if (j.type === 'Feature') return [j as RawFeature];
  if (typeof j.type === 'string') return [{ geometry: j as RawFeature['geometry'], properties: {} }];
  throw new Error('不支持的 GeoJSON 类型');
}

function addGeometry(g: RawFeature['geometry'], f: Feature, types: Record<string, number>): void {
  if (!g) return;
  types[g.type] = (types[g.type] ?? 0) + 1;
  const c = g.coordinates as never;
  switch (g.type) {
    case 'Point':
      f.points = concat(f.points, projectPath([c]));
      break;
    case 'MultiPoint':
      f.points = concat(f.points, projectPath(c));
      break;
    case 'LineString':
      if ((c as unknown[]).length >= 2) f.lines.push(projectPath(c));
      break;
    case 'MultiLineString':
      for (const line of c as unknown[][]) if (line.length >= 2) f.lines.push(projectPath(line as never));
      break;
    case 'Polygon':
      addPolygon(c, f);
      break;
    case 'MultiPolygon':
      for (const poly of c as unknown[]) addPolygon(poly as never, f);
      break;
    case 'GeometryCollection':
      for (const sub of g.geometries ?? []) addGeometry(sub as RawFeature['geometry'], f, types);
      break;
  }
}

function addPolygon(rings: ArrayLike<ArrayLike<ArrayLike<number>>>, f: Feature): void {
  const out: Float64Array[] = [];
  for (let r = 0; r < rings.length; r++) {
    if (rings[r].length < 3) continue;
    const ring = projectPath(rings[r]);
    // Keep holes on the same world copy as the outer ring.
    if (out.length > 0) {
      const shift = Math.round(out[0][0] - ring[0]);
      if (shift !== 0) for (let i = 0; i < ring.length; i += 2) ring[i] += shift;
    }
    out.push(ring);
  }
  if (out.length > 0) f.polygons.push(out);
}

function concat(a: Float64Array, b: Float64Array): Float64Array {
  if (a.length === 0) return b;
  const out = new Float64Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function isColor(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length < 64;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function categoricalColor(value: unknown): string {
  const n = num(value);
  if (n !== null) return PALETTE[Math.abs(Math.round(n)) % PALETTE.length];
  const s = String(value);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function applyStyle(layer: Layer): void {
  const s = layer.style;
  let margin = 0;
  for (const f of layer.features) {
    const p = f.properties;
    f.fill = s.colorBy && p[s.colorBy] != null ? categoricalColor(p[s.colorBy]) : s.fill;
    f.fillAlpha = s.fillOpacity;
    f.stroke = s.stroke;
    f.strokeWidth = s.strokeWidth;
    f.strokeAlpha = s.strokeOpacity;
    f.pointColor = s.pointColor;
    f.pointRadius = s.pointRadius;
    f.pointStroke = s.pointStroke;
    f.pointStrokeWidth = s.pointStrokeWidth;
    if (s.simplestyle) {
      if (isColor(p['fill'])) f.fill = p['fill'];
      f.fillAlpha = num(p['fill-opacity']) ?? f.fillAlpha;
      if (isColor(p['stroke'])) f.stroke = p['stroke'];
      f.strokeWidth = num(p['stroke-width']) ?? f.strokeWidth;
      f.strokeAlpha = num(p['stroke-opacity']) ?? f.strokeAlpha;
      if (isColor(p['marker-color'])) f.pointColor = p['marker-color'];
      const size = p['marker-size'];
      if (size === 'small') f.pointRadius = 3;
      else if (size === 'large') f.pointRadius = 6.5;
    }
    margin = Math.max(margin, f.strokeWidth, f.pointRadius + f.pointStrokeWidth);
  }
  layer.maxMarginPx = margin + 2;
}

function buildLayer(id: number, json: unknown, style: VectorStyle): Layer {
  const raw = toFeatures(json);
  const geometryTypes: Record<string, number> = {};
  const features: Feature[] = [];
  const keys = new Set<string>();
  const layerBBox = emptyBBox();

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (!r) continue;
    const properties = (r.properties && typeof r.properties === 'object' ? r.properties : {}) as Record<string, unknown>;
    if (i < 300) for (const k of Object.keys(properties)) if (keys.size < 200) keys.add(k);
    const f: Feature = {
      id: features.length,
      kind: 'point',
      polygons: [],
      lines: [],
      points: new Float64Array(0),
      bbox: emptyBBox(),
      properties,
      fill: '',
      fillAlpha: 0,
      stroke: '',
      strokeAlpha: 0,
      strokeWidth: 0,
      pointColor: '',
      pointRadius: 0,
      pointStroke: '',
      pointStrokeWidth: 0,
    };
    addGeometry(r.geometry, f, geometryTypes);
    for (const poly of f.polygons) for (const ring of poly) extendBBox(f.bbox, ring);
    for (const line of f.lines) extendBBox(f.bbox, line);
    if (f.points.length) extendBBox(f.bbox, f.points);
    if (!Number.isFinite(f.bbox[0])) continue;
    f.kind = f.polygons.length ? 'polygon' : f.lines.length ? 'line' : 'point';
    features.push(f);
    layerBBox[0] = Math.min(layerBBox[0], f.bbox[0]);
    layerBBox[1] = Math.min(layerBBox[1], f.bbox[1]);
    layerBBox[2] = Math.max(layerBBox[2], f.bbox[2]);
    layerBBox[3] = Math.max(layerBBox[3], f.bbox[3]);
  }

  const grid = new GridIndex(128);
  for (const f of features) {
    for (let shift = -1; shift <= 1; shift++) {
      const u0 = f.bbox[0] + shift;
      const u1 = f.bbox[2] + shift;
      if (u1 < 0 || u0 > 1) continue;
      grid.insert(f.id * 3 + shift + 1, u0, f.bbox[1], u1, f.bbox[3]);
    }
  }

  const layer: Layer = { id, features, grid, style, maxMarginPx: 0, propertyKeys: [...keys], geometryTypes, bbox: layerBBox };
  applyStyle(layer);
  return layer;
}

// -----------------------------------------------------------------------------
// Labels

function detectField(layer: Layer, candidates: string[], numeric: boolean): string | null {
  const sample = layer.features.slice(0, 400);
  for (const key of candidates) {
    let hits = 0;
    for (const f of sample) {
      const v = f.properties[key];
      if (v === null || v === undefined || v === '') continue;
      if (numeric ? num(v) !== null : typeof v === 'string' || typeof v === 'number') hits++;
    }
    if (sample.length > 0 && hits / sample.length >= 0.3) return key;
  }
  return null;
}

function computeLabels(layer: Layer, requested: string | null): { field: string | null; labels: LabelCandidate[] } {
  const field = requested ?? detectField(layer, LABEL_FIELDS, false);
  if (!field) return { field: null, labels: [] };
  const rankAsc = detectField(layer, RANK_ASC, true);
  const rankDesc = rankAsc ? null : detectField(layer, RANK_DESC, true);
  const minField = detectField(layer, MIN_ZOOM_FIELDS, true);

  const labels: LabelCandidate[] = [];
  for (const f of layer.features) {
    const raw = f.properties[field];
    if (raw === null || raw === undefined) continue;
    const text = String(raw).trim().slice(0, 64);
    if (!text) continue;

    let u: number;
    let v: number;
    let sizeMerc = 0;
    if (f.kind === 'polygon') {
      let best = f.polygons[0];
      let bestArea = -1;
      for (const poly of f.polygons) {
        const a = Math.abs(ringArea(poly[0]));
        if (a > bestArea) {
          bestArea = a;
          best = poly;
        }
      }
      [u, v] = polylabel(best);
      sizeMerc = Math.sqrt(bestArea);
    } else if (f.kind === 'line') {
      let best = f.lines[0];
      let bestLen = -1;
      for (const line of f.lines) {
        const len = pathLength(line);
        if (len > bestLen) {
          bestLen = len;
          best = line;
        }
      }
      [u, v] = pathMidpoint(best);
      sizeMerc = bestLen;
    } else {
      u = f.points[0];
      v = f.points[1];
    }
    const wrapped = u - Math.floor(u);
    const [lon, lat] = mercToLonLat(wrapped, v);
    const sizeMeters = sizeMerc * EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180);

    let priority: number;
    if (rankAsc) priority = num(f.properties[rankAsc]) ?? 50;
    else if (rankDesc) priority = -Math.log10(Math.max(1, num(f.properties[rankDesc]) ?? 1));
    else priority = f.kind === 'point' ? 0 : -Math.log10(sizeMeters + 1);
    priority += f.id * 1e-7;

    labels.push({
      featureId: f.id,
      text,
      lon,
      lat,
      priority,
      minZoom: minField ? (num(f.properties[minField]) ?? 0) : 0,
      kind: f.kind,
      sizeMeters,
    });
  }
  return { field, labels };
}

function summarize(layer: Layer, labelField: string | null): LayerSummary {
  const { field, labels } = computeLabels(layer, labelField);
  const b = layer.bbox;
  const valid = Number.isFinite(b[0]);
  let pointCount = 0;
  for (const f of layer.features) pointCount += f.points.length / 2;
  let bbox: LayerSummary['bbox'] = null;
  if (valid) {
    const [w, n] = mercToLonLat(b[0], b[1]);
    const [e, s] = mercToLonLat(b[2], b[3]);
    bbox = [w, s, e, n];
  }
  return {
    featureCount: layer.features.length,
    pointCount,
    geometryTypes: layer.geometryTypes,
    bbox,
    mercBBox: valid ? [b[0], b[1], b[2], b[3]] : null,
    propertyKeys: layer.propertyKeys,
    labelField: field,
    labels,
  };
}

// -----------------------------------------------------------------------------
// Rasterization

type Item = [Feature, number];

function collect(layer: Layer, u0: number, v0: number, u1: number, v1: number): Item[] {
  const items: Item[] = [];
  const rect: BBox = [u0, v0, u1, v1];
  for (const key of layer.grid.query(u0, v0, u1, v1)) {
    const f = layer.features[Math.floor(key / 3)];
    const shift = (key % 3) - 1;
    const b: BBox = [f.bbox[0] + shift, f.bbox[1], f.bbox[2] + shift, f.bbox[3]];
    if (bboxIntersects(b, rect)) items.push([f, shift]);
  }
  items.sort((a, b) => a[0].id - b[0].id || a[1] - b[1]);
  return items;
}

function tracePath(ctx: OffscreenCanvasRenderingContext2D, path: Float64Array, shift: number, scale: number, ox: number, oy: number, closed: boolean): void {
  const n = path.length / 2;
  let lx = 0;
  let ly = 0;
  for (let i = 0; i < n; i++) {
    const px = (path[i * 2] + shift) * scale - ox;
    const py = path[i * 2 + 1] * scale - oy;
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      // Drop sub-pixel steps: huge speedup for detailed data at low zoom.
      const dx = px - lx;
      const dy = py - ly;
      if (dx * dx + dy * dy < 0.36 && i < n - 1) continue;
      ctx.lineTo(px, py);
    }
    lx = px;
    ly = py;
  }
  if (closed) ctx.closePath();
}

function rasterize(req: Extract<VectorRequest, { type: 'raster' }>): ImageBitmap | null {
  const { z, x, y, size, pixelRatio, highlight } = req;
  const n = 2 ** z;
  const scale = size * n;
  const ox = x * size;
  const oy = y * size;
  const tu0 = x / n;
  const tv0 = y / n;
  const span = 1 / n;
  let canvas: OffscreenCanvas | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;

  for (const id of req.layers) {
    const layer = layers.get(id);
    if (!layer) continue;
    const margin = (layer.maxMarginPx * pixelRatio) / scale;
    const items = collect(layer, tu0 - margin, tv0 - margin, tu0 + span + margin, tv0 + span + margin);
    if (items.length === 0) continue;
    if (!ctx) {
      canvas = new OffscreenCanvas(size, size);
      ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
    }
    drawItems(ctx, items, scale, ox, oy, pixelRatio, false);
    if (highlight && highlight.layerId === id) {
      const hl = items.filter(([f]) => f.id === highlight.featureId);
      if (hl.length) drawItems(ctx, hl, scale, ox, oy, pixelRatio, true);
    }
  }
  return canvas ? canvas.transferToImageBitmap() : null;
}

function drawItems(ctx: OffscreenCanvasRenderingContext2D, items: Item[], scale: number, ox: number, oy: number, pr: number, highlight: boolean): void {
  // Fills first so that shared borders are not covered by neighbours.
  for (const [f, s] of items) {
    if (!f.polygons.length) continue;
    const alpha = highlight ? 0.35 : f.fillAlpha;
    if (alpha <= 0) continue;
    ctx.beginPath();
    for (const poly of f.polygons) for (const ring of poly) tracePath(ctx, ring, s, scale, ox, oy, true);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = highlight ? '#ffd23f' : f.fill;
    ctx.fill('evenodd');
  }
  for (const [f, s] of items) {
    if (!f.polygons.length && !f.lines.length) continue;
    const width = highlight ? Math.max(3, f.strokeWidth + 2) : f.strokeWidth;
    const alpha = highlight ? 1 : f.strokeAlpha;
    if (width <= 0 || alpha <= 0) continue;
    ctx.beginPath();
    for (const poly of f.polygons) for (const ring of poly) tracePath(ctx, ring, s, scale, ox, oy, true);
    for (const line of f.lines) tracePath(ctx, line, s, scale, ox, oy, false);
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width * pr;
    ctx.strokeStyle = highlight ? '#ffd23f' : f.stroke;
    ctx.stroke();
  }
  for (const [f, s] of items) {
    const pts = f.points;
    if (!pts.length) continue;
    const r = (f.pointRadius + (highlight ? 2.5 : 0)) * pr;
    ctx.globalAlpha = 1;
    ctx.fillStyle = highlight ? '#ffd23f' : f.pointColor;
    ctx.strokeStyle = f.pointStroke;
    ctx.lineWidth = f.pointStrokeWidth * pr;
    for (let i = 0; i < pts.length; i += 2) {
      const px = (pts[i] + s) * scale - ox;
      const py = pts[i + 1] * scale - oy;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      if (f.pointStrokeWidth > 0) ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

// -----------------------------------------------------------------------------
// Queries

function query(req: Extract<VectorRequest, { type: 'query' }>): FeatureHit | null {
  const { u, v, pixelSize } = req;
  const tol = req.tolerancePx * pixelSize;
  for (const id of req.layers) {
    const layer = layers.get(id);
    if (!layer) continue;
    const pad = tol + layer.maxMarginPx * pixelSize;
    const items = collect(layer, u - pad, v - pad, u + pad, v + pad);
    // Later features draw on top, so test them first.
    for (let i = items.length - 1; i >= 0; i--) {
      const [f, shift] = items[i];
      const uu = u - shift;
      let hit = false;
      for (let k = 0; k < f.points.length && !hit; k += 2) {
        const r = tol + f.pointRadius * pixelSize;
        hit = (f.points[k] - uu) ** 2 + (f.points[k + 1] - v) ** 2 <= r * r;
      }
      if (!hit) {
        const w = tol + (f.strokeWidth / 2) * pixelSize;
        for (const line of f.lines) if (!hit) hit = pathDistanceSq(uu, v, line) <= w * w;
      }
      if (!hit) for (const poly of f.polygons) if (!hit) hit = pointInRings(uu, v, poly);
      if (hit) return toHit(id, f);
    }
  }
  return null;
}

function toHit(layerId: number, f: Feature): FeatureHit {
  const [w, n] = mercToLonLat(f.bbox[0], f.bbox[1]);
  const [e, s] = mercToLonLat(f.bbox[2], f.bbox[3]);
  return {
    layerId,
    featureId: f.id,
    kind: f.kind,
    properties: f.properties,
    mercBBox: [f.bbox[0], f.bbox[1], f.bbox[2], f.bbox[3]],
    bbox: [w, s, e, n],
  };
}

/**
 * Raster requests are queued and drained in short slices so that cancel
 * messages (sent when the camera moves on) can overtake stale work.
 */
function drainRasterQueue(): void {
  drainScheduled = false;
  const start = performance.now();
  while (rasterQueue.length > 0 && performance.now() - start < 12) {
    const req = rasterQueue.shift()!;
    try {
      const bitmap = rasterize(req);
      post({ type: 'raster', id: req.id, bitmap }, bitmap ? [bitmap] : []);
    } catch (err) {
      post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (rasterQueue.length > 0) scheduleDrain();
}

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  setTimeout(drainRasterQueue, 0);
}

// -----------------------------------------------------------------------------

self.onmessage = (event: MessageEvent<VectorRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'load':
      readSource(msg.source)
        .then((json) => {
          const layer = buildLayer(msg.layerId, json, msg.style);
          layers.set(msg.layerId, layer);
          post({ type: 'loaded', layerId: msg.layerId, summary: summarize(layer, msg.labelField) });
        })
        .catch((err: unknown) => post({ type: 'error', layerId: msg.layerId, message: err instanceof Error ? err.message : String(err) }));
      break;
    case 'style': {
      const layer = layers.get(msg.layerId);
      if (layer) {
        layer.style = msg.style;
        applyStyle(layer);
      }
      break;
    }
    case 'labels': {
      const layer = layers.get(msg.layerId);
      if (layer) {
        const { field, labels } = computeLabels(layer, msg.labelField);
        post({ type: 'labels', layerId: msg.layerId, labelField: field, labels });
      }
      break;
    }
    case 'remove':
      layers.delete(msg.layerId);
      break;
    case 'cancel': {
      const i = rasterQueue.findIndex((r) => r.id === msg.id);
      if (i >= 0) {
        rasterQueue.splice(i, 1);
        post({ type: 'raster', id: msg.id, bitmap: null });
      }
      break;
    }
    case 'raster':
      rasterQueue.push(msg);
      scheduleDrain();
      break;
    case 'feature': {
      const f = layers.get(msg.layerId)?.features[msg.featureId];
      post({ type: 'query', id: msg.id, hit: f ? toHit(msg.layerId, f) : null });
      break;
    }
    case 'query':
      try {
        post({ type: 'query', id: msg.id, hit: query(msg) });
      } catch (err) {
        post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
      }
      break;
  }
};
