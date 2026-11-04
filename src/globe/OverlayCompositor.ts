import type { ImageryProvider } from './imagery/ImageryProvider';
import type { TileOverlaySource } from './overlay';

/** A semi-transparent raster layer drawn over the base imagery (labels, roads, grids...). */
export interface RasterOverlay {
  readonly id: number;
  readonly provider: ImageryProvider;
  opacity: number;
  visible: boolean;
}

/** Vector overlay versions live in the low part of the combined version number. */
const VECTOR_SPAN = 1_000_000;
const BLOB_CACHE_SIZE = 600;

interface CroppedImage {
  bitmap: ImageBitmap;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Combines raster overlay layers and rasterized vectors into the single
 * overlay texture each globe tile carries, so the tile shader stays one
 * texture fetch no matter how many layers are stacked.
 *
 * Raster changes (add / remove / opacity / order) invalidate every tile;
 * vector changes keep their region-based invalidation.
 */
export class OverlayCompositor implements TileOverlaySource {
  private rasterVersion = 0;
  private nextId = 1;
  private readonly layers: RasterOverlay[] = [];
  /** Compressed tile bytes, so vector-only refreshes do not refetch rasters. */
  private readonly blobs = new Map<string, Promise<Blob | null>>();

  constructor(private readonly vectors: TileOverlaySource & { readonly tileSize: number }) {}

  get version(): number {
    return this.rasterVersion * VECTOR_SPAN + this.vectors.version;
  }

  /** Bottom-to-top order. */
  get rasterLayers(): readonly RasterOverlay[] {
    return this.layers;
  }

  addRaster(provider: ImageryProvider, opacity = 1): RasterOverlay {
    const layer: RasterOverlay = { id: this.nextId++, provider, opacity, visible: true };
    this.layers.push(layer);
    this.rasterVersion++;
    return layer;
  }

  removeRaster(layer: RasterOverlay): void {
    const i = this.layers.indexOf(layer);
    if (i < 0) return;
    this.layers.splice(i, 1);
    for (const key of [...this.blobs.keys()]) if (key.startsWith(`${layer.id}/`)) this.blobs.delete(key);
    layer.provider.dispose?.();
    this.rasterVersion++;
  }

  setOpacity(layer: RasterOverlay, opacity: number): void {
    if (layer.opacity === opacity) return;
    layer.opacity = opacity;
    this.rasterVersion++;
  }

  setVisible(layer: RasterOverlay, visible: boolean): void {
    if (layer.visible === visible) return;
    layer.visible = visible;
    this.rasterVersion++;
  }

  /** Moves a layer up (+1, drawn later) or down (-1). */
  move(layer: RasterOverlay, delta: number): void {
    const i = this.layers.indexOf(layer);
    const j = Math.max(0, Math.min(this.layers.length - 1, i + delta));
    if (i < 0 || i === j) return;
    this.layers.splice(i, 1);
    this.layers.splice(j, 0, layer);
    this.rasterVersion++;
  }

  private activeRasters(level: number): RasterOverlay[] {
    return this.layers.filter((l) => l.visible && l.opacity > 0 && level >= l.provider.minZoom);
  }

  // ---------------------------------------------------------------------------
  // TileOverlaySource

  hasContent(level: number, x: number, y: number): boolean {
    return this.activeRasters(level).length > 0 || this.vectors.hasContent(level, x, y);
  }

  isCurrent(level: number, x: number, y: number, tileVersion: number): boolean {
    const tileRaster = Math.floor(tileVersion / VECTOR_SPAN);
    if (tileRaster !== this.rasterVersion) return false;
    return this.vectors.isCurrent(level, x, y, tileVersion - tileRaster * VECTOR_SPAN);
  }

  async requestOverlay(level: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap | null> {
    const rasters = this.activeRasters(level);
    const vector = this.vectors.hasContent(level, x, y) ? this.vectors.requestOverlay(level, x, y, signal) : Promise.resolve(null);
    // Common case: vectors only, no compositing needed.
    if (rasters.length === 0) return vector;

    const images = await Promise.all(rasters.map((l) => this.fetchRaster(l, level, x, y).catch(() => null)));
    let vectorBitmap: ImageBitmap | null = null;
    try {
      vectorBitmap = await vector;
    } catch (err) {
      for (const img of images) img?.bitmap.close();
      throw err;
    }
    if (signal.aborted) {
      for (const img of images) img?.bitmap.close();
      vectorBitmap?.close();
      throw new DOMException('Aborted', 'AbortError');
    }
    if (images.every((i) => !i) && !vectorBitmap) return null;

    const size = this.vectors.tileSize;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) return vectorBitmap;
    ctx.imageSmoothingQuality = 'high';
    images.forEach((img, i) => {
      if (!img) return;
      ctx.globalAlpha = rasters[i].opacity;
      ctx.drawImage(img.bitmap, img.sx, img.sy, img.sw, img.sh, 0, 0, size, size);
      img.bitmap.close();
    });
    if (vectorBitmap) {
      ctx.globalAlpha = 1;
      ctx.drawImage(vectorBitmap, 0, 0, size, size);
      vectorBitmap.close();
    }
    return canvas.transferToImageBitmap();
  }

  /** Tile image for a layer; beyond the layer's max zoom, a crop of its deepest ancestor. */
  private async fetchRaster(layer: RasterOverlay, level: number, x: number, y: number): Promise<CroppedImage | null> {
    const dz = Math.max(0, level - layer.provider.maxZoom);
    const z = level - dz;
    const ax = x >> dz;
    const ay = y >> dz;
    let bitmap: ImageBitmap | null = null;
    if (layer.provider.requestBlob) {
      const blob = await this.cachedBlob(layer, z, ax, ay);
      if (!blob) return null;
      bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
    } else {
      bitmap = await layer.provider.requestImage(z, ax, ay, new AbortController().signal);
      if (!bitmap) return null;
    }
    const span = 1 / 2 ** dz;
    const w = bitmap.width;
    const h = bitmap.height;
    return { bitmap, sx: (x - ax * 2 ** dz) * span * w, sy: (y - ay * 2 ** dz) * span * h, sw: w * span, sh: h * span };
  }

  private cachedBlob(layer: RasterOverlay, z: number, x: number, y: number): Promise<Blob | null> {
    const key = `${layer.id}/${z}/${x}/${y}`;
    let entry = this.blobs.get(key);
    if (entry) {
      this.blobs.delete(key);
      this.blobs.set(key, entry);
      return entry;
    }
    // Not tied to any one tile's abort signal: several tiles may share an ancestor.
    entry = layer.provider.requestBlob!(z, x, y);
    this.blobs.set(key, entry);
    entry.catch(() => this.blobs.delete(key));
    while (this.blobs.size > BLOB_CACHE_SIZE) this.blobs.delete(this.blobs.keys().next().value as string);
    return entry;
  }
}
