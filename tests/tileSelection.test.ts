import { describe, expect, it } from 'vitest';
import {
  childUvTransform,
  FOG_MAX_HEIGHT,
  fogAmount,
  fogRelaxedError,
  horizonFogDensity,
  IMAGERY_COALESCE_MS,
  IMAGERY_GROUP_WAIT_MS,
  imagerySwitchDue,
  selectionIn,
  TileSelection,
  wouldLoseDetail,
  type SelectionNode,
} from '../src/globe/tileSelection';

interface Node extends SelectionNode<Node> {
  name: string;
  children: Node[] | null;
  /** Level of the imagery this node showed when drawn. */
  shown: number;
}

function node(name: string, selection: TileSelection, selectionFrame: number, shown = 0, children: Node[] | null = null): Node {
  return { name, selection, selectionFrame, shown, children };
}

describe('selection memory', () => {
  it('reports what a tile was in a given frame, NONE otherwise', () => {
    const n = node('a', TileSelection.RENDERED, 41);
    expect(selectionIn(n, 41)).toBe(TileSelection.RENDERED);
    expect(selectionIn(n, 42)).toBe(TileSelection.NONE);
  });
});

describe('wouldLoseDetail (CesiumJS canRenderWithoutLosingDetail)', () => {
  const last = 9;

  it('blocks a parent while a descendant drawn last frame showed more than it can', () => {
    // Parent refined last frame; two children drawn with their own L6 imagery, one culled.
    const parent = node('p', TileSelection.REFINED, last, 5, [
      node('c0', TileSelection.RENDERED, last, 6),
      node('c1', TileSelection.RENDERED, last, 6),
      node('c2', TileSelection.CULLED, last, 9),
      node('c3', TileSelection.RENDERED, last, 4),
    ]);
    // The parent can only show a magnified L4 ancestor: c0 / c1 were sharper.
    expect(wouldLoseDetail(parent, last, (d) => d.shown > 4)).toBe(true);
    // Nothing drawn showed more than the parent can: it may replace its children.
    expect(wouldLoseDetail(parent, last, (d) => d.shown > 6)).toBe(false);
  });

  it('walks refined descendants and ignores culled ones and older frames', () => {
    const deep = node('g', TileSelection.RENDERED, last, 12);
    const parent = node('p', TileSelection.REFINED, last, 0, [
      node('c0', TileSelection.REFINED, last, 0, [node('g0', TileSelection.CULLED, last, 20), deep]),
      // Drawn two frames ago, not last frame: no longer on screen.
      node('c1', TileSelection.RENDERED, last - 1, 20),
      node('c2', TileSelection.CULLED, last, 20),
      node('c3', TileSelection.NONE, last, 20),
    ]);
    const seen: string[] = [];
    const blocked = wouldLoseDetail(parent, last, (d) => {
      seen.push(d.name);
      return d.shown > 10;
    });
    expect(blocked).toBe(true);
    expect(seen).toEqual(['g']);
    expect(wouldLoseDetail(parent, last, (d) => d.shown > 12)).toBe(false);
  });

  it('never blocks a tile without children', () => {
    expect(wouldLoseDetail(node('leaf', TileSelection.REFINED, last), last, () => true)).toBe(false);
  });
});

describe('horizon fog (CesiumJS Fog)', () => {
  it('is off in space and when looking straight down', () => {
    expect(horizonFogDensity(FOG_MAX_HEIGHT + 1, 0)).toBe(0);
    expect(horizonFogDensity(Number.NaN, 0)).toBe(0);
    expect(horizonFogDensity(1000, -1)).toBe(0);
    expect(horizonFogDensity(1000, 1)).toBe(0);
  });

  it('matches the CesiumJS density formula and grows as the camera descends', () => {
    // density = 6e-4 * 1e-3 * (h / 800 km)^-0.59, scaled by (1 - |view . up|)
    expect(horizonFogDensity(8000, 0)).toBeCloseTo(6e-7 * Math.pow(0.01, -0.59), 12);
    expect(horizonFogDensity(8000, -0.5)).toBeCloseTo(0.5 * horizonFogDensity(8000, 0), 12);
    expect(horizonFogDensity(500, 0)).toBeGreaterThan(horizonFogDensity(5000, 0));
    expect(horizonFogDensity(5000, 0)).toBeGreaterThan(horizonFogDensity(500_000, 0));
    // Clamped below 1e-4 of the max height (80 m), including below the ellipsoid.
    expect(horizonFogDensity(-50, 0)).toBe(horizonFogDensity(80, 0));
  });

  it('fogs distant tiles and relaxes their error by up to factor x threshold', () => {
    const density = horizonFogDensity(1000, 0);
    expect(fogAmount(0, density)).toBe(0);
    expect(fogAmount(5_000, density)).toBeLessThan(0.05);
    expect(fogAmount(300_000, density)).toBeGreaterThan(0.999);
    expect(fogRelaxedError(3, 1_000_000, density, 1.25, 1)).toBeCloseTo(3 - 1.25, 6);
    expect(fogRelaxedError(3, 1_000_000, density, 1.25, 0)).toBe(3);
    expect(fogRelaxedError(3, 1_000_000, 0, 1.25, 1)).toBe(3);
  });
});

describe('childUvTransform', () => {
  it('maps a child onto its quadrant of the parent picture', () => {
    expect(childUvTransform([0, 0, 1, 1], 0, 0)).toEqual([0, 0, 0.5, 0.5]);
    expect(childUvTransform([0, 0, 1, 1], 1, 1)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('agrees with magnifying an ancestor directly', () => {
    // Tile 7/(x, y) shows ancestor 4/(sx, sy): offset (x - sx * 8) / 8, scale 1/8 (Globe.setImageryTransform).
    const direct = (x: number, y: number, sx: number, sy: number, dz: number) => {
      const s = 1 / 2 ** dz;
      return [(x - sx * 2 ** dz) * s, (y - sy * 2 ** dz) * s, s, s];
    };
    const parent = direct(53, 26, 13, 6, 2) as [number, number, number, number]; // 6/53/26 showing 4/13/6
    const child = childUvTransform(parent, 1, 0); // 7/107/52
    const expected = direct(107, 52, 13, 6, 3);
    for (let i = 0; i < 4; i++) expect(child[i]).toBeCloseTo(expected[i], 12);
  });
});

describe('imagery reveal', () => {
  it('replaces the placeholder at once', () => {
    expect(imagerySwitchDue(0, false, true, false)).toBe(true);
    expect(imagerySwitchDue(0, true, true, false)).toBe(true);
  });

  it('coalesces sharper ancestor pictures for a moment', () => {
    expect(imagerySwitchDue(0, false, false, true)).toBe(false);
    expect(imagerySwitchDue(IMAGERY_COALESCE_MS - 1, false, false, true)).toBe(false);
    expect(imagerySwitchDue(IMAGERY_COALESCE_MS, false, false, false)).toBe(true);
  });

  it('reveals own imagery together with the siblings, or after a timeout', () => {
    expect(imagerySwitchDue(0, true, false, true)).toBe(true);
    expect(imagerySwitchDue(IMAGERY_GROUP_WAIT_MS - 1, true, false, false)).toBe(false);
    expect(imagerySwitchDue(IMAGERY_GROUP_WAIT_MS, true, false, false)).toBe(true);
  });
});
