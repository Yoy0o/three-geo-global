/** UI preferences and user-supplied credentials, kept in this browser only. */
export interface Settings {
  imagery: string;
  customImageryUrl: string;
  terrain: boolean;
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
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
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
