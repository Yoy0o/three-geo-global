import type { ImageryProvider } from './ImageryProvider';

const LEVEL_COLORS = ['#1e3a8a', '#1d4ed8', '#0369a1', '#0f766e', '#15803d', '#4d7c0f', '#a16207', '#c2410c', '#b91c1c', '#be185d', '#7e22ce', '#4338ca'];

/**
 * Procedural tiles showing level / column / row. Works offline, which makes it
 * handy for debugging level-of-detail selection and seams.
 */
export class DebugImageryProvider implements ImageryProvider {
  readonly id = 'debug-grid';
  readonly name = 'Debug grid';
  readonly minZoom = 0;
  readonly maxZoom = 22;
  readonly attribution = 'Procedural debug tiles';
  private readonly size = 256;

  async requestImage(level: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap | null> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const canvas = new OffscreenCanvas(this.size, this.size);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const s = this.size;
    const base = LEVEL_COLORS[level % LEVEL_COLORS.length];
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);

    // Checker pattern for scale perception.
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    const cells = 8;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        if ((i + j + x + y) % 2 === 0) ctx.fillRect((i * s) / cells, (j * s) / cells, s / cells, s / cells);
      }
    }

    // Lat/lon-ish graticule every 1/4 tile.
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      ctx.beginPath();
      ctx.moveTo((k * s) / 4, 0);
      ctx.lineTo((k * s) / 4, s);
      ctx.moveTo(0, (k * s) / 4);
      ctx.lineTo(s, (k * s) / 4);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, s - 2, s - 2);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 26px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`z ${level}`, s / 2, s / 2 - 22);
    ctx.font = '20px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(`${x} / ${y}`, s / 2, s / 2 + 14);
    return createImageBitmap(canvas);
  }
}
