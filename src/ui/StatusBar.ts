import { formatDegrees, formatDistance, RAD2DEG } from '../core/math';
import type { GeoViewer } from '../viewer/GeoViewer';
import { h } from './dom';

/** Bottom HUD: renderer badge, performance, camera and cursor readouts, attributions. */
export class StatusBar {
  readonly root: HTMLElement;
  readonly compass: HTMLElement;
  private readonly perf = h('span', { class: 'stat' });
  private readonly tiles = h('span', { class: 'stat' });
  private readonly cameraText = h('span', { class: 'stat' });
  private readonly cursorText = h('span', { class: 'stat' }, '—');
  private readonly attribution = h('div', { class: 'attribution' });
  private readonly needle: SVGElement;
  private readonly spinner = h('span', { class: 'spinner', title: '正在加载瓦片' });
  private pendingPointer: { x: number; y: number } | null = null;
  private frameCount = 0;

  constructor(private readonly viewer: GeoViewer) {
    const info = viewer.info;
    const features = [info.reversedDepth ? '反向Z' : '标准深度', info.highPrecision ? 'FP64矩阵' : null, info.timestampQuery ? 'GPU计时' : null]
      .filter(Boolean)
      .join(' · ');
    const badge = h(
      'span',
      { class: `badge ${info.backend === 'WebGPU' ? 'webgpu' : 'webgl'}`, title: `${info.adapter}\n${features}` },
      info.backend,
    );

    this.root = h(
      'footer',
      { class: 'statusbar' },
      h('div', { class: 'status-line' }, badge, h('span', { class: 'stat dim' }, features), this.spinner, this.perf, this.tiles),
      h('div', { class: 'status-line' }, h('span', { class: 'label' }, '相机'), this.cameraText, h('span', { class: 'label' }, '光标'), this.cursorText),
      this.attribution,
    );

    // Compass: needle points north; click to reset heading.
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '-50 -50 100 100');
    svg.innerHTML =
      '<circle r="46" class="compass-ring"/>' +
      '<g class="compass-needle"><path d="M0,-38 L9,0 L0,6 L-9,0 Z" class="north"/><path d="M0,38 L9,0 L0,-6 L-9,0 Z" class="south"/></g>' +
      '<text y="-26" class="compass-n">N</text>';
    this.needle = svg.querySelector('.compass-needle') as SVGElement;
    this.compass = h('button', { class: 'compass', title: '指北（点击复位朝向）', 'aria-label': '复位朝北' });
    this.compass.append(svg);
    this.compass.addEventListener('click', () => viewer.resetNorth());

    const canvas = viewer.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => (this.pendingPointer = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerleave', () => {
      this.pendingPointer = null;
      this.cursorText.textContent = '—';
    });

    viewer.events.on('frame', () => this.onFrame());
  }

  private onFrame(): void {
    const v = this.viewer;
    this.frameCount++;

    // Cursor picking is throttled to every other frame.
    if (this.pendingPointer && this.frameCount % 2 === 0) {
      const c = v.pickCartographic(this.pendingPointer.x, this.pendingPointer.y);
      this.pendingPointer = null;
      this.cursorText.textContent = c
        ? `${formatDegrees(c.longitude, 'E', 'W')}  ${formatDegrees(c.latitude, 'N', 'S')}  ${formatDistance(c.height)}`
        : '—';
    }

    const view = v.getView();
    this.needle.setAttribute('transform', `rotate(${-view.heading})`);
    if (this.frameCount % 6 !== 0) return;

    const s = v.stats;
    const gpu = s.gpuMs !== null ? ` · GPU ${s.gpuMs.toFixed(1)} ms` : '';
    this.perf.textContent = `${s.fps.toFixed(0)} FPS · CPU ${s.frameMs.toFixed(1)} ms${gpu} · ${s.drawCalls} draws · ${(s.triangles / 1000).toFixed(0)}k tris`;
    const g = v.globe.stats;
    let tilesText = `瓦片 ${g.rendered} / 缓存 ${g.cached} · L${g.maxLevel}`;
    if (g.waitingImagery > 0) tilesText += ` · 待影像 ${g.waitingImagery}`;
    // Finer tiles kept on screen until a coarser one can replace them without blurring.
    if (g.keptForDetail > 0) tilesText += ` · 保留 ${g.keptForDetail}`;
    // Loaded imagery waiting to be revealed together with its siblings.
    if (g.heldImagery > 0) tilesText += ` · 待显示 ${g.heldImagery}`;
    let busy = g.loading > 0;
    for (const t of v.tilesets) {
      const ts = (t.tiles as unknown as { stats: { visible?: number; downloading?: number; parsing?: number } }).stats;
      busy ||= (ts.downloading ?? 0) + (ts.parsing ?? 0) > 0;
      tilesText += ` · 3D ${ts.visible ?? 0}`;
    }
    // HTML markers shown / registered, with their per-frame CPU time (docs/agents/markers.md §5).
    const m = v.markers.stats;
    if (m.total > 0) tilesText += ` · 顶牌 ${m.shown} / ${m.total} (${m.ms.toFixed(1)} ms)`;
    this.tiles.textContent = tilesText;
    this.spinner.classList.toggle('active', busy);

    this.cameraText.textContent =
      `${formatDegrees(view.longitude / RAD2DEG, 'E', 'W')}  ${formatDegrees(view.latitude / RAD2DEG, 'N', 'S')}  ` +
      `高度 ${formatDistance(view.height)}  航向 ${view.heading.toFixed(0)}°  俯仰 ${view.pitch.toFixed(0)}°`;

    if (this.frameCount % 60 === 0) this.updateAttribution();
  }

  private updateAttribution(): void {
    const v = this.viewer;
    const parts = [v.globe.imageryProvider.attribution];
    for (const o of v.overlays.rasterLayers) if (o.visible) parts.push(o.provider.attribution);
    if (v.globe.terrainSource) parts.push(v.globe.terrainSource.attribution);
    for (const layer of v.tilesets) {
      const attrs = layer.tiles.getAttributions?.() ?? [];
      for (const a of attrs as { type: string; value: unknown }[]) if (a.type === 'string') parts.push(String(a.value));
    }
    const text = [...new Set(parts.filter(Boolean))].join(' | ');
    if (this.attribution.textContent !== text) this.attribution.textContent = text;
  }
}
