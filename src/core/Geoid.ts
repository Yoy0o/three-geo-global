import { EGM96_COLS, EGM96_GRID_BASE64, EGM96_ROWS } from './egm96Grid';

let grid: Int16Array | null = null;

function decode(): Int16Array {
  const bin = atob(EGM96_GRID_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

const RAD2DEG = 180 / Math.PI;

/**
 * EGM96 geoid undulation N in meters (mean sea level above the WGS84
 * ellipsoid), bilinearly interpolated from a 1-degree grid.
 * Ellipsoidal height = orthometric (MSL) height + N.
 */
export function geoidUndulation(longitude: number, latitude: number): number {
  grid ??= decode();
  const lat = latitude * RAD2DEG;
  const lon = longitude * RAD2DEG;
  const fr = Math.min(EGM96_ROWS - 1, Math.max(0, 90 - lat));
  const r0 = Math.min(EGM96_ROWS - 2, Math.floor(fr));
  const tr = fr - r0;
  let fc = (lon + 180) % 360;
  if (fc < 0) fc += 360;
  const c0 = Math.floor(fc) % EGM96_COLS;
  const c1 = (c0 + 1) % EGM96_COLS;
  const tc = fc - Math.floor(fc);
  const g = grid;
  const a = g[r0 * EGM96_COLS + c0] * (1 - tc) + g[r0 * EGM96_COLS + c1] * tc;
  const b = g[(r0 + 1) * EGM96_COLS + c0] * (1 - tc) + g[(r0 + 1) * EGM96_COLS + c1] * tc;
  return (a * (1 - tr) + b * tr) / 10;
}
