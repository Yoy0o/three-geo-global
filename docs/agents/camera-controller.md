# 相机控制器规范

代码：`src/viewer/GlobeCameraController.ts`（事件与状态）、`src/viewer/cameraMath.ts`（纯数学，可单测）、`src/viewer/CameraFlight.ts`（大圆弧飞行）。测试：`tests/camera.test.ts`。

## 1. 操作映射

| 输入 | 行为 | 说明 |
| --- | --- | --- |
| 左键拖拽 | 平移（抓住地面转动地球） | 光标下的点始终跟手，松手有惯性；`enablePan` |
| 滚轮 / 双指捏合 | 向光标处缩放 | 保持航向与俯仰，光标处的点不漂移；`enableZoom` |
| 右键 / 中键 / Ctrl·Shift + 左键拖拽 | 横向调航向，纵向调俯仰 | 默认绕屏幕中心的地面点（`orbitPivot = 'center'`，可改为 `'cursor'`）；向上拖朝地平线倾斜（Mapbox 习惯）；`enableRotate` / `enableTilt` |
| 右键拖拽时光标落在天空 | 原地环视 | 没有可用枢轴时退化为第一人称转头 |
| 双指旋转 / 双指上下移动 | 航向 / 俯仰 | 与右键拖拽一致 |
| 双击 | 先交给 `doubleClickHandler`，未处理则飞近该点 | 室内层级用这个钩子拦截双击 |
| 右键单击（不拖动） | 室内返回上一级 | 由 `InteractionManager` 的 `rightclick` 事件实现，不在控制器里 |
| W A S D / 方向键 | 沿地表移动 | 速度与离地高度成正比 |
| Q / E、R / F | 转航向、调俯仰 | |

用户说的"右键直接控制 pitch 和 roll"，按航向（水平旋转）加俯仰实现。真正的 roll（地平线倾斜）在地图浏览中会让人迷失方向，所以不开放。

## 2. 不变量（任何改动都必须保持）

1. **零 roll**：每次姿态变化后都会重建为零滚转姿态（`levelOrientation` / `orientationFromHeadingPitch`）。
2. **航向连续**：航向只能由 `getHeadingPitch` 计算，俯视和仰视时也不跳变。
3. **缩放不改航向和俯仰**：俯视的画面放大后仍是俯视，倾斜视角保持原有倾角，光标处的点保持在光标下（误差小于 0.002 NDC）。
4. **环绕不越过头顶**：绕枢轴调俯仰时，仰角限制在 `[0.5°, 89.99°]` 与 `pitchRangeDeg` 的交集内；只在运动方向上夹紧，起始点在范围外时不会被强行拉回。
5. **防入地只依据可靠地形**：`ControllerHost.groundHeight` 返回 null 表示未知或太粗，此时不把相机往上推（见 tile-loading.md §5）。
6. **任意用户输入都会打断动画**（飞行、环绕、惯性），并发出 `interactionstart` 事件。

## 3. 关键数学

### 3.1 鲁棒的航向 / 俯仰

设 f 为视线方向，u_c 为相机 up 向量，ENU 基为 (e, n, u)，`sp = f·u`，`cp = √(1−sp²)`：

```
pitch   = asin(sp)
H       = f_h·cp − u_c,h·sp          (_h 表示投到 e、n 平面)
heading = atan2(H·e, H·n)
```

对零 roll 相机有 `f = cp·H + sp·u`、`u_c = cp·u − sp·H`，代入可得上式恰好等于航向向量 H。俯视时（sp = −1）H 等于 u_c 的水平分量，所以航向始终有定义。旧实现只用 f_h：俯视时 f_h 接近 0，相机越过天底一点点，航向就会跳 180°，画面上下翻转。这就是"全球视角滚轮放大上下反转"的根因，左键拖动地球时也会触发。

### 3.2 `zoomTowards`：保持姿态的光标缩放

