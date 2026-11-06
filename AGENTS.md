# AGENTS.md：Three Geo Global 开发规范

本文面向在本仓库工作的 AI 编码代理和开发者，改代码前请先读。涉及具体子系统时，再读 `docs/agents/` 下对应的专题文档：

| 专题 | 文档 |
| --- | --- |
| 相机控制器（手势、不变量、数学） | [docs/agents/camera-controller.md](docs/agents/camera-controller.md) |
| 瓦片加载（底图 / 地形 / 3D Tiles） | [docs/agents/tile-loading.md](docs/agents/tile-loading.md) |
| 室内与 BIM 模型定义、层级导航 | [docs/agents/indoor-bim.md](docs/agents/indoor-bim.md) |
| 顶牌样式与点位标注（数据格式、样式规则、聚合） | [docs/agents/markers.md](docs/agents/markers.md) |
| 可借鉴与复用路线图（分阶段落地计划，开始新功能前先看） | [docs/agents/roadmap.md](docs/agents/roadmap.md) |
| ThingJS 示例分析与能力对照 | [docs/agents/thingjs-reference.md](docs/agents/thingjs-reference.md) |
| ThingJS 运行时源码分析、可借鉴的实现与落地清单（改层级、拾取、事件、样式前先看） | [docs/agents/thingjs-runtime-analysis.md](docs/agents/thingjs-runtime-analysis.md) |

## 1. 项目速览

基于 three.js 的 WebGPU 优先三维地球：WGS84 椭球、四叉树影像与地形、物理大气、OGC 3D Tiles、GeoJSON 矢量与注记、HTML 顶牌、统一拾取事件，以及从地球无缝进入建筑、楼层、房间的室内 / BIM 浏览。

- 技术栈：three r186.1（`WebGPURenderer` + TSL）、3d-tiles-renderer 0.5.3、TypeScript 5.9（strict）、Vite 8、Vitest 5。依赖版本是锁定的，不要随意升级。
- 命令：

  ```bash
  npm run dev        # http://localhost:5173（开发服务器可能已经在跑，先查端口占用，不要杀用户的进程）
  npm run typecheck  # tsc --noEmit
  npm test           # vitest，纯数学与数据逻辑
  npm run build      # 类型检查 + 生产构建
  ```

- 常用 URL 参数：`?webgl` `?imagery=osm` `?noterrain` `?tileset=<url>` `?geojson=<url>` `?points=<url>`（点位标注）`?demo`（示例办公楼）`?building=<url>`，以及 `#lon,lat,height,heading,pitch`。
- 调试入口：浏览器控制台里的 `window.viewer` 就是 `GeoViewer` 实例。

## 2. 目录与职责

```
src/
├─ core/        椭球（Ellipsoid）、测地学（geodesy，Worker 可用、无 three 依赖）、EGM96、太阳位置、EventEmitter
├─ globe/       四叉树地球：Globe（调度）、GlobeTile（状态）、tileSelection（选择规则纯函数）、
│               tileMeshLayout（网格索引布局，Worker 与象限填充共用）、TileMaterial（TSL）、Worker 构网、影像源、地形源
│  └─ terrain/  地形源描述、quantized-mesh 解码、terrainTiling（主线程与 Worker 共用的分块 / 插值规则）
├─ atmosphere/  大气散射 TSL 节点、星空
├─ tiles3d/     3D Tiles 图层；nodeMaterials（节点材质转换 + WebGPU 渐显）
├─ vector/      GeoJSON 图层、矢量 Worker、注记（LabelManager）
├─ indoor/      BIM / 室内：schema（文档格式）、BimEntity（实体与选择器）、Building（构建与定位）、
│               IndoorManager（层级导航、拾取、顶牌）、demoBuilding（示例数据）
├─ markers/     MarkerManager（HTML 顶牌：投影、裁剪、避让）、cards（顶牌样式模板）、
│               points（点位解析 / 规则，纯函数）、clusterTree（层级聚合树，纯函数 + Worker）、
│               PointLayer（点位图层）、demoPoints（示例）
├─ viewer/      GeoViewer（总装、拾取、帧循环）、GlobeCameraController、cameraMath、CameraFlight、
│               InteractionManager（click / dblclick / rightclick / hover + 选择器 + 标签）
└─ ui/          面板（ControlPanel / IndoorPanel / VectorPanel / PointPanel / OverlayPanel）、状态栏、属性弹窗、层级条
tests/          vitest：geo / camera / terrain / tileSelection / tileMeshLayout / requestScheduler / vector / points / clusterTree / indoor
docs/agents/    子系统规范（本文档的展开）
```

