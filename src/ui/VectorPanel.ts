import type { GeoJsonLayer, GeoJsonLayerOptions } from '../vector/GeoJsonLayer';
import type { GeoViewer } from '../viewer/GeoViewer';
import { h, section } from './dom';
import { GEOJSON_PRESETS } from './presets';

type Notify = (text: string, kind?: 'info' | 'error') => void;

const KIND_NAMES: Record<string, string> = {
  Point: '点',
  MultiPoint: '多点',
  LineString: '线',
  MultiLineString: '多线',
  Polygon: '面',
  MultiPolygon: '多面',
  GeometryCollection: '集合',
};

/** "矢量数据" section: GeoJSON presets, URL / file / drag-and-drop loading and the layer list. */
export class VectorPanel {
  readonly root: HTMLElement;
  private readonly list = h('div', { class: 'layer-list' });

  constructor(
    private readonly viewer: GeoViewer,
    private readonly notify: Notify,
  ) {
    const chips = GEOJSON_PRESETS.map((p) => {
      const b = h('button', { class: 'chip', title: p.note ?? '' }, p.name);
      b.addEventListener('click', () => this.load({ name: p.name, url: p.url, style: p.style, label: p.label }));
      return b;
    });

    const urlInput = h('input', { type: 'url', placeholder: 'https://…/data.geojson' });
    const loadUrl = h('button', { class: 'btn' }, '加载');
    loadUrl.addEventListener('click', () => {
      const url = urlInput.value.trim();
      if (!url) return this.notify('请填写 GeoJSON 地址', 'error');
      this.load({ url });
    });

    const fileInput = h('input', { type: 'file', accept: '.geojson,.json,application/geo+json,application/json', multiple: true, hidden: true });
    fileInput.addEventListener('change', () => {
      if (fileInput.files) void this.loadFiles(fileInput.files);
      fileInput.value = '';
    });
    const openFile = h('button', { class: 'btn ghost' }, '打开本地文件…');
    openFile.addEventListener('click', () => fileInput.click());

    this.root = section(
      '矢量数据 GeoJSON',
      h('div', { class: 'chips' }, ...chips),
      h('div', { class: 'row' }, urlInput, loadUrl),
      h('div', { class: 'row' }, openFile, fileInput, h('span', { class: 'hint' }, '也可把文件直接拖进窗口')),
      this.list,
    );
    viewer.events.on('vectors-changed', () => this.render());
    this.render();
  }

  load(options: GeoJsonLayerOptions, flyTo = true): GeoJsonLayer {
    const layer = this.viewer.addGeoJson(options);
    this.notify(`正在加载：${layer.name}`);
    layer.events.on('ready', (summary) => {
      const kinds = Object.entries(summary.geometryTypes)
        .map(([k, n]) => `${KIND_NAMES[k] ?? k} ${n}`)
        .join('、');
      this.notify(`已加载：${layer.name}（${summary.featureCount} 个要素：${kinds}）`);
      if (flyTo && summary.bbox) void this.viewer.flyToBBox(summary.bbox);
      this.render();
    });
    layer.events.on('error', ({ message }) => {
      this.notify(`加载失败：${layer.name}：${message}`, 'error');
      this.render();
    });
    return layer;
  }

  async loadFiles(files: FileList | File[]): Promise<void> {
    for (const file of Array.from(files)) {
      if (!/\.(geo)?json$/i.test(file.name) && !file.type.includes('json')) {
        this.notify(`跳过 ${file.name}：只支持 .geojson / .json`, 'error');
        continue;
      }
      try {
        const text = await file.text();
        this.load({ name: file.name.replace(/\.(geo)?json$/i, ''), data: text });
      } catch (err) {
        this.notify(`读取 ${file.name} 失败：${(err as Error).message}`, 'error');
      }
    }
  }

  private render(): void {
    this.list.replaceChildren();
    const layers = this.viewer.vectorLayers;
    if (layers.length === 0) {
      this.list.append(h('p', { class: 'hint' }, '尚未加载矢量数据。点击要素可查看属性。'));
      return;
    }
    // Top-most (last drawn) first.
    for (const layer of [...layers].reverse()) this.list.append(this.row(layer));
  }

  private row(layer: GeoJsonLayer): HTMLElement {
    const v = this.viewer;
    const vis = h('input', { type: 'checkbox', title: '显示 / 隐藏' });
    vis.checked = layer.visible;
    vis.addEventListener('change', () => (layer.visible = vis.checked));

    const status = layer.error ? '加载失败' : layer.ready ? `${layer.summary?.featureCount ?? 0} 个要素` : '加载中…';
    const name = h('span', { class: 'layer-name', title: `${layer.name}（${status}）` }, layer.name, h('small', {}, ` · ${status}`));

    const fly = h('button', { class: 'icon-btn', title: '缩放到图层' }, '⌖');
    fly.addEventListener('click', () => {
      if (layer.summary?.bbox) void v.flyToBBox(layer.summary.bbox);
    });
    const remove = h('button', { class: 'icon-btn', title: '移除图层' }, '✕');
    remove.addEventListener('click', () => v.removeGeoJson(layer));

    const color = h('input', { type: 'color', title: '图层颜色', class: 'swatch' });
    const types = Object.keys(layer.summary?.geometryTypes ?? {});
    const pointsOnly = types.length > 0 && types.every((t) => t === 'Point' || t === 'MultiPoint');
    color.value = toHex(pointsOnly ? layer.style.pointColor : layer.style.stroke);
    color.addEventListener('input', () => {
      const c = color.value;
      layer.setStyle(layer.style.colorBy ? { stroke: c, pointColor: c } : { stroke: c, fill: c, pointColor: c });
    });

    const labelToggle = h('input', { type: 'checkbox', title: '显示注记' });
    labelToggle.checked = layer.labelStyle.enabled;
    labelToggle.addEventListener('change', () => void layer.setLabelStyle({ enabled: labelToggle.checked }));

    const field = h('select', { class: 'field-select', title: '注记字段', 'aria-label': '注记字段' });
    for (const key of layer.summary?.propertyKeys ?? []) field.append(h('option', { value: key }, key));
    if (layer.labelStyle.field) field.value = layer.labelStyle.field;
    field.disabled = !layer.ready;
    field.addEventListener('change', () => void layer.setLabelStyle({ field: field.value, enabled: true }));

    return h(
      'div',
      { class: 'vlayer' },
      h('div', { class: 'vlayer-line' }, vis, name, fly, remove),
      h('div', { class: 'vlayer-line' }, color, h('label', { class: 'mini' }, labelToggle, '注记'), field),
    );
  }
}

/** Best-effort conversion of a CSS color to #rrggbb for <input type=color>. */
function toHex(css: string): string {
  if (/^#[0-9a-f]{6}$/i.test(css)) return css;
  if (/^#[0-9a-f]{3}$/i.test(css)) return `#${[...css.slice(1)].map((c) => c + c).join('')}`;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return '#60a5fa';
  ctx.fillStyle = css;
  const v = ctx.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(v) ? v : '#60a5fa';
}
