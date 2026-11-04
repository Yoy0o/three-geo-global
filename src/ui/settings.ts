/** UI preferences and user-supplied credentials, kept in this browser only. */
export type TerrainChoice = 'none' | 'aws' | 'mapbox' | 'maptiler' | 'cesium' | 'qm-url';

export interface OverlaySetting {
  id: string;
  opacity: number;
  visible: boolean;
}

export interface Settings {
  imagery: string;
  customImageryUrl: string;
  /** @deprecated kept for migrating older saved settings; use `terrainSource`. */
  terrain: boolean;
  terrainSource: TerrainChoice;
  mapboxToken: string;
  maptilerKey: string;
  quantizedMeshUrl: string;
  overlays: OverlaySetting[];
  exaggeration: number;
  atmosphere: boolean;
  lighting: boolean;
  stars: boolean;
  quality: number;
  tiandituKey: string;
  ionToken: string;
  googleKey: string;
}

const KEY = 'three-geo-global:settings';

export const DEFAULT_SETTINGS: Settings = {
  imagery: 'esri-imagery',
  customImageryUrl: '',
  terrain: true,
  terrainSource: 'aws',
  mapboxToken: '',
  maptilerKey: '',
  quantizedMeshUrl: '',
  overlays: [],
  exaggeration: 1,
  atmosphere: true,
  lighting: false,
  stars: true,
  quality: 1.25,
  tiandituKey: '',
  ionToken: '',
  googleKey: '',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      const merged = { ...DEFAULT_SETTINGS, ...saved };
      if (saved.terrainSource === undefined && saved.terrain === false) merged.terrainSource = 'none';
      if (!Array.isArray(merged.overlays)) merged.overlays = [];
      return merged;
    }
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
