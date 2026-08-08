import type { AppUx, AppUxCatalog } from "./types";

let catalog: AppUxCatalog | null = null;
let loadPromise: Promise<AppUxCatalog | null> | null = null;

function isCatalog(v: unknown): v is AppUxCatalog {
  if (!v || typeof v !== "object") return false;
  const o = v as AppUxCatalog;
  return o.version === 1 && o.apps != null && typeof o.apps === "object";
}

/** Fetch once; missing file / bad JSON → null (callers fall back to CONFIG desc). */
export function loadAppUxCatalog(): Promise<AppUxCatalog | null> {
  if (catalog) return Promise.resolve(catalog);
  if (loadPromise) return loadPromise;
  // Bust CDN/browser cache when Pages rebuilds (VITE_BUILD_MS set in CI).
  const bust = import.meta.env.VITE_BUILD_MS ?? "dev";
  const url = `${import.meta.env.BASE_URL}app-ux.json?v=${bust}`;
  loadPromise = fetch(url, { cache: "no-cache" })
    .then(async (res) => {
      if (!res.ok) return null;
      const data: unknown = await res.json();
      if (!isCatalog(data)) return null;
      catalog = data;
      return catalog;
    })
    .catch(() => null);
  return loadPromise;
}

export function uxForApp(
  apps: AppUxCatalog | null | undefined,
  appId: number,
): AppUx | null {
  if (!apps) return null;
  return apps.apps[String(appId)] ?? null;
}
