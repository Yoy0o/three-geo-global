export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const TWO_PI = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wraps an angle into (-PI, PI]. */
export function wrapPi(a: number): number {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

/** Shortest signed angular difference b - a, in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  return wrapPi(b - a);
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function formatDistance(meters: number): string {
  const a = Math.abs(meters);
  if (a >= 100_000) return `${(meters / 1000).toFixed(0)} km`;
  if (a >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${meters.toFixed(1)} m`;
}

export function formatDegrees(rad: number, pos: string, neg: string): string {
  const d = rad * RAD2DEG;
  return `${Math.abs(d).toFixed(5)}°${d >= 0 ? pos : neg}`;
}
