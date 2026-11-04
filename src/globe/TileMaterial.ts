import { DataTexture, SRGBColorSpace, Texture, Vector4 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  dot,
  float,
  Fn,
  If,
  materialReference,
  max,
  mix,
  modelWorldMatrix,
  normalize,
  normalLocal,
  positionGeometry,
  renderGroup,
  select,
  smoothstep,
  uniform,
  uv,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import {
  atmosphereUniforms as U,
  integrateScattering,
  sunTransmittanceAt,
  toAtmosphereSpace,
  type TSLNode,
} from '../atmosphere/AtmosphereNodes';

/** Globe tile material: per-tile values are plain properties read through `materialReference`. */
export interface TileMaterial extends MeshBasicNodeMaterial {
  imageryMap: Texture;
  /** (offsetU, offsetV, scaleU, scaleV) into `imageryMap` (magnified ancestor fallback). */
  imageryTransform: Vector4;
  /** Transparent overlay drawn over the imagery (rasterized vector layers). */
  overlayMap: Texture;
  overlayTransform: Vector4;
  tileLevel: number;
}

/** 1x1 fully transparent texture used when a tile has no overlay. */
export const EMPTY_OVERLAY = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
EMPTY_OVERLAY.colorSpace = SRGBColorSpace;
EMPTY_OVERLAY.needsUpdate = true;

export const tileDebugUniforms = {
  showTileBorders: uniform(0).setGroup(renderGroup),
  levelTint: uniform(0).setGroup(renderGroup),
};

interface SharedNodes {
  positionNode: TSLNode;
  colorNode: TSLNode;
}

let shared: SharedNodes | null = null;
const placeholder = new Texture();
placeholder.flipY = false;

/**
 * Node graph shared by every tile material. Because all tile materials point
 * at the same node instances, three.js builds the shader once and reuses one
 * GPU pipeline; per-tile inputs (imagery texture, UV transform, level) are
 * material properties fetched with `materialReference`, which gives each
 * draw its own bind group on both WebGPU and WebGL 2.
 */
function sharedNodes(): SharedNodes {
  if (shared) return shared;

  const imageryTransform: TSLNode = materialReference('imageryTransform', 'vec4');
  const tileLevel: TSLNode = materialReference('tileLevel', 'float');

  const vInscatter = varyingProperty('vec3', 'vInscatter');
  const vTransmittance = varyingProperty('vec3', 'vTransmittance');
  const vSunTransmittance = varyingProperty('vec3', 'vSunTransmittance');
  const vSunMu = varyingProperty('float', 'vSunMu');

  // Vertex stage: per-vertex aerial perspective (cheap and smooth enough at tile resolution).
  const positionNode = Fn(() => {
    vInscatter.assign(vec3(0));
    vTransmittance.assign(vec3(1));
    vSunTransmittance.assign(vec3(1));
    vSunMu.assign(1);

    If(U.atmosphereEnabled.greaterThan(0.5).or(U.lightingEnabled.greaterThan(0.5)), () => {
      const worldPos = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
      const pKm = toAtmosphereSpace(worldPos);
      const camKm = U.cameraPositionKm;
      const toVertex = pKm.sub(camKm);
      const dist = toVertex.length();
      const rd = toVertex.div(max(dist, 1e-6));

      If(U.atmosphereEnabled.greaterThan(0.5), () => {
        const scattering = integrateScattering(camKm, rd, dist, U.sunDirection, 10, null);
        vInscatter.assign(scattering.inscatter);
        vTransmittance.assign(scattering.transmittance);
      });

      const sun = sunTransmittanceAt(pKm, U.lightDirection);
      vSunTransmittance.assign(sun.transmittance);
      vSunMu.assign(sun.mu);
    });

    return positionGeometry;
  })();

  const imageryUV = uv().mul(imageryTransform.zw).add(imageryTransform.xy);
  const imagery: TSLNode = (materialReference('imageryMap', 'texture') as TSLNode).context({ getUV: () => imageryUV });
  const overlayTransform: TSLNode = materialReference('overlayTransform', 'vec4');
  const overlayUV = uv().mul(overlayTransform.zw).add(overlayTransform.xy);
  const overlay: TSLNode = (materialReference('overlayMap', 'texture') as TSLNode).context({ getUV: () => overlayUV });

  const colorNode = Fn(() => {
    const albedo = vec3(imagery.rgb).toVar();
    // Draped overlays (vectors) sit on the ground, so they are lit and hazed like it.
    albedo.assign(mix(albedo, overlay.rgb, overlay.a));

    // Debug overlays.
    If(tileDebugUniforms.levelTint.greaterThan(0.5), () => {
      const hue = tileLevel.mul(0.61803398875).fract().mul(6.2831853);
      const tint = vec3(hue.cos(), hue.add(2.094).cos(), hue.add(4.188).cos()).mul(0.5).add(0.5);
      albedo.assign(mix(albedo, tint, 0.45));
    });
    If(tileDebugUniforms.showTileBorders.greaterThan(0.5), () => {
      const e = uv();
      const edge = e.x.min(e.y).min(float(1).sub(e.x)).min(float(1).sub(e.y));
      albedo.assign(select(edge.lessThan(0.006), vec3(1, 0.85, 0.2), albedo));
    });

    // Sun lighting (optional): direct sun attenuated by the atmosphere + sky ambient.
    const n = normalize(normalLocal);
    const ndl = dot(n, U.lightDirection);
    const direct = vSunTransmittance.mul(max(ndl, 0));
    const skyAmbient = vec3(0.09, 0.11, 0.15).mul(smoothstep(-0.12, 0.35, vSunMu));
    const lit = albedo.mul(direct.add(skyAmbient).add(U.nightBrightness));
    const surface = mix(albedo, lit, U.lightingEnabled);

    // Aerial perspective.
    const hazed = surface.mul(vTransmittance).add(vInscatter.mul(U.groundHaze));
    return mix(surface, hazed, U.atmosphereEnabled);
  })();

  shared = { positionNode, colorNode };
  return shared;
}

export function createTileMaterial(texture: Texture = placeholder, level = 0): TileMaterial {
  const material = new MeshBasicNodeMaterial() as TileMaterial;
  material.name = 'GlobeTile';
  material.imageryMap = texture;
  material.imageryTransform = new Vector4(0, 0, 1, 1);
  material.overlayMap = EMPTY_OVERLAY;
  material.overlayTransform = new Vector4(0, 0, 1, 1);
  material.tileLevel = level;
  const nodes = sharedNodes();
  material.positionNode = nodes.positionNode;
  material.colorNode = nodes.colorNode;
  return material;
}

export type { TSLNode };
