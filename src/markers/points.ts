/**
 * Point marker data (点位): parsing and data-driven styling (clustering is in
 * clusterTree.ts). Pure functions without three.js or the DOM so they can be unit
 * tested; `PointLayer` turns the result into HTML markers.
 *
 * Accepted input (`parsePoints`):
 * - GeoJSON: FeatureCollection / Feature / geometry with Point or MultiPoint
 *   coordinates `[lon, lat, height?]` (degrees, meters). Other geometries are
 *   skipped and counted.
 * - An array of records with `lon|lng|longitude` and `lat|latitude`
 *   (degrees), optional `height|alt|altitude|elevation` (meters) and `id`;
 *   all other fields become properties.
 * - `{ points: [...] }` (same records), optionally with `style` and `rules`
 *   that the layer uses as defaults.
 */

/** Marker looks provided by `createCard` (markers/cards.ts). */
export type MarkerStyleName = 'card' | 'pin' | 'tag' | 'poi' | 'pulse' | 'beacon' | 'badge' | 'label';

export const MARKER_STYLES: readonly MarkerStyleName[] = ['poi', 'pulse', 'badge', 'beacon', 'label', 'pin', 'tag', 'card'];

/** One point, normalized. */
export interface PointRecord {
  id: string;
  /** Degrees. */
  longitude: number;
  /** Degrees. */
  latitude: number;
  /** Meters above the WGS84 ellipsoid; null = on the ground (terrain height). */
  height: number | null;
  properties: Record<string, unknown>;
}

/** How a point is drawn. Text fields are templates: `{name}` is replaced by that property. */
export interface PointStyle {
  style?: MarkerStyleName;
  /** Accent color (CSS). */
  color?: string;
  /** Short text or emoji drawn in the symbol. */
  icon?: string;
  title?: string;
  subtitle?: string;
  /** Status badge text, e.g. "告警". */
  badge?: string;
  badgeColor?: string;
  /** Meters added to the anchor height (the ground or the point's own height). */
  heightOffset?: number;
  /** Camera distance range in meters outside which the marker is hidden. */
  minDistance?: number;
  maxDistance?: number;
  /** Scale 1 up to `near` meters, `minScale` from `far` on. */
  scaleByDistance?: [near: number, far: number, minScale: number];
  /** Hidden when overlapping a marker of higher priority (default true). */
  declutter?: boolean;
  /** Higher wins collisions and clusters' representative choice. */
  priority?: number;
  zIndex?: number;
}

type Scalar = string | number | boolean | null;
/** Property test: equality, membership (array) or comparison operators. */
export type Condition = Scalar | Scalar[] | { eq?: Scalar; ne?: Scalar; gt?: number; gte?: number; lt?: number; lte?: number; in?: Scalar[] };

/** Applies `style` to points whose properties match all conditions of `when`. Later rules win. */
export interface PointRule {
  when: Record<string, Condition>;
  style: PointStyle;
}

export interface ParsedPoints {
  points: PointRecord[];
  /** Features or records that were not points or had invalid coordinates. */
  skipped: number;
  /** First problems found (with their location in the input). */
  warnings: string[];
  /** Defaults carried by a `{ points, style, rules }` document. */
  style?: PointStyle;
  rules?: PointRule[];
}

const LON_KEYS = ['lon', 'lng', 'longitude', 'Lon', 'Lng', 'Longitude', 'LON', 'LNG', '经度'];
const LAT_KEYS = ['lat', 'latitude', 'Lat', 'Latitude', 'LAT', '纬度'];
const HEIGHT_KEYS = ['height', 'alt', 'altitude', 'elevation', 'Height', 'z', '高度'];
const TITLE_KEYS = ['name', 'title', 'label', 'Name', 'NAME', '名称', 'id'];
const MAX_WARNINGS = 8;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pick(record: Record<string, unknown>, keys: readonly string[]): [string, unknown] | null {
  for (const k of keys) if (k in record && record[k] !== null && record[k] !== '') return [k, record[k]];
  return null;
}

function toNumber(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
}

function validLonLat(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}

