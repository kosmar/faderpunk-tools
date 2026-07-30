/** Persisted Scopepunk UI prefs (GitHub Pages / any origin). */
export type ScopePrefs = {
  masterGain?: number;
  keyPc?: number;
  clockBpm?: number;
  viewMode?: "all" | "solo" | "compare";
  /** layout_id values muted last session */
  mutedLayoutIds?: number[];
};

const KEY = "scopepunk-prefs-v1";

export function loadScopePrefs(): ScopePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ScopePrefs;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function patchScopePrefs(partial: ScopePrefs): void {
  try {
    const next = { ...loadScopePrefs(), ...partial };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (e) {
    console.warn("scopepunk prefs save failed", e);
  }
}
