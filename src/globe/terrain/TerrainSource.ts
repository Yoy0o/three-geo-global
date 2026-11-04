/** How elevation is packed into RGB pixels. */
export type TerrainEncoding = 'terrarium' | 'mapbox';

/**
 * Raster elevation tiles in the Web Mercator XYZ scheme. Decoding and mesh
 * generation happen in a worker, so this is a plain serializable descriptor.
 */
export interface TerrainSource {
  id: string;
  name: string;
  encoding: TerrainEncoding;
  /** URL template with {z} {x} {y} placeholders. */
  url: string;
  /** Deepest level with real data; deeper tiles are upsampled from it. */
  maxZoom: number;
  /**
   * Vertical datum of the samples. 'msl' heights are converted to ellipsoidal
   * heights with the EGM96 geoid so they line up with 3D Tiles and GNSS data.
   */
  heightReference: 'msl' | 'ellipsoid';
  attribution: string;
}

/** Free global DEM (SRTM / GMTED / ETOPO1 bathymetry) hosted on AWS Open Data. Heights are MSL (geoid-corrected in the worker). */
export const AWS_TERRARIUM: TerrainSource = {
  id: 'aws-terrarium',
  name: 'AWS Terrain Tiles',
  encoding: 'terrarium',
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  maxZoom: 15,
  heightReference: 'msl',
  attribution: 'Terrain © Mapzen, AWS Open Data (SRTM, GMTED2010, ETOPO1)',
};
