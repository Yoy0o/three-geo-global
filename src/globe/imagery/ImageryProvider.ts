/**
 * A source of raster tiles in the Web Mercator XYZ scheme.
 * `requestImage` resolves to null when the tile does not exist (e.g. HTTP 404),
 * in which case the globe falls back to a magnified ancestor tile.
 */
import { hostOf, scheduleRequest } from './RequestScheduler';

export interface ImageryProvider {
  readonly id: string;
  readonly name: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly attribution: string;
  /**
   * Requests the provider's servers take at once without queueing them in
   * the browser (about 6 per host for HTTP/1.1 servers); undefined = no limit
   * (HTTP/2, local sources). The globe dispatches at most this many imagery
   * loads, so the rest wait in its own priority queue.
   */
  readonly maxConcurrentRequests?: number;
  /**
   * Downloads a tile into the browser's HTTP cache without decoding it (no
   * main-thread or GPU cost), so a later `requestImage` is a cache hit. The
   * globe uses it for the next level around the view center while idle.
   * Optional; providers without it are never prefetched.
   */
  prefetch?(level: number, x: number, y: number, signal: AbortSignal): Promise<void>;
  requestImage(level: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap | null>;
  /** Raw encoded tile, when the provider can supply it (lets callers cache compressed bytes). */
  requestBlob?(level: number, x: number, y: number, signal?: AbortSignal): Promise<Blob | null>;
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
  /**
   * Requests in flight per host at most. Set it for HTTP/1.1 servers (6 is
   * what browsers allow per host): the excess then waits in the globe's
   * priority queue instead of the browser's, and started downloads are not
   * aborted (that would close the connection). See `RequestScheduler`.
   */
  maxRequestsPerHost?: number;
  /**
   * Let the globe prefetch the next level into the HTTP cache (default true).
   * Turn off for services with request quotas (e.g. Tianditu keys) or without
   * HTTP caching.
   */
  prefetch?: boolean;
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
  readonly maxConcurrentRequests?: number;
  private readonly url: string;
  private readonly subdomains: string[];
  private readonly params: Record<string, string>;
  private readonly perHost: number | undefined;

  constructor(options: XYZImageryOptions) {
    this.url = options.url;
    this.id = options.id ?? options.url;
    this.name = options.name ?? 'XYZ';
    this.minZoom = options.minZoom ?? 0;
    this.maxZoom = options.maxZoom ?? 19;
    this.attribution = options.attribution ?? '';
    this.subdomains = options.subdomains ?? [];
    this.params = options.params ?? {};
    this.perHost = options.maxRequestsPerHost;
    // No method at all when disabled: the globe only prefetches providers that have one.
    if (options.prefetch === false) this.prefetch = undefined;
    if (this.perHost !== undefined) {
      const hosts = this.url.includes('{s}') ? Math.max(1, this.subdomains.length) : 1;
      this.maxConcurrentRequests = this.perHost * hosts;
    }
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

  async requestBlob(level: number, x: number, y: number, signal?: AbortSignal): Promise<Blob | null> {
    const url = this.tileUrl(level, x, y);
    if (this.perHost === undefined) return fetchTileBlob(url, signal);
    return scheduleRequest(hostOf(url), { limit: this.perHost, signal }, (s) => fetchTileBlob(url, s));
  }

  async requestImage(level: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap | null> {
    const blob = await this.requestBlob(level, x, y, signal);
    return blob ? decodeImage(blob) : null;
  }

  prefetch?: (level: number, x: number, y: number, signal: AbortSignal) => Promise<void> = async (level, x, y, signal) => {
    const url = this.tileUrl(level, x, y);
    // Same mode and credentials as `fetchTileBlob`, so the cache entry is reused. No `priority: 'low'`:
    // Chrome then holds the request back behind others for a second or more; the globe already
    // starts prefetches only when nothing visible is waiting.
    const warm = async (s: AbortSignal | undefined) => {
      const res = await fetch(url, { signal: s, mode: 'cors', credentials: 'omit' });
      // The body must be read for the response to be stored.
      await res.arrayBuffer();
    };
    if (this.perHost === undefined) return warm(signal);
    return scheduleRequest(hostOf(url), { limit: this.perHost, signal }, warm);
  };
}

async function fetchTileBlob(url: string, signal: AbortSignal | undefined): Promise<Blob | null> {
  const res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`imagery HTTP ${res.status}`);
  const blob = await res.blob();
  return blob.size === 0 ? null : blob;
}
