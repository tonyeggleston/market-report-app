// Runtime-overridable selectors.
//
// Every fragile selector in the scrapers is wrapped in sel('dotted.key', '<default>').
// At the start of a run we fetch an override map from the hosted config
// (selectors.json). If a key is present there, it wins; otherwise the inline
// default is used. This lets selector fixes ship as a config push (edit JSON,
// deploy, re-run) instead of a full app rebuild + reinstall.
//
// Safety: the config is DATA ONLY (a flat map of key -> selector string). It is
// never executed as code. If the fetch fails or a key is absent, the bundled
// default is used, so the app can never be broken by a missing/blank config.

const CONFIG_URL = process.env.MR_SELECTORS_URL || 'https://marketpulse.commandmodule.com/selectors.json';

let overrides = {};      // flat map: "dotted.key" -> "selector string"
let loaded = false;

export async function loadSelectors(onProgress) {
  if (loaded) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(CONFIG_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      // Accept only string values; ignore anything else defensively.
      const clean = {};
      for (const [k, v] of Object.entries(data || {})) {
        if (typeof v === 'string' && v.trim()) clean[k] = v;
      }
      overrides = clean;
      if (onProgress) onProgress('Preparing browser...', `Loaded ${Object.keys(overrides).length} selector override(s)`);
    }
  } catch {
    // Offline or config unreachable — bundled defaults are used. Not fatal.
  }
  loaded = true;
}

// Return the override for `key` if present, else the bundled default.
export function sel(key, def) {
  const v = overrides[key];
  return (typeof v === 'string' && v.trim()) ? v : def;
}
