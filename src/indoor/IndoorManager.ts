import { Group, Sphere, Vector3, type Object3D, type PerspectiveCamera, type Raycaster } from 'three';
import type { Ellipsoid } from '../core/Ellipsoid';
import { EventEmitter } from '../core/EventEmitter';
import { DEG2RAD } from '../core/math';
import { createCard, type CardOptions } from '../markers/cards';
import type { Marker, MarkerManager } from '../markers/MarkerManager';
import { BimEntity, matchesSelector, type EntitySelector } from './BimEntity';
import { Building, type ModelLoader } from './Building';
import { parseBuildingDoc, type BuildingDoc, type LabelDef, type LabelMode } from './schema';

export interface LevelEvent {
  /** The level entered or left (null = the globe). */
  object: BimEntity | null;
  /** Level before the change. */
  previous: BimEntity | null;
  /** Level after the change. */
  next: BimEntity | null;
}

export interface IndoorEvents extends Record<string, unknown> {
  'buildings-changed': Building[];
  beforeEnterLevel: LevelEvent;
  enterLevel: LevelEvent;
  leaveLevel: LevelEvent;
  select: { entity: BimEntity | null };
  hover: { entity: BimEntity | null };
}

/** What the indoor layer needs from the viewer. */
export interface IndoorHost {
  readonly ellipsoid: Ellipsoid;
  readonly camera: PerspectiveCamera;
  readonly markers: MarkerManager;
  /** Terrain height (ellipsoidal meters) or null while unknown. */
  groundHeight(longitude: number, latitude: number): number | null;
  /** Flies to look at a sphere; `rangeScale` multiplies the fitting distance. */
  flyToSphere(sphere: Sphere, headingDeg: number, pitchDeg: number, rangeScale: number, duration?: number): Promise<void>;
  /** Current camera heading in degrees. */
  cameraHeading(): number;
  /** Photogrammetry and other 3D Tiles are hidden while inside a building so they cannot occlude it. */
  setTilesetsVisible(visible: boolean): void;
  loadModel: ModelLoader | null;
  /** Builds label DOM (default: `createCard`); injectable for custom cards and for tests. */
  createLabelElement?: (options: CardOptions, entity: BimEntity) => HTMLElement;
  /** Shifts the camera / its flight destination when the building being viewed moved (terrain clamping). */
  followMove?: (delta: Vector3) => void;
}

export interface EnterOptions {
  /** Animate the camera to the level (default true). */
  fly?: boolean;
  duration?: number;
}

interface LevelView {
  pitch: number;
  rangeScale: number;
  minRange: number;
}

/** Camera framing per level type (ThingJS default level flights). */
const VIEWS: Record<string, LevelView> = {
  building: { pitch: -32, rangeScale: 1.25, minRange: 60 },
  floor: { pitch: -58, rangeScale: 0.95, minRange: 30 },
  room: { pitch: -55, rangeScale: 1.4, minRange: 14 },
  thing: { pitch: -32, rangeScale: 3.2, minRange: 6 },
  element: { pitch: -40, rangeScale: 2.2, minRange: 6 },
};

const FLOOR_EXPAND_GAP = 7;
const HIGHLIGHT = '#1d4ed8';
const HOVER = '#0f2f66';

const _sphere = new Sphere();
const _p = new Vector3();

/**
 * Buildings and indoor navigation on the globe ("level" model of ThingJS):
 * globe → building → floor → room / thing. Double click enters a level,
 * right click or Esc goes back, the camera flies to every level and only
 * relevant content stays visible (exterior shell outside, one floor inside).
 * Emits `beforeEnterLevel` / `enterLevel` / `leaveLevel`.
 */
export class IndoorManager {
  readonly root = new Group();
  readonly buildings: Building[] = [];
  readonly events = new EventEmitter<IndoorEvents>();
  /** Current level (null = globe). */
  current: BimEntity | null = null;
  hovered: BimEntity | null = null;
  selected: BimEntity | null = null;
  /** Hide 3D Tiles while inside a building. */
  hideTilesetsIndoor = true;
  private _showLabels = true;
  private _expandFloors = false;
  private readonly labels = new Map<BimEntity, Marker>();
  private frame = 0;

