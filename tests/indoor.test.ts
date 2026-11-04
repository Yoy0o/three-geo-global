import { PerspectiveCamera, Sphere, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { matchesSelector } from '../src/indoor/BimEntity';
import { Building } from '../src/indoor/Building';
import { createDemoBuilding } from '../src/indoor/demoBuilding';
import { IndoorManager, type IndoorHost } from '../src/indoor/IndoorManager';
import { parseBuildingDoc, polygonArea, polygonCentroid, signedArea } from '../src/indoor/schema';

const E = Ellipsoid.WGS84;

function minimalDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'three-geo-building',
    version: '1.0',
    id: 'b1',
    name: 'Test',
    anchor: { longitude: 116.39, latitude: 39.9, height: 50, heading: 30 },
    floors: [
      {
        id: 'f1',
        index: 0,
        elevation: 0,
        height: 4,
        rooms: [{ id: 'r1', name: 'Room 1', footprint: [[0, 0], [10, 0], [10, 8], [0, 8]] }],
        things: [{ id: 't1', name: 'Cam 1', category: 'camera', position: [5, 4, 3] }],
      },
    ],
    ...overrides,
  };
}

/** Indoor host without a viewer: no markers DOM, no flights. */
function host(): IndoorHost {
  return {
    ellipsoid: E,
    camera: new PerspectiveCamera(),
    markers: { add: () => ({ remove: () => undefined }) } as unknown as IndoorHost['markers'],
    groundHeight: () => 40,
    flyToSphere: async () => undefined,
    cameraHeading: () => 0,
    setTilesetsVisible: () => undefined,
    loadModel: null,
    createLabelElement: () => ({}) as HTMLElement,
  };
}

describe('building schema', () => {
  it('parses a minimal document and fills defaults', () => {
    const doc = parseBuildingDoc(minimalDoc());
    expect(doc.floors).toHaveLength(1);
    expect(doc.anchor.heading).toBe(30);
    expect(doc.floors[0].rooms![0].walls).toBe(true);
    expect(doc.floors[0].things![0].shape).toBe('box');
  });

  it('reports the JSON path of problems', () => {
    expect(() => parseBuildingDoc({ ...minimalDoc(), format: 'x' })).toThrow('$.format');
    expect(() => parseBuildingDoc(minimalDoc({ anchor: { longitude: 1 } }))).toThrow('$.anchor.latitude');
    const dup = minimalDoc();
    (dup.floors as { things: { id: string }[] }[])[0].things[0].id = 'r1';
    expect(() => parseBuildingDoc(dup)).toThrow('duplicate id "r1"');
    const badRoom = minimalDoc();
    (badRoom.floors as { rooms: { footprint: unknown }[] }[])[0].rooms[0].footprint = [[0, 0]];
    expect(() => parseBuildingDoc(badRoom)).toThrow('$.floors[0].rooms[0].footprint');
  });

  it('computes polygon area, orientation and centroid', () => {
    const square: [number, number][] = [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ];
    expect(polygonArea(square)).toBe(12);
    expect(signedArea(square)).toBeGreaterThan(0);
    expect(signedArea([...square].reverse())).toBeLessThan(0);
    expect(polygonCentroid(square)).toEqual([2, 1.5]);
  });

  it('accepts the demo building after a JSON round trip', () => {
    const doc = parseBuildingDoc(JSON.parse(JSON.stringify(createDemoBuilding())));
    expect(doc.floors.map((f) => f.name)).toEqual(['1F', '2F', '3F', '4F', '5F']);
    const rooms = doc.floors.flatMap((f) => f.rooms ?? []);
    expect(rooms.length).toBeGreaterThan(40);
    expect(new Set(rooms.map((r) => r.id)).size).toBe(rooms.length);
  });
});

describe('Building', () => {
  it('builds the entity tree and places the local frame on the globe', () => {
    const b = new Building(parseBuildingDoc(minimalDoc()), E, null);
    expect(b.floors).toHaveLength(1);
    const [floor] = b.floors;
    expect(floor.children.map((c) => c.type)).toEqual(['room', 'thing']);
    expect(floor.children[0].properties['面积']).toBe('80.0 m²');
    // The local origin sits at the anchor (50 m above the ellipsoid).
    b.root.updateMatrixWorld(true);
    const origin = new Vector3().applyMatrix4(b.group.matrixWorld);
    const c = E.cartesianToCartographic(origin)!;
    expect(c.height).toBeCloseTo(50, 3);
    expect(c.longitude / (Math.PI / 180)).toBeCloseTo(116.39, 6);
    // Local +Y points 30 degrees east of north.
    const yAxis = new Vector3(0, 1, 0).applyMatrix4(b.group.matrixWorld).sub(origin).normalize();
    const east = new Vector3();
    const north = new Vector3();
    E.eastNorthUp(origin, east, north, new Vector3());
    expect(Math.atan2(yAxis.dot(east), yAxis.dot(north)) / (Math.PI / 180)).toBeCloseTo(30, 4);
    const bounds = b.worldBounds(new Sphere());
    expect(bounds).not.toBeNull();
    expect(bounds!.radius).toBeGreaterThan(5);
  });

  it('matches ThingJS-style selectors', () => {
    const b = new Building(parseBuildingDoc(minimalDoc()), E, null);
    const cam = b.floors[0].children[1];
    expect(matchesSelector(cam, '.Thing')).toBe(true);
    expect(matchesSelector(cam, '.room, .thing')).toBe(true);
    expect(matchesSelector(cam, '#t1')).toBe(true);
    expect(matchesSelector(cam, '[category=camera]')).toBe(true);
    expect(matchesSelector(cam, 'Cam 1')).toBe(true);
    expect(matchesSelector(cam, /^Cam/)).toBe(true);
    expect(matchesSelector(cam, '.Room')).toBe(false);
    expect(matchesSelector(cam, (e) => e.closest('floor')?.id === 'f1')).toBe(true);
  });
});

describe('IndoorManager levels', () => {
  it('steps globe -> building -> floor -> room and back with events', async () => {
    const indoor = new IndoorManager(host());
    const b = indoor.add(minimalDoc());
    const floor = indoor.getById('f1')!;
    const room = indoor.getById('r1')!;
    const events: string[] = [];
    indoor.events.on('enterLevel', (e) => events.push(`enter:${e.object?.id ?? 'globe'}`));
    indoor.events.on('leaveLevel', (e) => events.push(`leave:${e.object?.id ?? 'globe'}`));

    // From the globe a double click on a room enters its building first.
    expect(indoor.nextLevel(room)).toBe(b);
    await indoor.enter(b);
    expect(b.exterior.visible).toBe(false);
    expect(indoor.nextLevel(room)).toBe(floor);
    await indoor.enter(floor);
    expect(indoor.nextLevel(room)).toBe(room);
    await indoor.enter(room);
    expect(indoor.selected).toBe(room);
    await indoor.back();
    expect(indoor.current).toBe(floor);
    await indoor.enter(null);
    expect(b.exterior.visible).toBe(true);
    expect(b.floors.every((f) => !f.visible)).toBe(true);
    expect(events).toEqual(['enter:b1', 'enter:f1', 'enter:r1', 'leave:r1', 'enter:f1', 'leave:f1', 'leave:b1', 'enter:globe']);
  });

  it('clamps buildings without a height to the terrain', () => {
    const indoor = new IndoorManager(host());
    const doc = minimalDoc();
    (doc.anchor as Record<string, unknown>).height = undefined;
    const b = indoor.add(doc);
    expect(b.groundHeight).toBe(40);
  });
});
