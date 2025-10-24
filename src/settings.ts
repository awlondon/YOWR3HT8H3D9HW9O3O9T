export type SymbolEmitMode = 'paired' | 'standalone' | 'both';

const DEFAULT_SETTINGS = {
  tokenizeSymbols: true,
  symbolWeightScale: 0.35,
  symbolEmitMode: 'paired' as SymbolEmitMode,
  includeSymbolInSummaries: false,
};

type SettingsShape = typeof DEFAULT_SETTINGS & Record<string, unknown>;

function resolveGlobalSettings(): SettingsShape {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_SETTINGS };
  }

  const existing = (window as any).SETTINGS || {};
  const merged = { ...DEFAULT_SETTINGS, ...existing } as SettingsShape;
  (window as any).SETTINGS = merged;
  (window as any).CognitionEngine = (window as any).CognitionEngine || {};
  (window as any).CognitionEngine.settings = merged;
  return merged;
}

export const SETTINGS = resolveGlobalSettings();
export type Settings = typeof SETTINGS;
