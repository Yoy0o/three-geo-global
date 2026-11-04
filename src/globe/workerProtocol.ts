import type { TerrainSource } from './terrain/TerrainSource';

export interface BuildTileRequest {
  type: 'build';
  id: number;
  level: number;
  x: number;
  y: number;
  /** Grid cells per tile edge. */
  segments: number;
  terrain: TerrainSource | null;
  exaggeration: number;
  /** Clamp bathymetry to sea level so oceans stay flat under imagery. */
  clampToSeaLevel: boolean;
}

export interface CancelRequest {
  type: 'cancel';
  id: number;
}

export type WorkerRequest = BuildTileRequest | CancelRequest;

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
}

export interface BuildError {
  type: 'error';
  id: number;
  message: string;
  aborted: boolean;
}

export type WorkerResponse = BuiltTile | BuildError;
