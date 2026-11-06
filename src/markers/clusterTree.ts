/**
 * Hierarchical point clustering for the globe (聚合树), after Mapbox
 * Supercluster: the points are merged once per zoom level when the data
 * loads, and each frame only picks, per branch, the level that matches its
 * on-screen scale (like screen-space error for tiles). Per-frame cost is
 * proportional to the number of markers drawn, not to the number of points,
 * and clusters are fixed groups in world space: panning never reshuffles them.
 *
 * Differences to Supercluster, for a 3D globe:
 * - Distances are ECEF chords in meters (no Web Mercator), so clusters have
 *   the same ground size at every latitude and across the antimeridian.
 * - The level is chosen per node from its camera distance, so in a tilted
 *   view near points split while the horizon stays clustered.
 * - A cluster is drawn at its seed (its most important point), not at the
 *   centroid: the marker stays on a real point and on the terrain.
 *
 * Pure module (no three.js, no DOM): unit-tested, and usable in a Worker.
 */

/** Meters per CSS pixel at zoom 0 on the equator (256 px world, like web maps). */
export const ZOOM0_METERS_PER_PIXEL = (2 * Math.PI * 6_378_137) / 256;

export interface ClusterTreeOptions {
  /** Points closer than this on screen (CSS pixels) merge. */
  radius: number;
  /** Finest zoom that still merges points; finer views show every point. Default 18 (~0.6 m/px). */
  maxZoom?: number;
  /** Coarsest zoom built. Default 0. */
  minZoom?: number;
}

export interface ClusterTreeInput {
  /** ECEF positions in meters, xyz per point. */
  positions: Float64Array;
  /** Higher-priority points seed clusters first (ties keep input order). Default 0. */
  priorities?: Float64Array;
  /** Camera distance range per point in meters (default 0 / Infinity). */
  minDistances?: Float64Array;
  maxDistances?: Float64Array;
  /** Added to every bounding radius (meters): the points' heights may still change (terrain clamping). */
  heightMargin?: number;
}

/**
 * Node `i < pointCount` is point `i` (a leaf); larger ids are clusters.
 * All arrays are transferable (built in a Worker for large inputs).
 */
export interface ClusterTree {
  pointCount: number;
  /** Total nodes (points + clusters). */
  nodeCount: number;
  /** Representative point of each node (a leaf is its own seed). */
  seed: Int32Array;
  /** Points under each node. */
  count: Int32Array;
  /** Zoom level at which a cluster was formed (leaves: 127). */
  zoom: Int8Array;
  /** Children of cluster `c = node - pointCount`: `children[childStart[c] .. childStart[c + 1])`. */
  childStart: Int32Array;
  children: Int32Array;
  /** Bounding sphere around the seed position, meters. */
  radius: Float64Array;
  /** Camera distance range over the node's points (meters). */
  minDistance: Float64Array;
  maxDistance: Float64Array;
  /** Top-level nodes, by descending seed priority. */
  roots: Int32Array;
}

const LEAF_ZOOM = 127;

/**
 * Builds the cluster hierarchy: from `maxZoom` down to `minZoom`, the nodes of
 * the finer level are visited by descending priority and each joins the
 * nearest seed already placed within `radius` pixels at that zoom, else seeds
 * a new cluster. Groups of one are carried up unchanged (no single-child nodes).
 * O(n · levels) with a hash grid of 2·r cells (8 cells per query).
 */
