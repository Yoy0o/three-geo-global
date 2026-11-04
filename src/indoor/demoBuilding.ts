import { BUILDING_FORMAT, BUILDING_FORMAT_VERSION, type BuildingDoc, type FloorDef, type RoomDef, type ThingDef, type Vec2 } from './schema';

/** Axis-aligned room rectangle [x0, y0, x1, y1] in local meters. */
type Rect = [number, number, number, number];

interface RoomSpec {
  name: string;
  category: string;
  rect: Rect;
  /** Door on the corridor side at this position along the edge (0..1). */
  door?: number;
}

const HALF_X = 30;
const HALF_Y = 12;
const CORRIDOR = 1.6;
const FLOOR_HEIGHT = 4.2;

function rectPolygon([x0, y0, x1, y1]: Rect): Vec2[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** North rooms (y > corridor) have their door on the south edge (index 0), south rooms on the north edge (index 2). */
function room(floorId: string, n: number, spec: RoomSpec): RoomDef {
  const north = spec.rect[1] >= 0;
  return {
    id: `${floorId}-R${String(n).padStart(2, '0')}`,
    name: spec.name,
    category: spec.category,
    footprint: rectPolygon(spec.rect),
    doors: spec.category === 'corridor' ? [] : [{ edge: north ? 0 : 2, at: spec.door ?? 0.5, width: spec.category === 'lobby' ? 3.2 : 1.1 }],
    walls: spec.category !== 'corridor',
    properties: { 用途: categoryName(spec.category) },
  };
}

function categoryName(c: string): string {
  return (
    {
      lobby: '大堂 / 展示',
      office: '办公',
      meeting: '会议',
      server: '机房',
      restroom: '卫生间',
      stair: '交通核',
      storage: '设备用房',
      kitchen: '茶水 / 餐饮',
      corridor: '走廊',
    } as Record<string, string>
  )[c] ?? c;
}

function floorRooms(level: number): RoomSpec[] {
  const n = (s: string) => `${level}${s}`;
  const c = CORRIDOR;
  const corridor: RoomSpec = { name: `${level}F 走廊`, category: 'corridor', rect: [-HALF_X, -c, HALF_X, c] };
  const core: RoomSpec[] = [
    { name: `${level}F 卫生间`, category: 'restroom', rect: [18, c, 24, HALF_Y], door: 0.3 },
    { name: `${level}F 楼梯间`, category: 'stair', rect: [24, c, HALF_X, HALF_Y], door: 0.4 },
    { name: `${level}F 电梯厅`, category: 'stair', rect: [22, -HALF_Y, HALF_X, -c], door: 0.5 },
  ];
  if (level === 1) {
    return [
      corridor,
      ...core,
      { name: '入口大堂', category: 'lobby', rect: [-HALF_X, c, -6, HALF_Y], door: 0.6 },
      { name: '安保值班室', category: 'storage', rect: [-6, c, 2, HALF_Y] },
      { name: '咖啡吧', category: 'kitchen', rect: [2, c, 18, HALF_Y], door: 0.3 },
      { name: '产品展厅', category: 'lobby', rect: [-HALF_X, -HALF_Y, -10, -c], door: 0.5 },
      { name: '接待室', category: 'meeting', rect: [-10, -HALF_Y, 0, -c] },
      { name: '消防控制室', category: 'storage', rect: [0, -HALF_Y, 10, -c] },
      { name: '配电室', category: 'storage', rect: [10, -HALF_Y, 22, -c], door: 0.7 },
    ];
  }
  if (level === 5) {
    return [
      corridor,
      ...core,
      { name: '多功能厅', category: 'meeting', rect: [-HALF_X, c, -6, HALF_Y], door: 0.8 },
      { name: '数据机房', category: 'server', rect: [-6, c, 18, HALF_Y], door: 0.15 },
      { name: '大会议室', category: 'meeting', rect: [-HALF_X, -HALF_Y, -10, -c], door: 0.85 },
      { name: n('03 会议室'), category: 'meeting', rect: [-10, -HALF_Y, 0, -c] },
      { name: '监控中心', category: 'office', rect: [0, -HALF_Y, 22, -c], door: 0.2 },
    ];
  }
  return [
    corridor,
    ...core,
    { name: `${level}F 开放办公区 A`, category: 'office', rect: [-HALF_X, c, -6, HALF_Y], door: 0.85 },
    { name: n('05 经理室'), category: 'office', rect: [-6, c, 2, HALF_Y] },
    { name: `${level}F 开放办公区 B`, category: 'office', rect: [2, c, 18, HALF_Y], door: 0.15 },
    { name: n('01 会议室'), category: 'meeting', rect: [-HALF_X, -HALF_Y, -20, -c] },
    { name: n('02 会议室'), category: 'meeting', rect: [-20, -HALF_Y, -10, -c] },
    { name: n('03 办公室'), category: 'office', rect: [-10, -HALF_Y, 0, -c] },
    { name: n('04 办公室'), category: 'office', rect: [0, -HALF_Y, 10, -c] },
    { name: `${level}F 茶水间`, category: 'kitchen', rect: [10, -HALF_Y, 22, -c], door: 0.3 },
  ];
}

function floorThings(floorId: string, level: number, rooms: RoomSpec[]): ThingDef[] {
  const things: ThingDef[] = [];
  const ceiling = FLOOR_HEIGHT - 0.6;
  let k = 0;
  const id = (kind: string) => `${floorId}-${kind}${String(++k).padStart(2, '0')}`;

  // Corridor cameras and Wi-Fi access points.
  for (const x of [-22, -4, 14]) {
    things.push({
      id: id('CAM'),
      name: `${level}F 摄像机 ${things.length + 1}`,
      category: 'camera',
      position: [x, 0, ceiling],
      size: [0.22, 0.34, 0.22],
      properties: { 设备类型: '球形摄像机', 状态: '在线', 分辨率: '4K' },
      label: { mode: 'hover', icon: '📷', style: 'pin' },
    });
  }
  for (const x of [-14, 8]) {
    things.push({ id: id('AP'), name: `${level}F 无线 AP`, category: 'ap', shape: 'cylinder', position: [x, 0.6, ceiling + 0.25], size: [0.3, 0.3, 0.06], properties: { 设备类型: 'Wi-Fi 6 AP', 在线终端: 18 + level * 3 } });
  }
  // Fire extinguishers next to the stairs.
  things.push({ id: id('FE'), name: `${level}F 灭火器`, category: 'extinguisher', shape: 'cylinder', position: [23.4, 2.3, 0], size: [0.2, 0.2, 0.62], properties: { 类型: '干粉灭火器', 有效期: '2027-06' } });

  // A temperature / humidity sensor in every meeting room and office.
  rooms
    .filter((r) => r.category === 'meeting' || r.category === 'office' || r.category === 'server')
    .forEach((r, i) => {
      const [x0, y0, x1, y1] = r.rect;
      const t = (22.5 + ((level * 7 + i * 3) % 30) / 10).toFixed(1);
      const hum = 40 + ((level * 5 + i * 11) % 18);
      const hot = r.category === 'server' && level === 5;
      things.push({
        id: id('TH'),
        name: `${r.name} 温湿度`,
        category: 'sensor',
        position: [x1 - 0.4, (y0 + y1) / 2, 1.6],
        size: [0.12, 0.08, 0.16],
        properties: { 设备类型: '温湿度传感器', 温度: `${hot ? '27.8' : t} ℃`, 湿度: `${hum} %`, 状态: hot ? '温度偏高' : '正常', 所在房间: r.name },
        label: { title: hot ? '27.8℃ · 偏高' : `${t}℃ · ${hum}%`, icon: '🌡', mode: 'level', style: 'pin', color: hot ? '#f97316' : undefined },
      });
      // Meeting tables and office desks.
      if (r.category === 'meeting') {
        const w = Math.min(x1 - x0 - 3, 6);
        things.push({ id: id('TB'), name: `${r.name} 会议桌`, category: 'desk', position: [(x0 + x1) / 2, (y0 + y1) / 2, 0], size: [w, 1.6, 0.75], properties: { 座位: Math.round(w * 2) } });
      }
    });

  // Desk clusters in the open offices.
  for (const r of rooms.filter((s) => s.name.includes('开放办公区'))) {
    const [x0, y0, x1, y1] = r.rect;
    for (let ix = 0; ix < 4; ix++) {
      for (let iy = 0; iy < 2; iy++) {
        const x = x0 + 3 + ix * ((x1 - x0 - 6) / 3);
        const y = y0 + 3 + iy * 4.4;
        if (y > y1 - 1.5) continue;
        things.push({ id: id('DK'), name: `${r.name} 工位 ${ix * 2 + iy + 1}`, category: 'desk', position: [x, y, 0], size: [2.8, 1.4, 0.75], properties: { 工位数: 4, 部门: level % 2 ? '研发部' : '市场部' } });
      }
    }
  }

  // Server racks (one running hot) in the data center.
  if (level === 5) {
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 8; i++) {
        const alarm = row === 1 && i === 5;
        things.push({
          id: id('RK'),
          name: `机柜 ${String.fromCharCode(65 + row)}${String(i + 1).padStart(2, '0')}`,
          category: 'rack',
          position: [-3 + i * 1.9, 4.8 + row * 3.6, 0],
          size: [0.8, 1.2, 2.2],
          color: alarm ? '#7f1d1d' : undefined,
          properties: { 负载: `${alarm ? 92 : 38 + ((i * 13 + row * 7) % 40)} %`, 功率: `${(3.2 + ((i + row) % 4) * 0.6).toFixed(1)} kW`, 状态: alarm ? '告警：进风温度过高' : '正常' },
          label: alarm ? { title: `机柜 B0${i + 1}`, subtitle: '进风温度过高', icon: '⚠', mode: 'level', style: 'card', color: '#ef4444' } : { mode: 'hover', style: 'tag' },
        });
      }
    }
  }
  return things;
}

