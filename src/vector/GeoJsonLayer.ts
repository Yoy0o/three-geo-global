import { EventEmitter } from '../core/EventEmitter';
import type { LabelManager } from './LabelManager';
import { DEFAULT_LABEL_STYLE, DEFAULT_VECTOR_STYLE, type LabelStyle, type LayerSummary, type VectorSource, type VectorStyle } from './types';
import type { VectorService } from './VectorService';

export interface GeoJsonLayerOptions {
  name?: string;
  /** URL of a GeoJSON document (fetched and parsed in the vector worker). */
  url?: string;
  /** GeoJSON object or JSON text. */
  data?: unknown;
  style?: Partial<VectorStyle>;
  /** Label options, or false to disable labels. */
  label?: Partial<LabelStyle> | false;
}

export interface GeoJsonLayerEvents extends Record<string, unknown> {
  ready: LayerSummary;
  error: { message: string };
  change: void;
}

/** Distinct default colors so that several layers stay distinguishable. */
const LAYER_COLORS = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee'];
let nextId = 1;

/**
 * A GeoJSON dataset on the globe. Lines and polygons (and point symbols) are
 * rasterized in a worker and draped onto the terrain; labels are rendered as
 * decluttered screen-space text.
 */
export class GeoJsonLayer {
  readonly id = nextId++;
  readonly name: string;
  readonly events = new EventEmitter<GeoJsonLayerEvents>();
  summary: LayerSummary | null = null;
  ready = false;
  error: string | null = null;
  private _visible = true;
  private _style: VectorStyle;
  private _labelStyle: LabelStyle;

  constructor(
    options: GeoJsonLayerOptions,
    private readonly vectors: VectorService,
    private readonly labels: LabelManager,
  ) {
    const color = LAYER_COLORS[(this.id - 1) % LAYER_COLORS.length];
    this._style = { ...DEFAULT_VECTOR_STYLE, fill: color, stroke: color, pointColor: color, ...options.style };
    this._labelStyle = options.label === false ? { ...DEFAULT_LABEL_STYLE, enabled: false } : { ...DEFAULT_LABEL_STYLE, ...options.label };
    this.name = options.name ?? defaultName(options);

    let source: VectorSource;
    if (options.url) source = { url: options.url };
    else if (typeof options.data === 'string') source = { text: options.data };
    else if (options.data !== undefined) source = { json: options.data };
    else throw new Error('GeoJsonLayer needs `url` or `data`');

    vectors
      .load(this.id, source, this._style, this._labelStyle.field)
      .then((summary) => {
        this.summary = summary;
        this._labelStyle = { ...this._labelStyle, field: summary.labelField };
        this.ready = true;
        this.labels.setLabels(this.id, summary.labels, this._labelStyle, this.pointOffset());
        this.labels.setLayerVisible(this.id, this._visible);
        this.events.emit('ready', summary);
      })
      .catch((err: Error) => {
        this.error = err.message;
        this.events.emit('error', { message: err.message });
      });
  }

  get style(): Readonly<VectorStyle> {
    return this._style;
  }

  get labelStyle(): Readonly<LabelStyle> {
    return this._labelStyle;
  }

  get visible(): boolean {
    return this._visible;
  }

  set visible(v: boolean) {
    this._visible = v;
    this.vectors.setVisible(this.id, v);
    this.labels.setLayerVisible(this.id, v);
    this.events.emit('change', undefined);
  }

  setStyle(style: Partial<VectorStyle>): void {
    this._style = { ...this._style, ...style };
    this.vectors.setStyle(this.id, this._style);
    if (this.ready && style.pointRadius !== undefined) this.labels.setLabels(this.id, this.summary!.labels, this._labelStyle, this.pointOffset());
    this.events.emit('change', undefined);
  }

  /** Updates label options; changing `field` recomputes anchors in the worker. */
  async setLabelStyle(style: Partial<LabelStyle>): Promise<void> {
    const fieldChanged = style.field !== undefined && style.field !== this._labelStyle.field;
    this._labelStyle = { ...this._labelStyle, ...style };
    if (!this.ready || !this.summary) return;
    if (fieldChanged) {
      const { field, labels } = await this.vectors.relabel(this.id, this._labelStyle.field);
      this.summary = { ...this.summary, labelField: field, labels };
      this._labelStyle.field = field;
    }
    this.labels.setLabels(this.id, this.summary.labels, this._labelStyle, this.pointOffset());
    this.events.emit('change', undefined);
  }

  private pointOffset(): number {
    return this._style.pointRadius + this._style.pointStrokeWidth + 4;
  }

  dispose(): void {
    this.vectors.remove(this.id);
    this.labels.removeLayer(this.id);
  }
}

function defaultName(options: GeoJsonLayerOptions): string {
  if (options.url) {
    try {
      const file = new URL(options.url, location.href).pathname.split('/').pop() ?? '';
      return decodeURIComponent(file.replace(/\.(geo)?json$/i, '')) || 'GeoJSON';
    } catch {
      return 'GeoJSON';
    }
  }
  return 'GeoJSON';
}
