import type { TileOverlaySource } from '../globe/overlay';
import { bboxIntersects, type BBox } from './geometry';
import type { FeatureHit, LabelCandidate, LayerSummary, VectorRequest, VectorResponse, VectorSource, VectorStyle } from './types';

interface LayerState {
  id: number;
  visible: boolean;
  /** Normalized mercator bbox (null until loaded). */
  bbox: BBox | null;
  marginPx: number;
}

interface Invalidation {
  version: number;
  rect: BBox | null;
  marginPx: number;
}

const MAX_INVALIDATIONS = 256;

function marginFor(style: VectorStyle): number {
  // Highlighting widens strokes and points by a few pixels; per-feature
  // simplestyle widths are rarely larger than this.
  return Math.max(style.strokeWidth + 2, style.pointRadius + style.pointStrokeWidth + 3, 8);
}

/**
 * Main-thread side of the vector pipeline. Owns the vector worker, keeps the
 * layer draw order and implements {@link TileOverlaySource} so the globe can
 * drape rasterized vectors over its tiles. Changes are tracked as invalidated
 * mercator rectangles, so only tiles that actually change are re-rasterized.
 */
export class VectorService implements TileOverlaySource {
  version = 0;
  /** Overlay resolution: 256 px per tile per CSS pixel ratio (max 2). */
  readonly pixelRatio: number;
  readonly tileSize: number;

  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, (msg: VectorResponse) => void>();
  private readonly loads = new Map<number, { resolve: (s: LayerSummary) => void; reject: (e: Error) => void }>();
  private readonly relabels = new Map<number, (r: { field: string | null; labels: LabelCandidate[] }) => void>();
  /** Draw order: later layers are drawn on top. */
  private readonly layers: LayerState[] = [];
  private invalidations: Invalidation[] = [];
  private highlight: { layerId: number; featureId: number; bbox: BBox } | null = null;

  constructor() {
    this.pixelRatio = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
    this.tileSize = 256 * this.pixelRatio;
    this.worker = new Worker(new URL('./vector.worker.ts', import.meta.url), { type: 'module', name: 'vector' });
    this.worker.onmessage = (e: MessageEvent<VectorResponse>) => this.onMessage(e.data);
    this.worker.onerror = (e) => console.error('[VectorService] worker error', e.message);
  }

  private post(msg: VectorRequest): void {
    this.worker.postMessage(msg);
  }

