import type { Vector3 } from 'three';
import type { Cartographic } from '../core/Ellipsoid';
import { closestMatching, type BimEntity, type EntitySelector } from '../indoor/BimEntity';
import type { Tiles3DLayer } from '../tiles3d/Tiles3DLayer';

/** What lies under a screen point (closest along the view ray). */
export interface PickInfo {
  kind: 'entity' | 'tiles' | 'globe' | 'none';
  /** Building / floor / room / thing hit, when `kind` is 'entity'. */
  entity: BimEntity | null;
  tileset: Tiles3DLayer | null;
  /** World (ECEF) position. */
  point: Vector3 | null;
  /** Radians / meters. */
  cartographic: Cartographic | null;
  clientX: number;
  clientY: number;
}

export type InteractionType = 'click' | 'dblclick' | 'rightclick' | 'mousemove' | 'mouseenter' | 'mouseleave';

export interface InteractionEvent extends PickInfo {
  type: InteractionType;
  /** The entity the listener's selector matched (the hit entity or an ancestor); the hit entity without a selector. */
  object: BimEntity | null;
  button: number;
  originalEvent: MouseEvent | null;
  /** Suppresses the default behavior (e.g. the camera's double-click flight). */
  preventDefault(): void;
  readonly defaultPrevented: boolean;
}

export interface ListenerOptions {
  /** Only fire for entities matching this selector (bubbling to ancestors), e.g. '.Building'. */
  selector?: EntitySelector;
  /** Group listeners for removal with `off(type, tag)` (ThingJS event tags). */
  tag?: string;
}

type Handler = (e: InteractionEvent) => void;

interface Listener {
  type: InteractionType;
  handler: Handler;
  selector?: EntitySelector;
  tag?: string;
  /** Hover state for mouseenter / mouseleave. */
  current: BimEntity | null;
}

export interface InteractionHost {
  readonly domElement: HTMLElement;
  pickAt(clientX: number, clientY: number): PickInfo;
}

const CLICK_SLOP_PX = 5;
const CLICK_MAX_MS = 500;

/**
 * Pointer events resolved to scene objects (ThingJS-style `app.on`):
 * click / dblclick / rightclick (no drag), mousemove, mouseenter / mouseleave
 * on entities, with selector bubbling and tags. Hover picking is throttled to
 * one ray cast per frame and only runs while hover listeners exist.
 */
export class InteractionManager {
  enabled = true;
  private listeners: Listener[] = [];
  private down: { x: number; y: number; t: number; button: number } | null = null;
  private pendingMove: { x: number; y: number } | null = null;
  private hovered: PickInfo | null = null;
  private pointerInside = false;

  constructor(private readonly host: InteractionHost) {
    const el = host.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerleave', this.onPointerLeave);
  }

  /** Last hover pick (null when the pointer is outside or nothing is hovered). */
  get hover(): PickInfo | null {
    return this.hovered;
  }

  on(type: InteractionType, handler: Handler, options: ListenerOptions = {}): () => void {
    const listener: Listener = { type, handler, selector: options.selector, tag: options.tag, current: null };
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Removes listeners of a type; restrict to a tag or a handler. */
  off(type: InteractionType, tagOrHandler?: string | Handler): void {
    this.listeners = this.listeners.filter((l) => {
      if (l.type !== type) return true;
      if (tagOrHandler === undefined) return false;
      return typeof tagOrHandler === 'string' ? l.tag !== tagOrHandler : l.handler !== tagOrHandler;
    });
  }

  private hasHoverListeners(): boolean {
    return this.listeners.some((l) => l.type === 'mousemove' || l.type === 'mouseenter' || l.type === 'mouseleave');
  }

  /** Dispatches a native double click; returns true when a listener prevented the default. */
  dispatchDoubleClick(e: MouseEvent): boolean {
    if (!this.enabled || !this.listeners.some((l) => l.type === 'dblclick')) return false;
    return this.dispatch('dblclick', this.host.pickAt(e.clientX, e.clientY), e.button, e);
  }

  /** Runs throttled hover picking; call once per frame. */
  update(): void {
    if (!this.enabled || !this.pendingMove) return;
    const { x, y } = this.pendingMove;
    this.pendingMove = null;
    if (!this.hasHoverListeners()) {
      this.hovered = null;
      return;
    }
    const pick = this.host.pickAt(x, y);
    this.hovered = pick;
    this.updateHover(pick, null);
  }

  private updateHover(pick: PickInfo | null, original: MouseEvent | null): void {
    // All leaves before all enters, so moving from A to B reads "leave A, enter B".
    const changes: { l: Listener; prev: BimEntity | null; next: BimEntity | null }[] = [];
    for (const l of this.listeners) {
      if (l.type !== 'mouseenter' && l.type !== 'mouseleave') continue;
      const next = pick?.entity ? (l.selector ? closestMatching(pick.entity, l.selector) : pick.entity) : null;
      if (next === l.current) continue;
      changes.push({ l, prev: l.current, next });
      l.current = next;
    }
    for (const { l, prev } of changes) {
      if (l.type === 'mouseleave' && prev) l.handler(this.makeEvent('mouseleave', pick ?? emptyPick(), prev, 0, original));
    }
    for (const { l, next } of changes) {
      if (l.type === 'mouseenter' && next) l.handler(this.makeEvent('mouseenter', pick!, next, 0, original));
    }
    if (pick) {
      for (const l of [...this.listeners]) {
        if (l.type !== 'mousemove') continue;
        const object = pick.entity && l.selector ? closestMatching(pick.entity, l.selector) : pick.entity;
        if (l.selector && !object) continue;
        l.handler(this.makeEvent('mousemove', pick, object, 0, original));
      }
    }
  }

  private dispatch(type: InteractionType, pick: PickInfo, button: number, original: MouseEvent | null): boolean {
    let prevented = false;
    for (const l of [...this.listeners]) {
      if (l.type !== type) continue;
      let object = pick.entity;
      if (l.selector) {
        object = pick.entity ? closestMatching(pick.entity, l.selector) : null;
        if (!object) continue;
      }
      const event = this.makeEvent(type, pick, object, button, original);
      l.handler(event);
      prevented ||= event.defaultPrevented;
    }
    return prevented;
  }

  private makeEvent(type: InteractionType, pick: PickInfo, object: BimEntity | null, button: number, original: MouseEvent | null): InteractionEvent {
    let prevented = false;
    return {
      ...pick,
      type,
      object,
      button,
      originalEvent: original,
      preventDefault: () => {
        prevented = true;
      },
      get defaultPrevented() {
        return prevented;
      },
    };
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    this.down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button } : null;
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!this.enabled || !d || d.button !== e.button) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX || performance.now() - d.t > CLICK_MAX_MS) return;
    const type: InteractionType | null = e.button === 0 ? 'click' : e.button === 2 ? 'rightclick' : null;
    if (!type || !this.listeners.some((l) => l.type === type)) return;
    this.dispatch(type, this.host.pickAt(e.clientX, e.clientY), e.button, e);
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    this.pointerInside = true;
    // No hover updates while dragging the camera.
    if (e.buttons !== 0) return;
    this.pendingMove = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerLeave = () => {
    if (!this.pointerInside) return;
    this.pointerInside = false;
    this.pendingMove = null;
    this.hovered = null;
    this.updateHover(null, null);
  };

  dispose(): void {
    const el = this.host.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerleave', this.onPointerLeave);
    this.listeners = [];
  }
}

function emptyPick(): PickInfo {
  return { kind: 'none', entity: null, tileset: null, point: null, cartographic: null, clientX: 0, clientY: 0 };
}
