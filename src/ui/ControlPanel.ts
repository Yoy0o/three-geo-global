import { Vector3 } from 'three';
import { DEG2RAD } from '../core/math';
import { IMAGERY_PRESETS, findImageryPreset } from '../globe/imagery/presets';
import { XYZImageryProvider, type ImageryProvider } from '../globe/imagery/ImageryProvider';
import { tileDebugUniforms } from '../globe/TileMaterial';
import {
  AWS_TERRARIUM,
  cesiumIonTerrain,
  mapboxTerrain,
  maptilerTerrain,
  quantizedMeshFromLayerJson,
  type TerrainSource,
} from '../globe/terrain/TerrainSource';
import type { Tiles3DLayer, TilesetSource } from '../tiles3d/Tiles3DLayer';
import { lookAtHeadingPitchRange } from '../viewer/cameraMath';
import type { GeoViewer } from '../viewer/GeoViewer';
import { h, section, slider, toggle } from './dom';
import { IndoorPanel } from './IndoorPanel';
import { BOOKMARKS, TILESET_PRESETS, type Bookmark } from './presets';
import { OverlayPanel } from './OverlayPanel';
import { PointPanel } from './PointPanel';
import { saveSettings, type Settings, type TerrainChoice } from './settings';
import { VectorPanel } from './VectorPanel';

/** Builds an imagery provider from saved settings (shared with startup). */
export function createImagery(settings: Settings): ImageryProvider {
  if (settings.imagery === 'custom' && settings.customImageryUrl) {
    return new XYZImageryProvider({ id: 'custom', name: '自定义', url: settings.customImageryUrl, subdomains: ['a', 'b', 'c'], maxZoom: 20 });
  }
  const preset = findImageryPreset(settings.imagery) ?? IMAGERY_PRESETS[0];
  if (preset.requiresKey === 'tianditu' && !settings.tiandituKey) return IMAGERY_PRESETS[0].create();
  return preset.create(settings.tiandituKey);
}

/** Resolves the saved terrain choice (some sources need network calls, e.g. Cesium ion). */
export async function createTerrain(s: Settings): Promise<TerrainSource | null> {
  switch (s.terrainSource) {
    case 'none':
      return null;
    case 'aws':
      return AWS_TERRARIUM;
    case 'mapbox':
      if (!s.mapboxToken) throw new Error('请填写 Mapbox access token');
      return mapboxTerrain(s.mapboxToken);
    case 'maptiler':
      if (!s.maptilerKey) throw new Error('请填写 MapTiler key');
      return maptilerTerrain(s.maptilerKey);
    case 'cesium':
      if (!s.ionToken) throw new Error('请填写 Cesium ion token');
      return cesiumIonTerrain(s.ionToken, 1);
    case 'qm-url':
      if (!s.quantizedMeshUrl) throw new Error('请填写 quantized-mesh 地址');
      return quantizedMeshFromLayerJson(s.quantizedMeshUrl, { name: '自定义 quantized-mesh' });
  }
}

const TERRAIN_CHOICES: { id: TerrainChoice; name: string }[] = [
  { id: 'none', name: '无地形（椭球面）' },
  { id: 'aws', name: 'AWS Terrain Tiles（免 key）' },
  { id: 'mapbox', name: 'Mapbox Terrain-RGB（需 token）' },
  { id: 'maptiler', name: 'MapTiler Terrain（需 key）' },
  { id: 'cesium', name: 'Cesium World Terrain（需 ion token）' },
  { id: 'qm-url', name: '自定义 quantized-mesh（layer.json）' },
];

export class ControlPanel {
  readonly root: HTMLElement;
  readonly vectorPanel: VectorPanel;
  readonly pointPanel: PointPanel;
  readonly indoorPanel: IndoorPanel;
  private readonly layerList = h('div', { class: 'layer-list' });
  private readonly message = h('div', { class: 'panel-message', role: 'status' });

