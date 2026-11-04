/**
 * Building / indoor model definition ("three-geo-building" JSON, v1.0).
 *
 * The hierarchy follows the IFC spatial structure and ThingJS's levels:
 *
 *   Building (IfcBuilding, ThingJS Building)
 *   ├─ exterior shell (facade + roof, shown from the globe)
 *   └─ Floor (IfcBuildingStorey, ThingJS Floor)
 *      ├─ Room (IfcSpace, ThingJS Room)            footprint polygon, area, walls
 *      ├─ Element (IfcWall / IfcDoor / IfcWindow / IfcColumn / IfcSlab)
 *      └─ Thing (IfcElement: equipment, sensors, assets; ThingJS Thing/Entity)
 *
 * Coordinates are meters in a building-local frame: +X east, +Y north, +Z up
 * at the geo anchor, rotated clockwise by `anchor.heading`. Floor content is
 * relative to the floor slab (z = 0 is the floor level). Geometry is either
 * procedural (footprints / boxes) or glTF per building, floor or thing; glTF
 * nodes whose name (or `extras.id`) equals an element id become that element,
 * the rest is static geometry that is drawn but not individually managed
 * (ThingJS "Misc"). See docs/agents/indoor-bim.md.
 */

export const BUILDING_FORMAT = 'three-geo-building';
export const BUILDING_FORMAT_VERSION = '1.0';

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** Where the building-local origin sits on the globe. */
export interface GeoAnchor {
  /** Degrees. */
  longitude: number;
  /** Degrees. */
  latitude: number;
  /** Meters above the WGS84 ellipsoid. Omit to place the origin on the terrain. */
  height?: number;
  /** Degrees clockwise from north of the local +Y axis. */
  heading?: number;
}

/** A glTF / GLB model. */
export interface ModelRef {
  /** URL, resolved against the document URL. */
  uri: string;
  /** glTF is Y-up by spec; use 'Z' for Z-up exports. */
  upAxis?: 'Y' | 'Z';
  /** Uniform scale to meters. */
  scale?: number;
  /** Offset in local meters after the up-axis fix. */
  offset?: Vec3;
  /** Rotation about +Z in degrees. */
  rotation?: number;
}

/**
 * When a label ("顶牌") is visible:
 * - 'always': whenever its entity is visible;
 * - 'level': when the entity's parent level is entered (e.g. room cards inside a floor);
 * - 'hover': while the pointer is over the entity;
 * - 'click': after the entity is clicked, until something else is.
 */
export type LabelMode = 'always' | 'level' | 'hover' | 'click';

/** Top card / marker definition, data-driven like ThingJS's userData-configured 顶牌. */
export interface LabelDef {
  /** Defaults to the entity name. */
  title?: string;
  subtitle?: string;
  mode?: LabelMode;
  /** 'card': speech bubble with leader line; 'pin': icon + text; 'tag': compact pill. */
  style?: 'card' | 'pin' | 'tag';
  /** Accent color (CSS). */
  color?: string;
  /** Short text or emoji shown before the title. */
  icon?: string;
  /** Extra height above the entity's top, meters. */
  offset?: number;
}

export interface ElementBase {
  /** Stable unique id within the document (e.g. an IFC GlobalId). */
  id: string;
  name?: string;
  /** Classification such as "office", "meeting", "camera" (IFC ObjectType / PredefinedType). */
  category?: string;
  /** Source IFC class (e.g. "IfcSpace"), kept for round-tripping. */
  ifcType?: string;
  /** Attributes and property sets. */
  properties?: Record<string, unknown>;
  label?: LabelDef;
}

export interface BuildingDoc extends ElementBase {
  format: typeof BUILDING_FORMAT;
  version: string;
  anchor: GeoAnchor;
  /** Outline in local meters, counter-clockwise. */
  footprint?: Vec2[];
  /** Exterior shell shown from outside; procedural (extruded footprint) when no model is given. */
  exterior?: { model?: ModelRef; color?: string; opacity?: number };
  floors: FloorDef[];
}

