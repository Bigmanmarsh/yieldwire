// YieldWire · src/logos.js — coin logos, three layers.
//
// 1. STATIC curated map (src/coin-logos.json) — built from CoinGecko,
//    committed, ZERO per-run cost.
// 2. PERSISTED resolutions (state.coinLogos in data/state.json) — each
//    NEW symbol is live-resolved exactly once, then the URL is cached
//    forever in the public history. A coin that joins the board gets its
//    logo on the first cycle where budget allows, and never needs work again.
// 3. LIVE one-shot resolution via the free keyless CoinGecko API — only
//    for symbols missing from layers 1+2. Budgeted: max 5 calls per
//    cycle, 2s gap between calls, any 429 stops live lookups for the
//    cycle (the rest resolve in later cycles).
//
// Strict separation (unchanged): logos are UI decoration only. The
// detection engine never reads them. Every lookup is best-effort and
// wrapped — nothing here can fail a run or change a number. A pool with
// no resolvable logo renders as a letter monogram on the site.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MAP_PATH = join(dirname(fileURLToPath(import.meta.url)), "coin-logos.json");
const MAX_BATCH = 200; // CoinGecko /coins/markets accepts up to 250 ids; keep headroom
const LIVE_GAP_MS = 2000; // politeness gap before the batch call

// Manual disambiguation where several coins share a symbol (kept in sync
// with build-logos.mjs).
const OVERRIDE = {
  MSUSD: "metronome-synth-usd",
  USDC: "usd-coin",
  JEUR: "jarvis-synthetic-euro",
  EURC: "euro-coin",
  USDS: "usd-stablecoin",
  USDE: "usde",
};

let MAP = null;
function staticMap() {
  if (MAP === null) {
    try { MAP = JSON.parse(readFileSync(MAP_PATH, "utf8")); } catch { MAP = {}; }
  }
  return MAP;
}

let LIST_CACHE = null; // symbol(UPPER) → CoinGecko id, once per process
async function coinList() {
  if (LIST_CACHE === null) {
    const r = await fetch("https://api.coingecko.com/api/v3/coins/list", {
      signal: AbortSignal.timeout(20000), headers: { accept: "application/json" },
    });
    if (!r.ok) throw new Error("coins/list HTTP " + r.status);
    const arr = await r.json();
    LIST_CACHE = new Map();
    for (const c of arr) {
      const s = String(c.symbol || "").toUpperCase();
      if (s && !LIST_CACHE.has(s)) LIST_CACHE.set(s, c.id);
    }
  }
  return LIST_CACHE;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string[]} baseSymbols base-token symbols (UPPER) of this run's pools
 * @param {object} cache persistable cache object (state.coinLogos) — mutated
 *   in place with newly resolved URLs so the caller can persist them
 * @returns {Promise<object>} symbol → logo URL (null where unresolvable)
 *
 * Live layer = TWO network calls per cycle, max: one /coins/list (cached
 * per process) + ONE batched /coins/markets?ids=… covering every missing
 * symbol at once (capped at MAX_BATCH). No per-symbol hammering, so the
 * free-tier rate limit is barely touched. If more than MAX_BATCH symbols
 * are missing at once, the surplus simply resolves in a later cycle.
 */
export async function getCoinLogos(baseSymbols, cache = {}) {
  const m = staticMap();
  const all = [...new Set(baseSymbols.map((s) => String(s || "").toUpperCase()).filter(Boolean))];
  const missing = all.filter((s) => !m[s] && !cache[s]);
  const out = {};

  if (missing.length) {
    const batch = missing.slice(0, MAX_BATCH);
    try {
      const idBySym = await coinList();
      const symToId = {};
      for (const sym of batch) {
        const id = OVERRIDE[sym] || idBySym.get(sym);
        if (id) symToId[sym] = id;
      }
      if (Object.keys(symToId).length) {
        await sleep(LIVE_GAP_MS);
        const ids = [...new Set(Object.values(symToId))].join(",");
        const r = await fetch(
          `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=`,
          { signal: AbortSignal.timeout(20000), headers: { accept: "application/json" } },
        );
        if (r.status !== 429 && r.ok) {
          const rows = await r.json();
          const idToUrl = new Map();
          for (const row of rows) if (row && row.id && row.image) idToUrl.set(row.id, row.image);
          for (const [sym, id] of Object.entries(symToId)) {
            const url = idToUrl.get(id) || null;
            if (url) { cache[sym] = url; out[sym] = url; }
          }
        }
        // 429 or error → nothing persists this cycle; retried next cycle.
      }
    } catch { /* best-effort: stays null, retried next cycle */ }
  }

  for (const sym of all) out[sym] = m[sym] || cache[sym] || out[sym] || null;
  return out;
}

export const baseSymbol = (poolSymbol) => String(poolSymbol || "").split("-")[0].toUpperCase();
