import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Matrix4,
  Mesh,
  Object3D,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  Vector3,
  type Side,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Ellipsoid } from '../core/Ellipsoid';
import { DEG2RAD } from '../core/math';
import { BimEntity } from './BimEntity';
import {
  bounds2,
  polygonArea,
  polygonCentroid,
  signedArea,
  type BuildingDoc,
  type FloorDef,
  type ModelRef,
  type RoomDef,
  type StructureDef,
  type ThingDef,
  type Vec2,
} from './schema';

/** Loads a glTF model (resolved URL) into a scene graph. */
export type ModelLoader = (uri: string) => Promise<Object3D>;

const WALL_THICKNESS = 0.14;
const DOOR_HEIGHT = 2.1;
const SLAB_THICKNESS = 0.25;
const EXPAND_SPEED = 6;

/** Soft category colors for rooms and equipment. */
const ROOM_COLORS: Record<string, string> = {
  office: '#cfe3ff',
  meeting: '#ffe2b8',
  lobby: '#d9f2e3',
  corridor: '#eef1f5',
  server: '#e3d7ff',
  restroom: '#d4eef2',
  storage: '#ece4d8',
  stair: '#e6e6e6',
  kitchen: '#ffd6d6',
};
const THING_COLORS: Record<string, string> = {
  camera: '#334155',
  sensor: '#0ea5e9',
  ap: '#f8fafc',
  extinguisher: '#dc2626',
  rack: '#1f2937',
  ahu: '#94a3b8',
  desk: '#c8a27a',
  screen: '#111827',
};

function material(color: string, options: { opacity?: number; roughness?: number; metalness?: number; side?: Side } = {}): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.color = new Color(color);
  m.roughness = options.roughness ?? 0.85;
  m.metalness = options.metalness ?? 0;
  if (options.opacity !== undefined && options.opacity < 1) {
    m.transparent = true;
    m.opacity = options.opacity;
    m.depthWrite = false;
  }
  if (options.side !== undefined) m.side = options.side;
  return m;
}

/** Counter-clockwise copy of a polygon. */
function ccw(points: Vec2[]): Vec2[] {
  return signedArea(points) < 0 ? [...points].reverse() : points;
}

function shapeOf(points: Vec2[]): Shape {
  const s = new Shape();
  points.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  s.closePath();
  return s;
}

/** Prism over a polygon from z0 to z1. */
function prism(points: Vec2[], z0: number, z1: number): BufferGeometry {
  const g = new ExtrudeGeometry(shapeOf(ccw(points)), { depth: z1 - z0, bevelEnabled: false });
  g.translate(0, 0, z0);
  return g;
}

/** Wall box from a to b (centered on the segment), bottom at z0. */
function wallBox(a: Vec2, b: Vec2, z0: number, height: number, thickness: number): BufferGeometry | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 0.05 || height <= 0) return null;
  const g = new BoxGeometry(len, thickness, height);
  g.rotateZ(Math.atan2(dy, dx));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z0 + height / 2);
  return g;
}

/**
 * Walls along a room boundary, inset by half the wall thickness so the walls
 * of neighbouring rooms sit back to back instead of z-fighting. Door
 * openings leave a gap with a lintel above it.
 */
function roomWalls(room: RoomDef, height: number): BufferGeometry | null {
  const pts = ccw(room.footprint);
  const n = pts.length;
  const parts: BufferGeometry[] = [];
  const inset = WALL_THICKNESS / 2;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 0.05) continue;
    // Interior is on the left of each edge of a counter-clockwise polygon.
    const nx = (-dy / len) * inset;
    const ny = (dx / len) * inset;
    const p0: Vec2 = [a[0] + nx, a[1] + ny];
    const p1: Vec2 = [b[0] + nx, b[1] + ny];
    const at = (t: number): Vec2 => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
    // Door indices refer to the footprint as authored; map them when it was reversed
    // (edge i then runs backwards along authored edge n-2-i).
    const flipped = signedArea(room.footprint) < 0;
    const authoredEdge = flipped ? (n - 2 - i + n) % n : i;
    const doors = (room.doors ?? [])
      .filter((d) => d.edge === authoredEdge)
      .map((d) => ({ ...d, at: flipped ? 1 - d.at : d.at }))
      .sort((x, y) => x.at - y.at);
    let t0 = 0;
    for (const d of doors) {
      const w = Math.min(len * 0.9, d.width ?? 1.0) / len;
      const s = Math.max(0, d.at - w / 2);
      const e = Math.min(1, d.at + w / 2);
      const seg = wallBox(at(t0), at(s), 0, height, WALL_THICKNESS);
      if (seg) parts.push(seg);
      const lintel = wallBox(at(s), at(e), DOOR_HEIGHT, height - DOOR_HEIGHT, WALL_THICKNESS);
      if (lintel) parts.push(lintel);
      t0 = e;
    }
    const tail = wallBox(at(t0), at(1), 0, height, WALL_THICKNESS);
    if (tail) parts.push(tail);
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  for (const p of parts) p.dispose();
  return merged;
}