export interface FloorDef extends ElementBase {
  /** Storey order: 0 = ground floor, negative = basements. */
  index: number;
  /** Floor level above the building origin, meters. */
  elevation: number;
  /** Floor-to-floor height, meters. */
  height: number;
  /** Slab outline when it differs from the building footprint. */
  outline?: Vec2[];
  /** Whole-floor BIM export; nodes named after element ids become those elements. */
  model?: ModelRef;
  rooms?: RoomDef[];
  things?: ThingDef[];
  elements?: StructureDef[];
}

export interface RoomDef extends ElementBase {
  /** Boundary in floor-local meters. */
  footprint: Vec2[];
  /** Clear height; defaults to the floor height. */
  height?: number;
  /** Draw boundary walls (procedural floors only, default true). */
  walls?: boolean;
  /** Door openings: edge index of the footprint, position along it (0..1), width in meters. */
  doors?: { edge: number; at: number; width?: number }[];
  color?: string;
}

export interface ThingDef extends ElementBase {
  /** Floor-local meters; z is above the floor slab. */
  position: Vec3;
  /** Degrees about +Z. */
  rotation?: number;
  /** Primitive size [width, depth, height] when no model is given. */
  size?: Vec3;
  shape?: 'box' | 'cylinder' | 'sphere';
  color?: string;
  model?: ModelRef;
}

export interface StructureDef extends ElementBase {
  kind: 'wall' | 'door' | 'window' | 'column' | 'slab' | 'stair';
  /** Polyline (walls) or polygon (slabs) in floor-local meters. */
  path?: Vec2[];
  position?: Vec3;
  size?: Vec3;
  thickness?: number;
  height?: number;
  color?: string;
}

/** Shoelace area of a polygon in square meters. */
export function polygonArea(points: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) a += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
  return Math.abs(a) / 2;
}

/** Signed area (positive = counter-clockwise). */
export function signedArea(points: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  return a / 2;
}

/** Area-weighted centroid of a simple polygon. */
export function polygonCentroid(points: readonly Vec2[]): Vec2 {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const f = points[j][0] * points[i][1] - points[i][0] * points[j][1];
    cx += (points[j][0] + points[i][0]) * f;
    cy += (points[j][1] + points[i][1]) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = points.length || 1;
    return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Axis-aligned bounds of 2D points: [minX, minY, maxX, maxY]. */
export function bounds2(points: readonly Vec2[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

class SchemaError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'BuildingSchemaError';
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, path: string, fallback?: number): number {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new SchemaError(path, 'expected a finite number');
  return v;
}

function points2(v: unknown, path: string, min = 3): Vec2[] {
  if (!Array.isArray(v) || v.length < min) throw new SchemaError(path, `expected at least ${min} [x, y] points`);
  return v.map((p, i) => {
    if (!Array.isArray(p) || p.length < 2) throw new SchemaError(`${path}[${i}]`, 'expected [x, y]');
    return [num(p[0], `${path}[${i}][0]`), num(p[1], `${path}[${i}][1]`)] as Vec2;
  });
}

function vec3(v: unknown, path: string): Vec3 {
  if (!Array.isArray(v) || v.length < 3) throw new SchemaError(path, 'expected [x, y, z]');
  return [num(v[0], `${path}[0]`), num(v[1], `${path}[1]`), num(v[2], `${path}[2]`)];
}

function base(v: Record<string, unknown>, path: string, ids: Set<string>): ElementBase {
  if (typeof v.id !== 'string' || !v.id) throw new SchemaError(`${path}.id`, 'expected a non-empty string');
  if (ids.has(v.id)) throw new SchemaError(`${path}.id`, `duplicate id "${v.id}"`);
  ids.add(v.id);
  return {
    id: v.id,
    name: typeof v.name === 'string' ? v.name : undefined,
    category: typeof v.category === 'string' ? v.category : undefined,
    ifcType: typeof v.ifcType === 'string' ? v.ifcType : undefined,
    properties: isObj(v.properties) ? v.properties : undefined,
    label: isObj(v.label) ? (v.label as LabelDef) : undefined,
  };
}

function model(v: unknown, path: string): ModelRef | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v) || typeof v.uri !== 'string') throw new SchemaError(path, 'expected { uri }');
  return v as unknown as ModelRef;
}

/**
 * Validates a parsed document and fills defaults. Throws a descriptive
 * error (JSON path + problem) for malformed input.
 */