## 3. 全局约定（必须遵守）

### 3.1 坐标与单位

- 世界坐标就是 ECEF，单位米，+Z 指向北极。内部角度一律用弧度；对外 API（`ViewPosition`、`TargetView`、BIM 文档、UI 显示）用度，字段名或注释必须写明单位。
- 高度一律指 WGS84 椭球高。海拔类地形在 Worker 里用 EGM96 改正，quantized-mesh 和 3D Tiles 本身就是椭球高。
- 局部坐标系：`Ellipsoid.eastNorthUp` / `eastNorthUpToFixedFrame` 给出 ENU。建筑本地坐标为 X 东、Y 北、Z 上，再按 `heading`（自北顺时针，度）绕 Z 轴旋转。glTF 规定 Y 轴朝上，加载时要转成 Z 轴朝上。
- `Ellipsoid.geodeticSurfaceNormal` 只适用于椭球面上的点。离地点（相机、高空锚点）必须用 `geodeticNormal`；`eastNorthUp` 内部已经这样处理。

### 3.2 精度

- `renderer.highPrecision = true` 不能关：模型视图矩阵在 CPU 上以 float64 计算。
- 每个网格自带原点（RTC，`mesh.position` = 瓦片中心或建筑锚点）。不要把 ECEF 绝对坐标写进 float32 顶点。屏幕空间标签用高低位拆分（RTE），见 `LabelManager.splitDouble`。

### 3.3 渲染（WebGPU 优先）

- 着色器只用 TSL 写，同一份代码编译成 WGSL 和 GLSL。禁止用 `onBeforeCompile` 或 GLSL 字符串注入，它们在 WebGPU 下静默失效（3D Tiles 官方渐显插件就是这个原因不工作）。
- 共享节点实例才能共享管线：同类材质指向同一个节点图，逐对象参数用 `materialReference('prop', type)` 读材质属性（参见 `TileMaterial`、`fadeMaskNode`）。
- 纹理采样放在统一控制流里，不要写在依赖逐片元数据的分支中。
- 需要 `discard` 的效果只在需要时挂上（例如 `maskNode` 仅在渐变期间存在），稳态保留 early-Z。

### 3.4 相机

- 相机永远零 roll（地平线保持水平）。
- 航向 / 俯仰只能通过 `cameraMath.getHeadingPitch` 计算。禁止用"视线的水平分量"求航向：俯视时这个分量趋近于零，航向会跳变 180°，画面上下翻转。
- 手势必须满足 [camera-controller.md](docs/agents/camera-controller.md) 中的不变量：缩放保持航向和俯仰、光标处的点不漂移、环绕不越过枢轴头顶、只依据可靠地形防入地。

### 3.5 数据加载

- 地球瓦片的几何、影像、叠加层是三个独立通道，各有优先级桶和并发上限；新数据源要接入这套机制，不要自己 `fetch` 后同步上传。规则见 [tile-loading.md](docs/agents/tile-loading.md)。
- 完成的加载进入上传队列，按每帧预算应用；在应用之前它一直占着并发槽位（形成背压）。
- 3D Tiles 的材质替换必须在插件的 `processTileModel` 钩子里做：库在这个钩子之后才登记要释放的材质，晚于它替换会泄漏显存。

### 3.6 Worker

- 解码、构网、栅格化都放在 Worker 里。Worker 代码不能 import three（会拖进几百 KB），只能用 `core/geodesy`、`globe/terrain/*` 这类无依赖模块。
- 大缓冲区用 transferable 传递。主线程和 Worker 共用的规则（例如地形用哪一级数据）只写一份，放在无依赖模块中。

