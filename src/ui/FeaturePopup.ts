import { formatDegrees, formatDistance } from '../core/math';
import type { FeaturePick, GeoViewer } from '../viewer/GeoViewer';
import { h } from './dom';

const KIND_LABEL = { point: '点要素', line: '线要素', polygon: '面要素' } as const;
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

/**
 * Click-to-identify: a short click (not a drag) on a label or draped vector
 * shows the feature's properties and highlights it on the globe.
 */
export class FeaturePopup {
  readonly root: HTMLElement;
  private down: { x: number; y: number; t: number } | null = null;
  private requestId = 0;

  constructor(private readonly viewer: GeoViewer) {
    this.root = h('div', { class: 'feature-popup', hidden: true, role: 'dialog', 'aria-label': '要素属性' });
    const canvas = viewer.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      this.down = e.button === 0 && e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || e.button !== 0) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 500) return;
      void this.identify(e.clientX, e.clientY);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    viewer.events.on('vectors-changed', (layers) => {
      const hl = viewer.vectors.highlighted;
      if (hl && !layers.some((l) => l.id === hl.layerId)) this.close();
    });
  }

  private async identify(clientX: number, clientY: number): Promise<void> {
    const id = ++this.requestId;
    const pick = await this.viewer.pickFeature(clientX, clientY);
    if (id !== this.requestId) return;
    if (!pick) {
      this.close();
      return;
    }
    this.viewer.highlightFeature(pick.hit);
    this.show(pick, clientX, clientY);
  }

  private show(pick: FeaturePick, x: number, y: number): void {
    const { hit, layer, position } = pick;
    const field = layer.labelStyle.field;
    const title = (field && formatValue(hit.properties[field])) || layer.name;

    const close = h('button', { class: 'icon-btn', title: '关闭', 'aria-label': '关闭' }, '✕');
    close.addEventListener('click', () => this.close());
    const zoom = h('button', { class: 'btn ghost small' }, '缩放到要素');
    zoom.addEventListener('click', () => void this.viewer.flyToBBox(hit.bbox));

    const rows = Object.entries(hit.properties)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .slice(0, MAX_ROWS)
      .map(([k, v]) => {
        const text = formatValue(v);
        return h('tr', {}, h('th', { title: k }, k), h('td', { title: text }, text.length > 160 ? `${text.slice(0, 160)}…` : text));
      });
    const total = Object.keys(hit.properties).length;

    this.root.replaceChildren(
      h('header', {}, h('div', {}, h('strong', {}, title), h('span', {}, `${layer.name} · ${KIND_LABEL[hit.kind]}`)), close),
      rows.length ? h('div', { class: 'feature-table' }, h('table', {}, h('tbody', {}, ...rows))) : h('p', { class: 'hint' }, '该要素没有属性。'),
      h(
        'footer',
        {},
        h(
          'span',
          { class: 'hint' },
          position
            ? `${formatDegrees(position.longitude, 'E', 'W')} ${formatDegrees(position.latitude, 'N', 'S')} · ${formatDistance(position.height)}`
            : total > MAX_ROWS
              ? `仅显示前 ${MAX_ROWS} / ${total} 个字段`
              : '',
        ),
        zoom,
      ),
    );
    this.root.hidden = false;

    // Keep the popup inside the window; on narrow screens it docks at the bottom (CSS).
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
  }
}
