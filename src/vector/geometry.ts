/**
 * Planar geometry helpers for vector data in normalized Web Mercator space
 * (u = 0..1 west to east, v = 0..1 north to south). Shared by the vector
 * worker and unit tests; no DOM or three.js dependencies.
 */

export const MAX_LAT = 85.0511287798066;
const DEG = Math.PI / 180;

export function lonLatToMerc(lon: number, lat: number): [number, number] {
  const φ = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * DEG;
  const u = (lon + 180) / 360;
  const v = (1 - Math.log(Math.tan(Math.PI / 4 + φ / 2)) / Math.PI) / 2;
  return [u, v];
}

export function mercToLonLat(u: number, v: number): [number, number] {
  const lon = u * 360 - 180;
  const lat = (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * v))) - Math.PI / 2) / DEG;
  return [lon, lat];
}

/**
 * Converts a coordinate list to flat mercator (u, v) pairs, unwrapping
 * longitude jumps across the antimeridian so the path stays continuous.
 * Edges that run along the antimeridian itself (both ends at +-180, as in
 * RFC 7946 cut polygons) are left alone.
 */
export function projectPath(coords: ArrayLike<ArrayLike<number>>): Float64Array {
  const out = new Float64Array(coords.length * 2);
  let offset = 0;
  let prevLon = 0;
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    let lon = Number(c[0]);
    const lat = Number(c[1]);
    if (i > 0) {
      const raw = lon + offset;
      const delta = raw - prevLon;
      const onSeam = Math.abs(Number(coords[i - 1][0])) >= 179.9999 && Math.abs(lon) >= 179.9999;
      if (!onSeam && delta > 180) offset -= 360;
      else if (!onSeam && delta < -180) offset += 360;
    }
    lon += offset;
    prevLon = lon;
    const [u, v] = lonLatToMerc(lon, lat);
    out[i * 2] = u;
    out[i * 2 + 1] = v;
  }
  return out;
}

export type BBox = [number, number, number, number];

export function emptyBBox(): BBox {
  return [Infinity, Infinity, -Infinity, -Infinity];
}

export function extendBBox(b: BBox, path: Float64Array): BBox {
  for (let i = 0; i < path.length; i += 2) {
    const u = path[i];
    const v = path[i + 1];
    if (u < b[0]) b[0] = u;
    if (v < b[1]) b[1] = v;
    if (u > b[2]) b[2] = u;
    if (v > b[3]) b[3] = v;
  }
  return b;
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Signed shoelace area of a closed ring (positive = counter-clockwise in u/v). */
export function ringArea(ring: Float64Array): number {
  let s = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    s += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  }
  return s / 2;
}

export function pathLength(path: Float64Array): number {
  let len = 0;
  for (let i = 2; i < path.length; i += 2) len += Math.hypot(path[i] - path[i - 2], path[i + 1] - path[i - 1]);
  return len;
}

/** Even-odd point in polygon over all rings (outer + holes). */
export function pointInRings(u: number, v: number, rings: Float64Array[]): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i * 2];
      const yi = ring[i * 2 + 1];
      const xj = ring[j * 2];
      const yj = ring[j * 2 + 1];
      if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export function segmentDistanceSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx - px;
  const y = ay + t * dy - py;
  return x * x + y * y;
}

export function pathDistanceSq(u: number, v: number, path: Float64Array, closed = false): number {
  let best = Infinity;
  const n = path.length / 2;
  for (let i = 1; i < n; i++) {
    best = Math.min(best, segmentDistanceSq(u, v, path[i * 2 - 2], path[i * 2 - 1], path[i * 2], path[i * 2 + 1]));
  }
  if (closed && n > 2) best = Math.min(best, segmentDistanceSq(u, v, path[n * 2 - 2], path[n * 2 - 1], path[0], path[1]));
  return best;
}

/** Point halfway along a polyline. */
export function pathMidpoint(path: Float64Array): [number, number] {
  const half = pathLength(path) / 2;
  let acc = 0;
  for (let i = 2; i < path.length; i += 2) {
    const seg = Math.hypot(path[i] - path[i - 2], path[i + 1] - path[i - 1]);
    if (acc + seg >= half && seg > 0) {
      const t = (half - acc) / seg;
      return [path[i - 2] + (path[i] - path[i - 2]) * t, path[i - 1] + (path[i + 1] - path[i - 1]) * t];
    }
    acc += seg;
  }
  return [path[0], path[1]];
}