  constructor(
    private readonly viewer: GeoViewer,
    private readonly settings: Settings,
  ) {
    const collapse = h('button', { class: 'panel-toggle', title: '收起 / 展开面板', 'aria-label': '收起或展开面板' }, '☰');
    this.vectorPanel = new VectorPanel(viewer, (text, kind) => this.notify(text, kind));
    this.pointPanel = new PointPanel(viewer, (text, kind) => this.notify(text, kind));
    this.indoorPanel = new IndoorPanel(viewer, (text, kind) => this.notify(text, kind));
    const body = h(
      'div',
      { class: 'panel-body' },
      this.basemapSection(),
      this.terrainSection(),
      this.vectorPanel.root,
      this.pointPanel.root,
      this.indoorPanel.root,
      this.sceneSection(),
      this.tilesSection(),
      this.cameraSection(),
      this.bookmarkSection(),
      this.debugSection(),
    );
    this.root = h('aside', { class: 'panel' }, h('header', { class: 'panel-header' }, h('span', {}, '图层与场景'), collapse), this.message, body);
    collapse.addEventListener('click', () => this.root.classList.toggle('collapsed'));
    if (window.matchMedia('(max-width: 640px)').matches) this.root.classList.add('collapsed');
    viewer.events.on('tilesets-changed', () => this.renderLayers());
    const onImageryError = (msg: string) => this.notify(`${msg}，可在“底图影像”里切换其他服务。`, 'error');
    viewer.globe.onImageryError = onImageryError;
    if (viewer.globe.imageryErrorMessage) onImageryError(viewer.globe.imageryErrorMessage);
  }

  private save(): void {
    saveSettings(this.settings);
  }

  private notify(text: string, kind: 'info' | 'error' = 'info'): void {
    this.message.textContent = text;
    this.message.className = `panel-message visible ${kind}`;
    window.clearTimeout((this.message as unknown as { timer?: number }).timer);
    const ms = kind === 'error' ? 15000 : 6000;
    (this.message as unknown as { timer?: number }).timer = window.setTimeout(() => this.message.classList.remove('visible'), ms);
  }

  // ---------------------------------------------------------------------------

  private basemapSection(): HTMLElement {
    const s = this.settings;
    const select = h('select', { 'aria-label': '底图' });
    for (const p of IMAGERY_PRESETS) select.append(h('option', { value: p.id }, p.name));
    select.append(h('option', { value: 'custom' }, '自定义 XYZ URL'));
    select.value = s.imagery;

    const keyInput = h('input', { type: 'password', placeholder: '天地图 tk（浏览器端 key）', value: s.tiandituKey, autocomplete: 'off' });
    keyInput.addEventListener('change', () => {
      s.tiandituKey = keyInput.value.trim();
      this.save();
    });
    const urlInput = h('input', { type: 'url', placeholder: 'https://{s}.example.com/{z}/{x}/{y}.png', value: s.customImageryUrl });
    const urlRow = h('div', { class: 'row' }, urlInput);
    const apply = h('button', { class: 'btn' }, '应用');
    const keys = h('details', { class: 'keys' }, h('summary', {}, '访问凭证：天地图 key（仅存本机）'), keyInput);
    const extra = h('div', { class: 'stack' }, urlRow, apply);

    const refresh = () => {
      urlRow.hidden = select.value !== 'custom';
      apply.hidden = urlRow.hidden && select.value !== 'tianditu-img';
      if (select.value === 'tianditu-img') keys.open = true;
    };
    const commit = () => {
      s.imagery = select.value;
      s.tiandituKey = keyInput.value.trim();
      s.customImageryUrl = urlInput.value.trim();
      if (s.imagery === 'tianditu-img' && !s.tiandituKey) return this.notify('请先填写天地图 key', 'error');
      if (s.imagery === 'custom' && !s.customImageryUrl) return this.notify('请先填写 XYZ 模板 URL', 'error');
      this.save();
      this.viewer.globe.setImagery(createImagery(s));
    };
    select.addEventListener('change', () => {
      refresh();
      if (apply.hidden) commit();
    });
    apply.addEventListener('click', commit);
    refresh();
    const overlays = new OverlayPanel(this.viewer, s, () => this.save(), (t, k) => this.notify(t, k));
    return section('底图影像', select, extra, keys, overlays.root);
  }

