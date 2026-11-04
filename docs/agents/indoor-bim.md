# 室内与 BIM 模型规范

代码：`src/indoor/schema.ts`（格式与校验）、`src/indoor/BimEntity.ts`（实体、样式、选择器）、`src/indoor/Building.ts`（构建与地理定位）、`src/indoor/IndoorManager.ts`（层级导航、拾取、顶牌）、`src/indoor/demoBuilding.ts`（示例）。UI：`src/ui/IndoorPanel.ts`。测试：`tests/indoor.test.ts`。

## 1. 目标

- **无缝**：同一个场景、同一台相机，从地球飞进园区和建筑，再进入楼层、房间、设备，不切换页面，也不切换渲染器。
- **语义化**：每个房间和设备都是带编号、分类、属性的实体，可以查询、可以拾取、可以改样式，并能挂顶牌。
- **与 BIM 对齐**：层级对应 IFC 的空间结构，属性能承载 IFC 属性集；几何可以来自程序生成，也可以来自 glTF（由 IFC 或 Revit 导出）。

## 2. 层级模型

| 本项目 `type` | IFC | ThingJS | 说明 |
| --- | --- | --- | --- |
| （地球） | IfcSite 所在地 | Campus / 地图层级 | `current === null` |
| `building` | IfcBuilding | Building | 外立面加若干楼层；外部可见外壳 |
| `floor` | IfcBuildingStorey | Floor | 标高、层高、楼板轮廓 |
| `room` | IfcSpace | Room | 多边形轮廓，自动计算面积，自动生成墙（含门洞） |
| `element` | IfcWall / IfcDoor / IfcWindow / IfcColumn / IfcSlab / IfcStair | 墙 / 门 / 窗 / 地板 / 屋顶 | 结构构件，可选 |
| `thing` | IfcElement（设备、传感器、资产） | Thing / Entity | 位置、朝向、尺寸或模型 |

**托管实体与静态几何**（对应 ThingJS 的 Entity 和 Misc）：文档里列出的元素都是托管实体，可以拾取、改样式、查询、挂顶牌。glTF 中没有对应实体的节点属于静态几何，照常绘制，但拾取时只会解析到它所在的楼层或设备。

## 3. 坐标系

- 建筑本地坐标：原点在 `anchor`（经度、纬度、高度），+X 东、+Y 北、+Z 上，整体按 `anchor.heading`（度，自北顺时针，指 +Y 轴的朝向）旋转。
- 楼层内容相对楼板：z = 0 是该层地面；楼层组的 z = `elevation`（楼层展开时再加偏移）。
- `anchor.height` 是椭球高。省略时自动贴到地形上（地形足够精细后才贴，见 tile-loading.md §4.3）。贴地导致建筑抬升时，如果相机正飞向它或已经在它内部，会通过 `controller.translate` 同步平移，保持取景不变。
- glTF 默认 Y 轴朝上，加载时绕 X 轴转 +90°；Z 轴朝上的导出请写 `upAxis: 'Z'`。可选 `scale`、`offset`、`rotation`。
- 渲染时，建筑根节点的矩阵是锚点处 ENU 坐标系乘以 RotZ(−heading)，在 float64 的模型视图矩阵下没有抖动。

## 4. 文档格式（`three-geo-building` v1.0）

文件扩展名建议用 `*.building.json`（拖入页面即可加载）。字段如下（完整类型见 `schema.ts`）：

```jsonc
{
  "format": "three-geo-building",
  "version": "1.0",
  "id": "demo-office-a",            // 文档内唯一；建议使用 IFC GlobalId
  "name": "示例办公楼 · A 座",
  "category": "office",
  "ifcType": "IfcBuilding",
  "properties": { "建成年份": 2021 },
  "anchor": { "longitude": 116.3929, "latitude": 39.9994, "heading": 0 },   // 省略 height = 贴地
  "footprint": [[-30, -12], [30, -12], [30, 12], [-30, 12]],               // 本地米，逆时针
  "exterior": { "color": "#7fa6d6", "opacity": 0.55 },                      // 或 { "model": { "uri": "shell.glb" } }
  "label": { "title": "示例办公楼 · A 座", "subtitle": "5 层", "icon": "🏢", "style": "card" },
  "floors": [
    {
      "id": "F3", "name": "3F", "index": 2, "elevation": 8.4, "height": 4.2,
      "model": { "uri": "F3.glb" },                                          // 可选：整层 BIM 导出
      "rooms": [
        {
          "id": "F3-R10", "name": "303 办公室", "category": "office",
          "footprint": [[-10, -12], [0, -12], [0, -1.6], [-10, -1.6]],
          "doors": [{ "edge": 2, "at": 0.5, "width": 1.1 }],                 // 边从 0 起编号：edge 2 是北侧临走廊的边，在其中点开门
          "properties": { "用途": "办公" }
        }
      ],
      "things": [
        {
          "id": "F3-TH05", "name": "303 温湿度", "category": "sensor",
          "position": [-0.4, -6.8, 1.6], "size": [0.12, 0.08, 0.16],
          "properties": { "温度": "23.1 ℃", "湿度": "56 %", "状态": "正常" },
          "label": { "title": "23.1℃ · 56%", "icon": "🌡", "mode": "level", "style": "pin" }
        }
      ],
      "elements": [{ "id": "F3-W01", "kind": "wall", "path": [[0, 0], [5, 0]], "height": 3 }]
    }
  ]
}
```

