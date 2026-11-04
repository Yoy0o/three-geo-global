/**
 * A source of raster tiles in the Web Mercator XYZ scheme.
 * `requestImage` resolves to null when the tile does not exist (e.g. HTTP 404),
 * in which case the globe falls back to a magnified ancestor tile.
 */
export interface ImageryProvider {
  readonly id: string;
  readonly name: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly attribution: string;
  requestImage(level: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap | null>;
  dispose?(): void;
}

export interface XYZImageryOptions {
  id?: string;
  name?: string;
  /**
   * URL template. Supported placeholders: {z} {x} {y} {-y} (TMS row) {s}
   * (subdomain) and any key in `params` such as {key}.
   */
  url: string;
  subdomains?: string[];
  minZoom?: number;
  maxZoom?: number;
  attribution?: string;
  params?: Record<string, string>;
}

/** Decodes an image off the main thread. */
export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { premultiplyAlpha: 'none' });
}

export class XYZImageryProvider implements ImageryProvider {
  readonly id: string;
  readonly name: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly attribution: string;
  private readonly url: string;
  private readonly subdomains: string[];
  private readonly params: Record<string, string>;

  constructor(options: XYZImageryOptions) {
    this.url = options.url;
    this.id = options.id ?? options.url;
    this.name = options.name ?? 'XYZ';
    this.minZoom = options.minZoom ?? 0;
    this.maxZoom = options.maxZoom ?? 19;
    this.attribution = options.attribution ?? '';
    this.subdomains = options.subdomains ?? [];
    this.params = options.params ?? {};
  }

  tileUrl(z: number, x: number, y: number): string {
    let url = this.url
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y))
      .replace('{-y}', String(2 ** z - 1 - y));
    if (this.subdomains.length > 0) {
      url = url.replace('{s}', this.subdomains[(x + y + z) % this.subdomains.length]);
    }
    for (const [k, v] of Object.entries(this.params)) url = url.replaceAll(`{${k}}`, encodeURIComponent(v));
    return url;
  }

  async requestImage(level: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap | null> {
    const res = await fetch(this.tileUrl(level, x, y), { signal, mode: 'cors', credentials: 'omit' });
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) throw new Error(`imagery HTTP ${res.status}`);
    const blob = await res.blob();
    if (blob.size === 0) return null;
    return decodeImage(blob);
  }
}