  constructor(private readonly host: IndoorHost) {
    this.root.name = 'Indoor';
  }

  get showLabels(): boolean {
    return this._showLabels;
  }

  set showLabels(v: boolean) {
    this._showLabels = v;
  }

  /** Spread the floors of the entered building apart (楼层展开). */
  get expandFloors(): boolean {
    return this._expandFloors;
  }

  set expandFloors(v: boolean) {
    this._expandFloors = v;
    this.applyLevelState();
  }

  /** Re-applies visibility for the current level (after changing options such as `hideTilesetsIndoor`). */
  refresh(): void {
    this.applyLevelState();
  }

  // ---------------------------------------------------------------------------
  // Buildings

  /** Adds a building from a document (object or JSON text); `baseUrl` resolves model URIs. */
  add(input: BuildingDoc | unknown, baseUrl?: string): Building {
    const doc = parseBuildingDoc(input);
    if (this.buildings.some((b) => b.id === doc.id)) throw new Error(`建筑 ${doc.id} 已加载`);
    const building = new Building(doc, this.host.ellipsoid, this.host.loadModel, baseUrl);
    this.buildings.push(building);
    this.root.add(building.root);
    this.clampToGround(building, true);
    building.traverse((e) => this.createLabel(e));
    this.applyLevelState();
    this.events.emit('buildings-changed', this.buildings);
    return building;
  }

  remove(building: Building): void {
    const i = this.buildings.indexOf(building);
    if (i < 0) return;
    if (this.current && (this.current === building || this.current.isDescendantOf(building))) void this.enter(null, { fly: false });
    if (this.selected?.closest('building') === building) this.select(null);
    building.traverse((e) => {
      this.labels.get(e)?.remove();
      this.labels.delete(e);
    });
    this.buildings.splice(i, 1);
    building.dispose();
    this.applyLevelState();
    this.events.emit('buildings-changed', this.buildings);
  }

  /** All entities matching a selector (ThingJS `app.query`), e.g. '.Room', '#F3-301', '[category=camera]'. */
  query(selector: EntitySelector): BimEntity[] {
    const out: BimEntity[] = [];
    for (const b of this.buildings) b.traverse((e) => matchesSelector(e, selector) && out.push(e));
    return out;
  }

