import type { TerrainSource } from './terrain/TerrainSource';

/** An ancestor's height grid to build an interim mesh from (no network). */
export interface UpsampleSource {
  /** (segments + 1)^2 ellipsoidal heights, already exaggerated (as returned in `BuiltTile.heights`). */
  heights: Float32Array;
  segments: number;
  level: number;
  x: number;
  y: number;
}

export interface BuildTileRequest {
  type: 'build';
  id: number;
  level: number;
  x: number;
  y: number;
  /** Grid cells per tile edge. */
  segments: number;
  /** Id of a terrain source previously registered with a `source` message. */
  terrainId: string | null;
  exaggeration: number;
  /** Clamp bathymetry to sea level so oceans stay flat under imagery. */
  clampToSeaLevel: boolean;
  /**
   * When set, build immediately from this ancestor grid and only prefetch the
   * tile's own terrain; the result is flagged `upsampled` so the caller
   * requests the exact mesh later.
   */
  upsample?: UpsampleSource | null;
  /**
   * With `upsample`: start downloading the exact terrain right away (default
   * true). Off for meshes built ahead of need (tiles just outside the view).
   */
  prefetch?: boolean;
}

export interface CancelRequest {
  type: 'cancel';
  id: number;
}

export interface SourceRequest {
  type: 'source';
  source: TerrainSource;
}

export type WorkerRequest = BuildTileRequest | CancelRequest | SourceRequest;

export interface BuiltTile {
  type: 'built';
  id: number;
  /** RTC origin (ECEF, float64). */
  center: [number, number, number];
  /** Vertex positions relative to `center`. */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** Number of grid vertices (skirt vertices follow them). */
  gridVertexCount: number;
  minHeight: number;
  maxHeight: number;
  boundingRadius: number;
  /** Occludee point in ellipsoid-scaled space, or null if the tile cannot be horizon-culled. */
  horizonPoint: [number, number, number] | null;
  /** Height grid ((segments+1)^2, row-major north to south) for CPU sampling. */
  heights: Float32Array | null;
  /** Built from an ancestor's heights while the tile's own terrain downloads. */
  upsampled: boolean;
}

export interface BuildError {
  type: 'error';
  id: number;
  message: string;
  aborted: boolean;
}

export type WorkerResponse = BuiltTile | BuildError;
