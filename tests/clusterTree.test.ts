import { describe, expect, it } from 'vitest';
import { CollisionGrid } from '../src/core/CollisionGrid';
import { geodeticToEcef } from '../src/core/geodesy';
import { buildClusterTree, ClusterSelector, clusterLeaves, ZOOM0_METERS_PER_PIXEL, type ClusterTree, type ClusterView } from '../src/markers/clusterTree';

const D = Math.PI / 180;

function positionsOf(lonLat: [number, number][]): Float64Array {
  const out = new Float64Array(lonLat.length * 3);
  lonLat.forEach(([lon, lat], i) => geodeticToEcef(lon * D, lat * D, 0, out, i * 3));
  return out;
}

function random(seed: number): () => number {
  return () => (seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) / 4_294_967_296;
}

function scattered(n: number, seed = 1): [number, number][] {
  const r = random(seed);
  return Array.from({ length: n }, () => [116.1 + r() * 0.6, 39.7 + r() * 0.45] as [number, number]);
}

/** Camera straight above (lon, lat) at `height` m, 45° vertical fov, 900 px tall viewport. */
function viewAbove(lon: number, lat: number, height: number, extra: Partial<ClusterView> = {}): ClusterView {
  const c = new Float64Array(3);
  geodeticToEcef(lon * D, lat * D, height, c);
  return { cameraX: c[0], cameraY: c[1], cameraZ: c[2], pixelSize: (2 * Math.tan(22.5 * D)) / 900, ...extra };
}

function allLeaves(tree: ClusterTree): number[] {
  const out: number[] = [];
  for (const r of tree.roots) clusterLeaves(tree, r, out);
  return out.sort((a, b) => a - b);
}

describe('buildClusterTree', () => {
  it('covers every point exactly once and counts them', () => {
    const pts = scattered(2000);
    const tree = buildClusterTree({ positions: positionsOf(pts) }, { radius: 50 });
    expect(allLeaves(tree)).toEqual(pts.map((_, i) => i));
    const total = Array.from(tree.roots).reduce((s, r) => s + tree.count[r], 0);
    expect(total).toBe(pts.length);
    // No single-child clusters: groups of one are carried up unchanged.
    for (let c = 0; c < tree.nodeCount - tree.pointCount; c++) expect(tree.childStart[c + 1] - tree.childStart[c]).toBeGreaterThan(1);
  });

  it('is deterministic', () => {
    const positions = positionsOf(scattered(800, 3));
    const a = buildClusterTree({ positions }, { radius: 40 });
    const b = buildClusterTree({ positions }, { radius: 40 });
    expect(Array.from(a.children)).toEqual(Array.from(b.children));
    expect(Array.from(a.roots)).toEqual(Array.from(b.roots));
  });

  it('bounds every cluster: all its points lie within its radius of the seed', () => {
    const positions = positionsOf(scattered(1500, 5));
    const tree = buildClusterTree({ positions }, { radius: 56 });
    for (let node = tree.pointCount; node < tree.nodeCount; node++) {
      const s = tree.seed[node] * 3;
      for (const i of clusterLeaves(tree, node)) {
        const d = Math.hypot(positions[i * 3] - positions[s], positions[i * 3 + 1] - positions[s + 1], positions[i * 3 + 2] - positions[s + 2]);
        expect(d).toBeLessThanOrEqual(tree.radius[node] + 1e-6);
      }
      // Merges at zoom z are within 2 · radius px · (m/px at z) of the seed, per level below.
      expect(tree.radius[node]).toBeLessThan(4 * 56 * (ZOOM0_METERS_PER_PIXEL / 2 ** tree.zoom[node]));
    }
  });

  it('seeds clusters with the most important point', () => {
    const pts: [number, number][] = [
      [116.4, 39.9],
      [116.4001, 39.9],
      [116.4002, 39.9001],
    ];
    const priorities = new Float64Array([0, 0, 5]);
    const tree = buildClusterTree({ positions: positionsOf(pts), priorities }, { radius: 50 });
    expect(tree.roots.length).toBe(1);
    expect(tree.seed[tree.roots[0]]).toBe(2);
  });

  it('merges across the antimeridian', () => {
    const tree = buildClusterTree({ positions: positionsOf([[179.9999, 0], [-179.9999, 0]]) }, { radius: 50 });
    expect(tree.roots.length).toBe(1);
    expect(tree.count[tree.roots[0]]).toBe(2);
    // ~22 m apart: still separate at the finest built zoom (18: 50 px ≈ 30 m merges, 20 would not be built).
    expect(tree.zoom[tree.roots[0]]).toBeGreaterThanOrEqual(17);
  });

  it('keeps distance ranges per node', () => {
    const maxDistances = new Float64Array([1000, 5000, Infinity]);
    const tree = buildClusterTree({ positions: positionsOf([[0, 0], [0.00001, 0], [50, 0]]), maxDistances }, { radius: 50 });
    const near = Array.from({ length: tree.nodeCount }, (_, i) => i).find((i) => tree.count[i] === 2)!;
    expect(tree.maxDistance[near]).toBe(5000);
    expect(tree.minDistance[near]).toBe(0);
    expect(tree.maxDistance[tree.roots[0]]).toBe(Infinity);
  });
});

