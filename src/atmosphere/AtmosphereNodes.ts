/**
 * Physically based single-scattering atmosphere written in TSL (three.js
 * shading language). The same node graph compiles to WGSL on WebGPU and to
 * GLSL on the WebGL 2 fallback.
 *
 * Model: Rayleigh + Mie scattering and ozone absorption with exponential /
 * tent density profiles (Bruneton 2008 / Hillaire 2020 coefficients). The view
 * ray is ray-marched; the optical depth towards the sun uses Schüler's
 * analytic Chapman-function approximation instead of a nested loop, which keeps
 * the shader cheap enough to evaluate per pixel for the sky and per vertex for
 * the ground (aerial perspective).
 *
 * Units are kilometers in "atmosphere space": ECEF with z scaled by a/b so the
 * WGS84 ellipsoid becomes a sphere of radius a.
 */
import { Vector3 } from 'three';
import {
  abs,
  clamp,
  dot,
  exp,
  float,
  Fn,
  If,
  Loop,
  max,
  min,
  mix,
  normalize,
  pow,
  renderGroup,
  select,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { WGS84_A, WGS84_B } from '../core/geodesy';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TSLNode = any;

export const GROUND_RADIUS_KM = WGS84_A / 1000;
export const ATMOSPHERE_HEIGHT_KM = 80;
export const TOP_RADIUS_KM = GROUND_RADIUS_KM + ATMOSPHERE_HEIGHT_KM;
export const Z_SCALE = WGS84_A / WGS84_B;

const RAYLEIGH_SCATTERING = vec3(5.802e-3, 13.558e-3, 33.1e-3); // 1/km
const RAYLEIGH_SCALE_HEIGHT = 8.0; // km
const MIE_SCATTERING = 3.996e-3;
const MIE_EXTINCTION = 4.44e-3;
const MIE_SCALE_HEIGHT = 1.2;
const MIE_G = 0.8;
const OZONE_ABSORPTION = vec3(0.65e-3, 1.881e-3, 0.085e-3);
const OZONE_CENTER = 25.0;
const OZONE_HALF_WIDTH = 15.0;

/** Uniforms shared by every atmosphere-aware material (updated once per frame). */
export const atmosphereUniforms = {
  /** Direction used for scattering; equals the real sun when lighting is on. */
  sunDirection: uniform(new Vector3(1, 0, 0)).setGroup(renderGroup),
  /** Real sun direction (ECEF) for surface lighting. */
  lightDirection: uniform(new Vector3(1, 0, 0)).setGroup(renderGroup),
  /** Camera position in atmosphere space (km). */
  cameraPositionKm: uniform(new Vector3(GROUND_RADIUS_KM * 3, 0, 0)).setGroup(renderGroup),
  /** Camera altitude above the ellipsoid (km), computed in float64 on the CPU. */
  cameraAltitudeKm: uniform(1000).setGroup(renderGroup),
  sunIntensity: uniform(10).setGroup(renderGroup),
  /** 0 disables the atmosphere entirely. */
  atmosphereEnabled: uniform(1).setGroup(renderGroup),
  /** Strength of the haze added on top of the ground. */
  groundHaze: uniform(1).setGroup(renderGroup),
  /** 1 = day/night sun lighting on the ground, 0 = imagery shown as-is. */
  lightingEnabled: uniform(0).setGroup(renderGroup),
  /**
   * 1 = "studio" atmosphere: every sample is lit from its zenith, giving a
   * uniform halo around the planet regardless of the sun (map mode).
   */
  uniformLighting: uniform(1).setGroup(renderGroup),
  nightBrightness: uniform(0.015).setGroup(renderGroup),
};

/** ECEF meters -> atmosphere-space kilometers. */
export function toAtmosphereSpace(p: TSLNode): TSLNode {
  return vec3(p.x, p.y, p.z.mul(Z_SCALE)).mul(0.001);
}

/** Ray/sphere intersection distances (near, far); near > far when missed. */
export function raySphere(ro: TSLNode, rd: TSLNode, radius: number | TSLNode): TSLNode {
  const b = dot(ro, rd);
  const r = float(radius);
  const c = dot(ro, ro).sub(r.mul(r));
  const d = b.mul(b).sub(c);
  const s = sqrt(max(d, 0));
  return select(d.greaterThanEqual(0), vec2(b.negate().sub(s), b.negate().add(s)), vec2(1e9, -1e9));
}

/**
 * Schüler's approximation of the Chapman grazing-incidence function, times
 * exp(-h): relative optical depth from a point at height h (in scale heights)
 * to space along a direction with zenith cosine `coschi`.
 */
function chapman(X: number, h: TSLNode, coschi: TSLNode): TSLNode {
  const c = sqrt(h.add(X));
  const expH = exp(h.negate());
  const upper = c.div(c.mul(coschi).add(1)).mul(expH);
  const sinchi = sqrt(max(float(1).sub(coschi.mul(coschi)), 0));
  const x0 = sinchi.mul(h.add(X));
  const c0 = sqrt(x0);
  const lower = c0.mul(2).mul(exp(min(float(X).sub(x0), 50))).sub(c.div(float(1).sub(c.mul(coschi))).mul(expH));
  return select(coschi.greaterThanEqual(0), upper, max(lower, 0));
}

/** Optical depth (rayleigh, mie, ozone) from a point towards the sun. */
export function sunOpticalDepth(height: TSLNode, mu: TSLNode): TSLNode {
  const odR = chapman(GROUND_RADIUS_KM / RAYLEIGH_SCALE_HEIGHT, height.div(RAYLEIGH_SCALE_HEIGHT), mu).mul(RAYLEIGH_SCALE_HEIGHT);
  const odM = chapman(GROUND_RADIUS_KM / MIE_SCALE_HEIGHT, height.div(MIE_SCALE_HEIGHT), mu).mul(MIE_SCALE_HEIGHT);
  // Ozone: column above the point times the Rayleigh air-mass factor.
  const airMass = min(odR.div(exp(height.div(RAYLEIGH_SCALE_HEIGHT).negate()).mul(RAYLEIGH_SCALE_HEIGHT).add(1e-4)), 40);
  const odO = clamp(float(40).sub(height).div(30), 0, 1).mul(OZONE_HALF_WIDTH).mul(airMass);
  return vec3(odR, odM, odO);
}

/** Total extinction coefficient times optical depth. */
export function extinction(od: TSLNode): TSLNode {
  return RAYLEIGH_SCATTERING.mul(od.x).add(vec3(MIE_EXTINCTION).mul(od.y)).add(OZONE_ABSORPTION.mul(od.z));
}

/** Soft earth-shadow factor for a point at radius r looking towards the sun. */
function earthShadow(height: TSLNode, r: TSLNode, mu: TSLNode): TSLNode {
  const horizonMu = sqrt(max(height.mul(height.add(2 * GROUND_RADIUS_KM)), 0)).div(r).negate();
  return smoothstep(horizonMu.sub(0.012), horizonMu.add(0.004), mu);
}

function rayleighPhase(mu: TSLNode): TSLNode {
  return mu.mul(mu).add(1).mul(3 / (16 * Math.PI));
}

function miePhase(mu: TSLNode): TSLNode {
  // Cornette-Shanks
  const g = MIE_G;
  const k = (3 / (8 * Math.PI)) * ((1 - g * g) / (2 + g * g));
  return mu.mul(mu).add(1).mul(k).div(pow(max(float(1 + g * g).sub(mu.mul(2 * g)), 1e-4), 1.5));
}

export interface ScatteringResult {
  inscatter: TSLNode;
  transmittance: TSLNode;
  /** 1 when the ray is blocked by the planet before tMax. */
  hitGround: TSLNode;
}

/**
 * Integrates single scattering along `ro + rd * t` for t in [0, tMax].
 * Must be called inside an `Fn` body (it emits loops and variables).
 *
 * @param groundC precomputed |ro|^2 - Rg^2 for the ground test (pass for
 *   camera rays: it is evaluated in float64 on the CPU), or null to skip
 *   the planet intersection.
 */
export function integrateScattering(
  ro: TSLNode,
  rd: TSLNode,
  tMax: TSLNode,
  sunDir: TSLNode,
  steps: number,
  groundC: TSLNode | null,
): ScatteringResult {
  const inscatter = vec3(0).toVar();
  const transmittance = vec3(1).toVar();
  const hitGround = float(0).toVar();

  const top = raySphere(ro, rd, TOP_RADIUS_KM);
  const tStart = max(top.x, 0).toVar();
  const tEnd = min(top.y, tMax).toVar();

  if (groundC !== null) {
    const b = dot(ro, rd);
    const d = b.mul(b).sub(groundC);
    const tGround = b.negate().sub(sqrt(max(d, 0)));
    If(d.greaterThanEqual(0).and(tGround.greaterThan(0)), () => {
      tEnd.assign(min(tEnd, tGround));
      hitGround.assign(1);
    });
  }

  If(tEnd.greaterThan(tStart), () => {
    const dt = tEnd.sub(tStart).div(steps);
    const odView = vec3(0).toVar();
    const sumR = vec3(0).toVar();
    const sumM = vec3(0).toVar();

    Loop(steps, ({ i }: { i: TSLNode }) => {
      const t = tStart.add(float(i).add(0.5).mul(dt));
      const p = ro.add(rd.mul(t));
      const r = p.length();
      const h = r.sub(GROUND_RADIUS_KM);
      const densR = exp(h.div(-RAYLEIGH_SCALE_HEIGHT));
      const densM = exp(h.div(-MIE_SCALE_HEIGHT));
      const densO = max(float(1).sub(abs(h.sub(OZONE_CENTER)).div(OZONE_HALF_WIDTH)), 0);
      const dens = vec3(densR, densM, densO).mul(dt);

      const odAtSample = odView.add(dens.mul(0.5));
      odView.addAssign(dens);

      const mu = mix(dot(p, sunDir).div(r), 1, atmosphereUniforms.uniformLighting);
      const odSun = sunOpticalDepth(h, mu);
      const T = exp(extinction(odAtSample.add(odSun)).negate());
      const lit = T.mul(earthShadow(h, r, mu)).mul(dt);
      sumR.addAssign(lit.mul(densR));
      sumM.addAssign(lit.mul(densM));
    });

    const mu = dot(rd, sunDir);
    const scattering = RAYLEIGH_SCATTERING.mul(sumR).mul(rayleighPhase(mu)).add(sumM.mul(MIE_SCATTERING).mul(miePhase(mu)));
    inscatter.assign(scattering.mul(atmosphereUniforms.sunIntensity));
    transmittance.assign(exp(extinction(odView).negate()));
  });

  return { inscatter, transmittance, hitGround };
}

/** Transmittance from a ground point to the sun, plus the sun zenith cosine. */
export function sunTransmittanceAt(pKm: TSLNode, sunDir: TSLNode): { transmittance: TSLNode; mu: TSLNode } {
  const r = pKm.length();
  const h = max(r.sub(GROUND_RADIUS_KM), 0);
  const mu = dot(pKm, sunDir).div(r);
  const T = exp(extinction(sunOpticalDepth(h, mu)).negate()).mul(earthShadow(h, r, mu));
  return { transmittance: T, mu };
}

/**
 * Sky radiance for a world-space view direction (used as scene background).
 */
export const skyColorNode = Fn(([viewDir]: [TSLNode]) => {
  const u = atmosphereUniforms;
  const rd = normalize(vec3(viewDir.x, viewDir.y, viewDir.z.mul(Z_SCALE)));
  const ro = u.cameraPositionKm;
  const h = u.cameraAltitudeKm;
  const groundC = h.mul(h.add(2 * GROUND_RADIUS_KM));
  const { inscatter, transmittance, hitGround } = integrateScattering(ro, rd, float(1e9), u.sunDirection, 16, groundC);

  // Sun disk with limb darkening, attenuated by the atmosphere.
  const cosSun = dot(rd, u.lightDirection);
  const sunDisk = smoothstep(0.99996, 0.99999, cosSun).mul(u.lightingEnabled);
  const sunGlow = pow(max(cosSun, 0), 2000).mul(0.6).mul(u.lightingEnabled);
  const sun = transmittance.mul(sunDisk.mul(60).add(sunGlow)).mul(float(1).sub(hitGround));

  // Stylized halo: the physical atmosphere is only ~1 px thick when seen from
  // far away, so add a soft glow whose width scales with the camera distance.
  const camDist = ro.length();
  const b = dot(ro, rd);
  const closest = sqrt(max(camDist.mul(camDist).sub(b.mul(b)), 0));
  const haloWidth = camDist.mul(0.012);
  const haloAlt = max(closest.sub(GROUND_RADIUS_KM), 0);
  const facing = smoothstep(0, -0.2, b.div(camDist)); // only rays heading towards the planet
  const closestDir = ro.add(rd.mul(b.negate())).div(max(closest, 1));
  const dayside = mix(float(1), smoothstep(-0.35, 0.25, dot(closestDir, u.sunDirection)), u.lightingEnabled);
  const haloFade = smoothstep(800, 6000, u.cameraAltitudeKm);
  const halo = vec3(0.32, 0.55, 1.0)
    .mul(exp(haloAlt.div(haloWidth).negate()).mul(0.55))
    .mul(facing)
    .mul(dayside)
    .mul(haloFade);

  return inscatter.add(halo).mul(u.atmosphereEnabled).add(sun);
});