  private terrainSection(): HTMLElement {
    const s = this.settings;
    const select = h('select', { 'aria-label': '地形源' }, ...TERRAIN_CHOICES.map((c) => h('option', { value: c.id }, c.name)));
    select.value = s.terrainSource;
    const token = h('input', { type: 'password', autocomplete: 'off' });
    const url = h('input', { type: 'url', placeholder: 'https://…/layer.json（或其所在目录）', value: s.quantizedMeshUrl });
    const tokenRow = h('div', { class: 'row' }, token);
    const urlRow = h('div', { class: 'row' }, url);
    const apply = h('button', { class: 'btn' }, '应用');
    const hint = h('p', { class: 'hint' });

    const refresh = () => {
      const c = select.value as TerrainChoice;
      tokenRow.hidden = !['mapbox', 'maptiler', 'cesium'].includes(c);
      urlRow.hidden = c !== 'qm-url';
      apply.hidden = tokenRow.hidden && urlRow.hidden;
      token.placeholder = c === 'mapbox' ? 'Mapbox access token' : c === 'maptiler' ? 'MapTiler key' : 'Cesium ion access token';
      token.value = c === 'mapbox' ? s.mapboxToken : c === 'maptiler' ? s.maptilerKey : c === 'cesium' ? s.ionToken : '';
      hint.textContent =
        c === 'cesium' || c === 'qm-url'
          ? 'quantized-mesh 地形为椭球高，按地理瓦片在 Worker 中重采样到墨卡托网格。'
          : c === 'none'
            ? '关闭地形时地表为 WGS84 椭球面。'
            : '海拔经 EGM96 大地水准面改正为椭球高，可与 3D Tiles 对齐；海面按平均海平面处理。';
    };
    const commit = () => {
      const c = select.value as TerrainChoice;
      if (c === 'mapbox') s.mapboxToken = token.value.trim();
      if (c === 'maptiler') s.maptilerKey = token.value.trim();
      if (c === 'cesium') s.ionToken = token.value.trim();
      if (c === 'qm-url') s.quantizedMeshUrl = url.value.trim();
      s.terrainSource = c;
      s.terrain = c !== 'none';
      this.save();
      void this.applyTerrain();
    };
    select.addEventListener('change', () => {
      refresh();
      if (apply.hidden) commit();
    });
    apply.addEventListener('click', commit);
    refresh();

    const exag = slider('高程夸张', { min: 1, max: 5, step: 0.5, value: s.exaggeration, format: (v) => `${v.toFixed(1)}×` }, (v) => {
      s.exaggeration = v;
      this.save();
      const current = this.viewer.globe.terrainSource;
      if (current) this.viewer.globe.setTerrain(current, v);
    });
    return section('地形', select, tokenRow, urlRow, apply, exag.root, hint);
  }

  /** Applies the saved terrain choice, reporting errors in the panel. */
  async applyTerrain(): Promise<void> {
    try {
      const source = await createTerrain(this.settings);
      this.viewer.globe.setTerrain(source, this.settings.exaggeration);
      if (source && source !== AWS_TERRARIUM) this.notify(`地形：${source.name}`);
    } catch (err) {
      this.notify(`地形加载失败：${(err as Error).message}`, 'error');
    }
  }

  private sceneSection(): HTMLElement {
    const s = this.settings;
    const v = this.viewer;
    const hours = (d: Date) => d.getHours() + d.getMinutes() / 60;
    const time = slider('本地时间', { min: 0, max: 24, step: 0.25, value: hours(v.date), format: formatHour }, (val) => {
      const d = new Date(v.date);
      d.setHours(Math.floor(val), Math.round((val % 1) * 60), 0, 0);
      v.date = d;
    });
    const play = toggle('时间流逝（1 小时/秒）', false, (on) => {
      v.timeMultiplier = on ? 3600 : 0;
    });
    const now = h('button', { class: 'btn ghost' }, '现在');
    now.addEventListener('click', () => {
      v.date = new Date();
      time.setValue(hours(v.date));
    });
    v.events.on('frame', () => {
      if (v.timeMultiplier !== 0) time.setValue(hours(v.date));
    });

    return section(
      '场景',
      toggle('大气散射', s.atmosphere, (on) => {
        s.atmosphere = on;
        v.atmosphere = on;
        this.save();
      }),
      toggle('太阳光照 / 昼夜', s.lighting, (on) => {
        s.lighting = on;
        v.lighting = on;
        this.save();
      }),
      toggle('星空', s.stars, (on) => {
        s.stars = on;
        v.showStars = on;
        this.save();
      }),
      time.root,
      h('div', { class: 'row' }, play, now),
    );
  }

