import type { RasterOverlay } from '../globe/OverlayCompositor';
import { findOverlayPreset, OVERLAY_PRESETS } from '../globe/imagery/presets';
import type { GeoViewer } from '../viewer/GeoViewer';
import { h } from './dom';
import type { Settings } from './settings';

type Notify = (text: string, kind?: 'info' | 'error') => void;

/** Raster overlay layers (labels, roads, grids) stacked on the base imagery. */
export class OverlayPanel {
  readonly root: HTMLElement;
  private readonly list = h('div', { class: 'layer-list' });
  private readonly presetOf = new Map<RasterOverlay, string>();

  constructor(
    private readonly viewer: GeoViewer,
    private readonly settings: Settings,
    private readonly save: () => void,
    private readonly notify: Notify,
  ) {
    const select = h('select', { 'aria-label': '叠加图层' }, ...OVERLAY_PRESETS.map((p) => h('option', { value: p.id }, p.name)));
    const add = h('button', { class: 'btn' }, '叠加');
    add.addEventListener('click', () => {
      if (this.add(select.value)) this.persist();
    });
    this.root = h('div', { class: 'stack' }, h('div', { class: 'subhead' }, '叠加图层'), h('div', { class: 'row' }, select, add), this.list);
    for (const o of settings.overlays) this.add(o.id, o.opacity, o.visible, false);
    this.render();
  }

  add(id: string, opacity?: number, visible = true, report = true): boolean {
    const preset = findOverlayPreset(id);
    if (!preset) return false;
    if (preset.requiresKey === 'tianditu' && !this.settings.tiandituKey) {
      if (report) this.notify('请先在“访问凭证”里填写天地图 key', 'error');
      return false;
    }
    const layer = this.viewer.overlays.addRaster(preset.create(this.settings.tiandituKey), opacity ?? preset.opacity);
    if (!visible) this.viewer.overlays.setVisible(layer, false);
    this.presetOf.set(layer, id);
    this.render();
    return true;
  }

  private persist(): void {
    this.settings.overlays = this.viewer.overlays.rasterLayers
      .filter((l) => this.presetOf.has(l))
      .map((l) => ({ id: this.presetOf.get(l)!, opacity: l.opacity, visible: l.visible }));
    this.save();
  }

  private render(): void {
    const overlays = this.viewer.overlays;
    this.list.replaceChildren();
    const layers = [...overlays.rasterLayers].reverse(); // top-most first
    if (layers.length === 0) {
      this.list.append(h('p', { class: 'hint' }, '可在底图上叠加注记、路网等半透明图层。'));
      return;
    }
    for (const layer of layers) {
      const vis = h('input', { type: 'checkbox', title: '显示 / 隐藏' });
      vis.checked = layer.visible;
      vis.addEventListener('change', () => {
        overlays.setVisible(layer, vis.checked);
        this.persist();
      });
      const opacity = h('input', { type: 'range', min: 0, max: 1, step: 0.05, title: '不透明度', class: 'mini-range' });
      opacity.value = String(layer.opacity);
      opacity.addEventListener('change', () => {
        overlays.setOpacity(layer, Number(opacity.value));
        this.persist();
      });
      const up = h('button', { class: 'icon-btn', title: '上移' }, '↑');
      up.addEventListener('click', () => {
        overlays.move(layer, 1);
        this.persist();
        this.render();
      });
      const down = h('button', { class: 'icon-btn', title: '下移' }, '↓');
      down.addEventListener('click', () => {
        overlays.move(layer, -1);
        this.persist();
        this.render();
      });
      const remove = h('button', { class: 'icon-btn', title: '移除' }, '✕');
      remove.addEventListener('click', () => {
        overlays.removeRaster(layer);
        this.presetOf.delete(layer);
        this.persist();
        this.render();
      });
      this.list.append(
        h(
          'div',
          { class: 'vlayer' },
          h('div', { class: 'vlayer-line' }, vis, h('span', { class: 'layer-name', title: layer.provider.name }, layer.provider.name), up, down, remove),
          h('div', { class: 'vlayer-line' }, h('span', { class: 'mini' }, '不透明度'), opacity),
        ),
      );
    }
  }
}
