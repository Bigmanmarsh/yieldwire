// YieldWire · src/logos.js — decorative coin logos, from a static map.
//
// src/coin-logos.json is a curated symbol → logo URL map, built once
// (src/build-logos.mjs) from the free, keyless CoinGecko API and committed
// to the repo. Per-run cost: ZERO requests — the agent's market data still
// comes from exactly one live source (DeFiLlama), and this file adds no
// per-run third-party dependency, no rate-limit risk, no new failure mode.
//
// Strict separation: logos are UI decoration only. The detection engine
// never reads them; a missing logo degrades to a letter monogram on the
// site. Nothing here can fail a run or change a number.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MAP_PATH = join(dirname(fileURLToPath(import.meta.url)), "coin-logos.json");

let MAP = null;
function map() {
  if (MAP === null) {
    try {
      MAP = JSON.parse(readFileSync(MAP_PATH, "utf8"));
    } catch {
      MAP = {};
    }
  }
  return MAP;
}

/**
 * Map of BASE-TOKEN SYMBOL (upper) → logo URL or null.
 * A pool symbol like "MSUSD-USDC" yields the base token "MSUSD".
 */
export async function getCoinLogos(baseSymbols) {
  const m = map();
  const out = {};
  for (const sym of new Set(baseSymbols.map((s) => String(s).toUpperCase()).filter(Boolean))) {
    out[sym] = m[sym] || null;
  }
  return out;
}

export const baseSymbol = (poolSymbol) => String(poolSymbol || "").split("-")[0].toUpperCase();