### 3.7 交互与事件

- 点击、双击、右键单击、悬停一律走 `viewer.interaction`（`on(type, handler, { selector, tag })`）。不要在 canvas 上自己注册 pointer 监听来判断点击。
- 默认行为可以被 `event.preventDefault()` 阻止，例如双击进入层级时取消相机的"双击飞近"。
- HTML 顶牌盖在 canvas 上方，会截获事件。可交互顶牌必须提供 `onClick` / `onDoubleClick`；滚轮已由 `MarkerManager` 转发给 canvas。

### 3.8 代码风格

- TypeScript strict，开启 `noUnused*`。`any` 只允许出现在第三方库边界，并且要加 `eslint-disable-next-line` 注释。
- 每个模块文件开头写清职责。导出的 API 写 JSDoc；注释解释"为什么"，不复述代码。
- 公共 API 的单位、坐标系、取值范围必须写在类型或注释里。
- UI 文案用中文；DOM 用 `ui/dom.ts` 的 `h()`；样式复用 `style.css` 里的 CSS 变量。

### 3.9 数据与合规

- 访问凭证（天地图、ion、Google、Mapbox）只保存在本机 localStorage，不能写进仓库。
- 示例国界数据不是审定地图，在国内发布必须使用有审图号的数据。

## 4. 子系统要点

- **地球 Globe**：屏幕空间误差驱动的四叉树。
  - 瓦片有网格即可渲染；影像不足时用祖先影像放大顶替，新影像到达后交叉淡入。
  - 子瓦片可以先用精确祖先的高度插值出临时网格，最多跨 3 级。地形取数比网格层级低 3 级（一张 256 px 地形图服务 8×8 个网格瓦片，不损失精度）。
  - 选择规则借鉴 CesiumJS：每块瓦片记住上一帧的选择结果。缩小时，父瓦片要等自身影像和地形不比子孙差才替换它们（不丢细节守卫）。新进入视野、还没有网格的子瓦片，由父瓦片的对应象限暂时顶替（象限填充）。
  - 规则写在 `tileSelection.ts`，详见 tile-loading.md §2。
- **3D Tiles**：`NodeMaterialPlugin` 把材质转为节点材质；`TilesFadePlugin` 的材质管理器换成 `NodeFadeMaterialManager`（TSL dither 遮罩）；隐藏瓦片在 192 MB 显存预算内保留，3 s 后才释放。
- **相机**：左键抓地平移；右键横向调航向、纵向调俯仰（默认绕屏幕中心点）；滚轮缩放到光标并保持航向和俯仰；另有环绕巡航、俯仰范围、各类开关、双击钩子。
- **室内 / BIM**：层级为 地球 → 建筑 → 楼层 → 房间 / 设备。双击进入，右键单击或 Esc 返回，单击选中，悬停高亮。进出层级会触发 `beforeEnterLevel` / `enterLevel` / `leaveLevel` 事件。格式定义见 [indoor-bim.md](docs/agents/indoor-bim.md)。
- **顶牌 Marker**：HTML 元素锚定在世界坐标上，每帧用 float64 投影；做地平线、距离、视口裁剪，并按优先级避让；支持数据驱动的显示模式（always / level / hover / click）。
- **点位 PointLayer**：`viewer.addPoints({ data | url, style, rules, cluster })`。
  - 数据可以是 GeoJSON 点、点记录数组或点位文档；样式由图层默认值、属性规则、点自带 style 依次合并。
  - 无高度的点自动贴地。
  - 聚合用加载时建一次的层级聚合树（借鉴 Supercluster），每帧按节点距离选层；顶牌按需创建 DOM，避让走网格索引并定时放置。见 markers.md §5。
  - 共 8 种样式（card / pin / tag / poi / pulse / beacon / badge / label），见 markers.md。
- **矢量**：GeoJSON 在 Worker 中解析和栅格化，按瓦片贴地；注记做屏幕空间避让。

## 5. 常见任务

