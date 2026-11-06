import { POINT_DEMOS } from '../markers/demoPoints';
import type { PointLayer, PointLayerOptions } from '../markers/PointLayer';
import { MARKER_STYLES, type MarkerStyleName } from '../markers/points';
import type { GeoViewer } from '../viewer/GeoViewer';
import { h, section } from './dom';

type Notify = (text: string, kind?: 'info' | 'error') => void;

const STYLE_NAMES: Record<MarkerStyleName, string> = {
  poi: '图钉',
  pulse: '呼吸点',
  badge: '徽章',
  beacon: '光柱',
  label: '文字',
  pin: '圆点标签',
  tag: '标签',
  card: '卡片',
};

/**
 * "点位标注" section: demo point sets, URL / file loading and, per layer,
 * marker style, clustering, visibility, zoom-to and removal.
 */
export class PointPanel {
  readonly root: HTMLElement;
  private readonly list = h('div', { class: 'layer-list' });

  constructor(
    private readonly viewer: GeoViewer,
    private readonly notify: Notify,
  ) {
    const chips = POINT_DEMOS.map((d) => {
      const b = h('button', { class: 'chip', title: d.note }, d.name);
      b.addEventListener('click', () => this.load(d.options()));
      return b;
    });

    const urlInput = h('input', { type: 'url', placeholder: 'https://…/points.geojson' });
    const loadUrl = h('button', { class: 'btn' }, '加载');
    loadUrl.addEventListener('click', () => {
      const url = urlInput.value.trim();
      if (!url) return this.notify('请填写点位数据地址', 'error');
      this.load({ url });
    });

    const fileInput = h('input', { type: 'file', accept: '.json,.geojson,application/json,application/geo+json', multiple: true, hidden: true });
    fileInput.addEventListener('change', () => {
      if (fileInput.files) void this.loadFiles(fileInput.files);
      fileInput.value = '';
    });
    const openFile = h('button', { class: 'btn ghost' }, '打开点位文件…');
    openFile.addEventListener('click', () => fileInput.click());

    this.root = section(
      '点位标注',
      h('div', { class: 'chips' }, ...chips),
      h('div', { class: 'row' }, urlInput, loadUrl),
      h('div', { class: 'row' }, openFile, fileInput, h('span', { class: 'hint' }, '*.points.json 可直接拖进窗口')),
      this.list,
    );
    viewer.events.on('points-changed', () => this.render());
    this.render();
  }

  /** Adds a point layer and reports the result; flies to it once loaded. */
  load(options: PointLayerOptions, flyTo = true): PointLayer {
    const layer = this.viewer.addPoints(options);
    this.notify(`正在加载点位：${layer.name}`);
    layer.events.on('ready', ({ count, skipped, bbox }) => {
      this.notify(`已加载：${layer.name}（${count} 个点位${skipped ? `，跳过 ${skipped} 个非点要素或无效坐标` : ''}）`);
      if (flyTo && bbox) void this.viewer.flyToBBox(padBBox(bbox));
      this.render();
    });
    layer.events.on('error', ({ message }) => {
      this.notify(`点位加载失败：${layer.name}：${message}`, 'error');
      this.render();
    });
    return layer;
  }

  async loadFiles(files: FileList | File[]): Promise<void> {
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        this.load({ name: file.name.replace(/(\.points)?\.(geo)?json$/i, ''), data: text });
      } catch (err) {
        this.notify(`读取 ${file.name} 失败：${(err as Error).message}`, 'error');
      }
    }
  }

  private render(): void {
    this.list.replaceChildren();
    const layers = this.viewer.pointLayers;
    if (layers.length === 0) {
      this.list.append(h('p', { class: 'hint' }, '支持 GeoJSON 点要素、点记录数组（lon / lat 字段）。点击点位查看属性，点击聚合点放大。'));
      return;
    }
    for (const layer of [...layers].reverse()) this.list.append(this.row(layer));
  }

  private row(layer: PointLayer): HTMLElement {
    const v = this.viewer;
    const vis = h('input', { type: 'checkbox', title: '显示 / 隐藏' });
    vis.checked = layer.visible;
    vis.addEventListener('change', () => (layer.visible = vis.checked));

    const status = layer.error ? '加载失败' : layer.ready ? `${layer.count} 个点位` : '加载中…';
    const name = h('span', { class: 'layer-name', title: `${layer.name}（${status}）` }, layer.name, h('small', {}, ` · ${status}`));

    const fly = h('button', { class: 'icon-btn', title: '缩放到图层' }, '⌖');
    fly.addEventListener('click', () => {
      const bbox = layer.bbox;
      if (bbox) void v.flyToBBox(padBBox(bbox));
    });
    const remove = h('button', { class: 'icon-btn', title: '移除图层' }, '✕');
    remove.addEventListener('click', () => v.removePoints(layer));

    const style = h('select', { class: 'field-select', title: '点位样式（规则仍可覆盖）', 'aria-label': '点位样式' });
    for (const s of MARKER_STYLES) style.append(h('option', { value: s }, STYLE_NAMES[s]));
    style.value = layer.style.style ?? 'poi';
    style.disabled = !layer.ready;
    style.addEventListener('change', () => layer.setStyle({ ...layer.style, style: style.value as MarkerStyleName }));

    const cluster = h('input', { type: 'checkbox', title: '屏幕空间聚合' });
    cluster.checked = layer.cluster !== null;
    cluster.addEventListener('change', () => layer.setCluster(cluster.checked));

    return h(
      'div',
      { class: 'vlayer' },
      h('div', { class: 'vlayer-line' }, vis, name, fly, remove),
      h('div', { class: 'vlayer-line' }, style, h('label', { class: 'mini' }, cluster, '聚合')),
    );
  }
}

/** Single points or tight groups get some context around them. */
function padBBox([w, s, e, n]: [number, number, number, number]): [number, number, number, number] {
  const dx = Math.max((e - w) * 0.15, 0.01);
  const dy = Math.max((n - s) * 0.15, 0.01);
  return [w - dx, s - dy, e + dx, n + dy];
}