function addMesh(entity: BimEntity, geometry: BufferGeometry, mat: MeshStandardNodeMaterial, managed = true): Mesh {
  const mesh = new Mesh(geometry, mat);
  mesh.userData.entity = entity;
  entity.group.add(mesh);
  if (managed) entity.meshes.push(mesh);
  return mesh;
}

function labelOf<T extends { name?: string; label?: BimEntity['label'] }>(def: T): BimEntity['label'] {
  return def.label ? { ...def.label } : null;
}

/**
 * A building on the globe: entity tree (building → floors → rooms / things /
 * elements) plus meshes, positioned by the ENU frame at its geo anchor.
 */
export class Building extends BimEntity {
  /** Geographic placement: ENU frame at the anchor, rotated by the heading. Parent of `group`. */
  readonly root = new Group();
  /** Exterior shell shown from outside (hidden when the building is entered). */
  readonly exterior = new Group();
  readonly floors: BimEntity[] = [];
  /** Ground height (ellipsoidal meters) used for the anchor when the document has none. */
  groundHeight = 0;
  private expandGap = 0;
  private expandTarget = 0;
  private readonly topElevation: number;

  constructor(
    readonly doc: BuildingDoc,
    private readonly ellipsoid: Ellipsoid,
    private readonly loadModel: ModelLoader | null,
    private readonly baseUrl?: string,
  ) {
    super(doc.id, 'building', doc.name ?? doc.id, doc.category ?? 'building', doc.properties ?? {}, doc.label);
    this.root.name = `Building ${this.name}`;
    this.root.matrixAutoUpdate = false;
    this.root.add(this.group);
    this.exterior.name = 'exterior';
    this.group.add(this.exterior);

    const footprint = doc.footprint ?? this.floorUnionBounds();
    this.topElevation = Math.max(...doc.floors.map((f) => f.elevation + f.height));
    for (const f of doc.floors) this.buildFloor(f, footprint);
    this.buildExterior(footprint);

    const [cx, cy] = polygonCentroid(footprint);
    this.labelAnchor.set(cx, cy, this.topElevation + (this.label?.offset ?? 3));
    this.properties = { 楼层数: doc.floors.length, 建筑高度: `${this.topElevation.toFixed(1)} m`, ...this.properties };
    this.place(doc.anchor.height ?? 0);
  }

  /** Heading of the building's +Y axis in radians (clockwise from north). */
  get heading(): number {
    return (this.doc.anchor.heading ?? 0) * DEG2RAD;
  }

  /** Re-anchors the building at a height (ellipsoidal meters). */
  place(height: number): void {
    this.groundHeight = height;
    const a = this.doc.anchor;
    const origin = this.ellipsoid.cartographicToCartesian(a.longitude * DEG2RAD, a.latitude * DEG2RAD, height);
    const enu = this.ellipsoid.eastNorthUpToFixedFrame(origin);
    // Local +Y points `heading` clockwise from north: a negative turn about up.
    this.root.matrix.copy(enu).multiply(new Matrix4().makeRotationZ(-this.heading));
    this.root.matrixWorldNeedsUpdate = true;
    this.root.updateMatrixWorld(true);
  }

  /** Spreads floors apart vertically (楼层展开) by `gap` meters per storey (0 collapses). */
  setExpanded(gap: number): void {
    this.expandTarget = gap;
  }

  get isExpanding(): boolean {
    return Math.abs(this.expandGap - this.expandTarget) > 1e-3;
  }

  /** Advances animations; returns true when something moved. */
  update(dt: number): boolean {
    if (!this.isExpanding) return false;
    const k = 1 - Math.exp(-dt * EXPAND_SPEED);
    this.expandGap += (this.expandTarget - this.expandGap) * k;
    if (Math.abs(this.expandGap - this.expandTarget) < 0.01) this.expandGap = this.expandTarget;
    this.floors.forEach((f, rank) => {
      const def = this.doc.floors[rank];
      f.group.position.z = def.elevation + this.expandGap * rank;
      f.group.updateMatrixWorld(true);
    });
    return true;
  }