| 任务 | 做法 |
| --- | --- |
| 新增影像源 | 实现 `ImageryProvider`（`requestImage` 返回 `ImageBitmap`，404 返回 null），在 `imagery/presets.ts` 注册。只支持 HTTP/1.1 的服务要声明 `maxRequestsPerHost: 6`。不要绕开 Globe 的通道。 |
| 新增栅格地形源 | 在 `TerrainSource.ts` 描述，写明 `tileSize`（决定取数层级偏移）和 `heightReference`。 |
| 新增 BIM 字段 | 先改 `indoor/schema.ts` 的类型和 `parseBuildingDoc` 校验，再改 `Building` 构建，最后同步 [indoor-bim.md](docs/agents/indoor-bim.md) 并补 `tests/indoor.test.ts`。 |
| 新增交互行为 | 用 `viewer.interaction.on(...)` 并带上 `tag`，方便整体注销；需要阻止默认行为时调用 `preventDefault()`。 |
| 新增顶牌样式 | 在 `markers/points.ts` 的 `MarkerStyleName` 加名字，在 `markers/cards.ts` 加 `style` 分支，在 `style.css` 写 `.tg-<style>`。锚点约定为元素底部中点（pivot `[0.5, 1]`）；以符号中心为锚点的样式用负下外边距让元素止于符号中心。同步 markers.md 的样式表和 `PointPanel` 的中文名。 |
| 加载点位数据 | `viewer.addPoints(...)`、面板"点位标注"、`?points=<url>`，或拖入 `*.points.json`；规则写法见 markers.md §4。大批量（上万）或高频刷新的数值不要用 DOM 顶牌，走路线图 M3.6 / M4.6。 |
| 调加载性能 | 先看状态栏和 `viewer.globe.stats`，再按 [tile-loading.md](docs/agents/tile-loading.md) 的调参表调整；不要改坏桶的优先顺序。 |

## 6. 提交前验证

1. 运行 `npm run typecheck`、`npm test`、`npm run build`，全部通过。
2. 涉及数学、调度规则或数据格式的改动，必须在 `tests/` 里补单测（相机不变量、地形分块、BIM 解析与层级都已有测试，可以照着写）。
3. 浏览器手测（可以用 `window.viewer` 编程驱动）：
   - 全球俯视状态下，光标分别放在北、南、东、西，滚轮放大，航向保持 0°、俯仰保持 -90°，画面不翻转。
   - 右键横向拖动只改航向，纵向拖动只改俯仰；拖到极限时停在 -90° 或俯仰上限，不翻转。
   - 加载过程中没有空洞、台阶或拉长的裙边，相机不会被顶高。
   - 用 `?demo` 依次进入建筑 → 楼层 → 房间，再用右键 / Esc 逐级返回；事件顺序正确，顶牌不重叠。
   - 3D Tiles 加载后控制台没有着色器报错。
4. 自动化浏览器（扩展驱动的 Chrome）里，窗口被遮挡时 rAF 可能只有约 1 帧/秒。不要据此判断性能：看每帧 CPU 耗时（`viewer.stats.frameMs`）和逐帧的状态变化。

## 7. 已知陷阱（踩过的坑）

