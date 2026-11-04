import { Box3, Color, Group, Mesh, Sphere, Vector3, type Material, type Object3D } from 'three';
import type { LabelDef } from './schema';

export type EntityType = 'building' | 'floor' | 'room' | 'thing' | 'element';

/** Visual overrides (ThingJS `object.style`). */
export interface EntityStyle {
  /** Tint color (CSS), null to restore. */
  color?: string | null;
  /** 0..1, null to restore. */
  opacity?: number | null;
  /** Glow used for selection / hover highlight. */
  emissive?: string | null;
}

interface MaterialState {
  color: Color | null;
  emissive: Color | null;
  opacity: number;
  transparent: boolean;
}

type StylableMaterial = Material & { color?: Color; emissive?: Color; opacity: number; transparent: boolean };

const _box = new Box3();

/**
 * A managed element of a building: building, floor, room, thing (equipment)
 * or structural element. Owns a three.js group in building-local space; the
 * building's root carries the geographic placement (ENU frame at the anchor).
 */
export class BimEntity {
  readonly children: BimEntity[] = [];
  parent: BimEntity | null = null;
  /** Local-space content (child of the parent's group). */
  readonly group = new Group();
  /** Meshes that get style overrides (built per entity so overrides stay local). */
  readonly meshes: Mesh[] = [];
  /** Label anchor in this entity's local space (top of the content by default). */
  readonly labelAnchor = new Vector3();
  label: LabelDef | null;
  private styled = new Map<Material, MaterialState>();
  private _style: EntityStyle = {};

  constructor(
    readonly id: string,
    readonly type: EntityType,
    public name: string,
    public category: string,
    public properties: Record<string, unknown>,
    label?: LabelDef,
  ) {
    this.label = label ?? null;
    this.group.name = `${type}:${id}`;
    this.group.userData.entity = this;
  }

  add(child: BimEntity): void {
    child.parent = this;
    this.children.push(child);
    this.group.add(child.group);
  }

  get visible(): boolean {
    return this.group.visible;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }

  /** Visible including all ancestors (three.js raycasting ignores `visible`). */
  get effectivelyVisible(): boolean {
    let o: Object3D | null = this.group;
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return true;
  }

  /** Root-to-this chain, excluding this entity. */
  ancestors(): BimEntity[] {
    const out: BimEntity[] = [];
    for (let p = this.parent; p; p = p.parent) out.unshift(p);
    return out;
  }

  isDescendantOf(other: BimEntity): boolean {
    for (let p = this.parent; p; p = p.parent) if (p === other) return true;
    return false;
  }

  /** Depth-first walk over this entity and its descendants. */
  traverse(cb: (e: BimEntity) => void): void {
    cb(this);
    for (const c of this.children) c.traverse(cb);
  }

  /** Closest ancestor-or-self of a type. */
  closest(type: EntityType): BimEntity | null {
    for (let e: BimEntity | null = this; e; e = e.parent) if (e.type === type) return e;
    return null;
  }

  get style(): Readonly<EntityStyle> {
    return this._style;
  }

  /** Applies visual overrides to this entity's own meshes (ThingJS `obj.style.color = ...`). */
  setStyle(style: EntityStyle): void {
    this._style = { ...this._style, ...style };
    for (const mesh of this.meshes) {
      const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as StylableMaterial[];
      for (const m of materials) this.applyStyle(m);
    }
  }

  private applyStyle(m: StylableMaterial): void {
    let s = this.styled.get(m);
    if (!s) {
      s = { color: m.color?.clone() ?? null, emissive: m.emissive?.clone() ?? null, opacity: m.opacity, transparent: m.transparent };
      this.styled.set(m, s);
    }
    const st = this._style;
    if (m.color) {
      if (st.color) m.color.set(st.color);
      else if (s.color) m.color.copy(s.color);
    }
    if (m.emissive) {
      if (st.emissive) m.emissive.set(st.emissive);
      else if (s.emissive) m.emissive.copy(s.emissive);
    }
    const opacity = st.opacity ?? s.opacity;
    const transparent = st.opacity !== undefined && st.opacity !== null ? st.opacity < 1 : s.transparent;
    m.opacity = opacity;
    if (m.transparent !== transparent) {
      m.transparent = transparent;
      m.needsUpdate = true;
    }
  }

  /** World (ECEF) bounding sphere of the visible content, or null when empty. */
  worldBounds(out = new Sphere()): Sphere | null {
    this.group.updateWorldMatrix(true, true);
    _box.makeEmpty().expandByObject(this.group, true);
    if (_box.isEmpty()) return null;
    return _box.getBoundingSphere(out);
  }

  /** World (ECEF) position of the label anchor. */
  labelPosition(out = new Vector3()): Vector3 {
    this.group.updateWorldMatrix(true, false);
    return out.copy(this.labelAnchor).applyMatrix4(this.group.matrixWorld);
  }

  dispose(): void {
    this.group.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of materials) m.dispose();
    });
    this.styled.clear();
  }
}

/**
 * Entity selector (ThingJS `app.query` style):
 * - `.Building` `.Floor` `.Room` `.Thing` `.Element`: by type (case-insensitive)
 * - `#id`: by id
 * - `[category=camera]`, `[prop.status=alarm]`: by category or property value
 * - any other string: exact name
 * - comma separated alternatives: `.Room, .Thing`
 * - a RegExp tested against the name, or a predicate.
 */
export type EntitySelector = string | RegExp | ((e: BimEntity) => boolean);

export function matchesSelector(e: BimEntity, selector: EntitySelector): boolean {
  if (typeof selector === 'function') return selector(e);
  if (selector instanceof RegExp) return selector.test(e.name);
  return selector.split(',').some((part) => matchOne(e, part.trim()));
}

function matchOne(e: BimEntity, s: string): boolean {
  if (!s) return false;
  if (s.startsWith('.')) return e.type === s.slice(1).toLowerCase();
  if (s.startsWith('#')) return e.id === s.slice(1);
  const attr = /^\[([\w.]+)\s*=\s*"?([^"\]]*)"?\]$/.exec(s);
  if (attr) {
    const [, key, value] = attr;
    if (key === 'category') return e.category === value;
    if (key === 'type') return e.type === value;
    if (key.startsWith('prop.')) return String(e.properties[key.slice(5)] ?? '') === value;
    return String(e.properties[key] ?? '') === value;
  }
  return e.name === s;
}

/** Closest ancestor-or-self matching a selector (event bubbling). */
export function closestMatching(e: BimEntity | null, selector: EntitySelector): BimEntity | null {
  for (let x = e; x; x = x.parent) if (matchesSelector(x, selector)) return x;
  return null;
}
