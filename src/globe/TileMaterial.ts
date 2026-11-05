import { DataTexture, SRGBColorSpace, Texture, Vector4 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  attribute,
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
  /**
   * Previous imagery while cross-fading (a magnified ancestor or the
   * placeholder). Equal to `imageryMap` with `fade = 1` when not fading.
   */
  fadeMap: Texture;
  fadeTransform: Vector4;
  /** 0 = show `fadeMap`, 1 = show `imageryMap`. */
  fade: number;
  /** Transparent overlay drawn over the imagery (rasterized vector layers). */
  overlayMap: Texture;
  overlayTransform: Vector4;
  tileLevel: number;
  /**
   * Geometry morph, 0..1: each vertex is drawn `(1 - morph) * morphDelta`
   * meters below its height along the ellipsoid normal, so a new mesh can
   * start out as the surface that was on screen before. 1 = the mesh as built.
   */
  morph: number;
}

/** Per-vertex attribute holding the morph offsets (meters); every tile geometry must have it. */
export const MORPH_ATTRIBUTE = 'morphDelta';

/** a² / b² of WGS84: scales ECEF z so the gradient of the ellipsoid gives the geodetic normal. */
const WGS84_A2_OVER_B2 = 1.006739496742276;

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

/**
 * `materialReference` to a texture property that gets a texture binding of
 * its own. three merges uniform nodes with the same hash into one binding,
 * and a texture node's hash is the uuid of the texture it holds when the
 * shader is built (`TextureNode.getUniformHash`). Tile materials start out
 * with `imageryMap === fadeMap`, so the shared tile shader used to sample one
 * texture through both: every cross-fade blended the old picture with a
 * shrunken copy of it (tile-sized ghost copies), then snapped to the new one.
 */
function textureReference(property: string): TSLNode {
  const ref: TSLNode = materialReference(property, 'texture');
  // ReferenceNode creates its texture node lazily; give it a hash of its own.
  const setNodeType = ref.setNodeType.bind(ref);
  ref.setNodeType = (type: string) => {
    setNodeType(type);
    ref.node.getUniformHash = () => `globeTile.${property}`;
  };
  return ref;
}
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
  const morph: TSLNode = materialReference('morph', 'float');
  const morphDelta: TSLNode = attribute(MORPH_ATTRIBUTE, 'float');

  const vInscatter = varyingProperty('vec3', 'vInscatter');
  const vTransmittance = varyingProperty('vec3', 'vTransmittance');
  const vSunTransmittance = varyingProperty('vec3', 'vSunTransmittance');
  const vSunMu = varyingProperty('float', 'vSunMu');

  // Vertex stage: geometry morph, then per-vertex aerial perspective (cheap and smooth enough at tile resolution).
  const positionNode = Fn(() => {
    // Meshes are translated only (RTC), so the ECEF normal is also the local one. float32 ECEF is
    // plenty for a direction; offsets are tens to hundreds of meters.
    const ecef = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
    const up = normalize(ecef.mul(vec3(1, 1, WGS84_A2_OVER_B2)));
    const position = positionGeometry.sub(up.mul(morphDelta.mul(float(1).sub(morph)))).toVar();

    vInscatter.assign(vec3(0));
    vTransmittance.assign(vec3(1));
    vSunTransmittance.assign(vec3(1));
    vSunMu.assign(1);

    If(U.atmosphereEnabled.greaterThan(0.5).or(U.lightingEnabled.greaterThan(0.5)), () => {
      const worldPos = modelWorldMatrix.mul(vec4(position, 1)).xyz;
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

    return position;
  })();

  const imageryUV = uv().mul(imageryTransform.zw).add(imageryTransform.xy);
  const imagery: TSLNode = textureReference('imageryMap').context({ getUV: () => imageryUV });
  // Cross-fade source. Sampled unconditionally (texture fetches must stay in uniform
  // control flow); when not fading it is the same texels as `imagery`, so it is ~free.
  // Its binding must stay separate from `imagery`'s even then (see `textureReference`).
  const fadeTransform: TSLNode = materialReference('fadeTransform', 'vec4');
  const fadeUV = uv().mul(fadeTransform.zw).add(fadeTransform.xy);
  const previous: TSLNode = textureReference('fadeMap').context({ getUV: () => fadeUV });
  const fade: TSLNode = materialReference('fade', 'float');
  const overlayTransform: TSLNode = materialReference('overlayTransform', 'vec4');
  const overlayUV = uv().mul(overlayTransform.zw).add(overlayTransform.xy);
  const overlay: TSLNode = textureReference('overlayMap').context({ getUV: () => overlayUV });

  const colorNode = Fn(() => {
    const albedo = vec3(mix(previous.rgb, imagery.rgb, fade)).toVar();
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
  material.fadeMap = texture;
  material.fadeTransform = new Vector4(0, 0, 1, 1);
  material.fade = 1;
  material.overlayMap = EMPTY_OVERLAY;
  material.overlayTransform = new Vector4(0, 0, 1, 1);
  material.tileLevel = level;
  material.morph = 1;
  const nodes = sharedNodes();
  material.positionNode = nodes.positionNode;
  material.colorNode = nodes.colorNode;
  return material;
}

export type { TSLNode };
