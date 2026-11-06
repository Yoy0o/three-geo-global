import { describe, expect, it } from 'vitest';
import {
  defaultTitle,
  fillTemplate,
  matchesRule,
  parsePoints,
  pointsBBox,
  resolvePointStyle,
  type PointRecord,
  type PointRule,
} from '../src/markers/points';

describe('parsePoints', () => {
  it('reads GeoJSON points and multipoints and skips other geometries', () => {
    const parsed = parsePoints({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: 'a', geometry: { type: 'Point', coordinates: [116.4, 39.9, 50] }, properties: { name: 'A' } },
        { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }, properties: { id: 'm' } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: {} },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [200, 0] }, properties: {} },
      ],
    });
    expect(parsed.points.map((p) => p.id)).toEqual(['a', 'm-0', 'm-1']);
    expect(parsed.points[0]).toEqual({ id: 'a', longitude: 116.4, latitude: 39.9, height: 50, properties: { name: 'A' } });
    expect(parsed.points[1].height).toBeNull();
    expect(parsed.skipped).toBe(2);
    expect(parsed.warnings[0]).toContain('features[3]');
  });

  it('reads record arrays with common coordinate field names', () => {
    const parsed = parsePoints([
      { id: 1, lng: '121.5', lat: '31.2', name: '上海', alt: 10 },
      { 经度: 113.3, 纬度: 23.1, 名称: '广州' },
      { coordinates: [104.1, 30.7, 500], name: '成都' },
      { name: 'no coordinates' },
    ]);
    expect(parsed.points).toHaveLength(3);
    expect(parsed.points[0]).toEqual({ id: '1', longitude: 121.5, latitude: 31.2, height: 10, properties: { id: 1, name: '上海' } });
    expect(parsed.points[1].properties).toEqual({ 名称: '广州' });
    expect(parsed.points[2]).toMatchObject({ longitude: 104.1, latitude: 30.7, height: 500, properties: { name: '成都' } });
    expect(parsed.warnings[0]).toContain('[3]');
  });

  it('keeps ids unique and carries document defaults', () => {
    const parsed = parsePoints({
      points: [
        { id: 'x', lon: 0, lat: 0 },
        { id: 'x', lon: 1, lat: 1 },
      ],
      style: { style: 'pulse' },
      rules: [{ when: { a: 1 }, style: { color: 'red' } }, { bogus: true }],
    });
    expect(new Set(parsed.points.map((p) => p.id)).size).toBe(2);
    expect(parsed.style).toEqual({ style: 'pulse' });
    expect(parsed.rules).toHaveLength(1);
  });

  it('explains unsupported input', () => {
    expect(parsePoints(42).warnings[0]).toContain('JSON');
    expect(parsePoints({ foo: 1 }).points).toHaveLength(0);
  });
});

describe('style rules', () => {
  const point = (properties: Record<string, unknown>): PointRecord => ({ id: 'p', longitude: 0, latitude: 0, height: null, properties });

  it('matches equality, membership and comparisons', () => {
    const props = { status: '告警', level: 3, value: '12.5' };
    expect(matchesRule(props, { status: '告警' })).toBe(true);
    expect(matchesRule(props, { status: ['离线', '告警'] })).toBe(true);
    expect(matchesRule(props, { level: '3' })).toBe(true);
    expect(matchesRule(props, { value: { gt: 10, lte: 12.5 } })).toBe(true);
    expect(matchesRule(props, { value: { lt: 10 } })).toBe(false);
    expect(matchesRule(props, { status: { ne: '告警' } })).toBe(false);
    expect(matchesRule(props, { status: '告警', level: 4 })).toBe(false);
    expect(matchesRule(props, { missing: { in: ['a', 'b'] } })).toBe(false);
    // null means "no value": matches missing properties.
    expect(matchesRule(props, { missing: null })).toBe(true);
    expect(matchesRule(props, { status: null })).toBe(false);
  });

  it('applies matching rules in order, then the point style property', () => {
    const rules: PointRule[] = [
      { when: { type: 'camera' }, style: { color: 'purple', icon: '📷' } },
      { when: { status: 'alarm' }, style: { color: 'red', style: 'pulse' } },
    ];
    expect(resolvePointStyle(point({ type: 'camera' }), { style: 'badge', color: 'blue' }, rules)).toEqual({ style: 'badge', color: 'purple', icon: '📷' });
    expect(resolvePointStyle(point({ type: 'camera', status: 'alarm' }), { style: 'badge' }, rules)).toEqual({ style: 'pulse', color: 'red', icon: '📷' });
    expect(resolvePointStyle(point({ style: { color: 'green' } }), { color: 'blue' }, rules).color).toBe('green');
  });

  it('fills templates and picks a default title', () => {
    expect(fillTemplate('{name} · {value} ℃', { name: '站点', value: 21.5 })).toBe('站点 · 21.5 ℃');
    expect(fillTemplate('{missing}', {})).toBe('');
    expect(fillTemplate('plain', {})).toBe('plain');
    expect(defaultTitle(point({ 名称: '故宫' }))).toBe('故宫');
    expect(defaultTitle(point({}))).toBe('p');
  });
});

describe('pointsBBox', () => {
  it('computes a bounding box', () => {
    const p = (lon: number, lat: number): PointRecord => ({ id: '', longitude: lon, latitude: lat, height: null, properties: {} });
    expect(pointsBBox([p(1, 2), p(-3, 5), p(4, -1)])).toEqual([-3, -1, 4, 5]);
    expect(pointsBBox([])).toBeNull();
  });
});
