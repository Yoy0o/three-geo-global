/**
 * Level-of-detail selection rules for the globe quadtree, as pure functions
 * (no three.js) so they can be unit tested.
 *
 * Adapted from CesiumJS (`Scene/QuadtreePrimitive.js`,
 * `Scene/GlobeSurfaceTileProvider.js`, `Scene/Fog.js`, Apache-2.0) and
 * rewritten for this code base:
 * - every tile remembers what the previous traversal did with it
 *   (`TileSelection`), so decisions can depend on what was on screen;
 * - a tile that would replace descendants drawn last frame is only drawn once
 *   it shows at least as much detail as they did ("can render without losing
 *   detail"); until then the descendants stay on screen;
 * - when the camera is low and looks towards the horizon, distant tiles in
 *   the haze refine less (fog-relaxed screen-space error).
 *
 * See docs/agents/tile-loading.md §2.
 */

/** What a traversal did with a tile (CesiumJS `TileSelectionResult`). */
export const TileSelection = {
  /** Not visited, e.g. because an ancestor was drawn instead. */
  NONE: 0,
  /** Outside the view or behind the horizon. */
  CULLED: 1,
  /** Drawn. */
  RENDERED: 2,
  /** Not detailed enough: its children were visited instead. */
  REFINED: 3,
} as const;
export type TileSelection = (typeof TileSelection)[keyof typeof TileSelection];

/** The parts of a quadtree node the selection rules read. */
export interface SelectionNode<T> {
  readonly children: readonly T[] | null;
  selection: TileSelection;
  /** Frame number of the traversal that set `selection`. */
  selectionFrame: number;
}

/** What happened to `node` in the traversal of `frame` (`NONE` if it was not visited then). */
export function selectionIn<T>(node: SelectionNode<T>, frame: number): TileSelection {
  return node.selectionFrame === frame ? node.selection : TileSelection.NONE;
}

/**
 * Whether drawing `tile` now would make detail vanish that was on screen in
 * frame `lastFrame`. Walks the descendants refined in that frame down to the
 * ones drawn in it, and asks `showsMore` whether each showed something (sharper
 * imagery, real terrain) that the tile cannot show yet.
 *
 * Negation of CesiumJS `GlobeSurfaceTileProvider.canRenderWithoutLosingDetail`.
 */
export function wouldLoseDetail<T extends SelectionNode<T>>(tile: T, lastFrame: number, showsMore: (drawn: T) => boolean): boolean {
  const stack: T[] = tile.children ? [...tile.children] : [];
  while (stack.length > 0) {
    const d = stack.pop()!;
    const s = selectionIn(d, lastFrame);
    if (s === TileSelection.RENDERED) {
      if (showsMore(d)) return true;
    } else if (s === TileSelection.REFINED && d.children) {
      for (const c of d.children) stack.push(c);
    }
  }
  return false;
}

/** CesiumJS `Fog` defaults (`Scene/Fog.js`). */
const FOG_DENSITY = 6e-4;
const FOG_HEIGHT_SCALAR = 1e-3;
const FOG_HEIGHT_FALLOFF = 0.59;
/** Fog is off above this camera height (meters). */
export const FOG_MAX_HEIGHT = 800_000;

/**
 * Density of the "horizon fog" used to relax the screen-space error of
 * distant tiles (CesiumJS `Fog.update`): dense when the camera is low and
 * looks towards the horizon, zero above 800 km or when looking straight down
 * or up.
 *
 * @param height Camera height above the ellipsoid in meters.
 * @param viewDotUp Cosine of the angle between the view direction and the local vertical (-1..1).
 * @returns Density per meter (0 = no fog).
 */
export function horizonFogDensity(height: number, viewDotUp: number): number {
  if (!(height <= FOG_MAX_HEIGHT)) return 0;
  const d = FOG_DENSITY * FOG_HEIGHT_SCALAR * Math.pow(Math.max(height / FOG_MAX_HEIGHT, 1e-4), -FOG_HEIGHT_FALLOFF);
  return d * (1 - Math.min(1, Math.abs(viewDotUp)));
}

/** Amount of fog (0..1) at `distance` meters for a density per meter (CesiumJS `Math.fog`). */
export function fogAmount(distance: number, density: number): number {
  const s = distance * density;
  return 1 - Math.exp(-s * s);
}

/**
 * Screen-space error of a tile with the horizon fog taken into account: a
 * tile in full fog needs `1 + factor` times the threshold to refine.
 *
 * @param sse Error in CSS pixels before fog.
 * @param threshold The refinement threshold in CSS pixels (`maxScreenSpaceError`).
 * @param factor Extra threshold multiple in full fog (0 disables the fog).
 */
export function fogRelaxedError(sse: number, distance: number, density: number, threshold: number, factor: number): number {
  if (density <= 0 || factor <= 0) return sse;
  return sse - fogAmount(distance, density) * factor * threshold;
}

/**
 * UV transform (offsetU, offsetV, scaleU, scaleV) that shows on a child tile
 * the part of its parent's picture that covers it.
 *
 * @param parent The transform the parent uses for that picture.
 * @param qx Child column inside the parent (0 = west, 1 = east).
 * @param qy Child row inside the parent (0 = north, 1 = south).
 */
export function childUvTransform(parent: readonly [number, number, number, number], qx: number, qy: number): [number, number, number, number] {
  const [ou, ov, su, sv] = parent;
  return [ou + qx * su * 0.5, ov + qy * sv * 0.5, su * 0.5, sv * 0.5];
}

/** How long a sharper ancestor picture waits for something sharper still before it is shown (ms). */
export const IMAGERY_COALESCE_MS = 400;
/** How long a tile's own imagery waits for its siblings' before it is shown anyway (ms). */
export const IMAGERY_GROUP_WAIT_MS = 1500;

/**
 * Whether a tile on screen should switch to the better imagery that has
 * become available. Rules for a calm reveal (cf. CesiumJS, which replaces a
 * parent only once all four children can be drawn):
 * - anything replaces the placeholder at once;
 * - a sharper ancestor picture (an anchor or a preloaded ancestor) waits a
 *   moment, so ancestors arriving one after another cause one change, not one
 *   per level;
 * - the tile's own imagery is shown together with its siblings' (one larger
 *   square changes instead of a checkerboard), or after a timeout.
 *
 * @param waitedMs Time since the better imagery became available.
 * @param own The better imagery is the tile's own (final) imagery.
 * @param fromPlaceholder The tile shows the placeholder color.
 * @param siblingsReady Every sibling drawn this frame has its own imagery (or none to wait for).
 */
export function imagerySwitchDue(waitedMs: number, own: boolean, fromPlaceholder: boolean, siblingsReady: boolean): boolean {
  if (fromPlaceholder) return true;
  if (own) return siblingsReady || waitedMs >= IMAGERY_GROUP_WAIT_MS;
  return waitedMs >= IMAGERY_COALESCE_MS;
}