export function parseBuildingDoc(input: unknown): BuildingDoc {
  if (typeof input === 'string') input = JSON.parse(input);
  if (!isObj(input)) throw new SchemaError('$', 'expected an object');
  if (input.format !== BUILDING_FORMAT) throw new SchemaError('$.format', `expected "${BUILDING_FORMAT}"`);
  const version = typeof input.version === 'string' ? input.version : BUILDING_FORMAT_VERSION;
  if (version.split('.')[0] !== BUILDING_FORMAT_VERSION.split('.')[0]) throw new SchemaError('$.version', `unsupported version ${version}`);
  const ids = new Set<string>();
  const doc = base(input, '$', ids);
  if (!isObj(input.anchor)) throw new SchemaError('$.anchor', 'expected { longitude, latitude }');
  const a = input.anchor;
  const anchor: GeoAnchor = {
    longitude: num(a.longitude, '$.anchor.longitude'),
    latitude: num(a.latitude, '$.anchor.latitude'),
    height: a.height === undefined ? undefined : num(a.height, '$.anchor.height'),
    heading: num(a.heading, '$.anchor.heading', 0),
  };
  if (Math.abs(anchor.latitude) > 90) throw new SchemaError('$.anchor.latitude', 'out of range');
  const footprint = input.footprint === undefined ? undefined : points2(input.footprint, '$.footprint');
  if (!Array.isArray(input.floors) || input.floors.length === 0) throw new SchemaError('$.floors', 'expected at least one floor');

  const floors: FloorDef[] = input.floors.map((f: unknown, fi: number) => {
    const fp = `$.floors[${fi}]`;
    if (!isObj(f)) throw new SchemaError(fp, 'expected an object');
    const floor: FloorDef = {
      ...base(f, fp, ids),
      index: num(f.index, `${fp}.index`, fi),
      elevation: num(f.elevation, `${fp}.elevation`),
      height: num(f.height, `${fp}.height`),
      outline: f.outline === undefined ? undefined : points2(f.outline, `${fp}.outline`),
      model: model(f.model, `${fp}.model`),
    };
    if (floor.height <= 0) throw new SchemaError(`${fp}.height`, 'must be positive');
    floor.rooms = (Array.isArray(f.rooms) ? f.rooms : []).map((r: unknown, ri: number) => {
      const rp = `${fp}.rooms[${ri}]`;
      if (!isObj(r)) throw new SchemaError(rp, 'expected an object');
      return {
        ...base(r, rp, ids),
        footprint: points2(r.footprint, `${rp}.footprint`),
        height: r.height === undefined ? undefined : num(r.height, `${rp}.height`),
        walls: r.walls !== false,
        doors: Array.isArray(r.doors) ? (r.doors as RoomDef['doors']) : undefined,
        color: typeof r.color === 'string' ? r.color : undefined,
      } satisfies RoomDef;
    });
    floor.things = (Array.isArray(f.things) ? f.things : []).map((t: unknown, ti: number) => {
      const tp = `${fp}.things[${ti}]`;
      if (!isObj(t)) throw new SchemaError(tp, 'expected an object');
      return {
        ...base(t, tp, ids),
        position: vec3(t.position, `${tp}.position`),
        rotation: num(t.rotation, `${tp}.rotation`, 0),
        size: t.size === undefined ? undefined : vec3(t.size, `${tp}.size`),
        shape: t.shape === 'cylinder' || t.shape === 'sphere' ? t.shape : 'box',
        color: typeof t.color === 'string' ? t.color : undefined,
        model: model(t.model, `${tp}.model`),
      } satisfies ThingDef;
    });
    floor.elements = (Array.isArray(f.elements) ? f.elements : []).map((e: unknown, ei: number) => {
      const ep = `${fp}.elements[${ei}]`;
      if (!isObj(e) || typeof e.kind !== 'string') throw new SchemaError(ep, 'expected { kind }');
      return { ...(e as unknown as StructureDef), ...base(e, ep, ids) };
    });
    return floor;
  });
  floors.sort((x, y) => x.index - y.index);

  return {
    ...doc,
    format: BUILDING_FORMAT,
    version,
    anchor,
    footprint,
    exterior: isObj(input.exterior) ? (input.exterior as BuildingDoc['exterior']) : undefined,
    floors,
  };
}
