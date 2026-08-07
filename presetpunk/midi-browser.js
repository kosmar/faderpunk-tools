/**
 * Browser MIDI CC catalog helpers for static hosting (GitHub Pages).
 * When the local Node server is available, callers prefer ./api/* instead.
 */
(function (global) {
  const REPO = "pencilresearch/midi";
  const TREE_CACHE_KEY = "fp-midi-tree-v1";
  const CUSTOM_KEY = "fp-midi-custom-v1";
  const TREE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  function parseCsvCcs(text) {
    const lines = String(text || "").split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const headers = lines[0].split(",");
    const idxMsb = headers.indexOf("cc_msb");
    const idxName = headers.indexOf("parameter_name");
    const idxSec = headers.indexOf("section");
    const seen = new Set();
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = [];
      let cur = "";
      let q = false;
      for (const ch of lines[i]) {
        if (ch === '"') {
          q = !q;
          continue;
        }
        if (ch === "," && !q) {
          cols.push(cur);
          cur = "";
          continue;
        }
        cur += ch;
      }
      cols.push(cur);
      const msb = (cols[idxMsb] || "").trim();
      if (!msb) continue;
      const cc = Number(msb);
      if (!Number.isFinite(cc) || seen.has(cc)) continue;
      seen.add(cc);
      const name = cols[idxName] || `CC${cc}`;
      const sec = cols[idxSec] || "";
      rows.push({ cc, name: sec ? `${sec}: ${name}` : name });
    }
    return rows.sort((a, b) => a.cc - b.cc);
  }

  function loadCustom() {
    try {
      return JSON.parse(localStorage.getItem(CUSTOM_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }

  function saveCustom(map) {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(map));
  }

  function cdnCsvUrl(path) {
    const enc = String(path)
      .split("/")
      .map((p) => encodeURIComponent(p))
      .join("/");
    return `https://cdn.jsdelivr.net/gh/${REPO}@main/${enc}`;
  }

  async function fetchGithubCsvPaths() {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) throw new Error(`GitHub tree ${res.status}`);
    const data = await res.json();
    return (data.tree || [])
      .filter(
        (t) =>
          t.type === "blob" &&
          /\.csv$/i.test(t.path) &&
          !String(t.path).startsWith("."),
      )
      .map((t) => t.path);
  }

  async function listCatalog() {
    const customPaths = Object.keys(loadCustom()).sort();
    let upstream = [];
    try {
      const cached = JSON.parse(localStorage.getItem(TREE_CACHE_KEY) || "null");
      if (
        cached?.paths?.length &&
        Date.now() - (cached.at || 0) < TREE_TTL_MS
      ) {
        upstream = cached.paths;
      } else {
        upstream = await fetchGithubCsvPaths();
        localStorage.setItem(
          TREE_CACHE_KEY,
          JSON.stringify({ at: Date.now(), paths: upstream }),
        );
      }
    } catch {
      try {
        const cached = JSON.parse(localStorage.getItem(TREE_CACHE_KEY) || "null");
        upstream = cached?.paths || [];
      } catch {
        upstream = [];
      }
    }
    return [...customPaths, ...upstream];
  }

  async function fetchCcs(csvPath) {
    if (!csvPath) return [];
    const custom = loadCustom();
    if (custom[csvPath] != null) {
      return parseCsvCcs(custom[csvPath]);
    }
    const res = await fetch(cdnCsvUrl(csvPath));
    if (!res.ok) throw new Error(`CC CSV unreadable (${res.status})`);
    return parseCsvCcs(await res.text());
  }

  function uploadCustom(name, text) {
    const safe = String(name || "upload.csv")
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      .replace(/[^a-zA-Z0-9._-]+/g, "_");
    const path = `custom/${safe.endsWith(".csv") ? safe : `${safe}.csv`}`;
    const all = loadCustom();
    all[path] = String(text || "");
    saveCustom(all);
    return { ok: true, path };
  }

  async function syncFromGithub() {
    const paths = await fetchGithubCsvPaths();
    localStorage.setItem(
      TREE_CACHE_KEY,
      JSON.stringify({ at: Date.now(), paths }),
    );
    return {
      ok: true,
      message: `${paths.length} CSVs indexed from GitHub`,
      count: paths.length,
    };
  }

  /** True on GitHub Pages / file:// — no Node ./api/* server. */
  function isStaticHost() {
    try {
      if (typeof location === "undefined") return false;
      if (location.protocol === "file:") return true;
      return /\.github\.io$/i.test(location.hostname || "");
    } catch {
      return false;
    }
  }

  /** Once we see a 404 from ./api/*, stop probing for this page load. */
  let serverApiAvailable = isStaticHost() ? false : null;

  /** Probe local Node API; null if static host / offline / already known missing. */
  async function tryServerJson(url, opts) {
    if (serverApiAvailable === false) return null;
    try {
      const res = await fetch(url, opts);
      if (res.status === 404) {
        serverApiAvailable = false;
        return null;
      }
      serverApiAvailable = true;
      const data = await res.json().catch(() => null);
      return { res, data };
    } catch {
      return null;
    }
  }

  global.MidiBrowser = {
    parseCsvCcs,
    listCatalog,
    fetchCcs,
    uploadCustom,
    syncFromGithub,
    tryServerJson,
    isStaticHost,
  };
})(typeof window !== "undefined" ? window : globalThis);
