/**
 * A source of transparent images draped over the globe on top of the base
 * imagery, one per Web Mercator tile (e.g. rasterized vector layers).
 *
 * Content changes are announced by bumping `version`; `isCurrent` lets tiles
 * outside the changed region skip the refresh.
 */
export interface TileOverlaySource {
  readonly version: number;
  /** Cheap test whether anything may be drawn in this tile. */
  hasContent(level: number, x: number, y: number): boolean;
  /** Whether an overlay produced at `tileVersion` is still valid for this tile. */
  isCurrent(level: number, x: number, y: number, tileVersion: number): boolean;
  /** Resolves to null when the tile has nothing to show. */
  requestOverlay(level: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap | null>;
}