export function buildClusterTree(input: ClusterTreeInput, options: ClusterTreeOptions): ClusterTree {
  const pos = input.positions;
  const n = Math.floor(pos.length / 3);
  const maxZoom = Math.min(30, Math.max(0, Math.floor(options.maxZoom ?? 18)));
  const minZoom = Math.min(maxZoom, Math.max(0, Math.floor(options.minZoom ?? 0)));
  const margin = input.heightMargin ?? 0;
  const prio = input.priorities;

  // Level-0 order: descending priority, stable. Every level keeps this order
  // because clusters are created in the order of their seeds.
  let level = new Int32Array(n);
  for (let i = 0; i < n; i++) level[i] = i;
  if (prio) level.sort((a, b) => prio[b] - prio[a] || a - b);

  // Growing node arrays (leaves first).
  let cap = Math.max(16, n * 2);
  let seed = new Int32Array(cap);
  let count = new Int32Array(cap);
  let zoom = new Int8Array(cap);
  let radius = new Float64Array(cap);
  let minD = new Float64Array(cap);
  let maxD = new Float64Array(cap);
  for (let i = 0; i < n; i++) {
    seed[i] = i;
    count[i] = 1;
    zoom[i] = LEAF_ZOOM;
    radius[i] = margin;
    minD[i] = input.minDistances ? input.minDistances[i] : 0;
    maxD[i] = input.maxDistances ? input.maxDistances[i] : Infinity;
  }
  let nodeCount = n;
  const childStart: number[] = [0];
  const children: number[] = [];

  const grow = (need: number) => {
    if (need <= cap) return;
    cap = Math.max(need, cap * 2);
    const g32 = (a: Int32Array) => { const b = new Int32Array(cap); b.set(a); return b; };
    const g64 = (a: Float64Array) => { const b = new Float64Array(cap); b.set(a); return b; };
    seed = g32(seed);
    count = g32(count);
    const z = new Int8Array(cap);
    z.set(zoom);
    zoom = z;
    radius = g64(radius);
    minD = g64(minD);
    maxD = g64(maxD);
  };

  // Per-level scratch: hash grid of group seeds (head per cell + linked list).
  const grid = new Map<number, number>();
  let next = new Int32Array(n);
  let groupOf = new Int32Array(n);
  let groupHead = new Int32Array(n);
  let groupSize = new Int32Array(n);

  for (let z = maxZoom; z >= minZoom && level.length > 1; z--) {
    const r = options.radius * (ZOOM0_METERS_PER_PIXEL / 2 ** z);
    const r2 = r * r;
    const cell = 2 * r;
    grid.clear();
    const m = level.length;
    if (next.length < m) {
      next = new Int32Array(m);
      groupOf = new Int32Array(m);
      groupHead = new Int32Array(m);
      groupSize = new Int32Array(m);
    }
    let groups = 0;
    // `next` links groups in the same cell; group g is seeded by level[groupHead[g]].
    for (let k = 0; k < m; k++) {
      const s = seed[level[k]] * 3;
      const x = pos[s], y = pos[s + 1], w = pos[s + 2];
      const fx = x / cell, fy = y / cell, fz = w / cell;
      const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
      // The 2x2x2 cells covering [p - r, p + r] (cell size 2r).
      const ox = fx - ix < 0.5 ? -1 : 1, oy = fy - iy < 0.5 ? -1 : 1, oz = fz - iz < 0.5 ? -1 : 1;
      let best = -1;
      let bestD = Infinity;
      for (let c = 0; c < 8; c++) {
        let g = grid.get(cellKey(ix + (c & 1 ? ox : 0), iy + (c & 2 ? oy : 0), iz + (c & 4 ? oz : 0))) ?? -1;
        for (; g >= 0; g = next[g]) {
          const t = seed[level[groupHead[g]]] * 3;
          const dx = pos[t] - x, dy = pos[t + 1] - y, dz = pos[t + 2] - w;
          const d = dx * dx + dy * dy + dz * dz;
          if (d <= r2 && (d < bestD || (d === bestD && g < best))) {
            best = g;
            bestD = d;
          }
        }
      }
      if (best >= 0) {
        groupOf[k] = best;
        groupSize[best]++;
      } else {
        const key = cellKey(ix, iy, iz);
        next[groups] = grid.get(key) ?? -1;
        grid.set(key, groups);
        groupHead[groups] = k;
        groupSize[groups] = 1;
        groupOf[k] = groups;
        groups++;
      }
    }
    if (groups === m) continue; // nothing merged at this zoom

    // Collect members per group (in priority order), then emit the next level.
    const start = new Int32Array(groups + 1);
    for (let g = 0; g < groups; g++) start[g + 1] = start[g] + groupSize[g];
    const fill = start.slice(0, groups);
    const members = new Int32Array(m);
    for (let k = 0; k < m; k++) members[fill[groupOf[k]]++] = level[k];
    const upper = new Int32Array(groups);
    for (let g = 0; g < groups; g++) {
      const a = start[g], b = start[g + 1];
      if (b - a === 1) {
        upper[g] = members[a];
        continue;
      }
      grow(nodeCount + 1);
      const id = nodeCount++;
      const sd = seed[members[a]];
      const sp = sd * 3;
      let cnt = 0, rad = 0, lo = Infinity, hi = 0;
      for (let k = a; k < b; k++) {
        const c = members[k];
        children.push(c);
        cnt += count[c];
        const q = seed[c] * 3;
        const d = Math.hypot(pos[q] - pos[sp], pos[q + 1] - pos[sp + 1], pos[q + 2] - pos[sp + 2]);
        rad = Math.max(rad, d + radius[c]);
        lo = Math.min(lo, minD[c]);
        hi = Math.max(hi, maxD[c]);
      }
      childStart.push(children.length);
      seed[id] = sd;
      count[id] = cnt;
      zoom[id] = z;
      radius[id] = rad;
      minD[id] = lo;
      maxD[id] = hi;
      upper[g] = id;
    }
    level = upper;
  }

  return {
    pointCount: n,
    nodeCount,
    seed: seed.slice(0, nodeCount),
    count: count.slice(0, nodeCount),
    zoom: zoom.slice(0, nodeCount),
    childStart: Int32Array.from(childStart),
    children: Int32Array.from(children),
    radius: radius.slice(0, nodeCount),
    minDistance: minD.slice(0, nodeCount),
    maxDistance: maxD.slice(0, nodeCount),
    roots: level,
  };
}

