import { Vector3 } from 'three';
import { formatDegrees, formatDistance } from '../core/math';
import type { BimEntity } from '../indoor/BimEntity';
import type { FeaturePick, GeoViewer } from '../viewer/GeoViewer';
import { h } from './dom';

const KIND_LABEL = { point: '点要素', line: '线要素', polygon: '面要素' } as const;
const ENTITY_LABEL = { building: '建筑', floor: '楼层', room: '房间', thing: '设备', element: '构件' } as const;
const MAX_ROWS = 60;

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

const _p = new Vector3();

/**
 * Click-to-identify: a short click (not a drag) on a label or draped vector
 * shows the feature's properties and highlights it on the globe; a click on a
 * building, room or device shows its BIM properties.
 */
export class FeaturePopup {
  readonly root: HTMLElement;
  private requestId = 0;
  private entity: BimEntity | null = null;

  constructor(private readonly viewer: GeoViewer) {
    this.root = h('div', { class: 'feature-popup', hidden: true, role: 'dialog', 'aria-label': '属性' });
    viewer.interaction.on('click', (e) => {
      // Entities are selected by the viewer's indoor behavior; the 'select' event opens their panel.
      if (!e.entity) void this.identify(e.clientX, e.clientY);
    });
    viewer.indoor.events.on('select', ({ entity }) => {
      if (entity) this.showEntity(entity);
      else if (this.entity) this.close();
    });
    viewer.events.on('vectors-changed', (layers) => {
      const hl = viewer.vectors.highlighted;
      if (hl && !layers.some((l) => l.id === hl.layerId)) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  private async identify(clientX: number, clientY: number): Promise<void> {
    const id = ++this.requestId;
    const pick = await this.viewer.pickFeature(clientX, clientY);
    if (id !== this.requestId) return;
    if (!pick) {
      if (!this.entity) this.close();
      return;
    }
    this.entity = null;
    this.viewer.highlightFeature(pick.hit);
    this.show(pick, clientX, clientY);
  }

  private show(pick: FeaturePick, x: number, y: number): void {
    const { hit, layer, position } = pick;
    const field = layer.labelStyle.field;
    const title = (field && formatValue(hit.properties[field])) || layer.name;
    const zoom = h('button', { class: 'btn ghost small' }, '缩放到要素');
    zoom.addEventListener('click', () => void this.viewer.flyToBBox(hit.bbox));
    const total = Object.keys(hit.properties).length;
    const footer = position
      ? `${formatDegrees(position.longitude, 'E', 'W')} ${formatDegrees(position.latitude, 'N', 'S')} · ${formatDistance(position.height)}`
      : total > MAX_ROWS
        ? `仅显示前 ${MAX_ROWS} / ${total} 个字段`
        : '';
    this.render(title, `${layer.name} · ${KIND_LABEL[hit.kind]}`, hit.properties, footer, zoom);
    this.place(x, y);
  }

  private showEntity(entity: BimEntity): void {
    this.requestId++;
    this.viewer.highlightFeature(null);
    this.entity = entity;
    const indoor = this.viewer.indoor;
    const actions: HTMLElement[] = [];
    if (entity.type === 'building' || entity.type === 'floor' || entity.type === 'room') {
      const enter = h('button', { class: 'btn small' }, indoor.current === entity ? '已进入' : '进入');
      enter.toggleAttribute('disabled', indoor.current === entity);
      enter.addEventListener('click', () => void indoor.enter(entity));
      actions.push(enter);
    }
    const fly = h('button', { class: 'btn ghost small' }, '聚焦');
    fly.addEventListener('click', () => void this.viewer.flyToEntity(entity));
    actions.push(fly);
    const path = entity
      .ancestors()
      .map((a) => a.name)
      .join(' › ');
    const props: Record<string, unknown> = { 编号: entity.id, ...(entity.category ? { 分类: entity.category } : {}), ...entity.properties };
    this.render(entity.name, `${ENTITY_LABEL[entity.type]}${path ? ` · ${path}` : ''}`, props, '', ...actions);
    // Anchor next to the entity on screen.
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const p = entity.labelPosition(_p).project(this.viewer.camera);
    const visible = p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
    this.place(visible ? rect.left + ((p.x + 1) / 2) * rect.width : rect.left + rect.width * 0.62, visible ? rect.top + ((1 - p.y) / 2) * rect.height : rect.top + 80);
  }

  private render(title: string, subtitle: string, properties: Record<string, unknown>, footerText: string, ...actions: HTMLElement[]): void {
    const close = h('button', { class: 'icon-btn', title: '关闭', 'aria-label': '关闭' }, '✕');
    close.addEventListener('click', () => this.close());
    const rows = Object.entries(properties)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .slice(0, MAX_ROWS)
      .map(([k, v]) => {
        const text = formatValue(v);
        return h('tr', {}, h('th', { title: k }, k), h('td', { title: text }, text.length > 160 ? `${text.slice(0, 160)}…` : text));
      });
    this.root.replaceChildren(
      h('header', {}, h('div', {}, h('strong', {}, title), h('span', {}, subtitle)), close),
      rows.length ? h('div', { class: 'feature-table' }, h('table', {}, h('tbody', {}, ...rows))) : h('p', { class: 'hint' }, '没有属性。'),
      h('footer', {}, h('span', { class: 'hint' }, footerText), h('div', { class: 'row' }, ...actions)),
    );
    this.root.hidden = false;
  }

  /** Keeps the popup inside the window; on narrow screens it docks at the bottom (CSS). */
  private place(x: number, y: number): void {
    const pad = 12;
    const rect = this.root.getBoundingClientRect();
    const left = Math.min(Math.max(pad, x + 14), window.innerWidth - rect.width - pad);
    const top = Math.min(Math.max(pad, y + 14), window.innerHeight - rect.height - pad - 60);
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  close(): void {
    this.requestId++;
    if (!this.root.hidden) this.root.hidden = true;
    this.viewer.highlightFeature(null);
    if (this.entity) {
      this.entity = null;
      this.viewer.indoor.select(null);
    }
  }
}