/** Normalizes point data (see the module comment for the accepted shapes). */
export function parsePoints(input: unknown): ParsedPoints {
  const out: ParsedPoints = { points: [], skipped: 0, warnings: [] };
  const warn = (msg: string) => {
    out.skipped++;
    if (out.warnings.length < MAX_WARNINGS) out.warnings.push(msg);
  };
  const usedIds = new Set<string>();
  const add = (id: unknown, lon: number, lat: number, height: unknown, properties: Record<string, unknown>, where: string) => {
    if (!validLonLat(lon, lat)) return warn(`${where}: 坐标无效 (${lon}, ${lat})`);
    const h = toNumber(height);
    let key = id === undefined || id === null || id === '' ? `p${out.points.length}` : String(id);
    // Keep ids unique (MultiPoint parts, duplicate records).
    if (usedIds.has(key)) key = `${key}#${out.points.length}`;
    usedIds.add(key);
    out.points.push({ id: key, longitude: lon, latitude: lat, height: Number.isFinite(h) ? h : null, properties });
  };

  const fromGeometry = (geom: unknown, id: unknown, props: Record<string, unknown>, where: string) => {
    if (!isObject(geom)) return warn(`${where}: 缺少 geometry`);
    if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
      const [lon, lat, h] = geom.coordinates as unknown[];
      return add(id, toNumber(lon), toNumber(lat), h, props, where);
    }
    if (geom.type === 'MultiPoint' && Array.isArray(geom.coordinates)) {
      (geom.coordinates as unknown[]).forEach((c, i) => {
        const [lon, lat, h] = Array.isArray(c) ? (c as unknown[]) : [];
        add(id === undefined ? undefined : `${String(id)}-${i}`, toNumber(lon), toNumber(lat), h, props, `${where}.coordinates[${i}]`);
      });
      return;
    }
    if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
      (geom.geometries as unknown[]).forEach((g, i) => fromGeometry(g, id, props, `${where}.geometries[${i}]`));
      return;
    }
    out.skipped++;
  };

  const fromRecord = (r: unknown, where: string) => {
    if (!isObject(r)) return warn(`${where}: 不是对象`);
    if (r.type === 'Feature') return fromGeometry(r.geometry, r.id ?? (isObject(r.properties) ? r.properties.id : undefined), isObject(r.properties) ? r.properties : {}, where);
    const lon = pick(r, LON_KEYS);
    const lat = pick(r, LAT_KEYS);
    if (!lon || !lat) {
      // Records may carry a GeoJSON-like `coordinates` / `position` pair instead.
      const pos = Array.isArray(r.coordinates) ? r.coordinates : Array.isArray(r.position) ? r.position : null;
      if (!pos) return warn(`${where}: 缺少经纬度字段（lon/lng/longitude 与 lat/latitude）`);
      const { coordinates: _c, position: _p, id, ...props } = r;
      return add(id, toNumber(pos[0]), toNumber(pos[1]), pos[2], props, where);
    }
    const h = pick(r, HEIGHT_KEYS);
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) if (k !== lon[0] && k !== lat[0] && k !== h?.[0]) props[k] = v;
    return add(r.id, toNumber(lon[1]), toNumber(lat[1]), h?.[1], props, where);
  };

  if (Array.isArray(input)) {
    input.forEach((r, i) => fromRecord(r, `[${i}]`));
  } else if (isObject(input)) {
    if (input.type === 'FeatureCollection' && Array.isArray(input.features)) {
      input.features.forEach((f, i) => fromRecord(f, `features[${i}]`));
    } else if (input.type === 'Feature') {
      fromRecord(input, 'feature');
    } else if (typeof input.type === 'string' && 'coordinates' in input) {
      fromGeometry(input, undefined, {}, 'geometry');
    } else if (Array.isArray(input.points)) {
      input.points.forEach((r, i) => fromRecord(r, `points[${i}]`));
      if (isObject(input.style)) out.style = input.style as PointStyle;
      if (Array.isArray(input.rules)) out.rules = input.rules.filter((r): r is PointRule => isObject(r) && isObject(r.when) && isObject(r.style));
    } else {
      out.warnings.push('无法识别的数据：需要 GeoJSON 点要素、点记录数组或 { points: [...] }');
    }
  } else {
    out.warnings.push('无法识别的数据：需要 JSON 对象或数组');
  }
  return out;
}

function compare(value: unknown, cond: Condition): boolean {
  if (Array.isArray(cond)) return cond.some((c) => compare(value, c));
  // `null` stands for "no value": matches null and missing properties.
  if (cond === null) return value === null || value === undefined;
  if (!isObject(cond)) {
    // Loose equality between numbers and numeric strings ("3" matches 3).
    if (typeof cond === 'number' && typeof value === 'string') return Number(value) === cond;
    if (typeof cond === 'string' && typeof value === 'number') return String(value) === cond;
    return value === cond;
  }
  const n = toNumber(value);
  if (cond.eq !== undefined && !compare(value, cond.eq)) return false;
  if (cond.ne !== undefined && compare(value, cond.ne)) return false;
  if (cond.in !== undefined && !compare(value, cond.in)) return false;
  if (cond.gt !== undefined && !(n > cond.gt)) return false;
  if (cond.gte !== undefined && !(n >= cond.gte)) return false;
  if (cond.lt !== undefined && !(n < cond.lt)) return false;
  if (cond.lte !== undefined && !(n <= cond.lte)) return false;
  return true;
}

/** Whether all conditions of a rule hold for these properties. */
export function matchesRule(properties: Record<string, unknown>, when: Record<string, Condition>): boolean {
  for (const [key, cond] of Object.entries(when)) if (!compare(properties[key], cond)) return false;
  return true;
}

/** Base style, then every matching rule in order, then the point's own `style` property (an object). */
export function resolvePointStyle(point: PointRecord, base: PointStyle, rules: readonly PointRule[] = []): PointStyle {
  const style: PointStyle = { ...base };
  for (const rule of rules) if (matchesRule(point.properties, rule.when)) Object.assign(style, rule.style);
  const own = point.properties.style;
  if (isObject(own)) Object.assign(style, own as PointStyle);
  return style;
}

/** Replaces `{key}` with the property value (empty when missing). Text without braces is used as is. */
export function fillTemplate(template: string, properties: Record<string, unknown>): string {
  return template.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    const v = properties[key.trim()];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Title shown when the style has none: the first name-like property. */
export function defaultTitle(point: PointRecord): string {
  const hit = pick(point.properties, TITLE_KEYS);
  return hit ? String(hit[1]) : point.id;
}

/** Bounding box [west, south, east, north] in degrees of some points. */
export function pointsBBox(points: readonly PointRecord[]): [number, number, number, number] | null {
  if (points.length === 0) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of points) {
    w = Math.min(w, p.longitude);
    e = Math.max(e, p.longitude);
    s = Math.min(s, p.latitude);
    n = Math.max(n, p.latitude);
  }
  return [w, s, e, n];
}
