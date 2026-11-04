/** Visual style of a vector layer. Colors are CSS color strings. */
export interface VectorStyle {
  fill: string;
  fillOpacity: number;
  stroke: string;
  /** CSS pixels. */
  strokeWidth: number;
  strokeOpacity: number;
  pointColor: string;
  /** CSS pixels. */
  pointRadius: number;
  pointStroke: string;
  pointStrokeWidth: number;
  /** Property whose value picks a categorical fill color (e.g. Natural Earth `MAPCOLOR7`). */
  colorBy: string | null;
  /** Honor per-feature simplestyle-spec properties (`fill`, `stroke`, `marker-color`...). */
  simplestyle: boolean;
}

export interface LabelStyle {
  enabled: boolean;
  /** Property used as label text; null picks a name-like property automatically. */
  field: string | null;
  color: string;
  haloColor: string;
  /** CSS pixels. */
  size: number;
  /** Respect `min_label` / `min_zoom` style properties when present. */
  useMinZoom: boolean;
}

export const DEFAULT_VECTOR_STYLE: VectorStyle = {
  fill: '#3b82f6',
  fillOpacity: 0.18,
  stroke: '#60a5fa',
  strokeWidth: 1.5,
  strokeOpacity: 0.95,
  pointColor: '#f59e0b',
  pointRadius: 4,
  pointStroke: '#ffffff',
  pointStrokeWidth: 1.25,
  colorBy: null,
  simplestyle: true,
};

export const DEFAULT_LABEL_STYLE: LabelStyle = {
  enabled: true,
  field: null,
  color: '#ffffff',
  haloColor: 'rgba(8, 12, 20, 0.85)',
  size: 13,
  useMinZoom: true,
};

export type FeatureKind = 'point' | 'line' | 'polygon';

/** A label anchor computed in the worker. */
export interface LabelCandidate {
  featureId: number;
  text: string;
  /** Degrees. */
  lon: number;
  /** Degrees. */
  lat: number;
  /** Lower is more important. */
  priority: number;
  /** Equivalent web-map zoom from which the label may appear. */
  minZoom: number;
  kind: FeatureKind;
  /** Approximate feature size in meters (polygons and lines), 0 for points. */
  sizeMeters: number;
}

export interface LayerSummary {
  featureCount: number;
  pointCount: number;
  geometryTypes: Record<string, number>;
  /** [west, south, east, north] in degrees; west > east never happens (longitudes are unwrapped). */
  bbox: [number, number, number, number] | null;
  /** Bounding box in normalized Web Mercator (u right, v down); u may leave [0, 1] when unwrapped. */
  mercBBox: [number, number, number, number] | null;
  propertyKeys: string[];
  labelField: string | null;
  labels: LabelCandidate[];
}

export interface FeatureHit {
  layerId: number;
  featureId: number;
  kind: FeatureKind;
  properties: Record<string, unknown>;
  /** Normalized mercator bbox of the feature. */
  mercBBox: [number, number, number, number];
  /** [west, south, east, north] degrees. */
  bbox: [number, number, number, number];
}

export type VectorSource = { url: string } | { text: string } | { json: unknown };

export type VectorRequest =
  | { type: 'load'; layerId: number; source: VectorSource; style: VectorStyle; labelField: string | null }
  | { type: 'style'; layerId: number; style: VectorStyle }
  | { type: 'labels'; layerId: number; labelField: string | null }
  | { type: 'remove'; layerId: number }
  | {
      type: 'raster';
      id: number;
      z: number;
      x: number;
      y: number;
      size: number;
      pixelRatio: number;
      layers: number[];
      highlight: { layerId: number; featureId: number } | null;
    }
  | { type: 'cancel'; id: number }
  | { type: 'feature'; id: number; layerId: number; featureId: number }
  | {
      type: 'query';
      id: number;
      u: number;
      v: number;
      /** Normalized mercator units per CSS pixel at the query point. */
      pixelSize: number;
      /** Pick tolerance in CSS pixels. */
      tolerancePx: number;
      /** Layer ids, top-most first. */
      layers: number[];
    };

export type VectorResponse =
  | { type: 'loaded'; layerId: number; summary: LayerSummary }
  | { type: 'labels'; layerId: number; labelField: string | null; labels: LabelCandidate[] }
  | { type: 'raster'; id: number; bitmap: ImageBitmap | null }
  | { type: 'query'; id: number; hit: FeatureHit | null }
  | { type: 'error'; layerId?: number; id?: number; message: string };