  private floorUnionBounds(): Vec2[] {
    const pts = this.doc.floors.flatMap((f) => [...(f.outline ?? []), ...(f.rooms ?? []).flatMap((r) => r.footprint)]);
    const [x0, y0, x1, y1] = bounds2(pts.length ? pts : [[0, 0], [10, 10]]);
    return [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
  }

  private buildFloor(def: FloorDef, footprint: Vec2[]): void {
    const floor = new BimEntity(def.id, 'floor', def.name ?? `${def.index + 1}F`, def.category ?? 'floor', def.properties ?? {}, labelOf(def) ?? undefined);
    floor.group.position.z = def.elevation;
    const outline = def.outline ?? footprint;
    floor.properties = { 楼层: floor.name, 标高: `${def.elevation.toFixed(2)} m`, 层高: `${def.height.toFixed(2)} m`, 面积: `${polygonArea(outline).toFixed(1)} m²`, ...floor.properties };
    const [cx, cy] = polygonCentroid(outline);
    floor.labelAnchor.set(cx, cy, def.height);
    this.add(floor);
    this.floors.push(floor);

    // Slab: managed by the floor itself (picking empty floor area selects the floor).
    addMesh(floor, prism(outline, -SLAB_THICKNESS, 0), material('#d9dee6', { roughness: 0.95 }));

    for (const r of def.rooms ?? []) this.buildRoom(floor, r, def.height);
    for (const t of def.things ?? []) this.buildThing(floor, t);
    for (const e of def.elements ?? []) this.buildElement(floor, e, def.height);
    if (def.model) void this.attachModel(floor, def.model, def);
  }

  private buildRoom(floor: BimEntity, def: RoomDef, floorHeight: number): void {
    const area = polygonArea(def.footprint);
    const room = new BimEntity(def.id, 'room', def.name ?? def.id, def.category ?? 'room', { 面积: `${area.toFixed(1)} m²`, ...(def.properties ?? {}) }, labelOf(def) ?? undefined);
    floor.add(room);
    const height = def.height ?? floorHeight - 0.3;
    const color = def.color ?? ROOM_COLORS[room.category] ?? '#e8edf4';
    const geometry = new ShapeGeometry(shapeOf(ccw(def.footprint)));
    geometry.translate(0, 0, 0.02);
    addMesh(room, geometry, material(color, { roughness: 0.9 }));
    if (def.walls !== false) {
      const walls = roomWalls(def, height);
      if (walls) addMesh(room, walls, material('#f3f5f9', { roughness: 0.7 }));
    }
    const [cx, cy] = polygonCentroid(def.footprint);
    room.labelAnchor.set(cx, cy, height + (room.label?.offset ?? 0.6));
  }

  private buildThing(floor: BimEntity, def: ThingDef): void {
    const thing = new BimEntity(def.id, 'thing', def.name ?? def.id, def.category ?? 'thing', def.properties ?? {}, labelOf(def) ?? undefined);
    floor.add(thing);
    const [x, y, z] = def.position;
    thing.group.position.set(x, y, z);
    thing.group.rotation.z = -(def.rotation ?? 0) * DEG2RAD;
    const [w, d, h] = def.size ?? [0.5, 0.5, 0.5];
    if (def.model) {
      void this.attachModel(thing, def.model);
    } else {
      let geometry: BufferGeometry;
      if (def.shape === 'cylinder') geometry = new CylinderGeometry(w / 2, w / 2, h, 20).rotateX(Math.PI / 2);
      else if (def.shape === 'sphere') geometry = new SphereGeometry(Math.max(w, d, h) / 2, 20, 14);
      else geometry = new BoxGeometry(w, d, h);
      geometry.translate(0, 0, h / 2);
      const color = def.color ?? THING_COLORS[thing.category] ?? '#64748b';
      addMesh(thing, geometry, material(color, { roughness: 0.5, metalness: 0.2 }));
    }
    thing.labelAnchor.set(0, 0, h + (thing.label?.offset ?? 0.35));
  }

  private buildElement(floor: BimEntity, def: StructureDef, floorHeight: number): void {
    const el = new BimEntity(def.id, 'element', def.name ?? def.kind, def.category ?? def.kind, { 类型: def.kind, ...(def.properties ?? {}) }, labelOf(def) ?? undefined);
    floor.add(el);
    const color = def.color ?? (def.kind === 'window' ? '#93c5fd' : def.kind === 'door' ? '#a16207' : '#e5e7eb');
    let geometry: BufferGeometry | null = null;
    if ((def.kind === 'wall' || def.kind === 'window') && def.path && def.path.length >= 2) {
      const parts = def.path
        .slice(1)
        .map((b, i) => wallBox(def.path![i], b, 0, def.height ?? floorHeight, def.thickness ?? WALL_THICKNESS))
        .filter((g): g is BufferGeometry => g !== null);
      if (parts.length) geometry = mergeGeometries(parts.map((p) => p.toNonIndexed()));
    } else if (def.kind === 'slab' && def.path && def.path.length >= 3) {
      geometry = prism(def.path, -(def.thickness ?? SLAB_THICKNESS), 0);
    } else if (def.position) {
      const [w, d, h] = def.size ?? [0.4, 0.4, def.height ?? floorHeight];
      geometry = new BoxGeometry(w, d, h).translate(def.position[0], def.position[1], def.position[2] + h / 2);
    }
    if (geometry) {
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      el.labelAnchor.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.max.z + 0.3);
      addMesh(el, geometry, material(color, { opacity: def.kind === 'window' ? 0.45 : 1 }));
    }
  }