  private tilesSection(): HTMLElement {
    const s = this.settings;
    const presetButtons = TILESET_PRESETS.map((p) => {
      const b = h('button', { class: 'chip', title: p.note ?? '' }, p.name);
      b.addEventListener('click', () => {
        if (p.kind === 'url' && p.url) this.loadTileset({ type: 'url', url: p.url }, p.name, { clampToTerrain: p.ellipsoidAligned });
        else if (p.kind === 'google') {
          if (!s.googleKey) return this.notify('请在下方填写 Google Map Tiles API Key', 'error');
          this.loadTileset({ type: 'google', apiKey: s.googleKey }, p.name, { hideGlobe: true });
        } else if (p.kind === 'ion' && p.assetId) {
          if (!s.ionToken) return this.notify('请在下方填写 Cesium ion token', 'error');
          this.loadTileset({ type: 'ion', assetId: p.assetId, token: s.ionToken }, p.name);
        }
      });
      return b;
    });

    const urlInput = h('input', { type: 'url', placeholder: 'https://…/tileset.json' });
    const loadUrl = h('button', { class: 'btn' }, '加载');
    loadUrl.addEventListener('click', () => {
      const url = urlInput.value.trim();
      if (!url) return this.notify('请填写 tileset.json 地址', 'error');
      this.loadTileset({ type: 'url', url });
    });

    const ionAsset = h('input', { type: 'number', placeholder: 'ion 资产 ID', min: 1 });
    const loadIon = h('button', { class: 'btn' }, '加载');
    loadIon.addEventListener('click', () => {
      const id = Number(ionAsset.value);
      if (!id) return this.notify('请填写 ion 资产 ID', 'error');
      if (!s.ionToken) return this.notify('请先填写 Cesium ion token', 'error');
      this.loadTileset({ type: 'ion', assetId: id, token: s.ionToken });
    });

    const keyField = (placeholder: string, value: string, onSave: (v: string) => void) => {
      const input = h('input', { type: 'password', placeholder, value, autocomplete: 'off' });
      input.addEventListener('change', () => {
        onSave(input.value.trim());
        this.save();
      });
      return input;
    };

    const details = h(
      'details',
      { class: 'keys' },
      h('summary', {}, '访问凭证（仅保存在本机浏览器）'),
      keyField('Cesium ion access token', s.ionToken, (v) => (s.ionToken = v)),
      keyField('Google Map Tiles API key', s.googleKey, (v) => (s.googleKey = v)),
    );

    this.renderLayers();
    return section(
      '3D Tiles',
      h('div', { class: 'chips' }, ...presetButtons),
      h('div', { class: 'row' }, urlInput, loadUrl),
      h('div', { class: 'row' }, ionAsset, loadIon),
      details,
      this.layerList,
    );
  }

  private loadTileset(source: TilesetSource, name?: string, opts: { hideGlobe?: boolean; clampToTerrain?: boolean } = {}): void {
    const layer = this.viewer.addTileset({ source, name, errorTarget: source.type === 'google' ? 20 : 12 });
    if (opts.hideGlobe) this.viewer.showGlobe = false;
    this.notify(`正在加载：${layer.name}`);
    layer.events.on('ready', ({ sphere }) => {
      this.notify(`已加载：${layer.name}`);
      // Global datasets (Google) cover the planet; only fly to local ones.
      if (sphere.radius < 2e6) {
        if (opts.clampToTerrain) this.clampToTerrain(layer);
        void this.viewer.flyToSphere(sphere).then(() => {
          // Finer terrain is loaded by now: refine the offset.
          if (opts.clampToTerrain) this.clampToTerrain(layer);
        });
      }
      this.renderLayers();
    });
    layer.events.on('error', ({ message }) => this.notify(`加载失败：${message}`, 'error'));
  }

  /** Lifts an ellipsoid-based tileset so its center sits on the current terrain. */
  private clampToTerrain(layer: Tiles3DLayer): void {
    const v = this.viewer;
    if (!v.globe.terrainSource || !layer.ready) return;
    const c = v.ellipsoid.cartesianToCartographic(layer.boundingSphere.center);
    if (!c) return;
    const ground = v.globe.getHeight(c.longitude, c.latitude);
    if (ground === null) return;
    layer.heightOffset = Math.round(ground);
    this.renderLayers();
  }

  private renderLayers(): void {
    const list = this.layerList;
    list.replaceChildren();
    const layers = this.viewer.tilesets;
    if (layers.length === 0) {
      list.append(h('p', { class: 'hint' }, '尚未加载 3D Tiles。'));
      return;
    }
    for (const layer of layers) list.append(this.layerRow(layer));
    if (!this.viewer.showGlobe) {
      const show = h('button', { class: 'btn ghost' }, '重新显示地球瓦片');
      show.addEventListener('click', () => {
        this.viewer.showGlobe = true;
        this.renderLayers();
      });
      list.append(show);
    }
  }