1. 记下当前的航向和俯仰。
2. 沿相机到目标的连线移动：`C' = T + (C − T)·e^(−amount)`。
3. 在新位置按原航向和俯仰重建姿态。如果直接沿射线移动、姿态保持不变，相机越过曲面后当地竖直方向会转动，于是相机被"带歪"。
4. `reanchor`：找出光标射线与过 T 的球面的交点 P，绕地心把相机从 P 转到 T，使 T 回到光标下。
5. 再按原航向和俯仰重建一次（椭球不是正球，转动会引入约 0.02° 的俯仰漂移，多次缩放会累积）。

光标落在天空时不做 4、5 步（`anchored: false`），只沿视线前后移动。

### 3.3 `orbitAround`：绕点调航向和俯仰

- 航向：绕枢轴的当地竖直轴转 −Δh（绕竖直轴转 +a，相机航向变化 −a）。
- 俯仰：绕"相机右向量投到水平面"的轴转动。仰角在垂直于该轴的平面内测量：`tilt = atan2(o·up, −o·forward)`，其中 `forward = up × right`。目标仰角只在运动方向上夹紧。
- 任何绕"过枢轴的轴"的刚体转动，都保持枢轴在屏幕上的位置不变。
- 远距离（全球视角）时，相机自身的俯仰并不等于它相对枢轴的仰角，因为相机绕地球走了一段。这是几何事实，不是 bug（测试里有说明）。

### 3.4 高空的竖直方向

`eastNorthUp` 使用 `Ellipsoid.geodeticNormal`（先投影到椭球面再取法线）。原先的 `geodeticSurfaceNormal(p)` 用在高空点上会有偏差（17,000 km 高度约 0.42°），导致"俯视"并不真正对准星下点。

## 4. 对外 API

控制器属性：

| 属性 | 默认 | 作用（对应 ThingJS） |
| --- | --- | --- |
| `enabled` | true | 总开关（`camera.enable`） |
| `enablePan` / `enableRotate` / `enableTilt` / `enableZoom` / `enableKeyboard` | true | 各手势开关（`enablePan` / `enableRotate` / `enableZoom`） |
| `pitchRangeDeg` | `[-90, -2]` | 环绕和倾斜手势的俯仰范围（`vertAngleLimit`，这里用相机俯仰表示） |
| `minimumAltitude` / `maximumDistance` | 1.5 m / 6e7 m | 离地高度下限、到地心距离上限（`distanceLimited`） |
| `orbitPivot` | `'center'` | 右键环绕中心：屏幕中心点或光标处 |
| `inertia` / `zoomSpeed` / `rotateSpeed` | | 手感参数 |
| `doubleClickHandler` | null | 返回 true 时吞掉默认的"双击飞近" |
| `events` | | `interactionstart`、`change` |

方法：`setView`、`flyTo`、`rotateHeadingAround`（指北针复位用）、`startAutoOrbit({ pivot?, degreesPerSecond?, totalDegrees? })`（`rotateAround.start` / `earthFlyRotateBySpeed`）、`stopAutoOrbit`、`cancelFlight`、`translate(delta)`（平移相机；飞行中则平移飞行终点，按飞行进度混入。被观察的对象移动时用它保持取景，例如建筑贴地）。

GeoViewer 层面：`flyTo(ViewPosition)`、`flyToTarget({ target, heading, pitch, range })`（对应 `flyTo({ target, horzAngle, vertAngle })`）、`flyToSphere(sphere, heading, pitch, duration, { rangeScale, minRange })`、`flyToEntity(entity)`（对应 `camera.fit(obj)`）、`startAutoOrbit` / `stopAutoOrbit`、`resetNorth`。

## 5. 测试要求

`tests/camera.test.ts` 覆盖了：航向 / 俯仰往返（含 ±90°）、越过天底时航向保持、全球俯视向四个方向缩放不翻转且光标锚定、倾斜视角缩放保持姿态、对称缩小、环绕的航向 / 俯仰直接映射、环绕不越顶、全球视角环绕、跨纬度拖动保持朝北。

新增手势或修改数学时，必须在这里补对应的断言。断言针对不变量（航向、俯仰、光标锚定），不要针对实现细节。