/** Hash of an integer cell; collisions only add candidates (distances are always checked). */
function cellKey(x: number, y: number, z: number): number {
  return (Math.imul(x, 73_856_093) ^ Math.imul(y, 19_349_663) ^ Math.imul(z, 83_492_791)) | 0;
}

/** Camera state for `selectClusters`. */
export interface ClusterView {
  /** Camera position, ECEF meters. */
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  /**
   * Meters per CSS pixel per meter of distance: `2 · tan(fov / 2) / viewportHeight`.
   * A node at distance d is drawn at zoom log2(ZOOM0_METERS_PER_PIXEL / (d · pixelSize)).
   */
  pixelSize: number;
  /** Frustum planes (nx, ny, nz, constant) × n, inside when n·p + constant ≥ 0. Branches outside are skipped. */
  planes?: Float64Array;
  /** Clusters with fewer points show their points instead. Default 2. */
  minPoints?: number;
  /** Zoom hysteresis against flicker at a level boundary. Default 0.15. */
  hysteresis?: number;
}

/**
 * Per-frame selection over a `ClusterTree`: walks from the roots and stops at
 * the first node whose level is at least as coarse as the screen at its
 * distance. Remembers which nodes were split, so a node near a level boundary
 * does not flip every frame.
 */
export class ClusterSelector {
  private readonly split: Uint8Array;
  private readonly stack: number[] = [];

  constructor(readonly tree: ClusterTree) {
    this.split = new Uint8Array(Math.max(0, tree.nodeCount - tree.pointCount));
  }

  /**
   * Fills `points` with the leaves to draw and `clusters` with the cluster
   * nodes to draw. `positions` are the live ECEF positions (they may differ
   * from the build positions after terrain clamping). Distance and frustum
   * tests are conservative (bounding spheres); exact per-marker culling is
   * left to the caller.
   */
  select(positions: Float64Array, view: ClusterView, points: number[], clusters: number[]): void {
    const t = this.tree;
    const n = t.pointCount;
    const minPoints = Math.max(2, view.minPoints ?? 2);
    const hyst = view.hysteresis ?? 0.15;
    const planes = view.planes;
    const k = Math.max(1e-12, view.pixelSize);
    points.length = 0;
    clusters.length = 0;
    const stack = this.stack;
    stack.length = 0;
    for (let i = t.roots.length - 1; i >= 0; i--) stack.push(t.roots[i]);
    while (stack.length > 0) {
      const node = stack.pop()!;
      const s = t.seed[node] * 3;
      const px = positions[s], py = positions[s + 1], pz = positions[s + 2];
      const r = t.radius[node];
      if (planes) {
        let outside = false;
        for (let p = 0; p < planes.length; p += 4) {
          if (planes[p] * px + planes[p + 1] * py + planes[p + 2] * pz + planes[p + 3] < -r) {
            outside = true;
            break;
          }
        }
        if (outside) continue;
      }
      const d = Math.hypot(px - view.cameraX, py - view.cameraY, pz - view.cameraZ);
      if (d - r > t.maxDistance[node] || d + r < t.minDistance[node]) continue;
      if (node < n) {
        points.push(node);
        continue;
      }
      const c = node - n;
      const screenZoom = Math.log2(ZOOM0_METERS_PER_PIXEL / (Math.max(1, d) * k));
      // Drawn as a cluster while the screen is at or coarser than the zoom it was formed at.
      const limit = t.zoom[node] + 1 + (this.split[c] ? -hyst : hyst);
      const split = screenZoom >= limit || t.count[node] < minPoints;
      this.split[c] = split ? 1 : 0;
      if (!split) {
        clusters.push(node);
        continue;
      }
      for (let i = t.childStart[c + 1] - 1; i >= t.childStart[c]; i--) stack.push(t.children[i]);
    }
  }
}

/** Point indices under a node (a leaf returns itself). */
export function clusterLeaves(tree: ClusterTree, node: number, out: number[] = []): number[] {
  const n = tree.pointCount;
  const stack = [node];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id < n) {
      out.push(id);
      continue;
    }
    const c = id - n;
    for (let i = tree.childStart[c]; i < tree.childStart[c + 1]; i++) stack.push(tree.children[i]);
  }
  return out;
}
