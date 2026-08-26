// YieldWire · src/data.js
// The single source of truth: the DeFiLlama yields endpoint.
// No API keys. No other provider in v1. Everything the agent "knows"
// about the market comes from this one call, and the site says so.

const API_URL = "https://yields.llama.fi/pools";
const ENDPOINT_LABEL = "DeFiLlama /yields → GET https://yields.llama.fi/pools";

export async function fetchPools() {
  const res = await fetch(API_URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`DeFiLlama HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.data) || json.data.length === 0) {
    throw new Error("DeFiLlama returned no pool data");
  }
  return json.data;
}

export const ENDPOINT = ENDPOINT_LABEL;
export const FIELDS_USED = [
  "pool (id)",
  "chain",
  "project",
  "symbol",
  "stablecoin",
  "tvlUsd",
  "apy",
  "apyBase",
  "apyReward",
  "apyPct1D",
];