describe('ClusterSelector', () => {
  const pts = scattered(3000, 7);
  const positions = positionsOf(pts);
  const tree = buildClusterTree({ positions }, { radius: 56 });

  it('draws few clusters from afar and single points up close', () => {
    const sel = new ClusterSelector(tree);
    const points: number[] = [];
    const clusters: number[] = [];
    sel.select(positions, viewAbove(116.4, 39.9, 2_000_000, { minPoints: 3 }), points, clusters);
    expect(clusters.length).toBeLessThanOrEqual(3);
    // Without culling, what is drawn covers every point exactly once.
    const covered = [...points];
    for (const c of clusters) clusterLeaves(tree, c, covered);
    expect(covered.sort((a, b) => a - b)).toEqual(pts.map((_, i) => i));

    const [lon, lat] = pts[0];
    sel.select(positions, viewAbove(lon, lat, 50, { minPoints: 3 }), points, clusters);
    expect(points).toContain(0);
  });

  it('skips branches outside the frustum', () => {
    const sel = new ClusterSelector(tree);
    const points: number[] = [];
    const clusters: number[] = [];
    // A plane through the center of the earth keeping only the western hemisphere (y < 0).
    sel.select(positions, viewAbove(116.4, 39.9, 20_000, { planes: new Float64Array([0, -1, 0, 0]) }), points, clusters);
    expect(points.length + clusters.length).toBe(0);
  });

  it('does not flip clusters at a level boundary (hysteresis)', () => {
    const sel = new ClusterSelector(tree);
    const points: number[] = [];
    const clusters: number[] = [];
    const counts = new Set<number>();
    // Height whose screen zoom is exactly a level boundary, jittered by ±1%.
    const base = ZOOM0_METERS_PER_PIXEL / ((2 * Math.tan(22.5 * D)) / 900) / 2 ** 12;
    sel.select(positions, viewAbove(116.4, 39.9, base, { minPoints: 3 }), points, clusters);
    for (let i = 0; i < 20; i++) {
      sel.select(positions, viewAbove(116.4, 39.9, base * (i % 2 ? 1.01 : 0.99), { minPoints: 3 }), points, clusters);
      counts.add(points.length * 100_000 + clusters.length);
    }
    expect(counts.size).toBe(1);
  });

  it('shows small groups as points (minPoints)', () => {
    const t = buildClusterTree({ positions: positionsOf([[0, 0], [0.00005, 0]]) }, { radius: 50 });
    const sel = new ClusterSelector(t);
    const points: number[] = [];
    const clusters: number[] = [];
    sel.select(positionsOf([[0, 0], [0.00005, 0]]), viewAbove(0, 0, 1_000_000, { minPoints: 3 }), points, clusters);
    expect(clusters).toEqual([]);
    expect(points.sort()).toEqual([0, 1]);
  });

  it('drops points beyond their max distance', () => {
    const p = positionsOf([[0, 0], [0.00001, 0]]);
    const t = buildClusterTree({ positions: p, maxDistances: new Float64Array([1000, 1000]) }, { radius: 50 });
    const points: number[] = [];
    const clusters: number[] = [];
    new ClusterSelector(t).select(p, viewAbove(0, 0, 100_000), points, clusters);
    expect(points.length + clusters.length).toBe(0);
  });
});

describe('CollisionGrid', () => {
  it('detects overlaps through the cells and clamps rectangles outside the viewport', () => {
    const g = new CollisionGrid(64);
    g.reset(400, 300);
    expect(g.tryInsert(10, 10, 90, 40)).toBe(true);
    expect(g.tryInsert(80, 30, 150, 60)).toBe(false);
    expect(g.tryInsert(91, 10, 150, 40)).toBe(true);
    // Partly off screen on the right: still collides with a rect in the border cells.
    expect(g.tryInsert(380, 100, 460, 120)).toBe(true);
    expect(g.hits(420, 105, 440, 110)).toBe(true);
    g.insert(0, 200, 400, 210);
    expect(g.hits(300, 205, 310, 220)).toBe(true);
    expect(g.count).toBe(4);
    g.reset(400, 300);
    expect(g.hits(10, 10, 90, 40)).toBe(false);
  });
});
