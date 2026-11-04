import { AdditiveBlending, BufferAttribute, BufferGeometry, Mesh } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cos,
  exp,
  float,
  Fn,
  renderGroup,
  screenDPR,
  sin,
  uniform,
  vec3,
  vec4,
  viewportSize,
} from 'three/tsl';

/** Deterministic PRNG so the star field is stable between sessions. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Procedural star field drawn as camera-facing quads "at infinity".
 * Stars live in an inertial frame and are rotated into ECEF by the Greenwich
 * sidereal angle, so they turn with the sky as time passes.
 */
export class StarField {
  readonly mesh: Mesh;
  readonly uniforms = {
    siderealAngle: uniform(0).setGroup(renderGroup),
    visibility: uniform(1).setGroup(renderGroup),
  };

  constructor(count = 9000, seed = 7) {
    const rand = mulberry32(seed);
    const dirs = new Float32Array(count * 4 * 3);
    const corners = new Float32Array(count * 4 * 2);
    const colors = new Float32Array(count * 4 * 4);
    const indices = new Uint32Array(count * 6);

    // Magnitude distribution N(<m) ~ 10^(0.45 m) between -1.5 and 6.5.
    const m0 = -1.5;
    const m1 = 6.5;
    const b0 = 10 ** (0.45 * m0);
    const b1 = 10 ** (0.45 * m1);
    const cornerOffsets = [-1, -1, 1, -1, 1, 1, -1, 1];

    for (let i = 0; i < count; i++) {
      // Uniform direction, slightly concentrated towards a "galactic plane" for texture.
      let z = rand() * 2 - 1;
      if (rand() < 0.35) z *= 0.25;
      const phi = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      const rot = 1.09; // tilt of the band relative to the equator
      const x0 = r * Math.cos(phi);
      const y0 = r * Math.sin(phi);
      const x = x0;
      const y = y0 * Math.cos(rot) - z * Math.sin(rot);
      const zz = y0 * Math.sin(rot) + z * Math.cos(rot);

      const mag = Math.log10(rand() * (b1 - b0) + b0) / 0.45;
      const flux = 10 ** (-0.4 * mag);
      const size = 1.1 + 1.6 * Math.min(1, Math.sqrt(flux));
      const intensity = Math.min(3.5, 0.32 * flux + 0.05);
      const warm = rand() ** 2;
      const cr = 0.72 + 0.28 * warm;
      const cg = 0.8 + 0.08 * warm;
      const cb = 1.0 - 0.38 * warm;

      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        dirs.set([x, y, zz], v * 3);
        corners.set([cornerOffsets[k * 2], cornerOffsets[k * 2 + 1]], v * 2);
        colors.set([cr * intensity, cg * intensity, cb * intensity, size], v * 4);
      }
      indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(dirs, 3));
    geometry.setAttribute('starCorner', new BufferAttribute(corners, 2));
    geometry.setAttribute('starColor', new BufferAttribute(colors, 4));
    geometry.setIndex(new BufferAttribute(indices, 1));

    const material = new MeshBasicNodeMaterial();
    material.name = 'StarField';
    material.depthTest = false;
    material.depthWrite = false;
    material.transparent = false;
    material.blending = AdditiveBlending;
    material.fog = false;

    const dir = attribute('position', 'vec3');
    const corner = attribute('starCorner', 'vec2');
    const color = attribute('starColor', 'vec4');
    const angle = this.uniforms.siderealAngle;

    material.vertexNode = Fn(() => {
      // Inertial -> ECEF: rotate by -GMST about the polar axis.
      const c = cos(angle.negate());
      const s = sin(angle.negate());
      const d = vec3(dir.x.mul(c).sub(dir.y.mul(s)), dir.x.mul(s).add(dir.y.mul(c)), dir.z);
      const viewDir = cameraViewMatrix.mul(vec4(d, 0)).xyz;
      const clip = cameraProjectionMatrix.mul(vec4(viewDir, 1)).toVar();
      const sizePx = color.w.mul(screenDPR);
      const offset = corner.mul(sizePx).div(viewportSize.mul(0.5)).mul(clip.w);
      // Depth is irrelevant (no depth test); keep z inside the clip volume for every convention.
      return vec4(clip.xy.add(offset), clip.w.mul(0.5), clip.w);
    })();

    material.colorNode = Fn(() => {
      const r2 = corner.dot(corner);
      const falloff = exp(r2.mul(-3.2));
      return color.rgb.mul(falloff).mul(this.uniforms.visibility).mul(float(1));
    })();

    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'Stars';
    this.mesh.frustumCulled = false;
    // Drawn right after the sky background, before any opaque geometry.
    this.mesh.renderOrder = -1000;
  }
}