  private onMessage(msg: VectorResponse): void {
    switch (msg.type) {
      case 'loaded': {
        const state = this.layers.find((l) => l.id === msg.layerId);
        if (state) {
          state.bbox = msg.summary.mercBBox;
          this.invalidate(state.bbox, state.marginPx);
        }
        this.loads.get(msg.layerId)?.resolve(msg.summary);
        this.loads.delete(msg.layerId);
        break;
      }
      case 'labels':
        this.relabels.get(msg.layerId)?.({ field: msg.labelField, labels: msg.labels });
        this.relabels.delete(msg.layerId);
        break;
      case 'raster':
      case 'query': {
        const cb = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        cb?.(msg);
        break;
      }
      case 'error':
        if (msg.id !== undefined) {
          const cb = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          cb?.(msg);
        } else if (msg.layerId !== undefined) {
          this.loads.get(msg.layerId)?.reject(new Error(msg.message));
          this.loads.delete(msg.layerId);
        }
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Layers

  load(layerId: number, source: VectorSource, style: VectorStyle, labelField: string | null): Promise<LayerSummary> {
    this.layers.push({ id: layerId, visible: true, bbox: null, marginPx: marginFor(style) });
    return new Promise((resolve, reject) => {
      this.loads.set(layerId, { resolve, reject });
      this.post({ type: 'load', layerId, source, style, labelField });
    });
  }

  setStyle(layerId: number, style: VectorStyle): void {
    const state = this.layers.find((l) => l.id === layerId);
    if (!state) return;
    this.post({ type: 'style', layerId, style });
    state.marginPx = Math.max(state.marginPx, marginFor(style));
    this.invalidate(state.bbox, state.marginPx);
  }

  setVisible(layerId: number, visible: boolean): void {
    const state = this.layers.find((l) => l.id === layerId);
    if (!state || state.visible === visible) return;
    state.visible = visible;
    this.invalidate(state.bbox, state.marginPx);
  }

  /** Recomputes label candidates for a different label property. */
  relabel(layerId: number, labelField: string | null): Promise<{ field: string | null; labels: LabelCandidate[] }> {
    return new Promise((resolve) => {
      this.relabels.set(layerId, resolve);
      this.post({ type: 'labels', layerId, labelField });
    });
  }

  remove(layerId: number): void {
    const i = this.layers.findIndex((l) => l.id === layerId);
    if (i < 0) return;
    const [state] = this.layers.splice(i, 1);
    this.post({ type: 'remove', layerId });
    if (this.highlight?.layerId === layerId) this.highlight = null;
    this.invalidate(state.bbox, state.marginPx);
  }

  /** Highlights one feature (or clears with null); only its tiles are redrawn. */
  setHighlight(hit: Pick<FeatureHit, 'layerId' | 'featureId' | 'mercBBox'> | null): void {
    const old = this.highlight;
    if (old && hit && old.layerId === hit.layerId && old.featureId === hit.featureId) return;
    this.highlight = hit ? { layerId: hit.layerId, featureId: hit.featureId, bbox: hit.mercBBox } : null;
    if (old) this.invalidate(old.bbox, 12);
    if (hit) this.invalidate(hit.mercBBox, 12);
  }

  get highlighted(): { layerId: number; featureId: number } | null {
    return this.highlight ? { layerId: this.highlight.layerId, featureId: this.highlight.featureId } : null;
  }

  // ---------------------------------------------------------------------------
  // Queries

  /**
   * Top-most visible feature at a normalized mercator position.
   * `pixelSize` is the mercator size of one CSS pixel at that position.
   */
  query(u: number, v: number, pixelSize: number, tolerancePx = 5): Promise<FeatureHit | null> {
    const ids = this.layers.filter((l) => l.visible && l.bbox).map((l) => l.id).reverse();
    if (ids.length === 0) return Promise.resolve(null);
    return this.request({ type: 'query', id: this.nextId++, u, v, pixelSize, tolerancePx, layers: ids }).then((msg) =>
      msg.type === 'query' ? msg.hit : null,
    );
  }

  getFeature(layerId: number, featureId: number): Promise<FeatureHit | null> {
    return this.request({ type: 'feature', id: this.nextId++, layerId, featureId }).then((msg) => (msg.type === 'query' ? msg.hit : null));
  }

  private request(msg: Extract<VectorRequest, { id: number }>): Promise<VectorResponse> {
    return new Promise((resolve) => {
      this.pending.set(msg.id, resolve);
      this.post(msg);
    });
  }

  // ---------------------------------------------------------------------------
  // TileOverlaySource

  private invalidate(rect: BBox | null, marginPx: number): void {
    // A layer without a bbox (still loading or empty) has drawn nothing yet.
    if (rect === null) return;
    this.version++;
    this.invalidations.push({ version: this.version, rect, marginPx });
    if (this.invalidations.length > MAX_INVALIDATIONS) this.invalidations.splice(0, this.invalidations.length - MAX_INVALIDATIONS);
  }

  private rectHitsTile(rect: BBox, marginPx: number, level: number, x: number, y: number): boolean {
    const n = 2 ** level;
    const m = (marginPx + 2) / (256 * n);
    const tile: BBox = [x / n - m, y / n - m, (x + 1) / n + m, (y + 1) / n + m];
    for (let shift = -1; shift <= 1; shift++) {
      if (bboxIntersects([rect[0] + shift, rect[1], rect[2] + shift, rect[3]], tile)) return true;
    }
    return false;
  }

  hasContent(level: number, x: number, y: number): boolean {
    for (const l of this.layers) {
      if (l.visible && l.bbox && this.rectHitsTile(l.bbox, l.marginPx, level, x, y)) return true;
    }
    return false;
  }

  isCurrent(level: number, x: number, y: number, tileVersion: number): boolean {
    if (tileVersion >= this.version) return true;
    const oldest = this.invalidations.length > 0 ? this.invalidations[0].version : this.version + 1;
    // History before `oldest` was trimmed: we cannot tell, so refresh.
    if (tileVersion + 1 < oldest) return false;
    for (const inv of this.invalidations) {
      if (inv.version <= tileVersion) continue;
      if (!inv.rect || this.rectHitsTile(inv.rect, inv.marginPx, level, x, y)) return false;
    }
    return true;
  }

  requestOverlay(level: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap | null> {
    const ids = this.layers.filter((l) => l.visible && l.bbox && this.rectHitsTile(l.bbox, l.marginPx, level, x, y)).map((l) => l.id);
    if (ids.length === 0) return Promise.resolve(null);
    const id = this.nextId++;
    const hl = this.highlight;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.type === 'raster') resolve(msg.bitmap);
        else reject(new Error(msg.type === 'error' ? msg.message : 'unexpected response'));
      });
      this.post({
        type: 'raster',
        id,
        z: level,
        x,
        y,
        size: this.tileSize,
        pixelRatio: this.pixelRatio,
        layers: ids,
        highlight: hl ? { layerId: hl.layerId, featureId: hl.featureId } : null,
      });
      signal.addEventListener(
        'abort',
        () => {
          if (this.pending.has(id)) this.post({ type: 'cancel', id });
        },
        { once: true },
      );
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
    for (const l of this.loads.values()) l.reject(new Error('disposed'));
    this.loads.clear();
  }
}
