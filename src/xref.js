// YieldWire · src/xref.js — claim cross-reference (deterministic; LLM is never
// involved in verification).
//
// For each detected event, the headline claims in the fact line are checked
// against INDEPENDENT sources:
//   · TVL claim      → on-chain pool reserves (this run's crosscheck result,
//                      read via getReserves() from the pool contract)
//   · token peg claim→ CoinGecko price (independent of DeFiLlama's price index)
//   · "leader" claim → recomputed from the same run's full monitored universe
//
// Verdicts: CORROBORATED / INDEPENDENT-SOURCE-MATCH / PEG DEVIATION /
// UNVERIFIED (never silently drops — an unverifiable claim is labeled as such).
// Any source failure degrades that claim to UNVERIFIED; the event still ships.

import { poolTokens, EUR_PEG, PEG_BAND, EUR_CG_ID } from "./crosscheck.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cgPriceById(id) {
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, { signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    return j?.[id]?.usd ?? null;
  } catch {
    return null;
  }
}

// ev: event with pool, factLine, crosscheckEntry (may be null)
// universe: the run's normalized pool list (for leader re-derivation)
export async function crossReference(ev, universe, priceMap) {
  const claims = [];
  const sources = [];
  const pool = ev.pool;

  // 1 ── TVL claim vs on-chain reserves (from this run's crosscheck)
  const xc = ev.crosscheckEntry;
  const tvlClaim = `TVL $${Math.round(pool.tvl).toLocaleString("en-US")}`;
  if (xc && xc.status === "verified" && xc.onchainTvl != null) {
    claims.push({
      id: "TVL", claim: tvlClaim,
      verdict: xc.devPct <= 25 ? "CORROBORATED" : "DEVIATION",
      detail: `on-chain reserves at block ${xc.blockNumber} = $${xc.onchainTvl.toLocaleString("en-US")} (Δ ${xc.devPct}% vs DeFiLlama)`,
      via: "pool contract getReserves() · " + (xc.basescan || "Basescan"),
      link: xc.basescan,
    });
  } else {
    claims.push({
      id: "TVL", claim: tvlClaim, verdict: "UNVERIFIED",
      detail: "on-chain cross-check unavailable this run " + (xc ? `(${xc.status})` : "(pool not in this run's checked set)"),
      via: "awaiting on-chain cross-check", link: null,
    });
  }
  if (xc?.basescan) sources.push({ name: "Basescan (on-chain)", url: xc.basescan, fetchedAt: ev.ts });

  // 2 ── token peg claim vs CoinGecko (independent index).
  // Preferred: this run's crosscheck already read CoinGecko prices for the pool.
  const xcPeg = xc?.pegFlags || [];
  const xcPrices = xc?.prices || {};
  const toks = poolTokens(pool) || [];
  const syms = String(pool.symbol || "").split("-").filter(Boolean);
  const checkedSyms = new Set();
  for (let i = 0; i < toks.length; i++) {
    const s = syms[i] || `TOK${i}`;
    if (checkedSyms.has(s)) continue;
    checkedSyms.add(s);
    const id = priceMap[s];
    const link = id ? `https://www.coingecko.com/en/coins/${id}` : null;
    const pegLabel = EUR_PEG.has(s) ? "€" : "$";
    const flag = xcPeg.find((f) => f.symbol === s);
    if (flag) {
      claims.push({ id: "PEG", claim: `${s} treated as ${pegLabel}-stable`, verdict: "PEG DEVIATION", detail: `${s} trading at $${flag.price.toFixed(4)} — ${Math.abs(flag.offPegPct).toFixed(1)}% ${flag.offPegPct < 0 ? "below" : "above"} its ${flag.peg} peg (peg ref $${flag.refUsd}) per CoinGecko. An APY on this token is not ${flag.peg === "€1" ? "EUR" : "USD"} yield at face value.`, via: "CoinGecko" + (id ? " /coins/" + id : ""), link });
      if (link) sources.push({ name: `CoinGecko · ${s}`, url: link, fetchedAt: ev.ts });
      continue;
    }
    const p = xcPrices[s] ?? (id ? await cgPriceById(id) : null);
    if (p == null) {
      claims.push({ id: "PEG", claim: `${s} treated as ${pegLabel}-stable`, verdict: "UNVERIFIED", detail: "independent price unavailable this run", via: "CoinGecko", link: null });
      continue;
    }
    // The verdict tracks the PRICE, not whether the pool happened to be in
    // this run's on-chain verification set: a token beyond the same ±3% band
    // the cross-check uses is a PEG DEVIATION wherever it is read from.
    const ref = EUR_PEG.has(s) ? await cgPriceById(EUR_CG_ID) : 1.0;
    if (ref == null) {
      claims.push({ id: "PEG", claim: `${s} treated as ${pegLabel}-stable`, verdict: "UNVERIFIED", detail: "peg reference unavailable this run", via: "CoinGecko", link: null });
      continue;
    }
    const offPct = (p / ref - 1) * 100;
    if (Math.abs(p - ref) / ref > PEG_BAND) {
      claims.push({ id: "PEG", claim: `${s} treated as ${pegLabel}-stable`, verdict: "PEG DEVIATION", detail: `${s} trading at $${p.toFixed(4)} — ${Math.abs(offPct).toFixed(1)}% ${offPct < 0 ? "below" : "above"} its ${pegLabel}1 peg per CoinGecko. An APY on this token is not ${pegLabel === "€" ? "EUR" : "USD"} yield at face value.`, via: "CoinGecko" + (id ? " /coins/" + id : ""), link });
      if (link) sources.push({ name: `CoinGecko · ${s}`, url: link, fetchedAt: ev.ts });
      continue;
    }
    claims.push({ id: "PEG", claim: `${s} treated as ${pegLabel}-stable`, verdict: "INDEPENDENT-SOURCE-MATCH", detail: `${s} at $${p.toFixed(5)} per CoinGecko (Δ ${offPct.toFixed(2)}% vs ${pegLabel}1)`, via: "CoinGecko" + (id ? " /coins/" + id : ""), link });
    if (link) sources.push({ name: `CoinGecko · ${s}`, url: link, fetchedAt: ev.ts });
    if (id) await sleep(300);
  }

  // 3 ── leader claim → recompute from this run's universe (deterministic)
  if (String(ev.type).startsWith("NEW-LEADER") || /leader|highest/i.test(ev.factLine || "")) {
    const best = [...universe].sort((a, b) => b.apy - a.apy)[0];
    const rank = [...universe].sort((a, b) => b.apy - a.apy).findIndex((p) => p.id === pool.id) + 1;
    if (best?.id === pool.id) {
      claims.push({ id: "LEADER", claim: "highest APY among monitored Base stablecoin pools", verdict: "CORROBORATED", detail: `recomputed from this run's ${universe.length}-pool universe: rank #1 of ${universe.length}`, via: "deterministic re-derivation (no LLM)", link: null });
    } else {
      claims.push({ id: "LEADER", claim: "highest APY among monitored Base stablecoin pools", verdict: "RECOMPUTED-CHANGED", detail: `recomputed: this pool is rank #${rank} of ${universe.length}; current top is ${best?.symbol || "?"} at ${best?.apy.toFixed(2)}%`, via: "deterministic re-derivation (no LLM)", link: null });
    }
  }

  return { claims, sources, checkedAt: ev.ts };
}
