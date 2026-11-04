/** Geographic rectangle in radians. */
export interface GeoRect {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Highest latitude representable in Web Mercator (about 85.0511 deg). */
export const MERCATOR_MAX_LATITUDE = 2 * Math.atan(Math.exp(Math.PI)) - Math.PI / 2;

/**
 * Web Mercator (EPSG:3857) "XYZ" tiling: level 0 is one tile covering the
 * world, y = 0 is the northernmost row. This is the scheme used by almost every
 * public raster tile service (OSM, ArcGIS, Carto, Mapbox, Google, Terrarium...).
 */
export class WebMercatorTilingScheme {
  readonly maxLatitude = MERCATOR_MAX_LATITUDE;

  tilesAtLevel(level: number): number {
    return 2 ** level;
  }

  /** Normalized mercator y (0 = north edge, 1 = south edge) to latitude. */
  mercatorVToLatitude(v: number): number {
    const my = Math.PI * (1 - 2 * v);
    return 2 * Math.atan(Math.exp(my)) - Math.PI / 2;
  }

  latitudeToMercatorV(lat: number): number {
    const clamped = Math.max(-this.maxLatitude, Math.min(this.maxLatitude, lat));
    const my = Math.log(Math.tan(Math.PI / 4 + clamped / 2));
    return (1 - my / Math.PI) / 2;
  }

  tileRect(level: number, x: number, y: number, result: GeoRect = { west: 0, south: 0, east: 0, north: 0 }): GeoRect {
    const n = this.tilesAtLevel(level);
    result.west = (x / n) * 2 * Math.PI - Math.PI;
    result.east = ((x + 1) / n) * 2 * Math.PI - Math.PI;
    result.north = this.mercatorVToLatitude(y / n);
    result.south = this.mercatorVToLatitude((y + 1) / n);
    return result;
  }

  /** Tile coordinates containing a position. */
  positionToTile(level: number, longitude: number, latitude: number): { x: number; y: number } {
    const n = this.tilesAtLevel(level);
    const u = (longitude + Math.PI) / (2 * Math.PI);
    const v = this.latitudeToMercatorV(latitude);
    return {
      x: Math.min(n - 1, Math.max(0, Math.floor(u * n))),
      y: Math.min(n - 1, Math.max(0, Math.floor(v * n))),
    };
  }
}