- **俯视翻转**：俯视时视线水平分量接近 0，用它求航向就会跳 180°。航向公式是 `H = f_h·cos p − up_h·sin p`，详见相机文档。
- **高空法线偏差**：`geodeticSurfaceNormal(p)` 用在离地点上，在 17,000 km 高度会偏 0.42°；改用 `geodeticNormal`。
- **地形空洞**：临时网格如果从另一个临时网格插值，误差会一层层传下去；子瓦片又按错误的高度做裁剪，就会被误剔除。规则是只从精确祖先插值、最多跨 3 级，子瓦片的包围体用精确祖先的高度范围。
- **相机被顶高**：粗分辨率或插值地形可能比真实地面高出数百米。防入地只采用网格间距不超过 `max(50 m, 离地高度 × 1.5)` 的地形。
- **3D Tiles 显存泄漏**：在 `load-model` 事件里替换材质，库释放的仍是旧材质；必须在 `processTileModel` 里替换。
- **HTML 顶牌吞事件**：双击落在顶牌上时 canvas 收不到；顶牌要自己处理单击和双击，滚轮要转发。
- **建筑贴地后取景偏移**：页面刚打开就进入建筑时，飞行目标还是建筑贴地前的位置。贴地平移必须同步给相机（`followMove` 调用 `controller.translate`）。
- **告警被避让隐藏**：重要信息（卡片样式）不能参与避让，只作为障碍物。
- **顶牌数量一多就掉帧**：3000 个点时，每帧的 O(n²) 避让、每帧重算屏幕空间聚合、给所有顶牌写 transform 和随距离变化的 z-index、每个标签上的 `backdrop-filter`（每帧都要重新模糊下方的 WebGPU 画面），叠加起来会让帧率明显下降。现在的规则：
  - 避让走 `CollisionGrid`，并定时放置。
  - 聚合走聚合树。
  - 样式只写变化值。
  - 大批量显示时进入 `dense` 模式，去掉滤镜。
  - 新增顶牌样式不要给大批量元素加 `backdrop-filter`、`filter` 或常驻动画（markers.md §5）。
- **three 射线检测不看 `visible`**：拾取后要自行过滤不可见的对象（见 `IndoorManager.pick`）。
- **缩放闪烁：淡入从过期画面开始**：渲染循环先置了 `visible` 和 `lastRenderedFrame` 再判断"上一帧是否在屏幕上"，结果对新上屏的瓦片永远成立，瓦片会从很久以前显示过的粗影像开始淡入。判断"上一帧是否在屏幕上"必须在更新这两个字段之前做（`showNewTile`）。
- **缩放闪烁：缩小时先模糊再变清晰**：父瓦片的影像还没加载就替换了清晰的子瓦片。必须走不丢细节守卫（`losesDetail`），不要绕过 `TileSelection` 直接按 SSE 决定。
- **缩放闪烁：父子来回切换**：子瓦片刚进入视野时还没有网格，父瓦片被迫退回，下一帧又细化。现在靠视野外兄弟瓦片预建网格、本地构网的独立并发额度，以及象限填充来避免。
- **取消请求不等于释放**：只打取消标记时，槽位和 HTTP 连接要等网络返回才释放；地形服务多为 HTTP/1.1，每个域名约 6 个连接，过期请求会把细化卡住几秒。取消必须立即归还槽位，并中止没人等待的下载。
- **地形跳动**：临时网格（祖先数据插值）和精确网格在山区可以相差数百米，层级切换时直接换网格，倾斜视角下画面会错动。换网格和父子替换都要走地形渐变（`startMorph`，tile-loading.md §2），不要直接把 `material.morph` 置 1 了事。
- **TSL 纹理槽被合并**：three 按哈希合并 uniform，纹理节点的哈希是编译时所持纹理的 uuid。两个 `materialReference(..., 'texture')` 在编译时指向同一张纹理，就会共用一个绑定，之后各自赋不同纹理也没用。瓦片的交叉淡入因此一直在混合"旧画面 + 缩小的旧画面"（重影、错位副本），这是加载闪烁的根因。需要同时采样多张纹理时用 `TileMaterial.textureReference` 这种固定独立哈希的写法。
- **影像逐格闪烁**：每块瓦片影像一到就各自淡入，祖先影像逐级到达时还会连续淡入好几次，画面像棋盘一样闪。屏幕上的瓦片换影像要走 `updateShownImagery`（合并中间层级、兄弟成组揭示，tile-loading.md §2），不要在影像到达时直接 `resolveImagery(tile, true)`。
- **HTTP/1.1 影像源排队失控**：浏览器每个域名只开约 6 个连接，多派发的请求在浏览器里先来先服务，优先级失效，屏幕中心要等十几秒才清晰。HTTP/1.1 的源（如 `server.arcgisonline.com`）必须在预设里声明 `maxRequestsPerHost`，见 tile-loading.md §3.1。
- **Windows 环境**：`python` 可能只是应用商店的占位程序，脚本请用 Node；Bash 中使用 POSIX 路径。