校验（`parseBuildingDoc`）：缺字段、类型错误、id 重复、多边形少于 3 个点、层高非正等问题，都会抛出带 JSON 路径的错误（例如 `$.floors[0].rooms[0].footprint: expected at least 3 [x, y] points`）。楼层按 `index` 排序，默认值也在这里统一填充。

### 4.1 glTF 与实体的映射

- `floor.model` 里，节点的 `name` 或 `extras.id`（three 里是 `userData.id`）等于某个房间、设备或构件的 `id` 时，该节点子树会被挂到这个实体下（保持世界变换不变），并克隆材质，让样式修改只影响它自己。
- `thing.model` 整体属于该设备。`exterior.model` 是外壳。
- 从 IFC 转换的建议：用 IfcOpenShell 或 xeokit-convert 导出 glTF，节点名使用 GlobalId；空间结构和属性集导出为本格式的 floors / rooms / things 与 `properties`。

### 4.2 顶牌（label）

数据驱动，对应 ThingJS 用 userData 配置顶牌的做法：

| 字段 | 说明 |
| --- | --- |
| `title` / `subtitle` | 默认 title 为实体名；房间的 subtitle 默认为面积 |
| `mode` | `always`：实体可见就显示；`level`：父层级被进入时显示（默认，例如进入楼层后显示房间牌）；`hover`：悬停时显示；`click`：选中时显示 |
| `style` | `card`：气泡加引线（建筑和告警默认）；`pin`：圆点加文字（设备默认）；`tag`：紧凑标签（房间默认） |
| `color` / `icon` / `offset` | 强调色、前置图标、距实体顶部的额外高度（米） |

建筑和房间会自动生成顶牌，设备只有在文档里写了 `label` 才有。顶牌按优先级避让：卡片样式（建筑、告警）始终显示，其余按 选中 > 悬停 > 房间 > 设备 排序，同优先级近者优先。

## 5. 运行时 API

```ts
const b = viewer.indoor.add(doc, baseUrl);       // 解析、构建、贴地，并生成顶牌
await viewer.indoor.enter(b);                     // 进入建筑（相机飞行，可传 { fly: false, duration }）
await viewer.indoor.enter(viewer.indoor.getById('F3'));
viewer.indoor.back();                             // 房间 → 楼层 → 建筑 → 地球
viewer.indoor.query('.Room');                     // 选择器：.Type  #id  [category=camera]  [prop.状态=告警]  名称  正则  谓词
viewer.indoor.query('[category=camera]').forEach((c) => c.setStyle({ color: '#ff0000' }));
viewer.indoor.select(entity);                     // 高亮并弹出属性
viewer.indoor.expandFloors = true;                // 楼层展开（进入建筑时生效）
viewer.indoor.showLabels = false;
viewer.indoor.events.on('enterLevel', ({ object, previous }) => { /* ... */ });
viewer.flyToEntity(entity, { pitch: -40 });       // camera.fit
```

`BimEntity`：`id` `type` `name` `category` `properties` `label` `parent` `children` `group`，以及 `setStyle({ color, opacity, emissive })`、`visible`、`effectivelyVisible`、`worldBounds()`、`labelPosition()`、`closest(type)`、`traverse(cb)`、`isDescendantOf(e)`。

事件：`beforeEnterLevel` / `enterLevel` / `leaveLevel`（`{ object, previous, next }`）、`select`、`hover`、`buildings-changed`。离开事件从内到外依次触发（例如 `leave:303 → enter:3F`）。

## 6. 默认交互与可见性

| 操作 | 结果 |
| --- | --- |
| 双击建筑（地球层级） | 进入建筑：隐藏外壳，显示全部楼层（可展开），压制 3D Tiles，相机取四分之三视角 |
| 双击楼层 / 楼层按钮 | 进入楼层：只显示该层，显示房间顶牌，相机俯视约 58° |
| 双击房间 / 设备 | 进入并选中，相机拉近 |
| 单击 | 选中（建筑外部单击选中整栋），弹出属性面板 |
| 悬停 | 高亮（外部悬停高亮整栋） |
| 右键单击 / Esc / 面包屑 / ‹ 按钮 | 返回上一级（Esc 先关闭属性弹窗） |

顶牌盖在 canvas 上，单击和双击由顶牌自己处理，行为与点到实体本身一致；滚轮会转发给 canvas。

## 7. 扩展守则

- 新增实体类型：先扩展 `EntityType` 和 `schema.ts`，在 `Building` 中构建，再在 `IndoorManager` 的 `VIEWS`（相机取景）和 `nextLevel`（双击逻辑）中补上规则，最后同步本文与测试。
- 实时数据（如 IoT 状态）：更新 `entity.properties`，调用 `setStyle()` 改颜色；顶牌内容改变后调用 `marker.invalidateSize()`。
- 大规模设备（成千上万个）：当前每个设备一个网格和一份材质，适合几百到一两千个；更大规模应该改用 `InstancedMesh` 或 `BatchedMesh`，并通过 instanceId 映射到实体（路线图）。
- 不要在实体上直接改 `group.visible` 来实现层级效果，统一由 `IndoorManager.applyLevelState` 根据当前层级计算。

## 8. 路线图

- IFC 直读（web-ifc）及按楼层流式加载；楼层模型使用 3D Tiles 或 glTF LOD。
- 剖切面 / 剖切盒（ThingJS"剖切"）、室内导航（路网 + A*）、热力图和点位聚合。
- 设备实例化渲染（InstancedMesh）与实体映射；顶牌的遮挡判断（深度采样）。
