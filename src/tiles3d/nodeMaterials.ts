import { DoubleSide, type Material, type Mesh, type Object3D } from 'three';
import { float, Fn, materialReference, screenCoordinate } from 'three/tsl';
import type { TSLNode } from '../atmosphere/AtmosphereNodes';

/** Converts plain materials to their node equivalents (`renderer.library.fromMaterial`). */
export interface NodeMaterialLibrary {
  fromMaterial(material: Material): Material | null;
}

interface FadeableMaterial extends Material {
  isNodeMaterial?: boolean;
  maskNode?: TSLNode | null;
  fadeIn: number;
  fadeOut: number;
}

function materialsOf(object: Object3D): Material[] {
  const m = (object as Mesh).material;
  if (!m) return [];
  return Array.isArray(m) ? m : [m];
}

/**
 * 3DTilesRendererJS plugin that turns tile materials into node materials while
 * the tile is being parsed (`processTileModel` runs before the renderer
 * records the materials it will dispose, so nothing leaks). Node materials are
 * what WebGPURenderer would create internally anyway; owning them lets us add
 * TSL features such as the LOD fade.
 */
export class NodeMaterialPlugin {
  readonly name = 'NODE_MATERIAL_PLUGIN';

  constructor(private readonly library: NodeMaterialLibrary) {}

  processTileModel(scene: Object3D): void {
    scene.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.material) return;
      const convert = (m: Material): Material => {
        const node = this.library.fromMaterial(m) ?? m;
        // Photogrammetry often has inconsistent winding; avoid holes.
        node.side = DoubleSide;
        return node;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
    });
  }
}

let sharedMask: TSLNode | null = null;

/**
 * Screen-space 4x4 Bayer dither (same pattern as 3DTilesRendererJS's GLSL
 * fade): keeps fragments whose threshold lies in [fadeOut, fadeIn). One node
 * instance is shared by every material so they keep sharing pipelines.
 */
export function fadeMaskNode(): TSLNode {
  if (sharedMask) return sharedMask;
  const fadeIn: TSLNode = materialReference('fadeIn', 'float');
  const fadeOut: TSLNode = materialReference('fadeOut', 'float');
  sharedMask = Fn(() => {
    const v: TSLNode = (screenCoordinate.xy as TSLNode).mod(4).floor();
    const bayer2 = (p: TSLNode): TSLNode => p.y.mul(3).add(p.x.mul(2)).mod(4);
    const bayer4: TSLNode = bayer2(v.mod(2)).mul(4).add(bayer2(v.mod(4).mul(0.5).floor()));
    const dither: TSLNode = bayer4.add(0.5).div(float(16));
    return dither.lessThan(fadeIn).and(dither.greaterThanEqual(fadeOut));
  })();
  return sharedMask;
}

/**
 * Drop-in replacement for the library's FadeMaterialManager, whose shader
 * patching relies on `onBeforeCompile` and therefore does nothing under
 * WebGPU. Fading materials get the shared dither `maskNode`; finished ones
 * drop it again so steady-state tiles keep early depth testing.
 */
export class NodeFadeMaterialManager {
  /** Number of materials currently fading (read by the plugin). */
  fading = 0;
  private readonly state = new WeakMap<Material, { fading: boolean }>();

  prepareScene(scene: Object3D): void {
    scene.traverse((child) => {
      for (const m of materialsOf(child)) this.prepareMaterial(m);
    });
  }

  prepareMaterial(material: Material): void {
    const m = material as FadeableMaterial;
    if (!m.isNodeMaterial || this.state.has(m)) return;
    m.fadeIn = 0;
    m.fadeOut = 0;
    this.state.set(m, { fading: false });
  }

  setFade(scene: Object3D | null, fadeIn: number, fadeOut: number): void {
    if (!scene) return;
    const fading = !(fadeIn === 0 || fadeIn === 1) || !(fadeOut === 0 || fadeOut === 1);
    scene.traverse((child) => {
      for (const material of materialsOf(child)) {
        const s = this.state.get(material);
        if (!s) continue;
        const m = material as FadeableMaterial;
        m.fadeIn = fadeIn;
        m.fadeOut = fadeOut;
        if (s.fading !== fading) {
          s.fading = fading;
          this.fading += fading ? 1 : -1;
          m.maskNode = fading ? fadeMaskNode() : null;
          m.needsUpdate = true;
        }
      }
    });
  }

  deleteScene(scene: Object3D | null): void {
    if (!scene) return;
    this.setFade(scene, 1, 0);
    scene.traverse((child) => {
      for (const m of materialsOf(child)) this.state.delete(m);
    });
  }
}