/**
 * A procedural five-storey office building, used as the built-in indoor
 * demo. It exercises every part of the format: rooms with doors, equipment
 * with properties, data-driven labels in several modes and an alarm.
 */
export function createDemoBuilding(longitude = 116.3929, latitude = 39.9994): BuildingDoc {
  const floors: FloorDef[] = [];
  for (let level = 1; level <= 5; level++) {
    const id = `F${level}`;
    const specs = floorRooms(level);
    floors.push({
      id,
      name: `${level}F`,
      index: level - 1,
      elevation: (level - 1) * FLOOR_HEIGHT,
      height: FLOOR_HEIGHT,
      ifcType: 'IfcBuildingStorey',
      rooms: specs.map((s, i) => ({ ...room(id, i + 1, s), ifcType: 'IfcSpace' })),
      things: floorThings(id, level, specs),
    });
  }
  return {
    format: BUILDING_FORMAT,
    version: BUILDING_FORMAT_VERSION,
    id: 'demo-office-a',
    name: '示例办公楼 · A 座',
    category: 'office',
    ifcType: 'IfcBuilding',
    anchor: { longitude, latitude, heading: 0 },
    footprint: rectPolygon([-HALF_X, -HALF_Y, HALF_X, HALF_Y]),
    properties: { 用途: '办公', 建成年份: 2021, 建筑面积: '7200 m²', 物业单位: '示例物业' },
    label: { title: '示例办公楼 · A 座', subtitle: '5 层 · 双击进入', icon: '🏢', style: 'card' },
    exterior: { color: '#7fa6d6', opacity: 0.55 },
    floors,
  };
}
