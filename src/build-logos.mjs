// One-shot builder: src/coin-logos.json (run manually, NOT part of the agent).
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Curated base tokens that can appear on the Base stablecoin board.
const SYMBOLS = [
  "USDC","USDS","USDE","DAI","USDT","EURC","JEUR","MSUSD","SYRUPUSDC",
  "GTUSDA","GTUSDCP","STEAKUSDC","MWUSDC","MWEURC","CRVUSD","SUSD","SDAI",
  "EUSDM","SUSDE","USDBC","ZVUSDC","DEUSD","USDF","FRAX","LUSD","GHO","TUSD","FDUSD","PYUSD","USDM",
];
// Manual disambiguation where several coins share a symbol.
const OVERRIDE = {
  MSUSD: "metronome-synth-usd",
  USDC: "usd-coin",
  JEUR: "jarvis-synthetic-euro",
  EURC: "euro-coin",
  USDS: "usd-stablecoin",
  USDE: "usde",
};

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { accept: "application/json" } });
    if (res.status === 429) { console.log("  429 — backoff 12s"); await sleep(12000); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  throw new Error("429 after retries");
}

const list = await getJson("https://api.coingecko.com/api/v3/coins/list");
const idBySymbol = new Map();
for (const c of list) {
  const sym = String(c.symbol || "").toUpperCase();
  if (sym && !idBySymbol.has(sym)) idBySymbol.set(sym, c.id);
}

const out = {};
for (const sym of SYMBOLS) {
  const id = OVERRIDE[sym] || idBySymbol.get(sym);
  if (!id) { console.log(`${sym}: no CoinGecko match → monogram`); continue; }
  try {
    const c = await getJson(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`);
    const url = c.image?.small || c.image?.thumb || null;
    if (url) { out[sym] = url; console.log(`${sym} (${id}) → ${url}`); }
    else console.log(`${sym} (${id}): no image → monogram`);
  } catch (err) {
    console.log(`${sym} (${id}): FAILED ${err.message} → monogram`);
  }
  await sleep(3500);
}

writeFileSync(join(root, "src/coin-logos.json"), JSON.stringify(out, null, 2));
console.log(`\nwrote src/coin-logos.json with ${Object.keys(out).length}/${SYMBOLS.length} logos`);
