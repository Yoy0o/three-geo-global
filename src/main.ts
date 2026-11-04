import './style.css';
import { AWS_TERRARIUM } from './globe/terrain/TerrainSource';
import { ControlPanel, createImagery } from './ui/ControlPanel';
import { h } from './ui/dom';
import { FeaturePopup } from './ui/FeaturePopup';
import { loadSettings } from './ui/settings';
import { StatusBar } from './ui/StatusBar';
import { GeoViewer, type ViewPosition } from './viewer/GeoViewer';

const DEFAULT_VIEW: ViewPosition = { longitude: 112, latitude: 26, height: 1.75e7, heading: 0, pitch: -90 };

/** Camera state in the URL hash: #lon,lat,height,heading,pitch */
function parseHashView(): ViewPosition | null {
  const parts = location.hash.slice(1).split(',').map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  const [longitude, latitude, height, heading = 0, pitch = -90] = parts;
  return { longitude, latitude, height, heading, pitch };
}

function syncHash(viewer: GeoViewer): void {
  let last = '';
  window.setInterval(() => {
    if (viewer.controller.isFlying) return;
    const v = viewer.getView();
    const hash = `#${v.longitude.toFixed(5)},${v.latitude.toFixed(5)},${v.height.toFixed(0)},${v.heading.toFixed(1)},${v.pitch.toFixed(1)}`;
    if (hash !== last) {
      last = hash;
      history.replaceState(null, '', hash);
    }
  }, 600);
}

function showFatal(message: string): void {
  document.getElementById('app')!.append(
    h('div', { class: 'fatal' }, h('h2', {}, '无法启动三维地球'), h('p', {}, message), h('p', { class: 'hint' }, '需要支持 WebGPU 或 WebGL 2 的浏览器（Chrome / Edge 113+、Safari 26+、Firefox 141+）。')),
  );
}

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  const container = document.getElementById('viewer')!;
  const params = new URLSearchParams(location.search);
  const settings = loadSettings();
  const imageryParam = params.get('imagery');
  if (imageryParam) settings.imagery = imageryParam;
  if (params.has('noterrain')) settings.terrain = false;

  const splash = h('div', { class: 'splash' }, h('div', { class: 'splash-globe' }), h('span', {}, '正在初始化 GPU…'));
  app.append(splash);

  let viewer: GeoViewer;
  try {
    viewer = await GeoViewer.create({
      container,
      imagery: createImagery(settings),
      terrain: settings.terrain ? AWS_TERRARIUM : null,
      terrainExaggeration: settings.exaggeration,
      maxScreenSpaceError: settings.quality,
      forceWebGL: params.has('webgl'),
      initialView: parseHashView() ?? DEFAULT_VIEW,
    });
  } catch (err) {
    splash.remove();
    console.error(err);
    showFatal(err instanceof Error ? err.message : String(err));
    return;
  }
  splash.remove();

  viewer.atmosphere = settings.atmosphere;
  viewer.lighting = settings.lighting;
  viewer.showStars = settings.stars;

  const panel = new ControlPanel(viewer, settings);
  const status = new StatusBar(viewer);
  const title = h(
    'div',
    { class: 'brand' },
    h('strong', {}, 'Three Geo Global'),
    h('span', {}, '左键拖拽旋转 · 滚轮缩放 · 右键/Ctrl 拖拽倾斜旋转 · 双击飞近'),
  );
  const popup = new FeaturePopup(viewer);
  app.append(title, panel.root, status.root, status.compass, popup.root);
  syncHash(viewer);
  enableFileDrop(app, (files) => void panel.vectorPanel.loadFiles(files));

  // ?geojson=<url> loads a GeoJSON layer on startup (repeatable).
  for (const url of params.getAll('geojson')) panel.vectorPanel.load({ url }, !location.hash);

  // ?tileset=<url> loads a 3D Tiles dataset on startup.
  const tileset = params.get('tileset');
  if (tileset) {
    const layer = viewer.addTileset({ source: { type: 'url', url: tileset } });
    layer.events.on('ready', ({ sphere }) => {
      if (sphere.radius < 2e6 && !location.hash) void viewer.flyToSphere(sphere);
    });
  }

  // Handy for debugging from the console.
  (window as unknown as { viewer: GeoViewer }).viewer = viewer;
}

/** Drag GeoJSON files anywhere onto the page to load them. */
function enableFileDrop(app: HTMLElement, onFiles: (files: File[]) => void): void {
  const overlay = h('div', { class: 'drop-overlay', hidden: true }, h('div', {}, '释放以加载 GeoJSON 文件'));
  app.append(overlay);
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) onFiles(files);
  });
}

void main();