  private layerRow(layer: Tiles3DLayer): HTMLElement {
    const vis = h('input', { type: 'checkbox', title: '显示 / 隐藏' });
    vis.checked = layer.visible;
    vis.addEventListener('change', () => (layer.visible = vis.checked));
    const fly = h('button', { class: 'icon-btn', title: '飞到图层' }, '⌖');
    fly.addEventListener('click', () => {
      if (layer.ready && layer.boundingSphere.radius < 2e6) void this.viewer.flyToSphere(layer.boundingSphere);
    });
    const remove = h('button', { class: 'icon-btn', title: '移除' }, '✕');
    remove.addEventListener('click', () => {
      this.viewer.removeTileset(layer);
      if (this.viewer.tilesets.length === 0) this.viewer.showGlobe = true;
      this.renderLayers();
    });
    const offset = h('input', { type: 'number', step: 1, value: layer.heightOffset, title: '高度偏移 (m)', class: 'offset' });
    offset.addEventListener('change', () => (layer.heightOffset = Number(offset.value) || 0));
    const clamp = h('button', { class: 'icon-btn', title: '贴地：把图层中心抬到地形高度' }, '⤓');
    clamp.addEventListener('click', () => this.clampToTerrain(layer));
    return h('div', { class: 'layer-row' }, vis, h('span', { class: 'layer-name', title: layer.name }, layer.name), offset, clamp, fly, remove);
  }

  /** Camera controls (ThingJS "控制交互"): orbit pivot, pitch limit, inertia, auto orbit. */
  private cameraSection(): HTMLElement {
    const c = this.viewer.controller;
    const pivot = h(
      'select',
      { 'aria-label': '右键旋转中心' },
      h('option', { value: 'center' }, '右键绕屏幕中心旋转'),
      h('option', { value: 'cursor' }, '右键绕光标处旋转'),
    );
    pivot.value = c.orbitPivot;
    pivot.addEventListener('change', () => (c.orbitPivot = pivot.value as 'center' | 'cursor'));
    const maxTilt = slider(
      '最大倾斜',
      { min: 10, max: 88, step: 1, value: 90 + c.pitchRangeDeg[1], format: (v) => `${v.toFixed(0)}°` },
      (v) => (c.pitchRangeDeg = [c.pitchRangeDeg[0], -(90 - v)]),
    );
    const orbit = h('button', { class: 'btn ghost', title: '绕屏幕中心点匀速环绕；任意操作即停止' }, '环绕浏览');
    orbit.addEventListener('click', () => {
      if (c.isAutoOrbiting) this.viewer.stopAutoOrbit();
      else void this.viewer.startAutoOrbit({ degreesPerSecond: 12 });
    });
    return section(
      '相机',
      pivot,
      maxTilt.root,
      h('div', { class: 'row' }, toggle('惯性', c.inertia, (on) => (c.inertia = on)), orbit),
      h('p', { class: 'hint' }, '右键拖拽：水平调航向、垂直调俯仰；滚轮缩放保持当前航向与俯仰。'),
    );
  }

  private bookmarkSection(): HTMLElement {
    const buttons = BOOKMARKS.map((b) => {
      const btn = h('button', { class: 'chip' }, b.name);
      btn.addEventListener('click', () => this.flyToBookmark(b));
      return btn;
    });
    return section('视点', h('div', { class: 'chips' }, ...buttons));
  }

  private flyToBookmark(b: Bookmark): void {
    const v = this.viewer;
    const target = v.ellipsoid.cartographicToCartesian(b.target[0] * DEG2RAD, b.target[1] * DEG2RAD, b.target[2]);
    const position = new Vector3();
    lookAtHeadingPitchRange(v.ellipsoid, target, b.heading * DEG2RAD, b.pitch * DEG2RAD, b.range, position, v.camera.quaternion.clone());
    void v.controller.flyTo({ position, heading: b.heading * DEG2RAD, pitch: b.pitch * DEG2RAD });
  }

  private debugSection(): HTMLElement {
    const s = this.settings;
    const g = this.viewer.globe;
    const quality = slider(
      '影像精度 (SSE)',
      { min: 0.75, max: 3, step: 0.25, value: s.quality, format: (v) => `${v.toFixed(2)} px` },
      (v) => {
        s.quality = v;
        g.maxScreenSpaceError = v;
        this.save();
      },
    );
    g.maxScreenSpaceError = s.quality;
    const details = h(
      'details',
      { class: 'debug' },
      h('summary', {}, '调试'),
      quality.root,
      toggle('瓦片边界', false, (v) => (tileDebugUniforms.showTileBorders.value = v ? 1 : 0)),
      toggle('按层级着色', false, (v) => (tileDebugUniforms.levelTint.value = v ? 1 : 0)),
      toggle('线框', false, (v) => g.setWireframe(v)),
      toggle('冻结 LOD', false, (v) => (g.freeze = v)),
    );
    return h('section', { class: 'panel-section' }, details);
  }
}

function formatHour(v: number): string {
  const hh = Math.floor(v) % 24;
  const mm = Math.round((v % 1) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
