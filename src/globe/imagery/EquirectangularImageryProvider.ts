import { mercatorVToLatitude } from '../../core/geodesy';
import { decodeImage, type ImageryProvider } from './ImageryProvider';

export interface EquirectangularImageryOptions {
  id?: string;
  name?: string;
  /** URL of a single global image in plate carrée (lon -180..180, lat 90..-90). */
  url: string;
  maxZoom?: number;
  attribution?: string;
}

/**
 * Serves Web Mercator tiles cut from one global equirectangular image
 * (e.g. NASA Blue Marble). Useful as an offline / low-bandwidth basemap.
 */
export class EquirectangularImageryProvider implements ImageryProvider {
  readonly id: string;
  readonly name: string;
  readonly minZoom = 0;
  readonly maxZoom: number;
  readonly attribution: string;
  private readonly url: string;
  private image: Promise<ImageBitmap> | null = null;

  constructor(options: EquirectangularImageryOptions) {
    this.url = options.url;
    this.id = options.id ?? options.url;
    this.name = options.name ?? 'Equirectangular image';
    this.maxZoom = options.maxZoom ?? 5;
    this.attribution = options.attribution ?? '';
  }

  private load(): Promise<ImageBitmap> {
    this.image ??= fetch(this.url, { mode: 'cors', credentials: 'omit' })
      .then((r) => {
        if (!r.ok) throw new Error(`image HTTP ${r.status}`);
        return r.blob();
      })
      .then(decodeImage);
    this.image.catch(() => (this.image = null));
    return this.image;
  }

  async requestImage(level: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap | null> {
    const img = await this.load();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const size = 256;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const n = 2 ** level;
    const srcW = img.width / n;
    const srcX = (x / n) * img.width;
    // Re-project row by row: rows are uniform in mercator, the source is uniform in latitude.
    for (let row = 0; row < size; row++) {
      const lat0 = mercatorVToLatitude((y + row / size) / n);
      const lat1 = mercatorVToLatitude((y + (row + 1) / size) / n);
      const sy0 = ((Math.PI / 2 - lat0) / Math.PI) * img.height;
      const sy1 = ((Math.PI / 2 - lat1) / Math.PI) * img.height;
      ctx.drawImage(img, srcX, sy0, srcW, Math.max(sy1 - sy0, 0.01), 0, row, size, 1);
    }
    return createImageBitmap(canvas);
  }
}
