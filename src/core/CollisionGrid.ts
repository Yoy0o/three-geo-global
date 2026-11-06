/**
 * Uniform screen grid for rectangle collision tests (label and marker
 * decluttering), like the grid index behind Mapbox GL's CollisionIndex: a
 * query only looks at the rectangles in the cells it covers, so placing n
 * labels is O(n) instead of O(n²). Rectangles are in CSS pixels; ones outside
 * the viewport are clamped to the border cells.
 */
export class CollisionGrid {
  private cells: number[][] = [];
  private rects: number[] = [];
  private cols = 0;
  private rows = 0;

  /** @param size Cell size in CSS pixels (about the size of a typical label). */
  constructor(private readonly size = 64) {}

  /** Number of rectangles inserted since the last reset. */
  get count(): number {
    return this.rects.length / 4;
  }

  reset(width: number, height: number): void {
    this.cols = Math.max(1, Math.ceil(width / this.size));
    this.rows = Math.max(1, Math.ceil(height / this.size));
    const n = this.cols * this.rows;
    if (this.cells.length !== n) this.cells = Array.from({ length: n }, () => []);
    else for (const c of this.cells) c.length = 0;
    this.rects.length = 0;
  }

  /** Whether the rectangle overlaps one already inserted. */
  hits(x0: number, y0: number, x1: number, y1: number): boolean {
    const s = this.size;
    const cx0 = clamp(Math.floor(x0 / s), this.cols);
    const cy0 = clamp(Math.floor(y0 / s), this.rows);
    const cx1 = clamp(Math.floor(x1 / s), this.cols);
    const cy1 = clamp(Math.floor(y1 / s), this.rows);
    const r = this.rects;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (const i of this.cells[cy * this.cols + cx]) {
          if (x0 < r[i + 2] && x1 > r[i] && y0 < r[i + 3] && y1 > r[i + 1]) return true;
        }
      }
    }
    return false;
  }

  /** Adds the rectangle without testing it (obstacles). */
  insert(x0: number, y0: number, x1: number, y1: number): void {
    const s = this.size;
    const cx0 = clamp(Math.floor(x0 / s), this.cols);
    const cy0 = clamp(Math.floor(y0 / s), this.rows);
    const cx1 = clamp(Math.floor(x1 / s), this.cols);
    const cy1 = clamp(Math.floor(y1 / s), this.rows);
    const idx = this.rects.length;
    this.rects.push(x0, y0, x1, y1);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.cells[cy * this.cols + cx].push(idx);
  }

  /** Inserts the rectangle unless it overlaps an existing one. */
  tryInsert(x0: number, y0: number, x1: number, y1: number): boolean {
    if (this.hits(x0, y0, x1, y1)) return false;
    this.insert(x0, y0, x1, y1);
    return true;
  }
}

function clamp(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}