  getById(id: string): BimEntity | null {
    return this.query(`#${id}`)[0] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Levels

  /**
   * Switches the level (null = back to the globe). Rooms, things and elements
   * are shown inside their floor and get selected.
   */
  async enter(target: BimEntity | null, options: EnterOptions = {}): Promise<void> {
    const previous = this.current;
    this.events.emit('beforeEnterLevel', { object: target, previous, next: target });
    for (let e = previous; e && !(target && (e === target || target.isDescendantOf(e))); e = e.parent) {
      this.events.emit('leaveLevel', { object: e, previous, next: target });
    }
    this.current = target;
    if (target && (target.type === 'room' || target.type === 'thing' || target.type === 'element')) this.select(target);
    else if (this.selected && (!target || !this.selected.isDescendantOf(target))) this.select(null);
    this.applyLevelState();
    this.events.emit('enterLevel', { object: target, previous, next: target });
    if (options.fly !== false) await this.flyToLevel(target, previous, options.duration);
  }

  /**
   * The level a double click on `hit` should enter: the building from
   * outside, then its floor, then the room / thing itself. Null when `hit` is
   * already the current level.
   */
  nextLevel(hit: BimEntity): BimEntity | null {
    const building = hit.closest('building');
    if (!building) return null;
    const current = this.current;
    if (current?.closest('building') !== building) return building;
    const floor = hit.closest('floor');
    const currentFloor = current?.closest('floor') ?? null;
    if (!currentFloor || floor !== currentFloor) return floor ?? building;
    // Same floor: dive into the room / thing (the floor slab itself steps back to the floor view).
    return hit === current ? null : hit;
  }

  /** Goes up one level (room → floor → building → globe). */
  back(): Promise<void> {
    const c = this.current;
    if (!c) return Promise.resolve();
    let parent = c.parent;
    // Structural elements and things are viewed inside their floor; the floor is the next level up.
    if ((c.type === 'thing' || c.type === 'element' || c.type === 'room') && parent?.type !== 'floor') parent = c.closest('floor');
    return this.enter(parent);
  }

  private async flyToLevel(target: BimEntity | null, previous: BimEntity | null, duration?: number): Promise<void> {
    const subject = target ?? previous?.closest('building') ?? null;
    if (!subject || !subject.worldBounds(_sphere)) return;
    this.flyingTo = (subject.closest('building') as Building | null) ?? null;
    try {
      await this.flyToSubject(target, previous, duration);
    } finally {
      this.flyingTo = null;
    }
  }

  /** Building the camera is flying to (its re-grounding shifts the flight). */
  private flyingTo: Building | null = null;

  private async flyToSubject(target: BimEntity | null, previous: BimEntity | null, duration?: number): Promise<void> {
    if (!target) {
      // Back to the globe: step out to a wide view of the building.
      await this.host.flyToSphere(_sphere, this.host.cameraHeading(), -35, 3, duration);
      return;
    }
    const view = VIEWS[target.type] ?? VIEWS.thing;
    const building = target.closest('building') as Building | null;
    // Entering a building from far away: a classic three-quarter view; inside, keep the heading.
    const heading = target.type === 'building' && !previous ? ((building?.heading ?? 0) / DEG2RAD) - 30 : this.host.cameraHeading();
    const radius = Math.max(_sphere.radius, view.minRange / 2);
    _sphere.radius = radius;
    await this.host.flyToSphere(_sphere, heading, view.pitch, view.rangeScale, duration);
  }

  /** Visibility per level: exterior outside, all floors in a building, one floor below that. */
  private applyLevelState(): void {
    const building = (this.current?.closest('building') as Building | null) ?? null;
    const floor = this.current?.closest('floor') ?? null;
    for (const b of this.buildings) {
      const inside = b === building;
      b.exterior.visible = !inside;
      for (const f of b.floors) f.visible = inside && (!floor || f === floor);
      b.setExpanded(inside && !floor && this._expandFloors ? FLOOR_EXPAND_GAP : 0);
    }
    this.host.setTilesetsVisible(!(building && this.hideTilesetsIndoor));
  }

  // ---------------------------------------------------------------------------
  // Selection / hover

  select(entity: BimEntity | null): void {
    if (entity === this.selected) return;
    const prev = this.selected;
    this.selected = entity;
    if (prev) this.restyle(prev);
    if (entity) this.restyle(entity);
    this.events.emit('select', { entity });
  }

  setHovered(entity: BimEntity | null): void {
    if (entity === this.hovered) return;
    const prev = this.hovered;
    this.hovered = entity;
    if (prev) this.restyle(prev);
    if (entity) this.restyle(entity);
    this.events.emit('hover', { entity });
  }

  private restyle(e: BimEntity): void {
    const color = e === this.selected ? HIGHLIGHT : e === this.hovered && e.type !== 'building' ? HOVER : null;
    e.setStyle({ emissive: color });
  }

  /** Closest visible entity hit by a ray. */
  pick(raycaster: Raycaster): { entity: BimEntity; point: Vector3; distance: number } | null {
    if (this.buildings.length === 0) return null;
    const hits = raycaster.intersectObject(this.root, true);
    for (const h of hits) {
      if (!isVisible(h.object)) continue;
      const entity = entityOf(h.object);
      if (entity) return { entity, point: h.point, distance: h.distance };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Labels (顶牌)

  private createLabel(e: BimEntity): void {
    const def = e.label ?? defaultLabel(e);
    if (!def) return;
    const mode: LabelMode = def.mode ?? (e.type === 'building' ? 'always' : 'level');
    const subtitle = def.subtitle ?? (e.type === 'room' ? String(e.properties['面积'] ?? '') : undefined);
    const card: CardOptions = {
      title: def.title ?? e.name,
      subtitle,
      style: def.style ?? (e.type === 'building' ? 'card' : e.type === 'thing' ? 'pin' : 'tag'),
      color: def.color,
      icon: def.icon,
    };
    const element = (this.host.createLabelElement ?? createCard)(card, e);
    // Alarm cards (style 'card' inside a floor) and the selection always win the collision test.
    const base = e.type === 'building' ? 10 : def.style === 'card' ? 8 : e.type === 'room' ? 4 : 2;
    const marker = this.host.markers.add({
      element,
      position: () => e.labelPosition(_p),
      visible: () => this.isLabelVisible(e, mode),
      maxDistance: e.type === 'building' ? 25_000 : e.type === 'thing' ? 120 : 400,
      zIndex: e.type === 'building' ? 1 : e.type === 'thing' ? 3 : 2,
      // Cards (buildings, alarms) are never hidden by decluttering; tags and pins make way for them.
      declutter: e.type !== 'building' && def.style !== 'card',
      priority: () => base + (this.selected === e ? 20 : 0) + (this.hovered === e ? 10 : 0),
      // Labels sit above the canvas, so they take over its click / double-click behavior.
      onClick: () => this.select(e),
      onDoubleClick: () => {
        const next = this.nextLevel(e);
        if (next) void this.enter(next);
      },
      userData: { entity: e },
    });
    this.labels.set(e, marker);
  }

  private isLabelVisible(e: BimEntity, mode: LabelMode): boolean {
    if (!this._showLabels) return false;
    if (e.type === 'building') {
      const inside = this.current?.closest('building') === e;
      return !inside && (mode === 'always' || (mode === 'hover' && this.hovered === e));
    }
    if (!e.effectivelyVisible) return false;
    switch (mode) {
      case 'always':
        return true;
      case 'hover':
        return this.hovered === e;
      case 'click':
        return this.selected === e;
      case 'level': {
        const parent = e.parent;
        const c = this.current;
        return !!parent && !!c && (c === parent || c.isDescendantOf(parent));
      }
    }
  }

  // ---------------------------------------------------------------------------

  /** Advances animations and terrain clamping; returns true when something moved. */
  update(dt: number): boolean {
    this.frame++;
    let changed = false;
    for (const b of this.buildings) {
      if (b.update(dt)) changed = true;
      // Poll often until the terrain under the anchor is detailed enough, then rarely.
      if (this.frame % (this.grounded.has(b) ? 30 : 5) === 0) this.clampToGround(b, false);
    }
    return changed;
  }

  private readonly grounded = new WeakSet<Building>();

  /** Buildings without an explicit height sit on the terrain; refined as finer terrain arrives. */
  private clampToGround(b: Building, force: boolean): void {
    if (b.doc.anchor.height !== undefined) return;
    const a = b.doc.anchor;
    const h = this.host.groundHeight(a.longitude * DEG2RAD, a.latitude * DEG2RAD);
    if (h === null) return;
    this.grounded.add(b);
    if (!force && Math.abs(h - b.groundHeight) <= 0.25) return;
    const before = b.group.getWorldPosition(new Vector3());
    b.place(h);
    const after = b.group.getWorldPosition(new Vector3());
    // Keep looking at the building when it settles while we fly to it or are inside it.
    if (this.host.followMove && (this.flyingTo === b || this.current?.closest('building') === b)) this.host.followMove(after.sub(before));
  }

  dispose(): void {
    for (const b of [...this.buildings]) this.remove(b);
    this.root.removeFromParent();
  }
}

function defaultLabel(e: BimEntity): LabelDef | null {
  // Buildings and rooms always get a card; equipment only when the document asks for one.
  return e.type === 'building' || e.type === 'room' ? {} : null;
}

function isVisible(o: Object3D): boolean {
  for (let x: Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

function entityOf(o: Object3D): BimEntity | null {
  for (let x: Object3D | null = o; x; x = x.parent) {
    const e = x.userData.entity as BimEntity | undefined;
    if (e instanceof BimEntity) return e;
  }
  return null;
}