  private buildExterior(footprint: Vec2[]): void {
    const ext = this.doc.exterior;
    if (ext?.model) {
      void this.attachModel(this, ext.model, undefined, this.exterior);
      return;
    }
    const color = ext?.color ?? '#8fb3d9';
    // Glass curtain wall with opaque floor bands, and a roof slab.
    const glass = material(color, { opacity: ext?.opacity ?? 0.5, roughness: 0.15, metalness: 0.4, side: DoubleSide });
    const shell = new Mesh(prism(footprint, 0, this.topElevation), glass);
    shell.renderOrder = 2;
    shell.userData.entity = this;
    this.exterior.add(shell);
    this.meshes.push(shell);
    const band = material('#e6ebf2', { roughness: 0.8 });
    const [cx, cy] = polygonCentroid(footprint);
    const grow = (p: Vec2): Vec2 => [cx + (p[0] - cx) * 1.012, cy + (p[1] - cy) * 1.012];
    const bands: BufferGeometry[] = [];
    for (const f of this.doc.floors) bands.push(prism(footprint.map(grow), f.elevation - 0.35, f.elevation + 0.05));
    bands.push(prism(footprint.map(grow), this.topElevation - 0.1, this.topElevation + 0.6));
    const merged = mergeGeometries(bands.map((b) => b.toNonIndexed()));
    for (const b of bands) b.dispose();
    const bandMesh = new Mesh(merged, band);
    bandMesh.userData.entity = this;
    this.exterior.add(bandMesh);
    this.meshes.push(bandMesh);
  }

  /**
   * Loads a glTF and attaches it to an entity. For floor models, nodes named
   * after (or with `extras.id` of) a room / thing / element id are moved under
   * that entity; everything else stays as static floor geometry.
   */
  private async attachModel(entity: BimEntity, ref: ModelRef, floorDef?: FloorDef, parent: Object3D = entity.group): Promise<void> {
    if (!this.loadModel) return;
    try {
      const uri = this.baseUrl ? new URL(ref.uri, this.baseUrl).href : ref.uri;
      const scene = await this.loadModel(uri);
      const holder = new Group();
      holder.name = `model ${ref.uri}`;
      if ((ref.upAxis ?? 'Y') === 'Y') holder.rotation.x = Math.PI / 2; // glTF +Y up -> local +Z up
      holder.scale.setScalar(ref.scale ?? 1);
      const wrapper = new Group();
      wrapper.rotation.z = -(ref.rotation ?? 0) * DEG2RAD;
      if (ref.offset) wrapper.position.set(...ref.offset);
      wrapper.add(holder);
      holder.add(scene);
      parent.add(wrapper);
      wrapper.updateMatrixWorld(true);

      if (floorDef) {
        const byId = new Map<string, BimEntity>();
        for (const c of entity.children) byId.set(c.id, c);
        const moves: [Object3D, BimEntity][] = [];
        scene.traverse((node) => {
          const id = (node.userData?.id as string | undefined) ?? node.name;
          const target = id ? byId.get(id) : undefined;
          if (target && !moves.some(([n]) => isAncestor(n, node))) moves.push([node, target]);
        });
        for (const [node, target] of moves) {
          target.group.attach(node);
          node.traverse((o) => {
            const mesh = o as Mesh;
            if (!mesh.isMesh) return;
            // Per-entity materials so style overrides stay local.
            mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
            mesh.userData.entity = target;
            target.meshes.push(mesh);
          });
        }
      }
      scene.traverse((o) => {
        if ((o as Mesh).isMesh && !o.userData.entity) {
          o.userData.entity = entity;
          if (entity.type === 'thing' || parent === this.exterior) entity.meshes.push(o as Mesh);
        }
      });
    } catch (err) {
      console.warn(`[Building] model ${ref.uri} failed:`, (err as Error).message);
    }
  }

  /** Local (building frame) point to world ECEF. */
  localToWorld(p: Vector3): Vector3 {
    return p.applyMatrix4(this.group.matrixWorld);
  }

  /** Disposes every mesh of the building (the entity groups are nested, one traversal covers all). */
  override dispose(): void {
    super.dispose();
    this.root.removeFromParent();
  }
}

function isAncestor(a: Object3D, b: Object3D): boolean {
  for (let p = b.parent; p; p = p.parent) if (p === a) return true;
  return false;
}