// -----------------------------------------------------------------------------
// Pole of inaccessibility (the "polylabel" algorithm by Mapbox): the interior
// point farthest from the outline, a much better label anchor than a centroid.

interface Cell {
  x: number;
  y: number;
  h: number;
  d: number;
  max: number;
}

function signedDistance(x: number, y: number, rings: Float64Array[]): number {
  const d = Math.sqrt(Math.min(...rings.map((r) => pathDistanceSq(x, y, r, true))));
  return pointInRings(x, y, rings) ? d : -d;
}

function makeCell(x: number, y: number, h: number, rings: Float64Array[]): Cell {
  const d = signedDistance(x, y, rings);
  return { x, y, h, d, max: d + h * Math.SQRT2 };
}

class MaxHeap {
  private items: Cell[] = [];
  get length(): number {
    return this.items.length;
  }
  push(c: Cell): void {
    const a = this.items;
    a.push(c);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].max >= a[i].max) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): Cell {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].max > a[m].max) m = l;
        if (r < a.length && a[r].max > a[m].max) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export function polylabel(rings: Float64Array[], precisionRatio = 0.005, maxCells = 3000): [number, number] {
  const outer = rings[0];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    minX = Math.min(minX, outer[i]);
    minY = Math.min(minY, outer[i + 1]);
    maxX = Math.max(maxX, outer[i]);
    maxY = Math.max(maxY, outer[i + 1]);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const cellSize = Math.min(width, height);
  if (cellSize <= 0) return [minX, minY];
  const precision = Math.max(width, height) * precisionRatio;

  const queue = new MaxHeap();
  const h0 = cellSize / 2;
  for (let x = minX; x < maxX; x += cellSize) {
    for (let y = minY; y < maxY; y += cellSize) queue.push(makeCell(x + h0, y + h0, h0, rings));
  }

  // Seed with the area centroid and the bbox center.
  let best = makeCell(...ringCentroid(outer), 0, rings);
  const center = makeCell(minX + width / 2, minY + height / 2, 0, rings);
  if (center.d > best.d) best = center;

  let processed = 0;
  while (queue.length > 0 && processed++ < maxCells) {
    const c = queue.pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    const h = c.h / 2;
    queue.push(makeCell(c.x - h, c.y - h, h, rings));
    queue.push(makeCell(c.x + h, c.y - h, h, rings));
    queue.push(makeCell(c.x - h, c.y + h, h, rings));
    queue.push(makeCell(c.x + h, c.y + h, h, rings));
  }
  return [best.x, best.y];
}

function ringCentroid(ring: Float64Array): [number, number] {
  let area = 0;
  let x = 0;
  let y = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
    x += (ring[i * 2] + ring[j * 2]) * f;
    y += (ring[i * 2 + 1] + ring[j * 2 + 1]) * f;
    area += f * 3;
  }
  if (area === 0) return [ring[0], ring[1]];
  return [x / area, y / area];
}

// -----------------------------------------------------------------------------

/**
 * Uniform grid over the unit square. Items carry an integer key; features
 * whose unwrapped bbox leaves [0, 1] are inserted once per world copy.
 */
export class GridIndex {
  private readonly cells: number[][];
  private stamp = 1;
  private readonly marks = new Map<number, number>();

  constructor(readonly n = 128) {
    this.cells = Array.from({ length: n * n }, () => []);
  }

  insert(key: number, u0: number, v0: number, u1: number, v1: number): void {
    const n = this.n;
    const x0 = Math.max(0, Math.floor(u0 * n));
    const y0 = Math.max(0, Math.floor(v0 * n));
    const x1 = Math.min(n - 1, Math.floor(u1 * n));
    const y1 = Math.min(n - 1, Math.floor(v1 * n));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.cells[y * n + x].push(key);
  }

  /** Unique keys whose cells overlap the rectangle. */
  query(u0: number, v0: number, u1: number, v1: number): number[] {
    const n = this.n;
    const x0 = Math.max(0, Math.floor(u0 * n));
    const y0 = Math.max(0, Math.floor(v0 * n));
    const x1 = Math.min(n - 1, Math.floor(u1 * n));
    const y1 = Math.min(n - 1, Math.floor(v1 * n));
    const out: number[] = [];
    const stamp = ++this.stamp;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (const key of this.cells[y * n + x]) {
          if (this.marks.get(key) !== stamp) {
            this.marks.set(key, stamp);
            out.push(key);
          }
        }
      }
    }
    return out;
  }
}
