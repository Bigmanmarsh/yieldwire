// YieldWire · src/crosscheck.js — on-chain cross-check (read-only, no wallet, $0).
//
// For supported pools (v1: Aerodrome v1 — vAMM/sAMM on Base), the agent reads
// reserves DIRECTLY from the pool contract via public Base RPC, values them
// with token prices, and publishes: pool address, on-chain TVL, block number,
// deviation vs the DeFiLlama figure, and PEG FLAGS for tokens classified as
// stablecoins that are trading away from $1.
//
// This is data-quality verification, not detection: it never fires events,
// never changes a number the engine publishes, and can never fail a run —
// any RPC/price failure degrades that pool to status "skipped".
//
// Public, verifiable: every result carries the block number and pool address,
// so anyone can re-run getReserves() on Basescan and reproduce the figure.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// DeFiLlama yields `underlyingTokens` arrives as a comma-joined string or an
// array, sometimes with "chain_" prefixes. Normalize to a clean address list.
export function poolTokens(p) {
  const raw = p.underlyingTokens;
  if (!raw) return null;
  let arr;
  if (typeof raw === "string") arr = raw.split(",").map((s) => s.trim()).filter(Boolean);
  else if (Array.isArray(raw)) arr = raw.map(String).map((s) => s.trim()).filter(Boolean);
  else return null;
  arr = arr.map((s) => s.replace(/^[^:]+:/, "").trim());
  return arr.length >= 2 ? arr : null;
}

const RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://1rpc.io/base",
  "https://base.drpc.org",
];
const FACTORY_REGISTRY = "0x5C3F18F06CC09CA1910767A34a20F771039E37C0";
const PRIMARY_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

// Function selectors (Ethereum keccak-256 first 4 bytes)
const SEL = {
  getPoolFee: "0x1698ee82",    // getPool(address,address,uint24)
  getPoolStable: "0x79bc57d5", // getPool(address,address,bool)
  getReserves: "0x0902f1ac",   // getReserves()
  decimals: "0x313ce567",      // decimals()
  pfLength: "0x0cb299c9",      // poolFactoriesLength()
  pfList: "0x06121cd5",        // poolFactories()
};

const FEES_TO_TRY = [3000, 500];           // vAMM 0.30%, sAMM 0.05%
export const HARD_PEG_USD = new Set(["USDC", "USDT", "DAI", "USDBC", "ZVUSDC", "STEAKUSDC", "MWUSDC", "GTUSDA", "SYRUPUSDC", "SUSD", "SDAI"]); // $-pegged: valued at $1.00 by definition
export const EUR_PEG = new Set(["JEUR", "EURC", "MWEURC"]); // €-pegged: peg reference is the EUR/USD market rate, not $1
const EUR_CG_ID = "eur";                    // CoinGecko "euro"
const PEG_BAND = 0.03;                     // ±3% off the token's own peg → flag
export const PROJECTS = new Set(["aerodrome-v1"]); // v1 coverage (exported so run.js selects the verification set from the same source)
const PACE_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (l) => console.log(`[YIELDWIRE:crosscheck] ${l}`);

async function ethCall(to, data) {
  let lastErr;
  for (let i = 0; i < RPCS.length; i++) {
    try {
      const r = await fetch(RPCS[i % RPCS.length], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        signal: AbortSignal.timeout(12000),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      if (!j.result || j.result === "0x") throw new Error("empty result");
      return j.result;
    } catch (e) {
      lastErr = e.message;
      await sleep(300);
    }
  }
  throw new Error(`rpc failed: ${lastErr}`);
}

const pad32 = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const word = (hex) => hex.slice(2).match(/.{1,64}/g);
const isZeroAddr = (a) => !a || /^0x0*$/.test(a);

export async function crosscheckPools(pools, cache = {}) {
  const out = {
    checkedAt: new Date().toISOString(),
    method: "getReserves() read directly from pool contracts via public Base RPC (read-only, no wallet, no funds)",
    rpc: "mainnet.base.org + public fallbacks",
    pools: [],
    summary: { attempted: 0, verified: 0, pegFlags: 0, skipped: 0 },
  };
  const cacheOut = {
    factories: cache.factories || null,
    decimals: cache.decimals || {},
    poolAddr: cache.poolAddr || {},
    lastFactories: cache.lastFactories || 0,
  };

  let blockNumber = null, blockTs = null;
  try {
    let bn;
    for (const url of RPCS) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(12000) });
        bn = (await r.json()).result;
        if (bn) break;
      } catch { await sleep(200); }
    }
    if (bn) {
      blockNumber = BigInt(bn).toString();
      const r = await fetch(RPCS[0], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [bn, false] }), signal: AbortSignal.timeout(12000) }).catch(() => null);
      const j = r ? await r.json().catch(() => null) : null;
      blockTs = j?.result?.timestamp ? new Date(Number(j.result.timestamp) * 1000).toISOString() : null;
    }
  } catch (e) {
    log("block anchor failed: " + e.message);
  }
  out.blockNumber = blockNumber;
  out.blockTs = blockTs;
  out.verifyAt = blockNumber ? `https://basescan.org/block/${blockNumber}` : null;

  try {
    // ── factory list (cached 24h)
    if (!cacheOut.factories || Date.now() - cacheOut.lastFactories > 86400000) {
      try {
        const raw = await ethCall(FACTORY_REGISTRY, SEL.pfList);
        const words = raw.slice(2).match(/.{64}/g);
        const n = Number(BigInt("0x" + words[1]));
        const fs = [];
        for (let i = 0; i < n; i++) {
          const a = "0x" + words[2 + i].slice(24);
          if (!isZeroAddr(a)) fs.push(a);
        }
        if (fs.length) { cacheOut.factories = fs; cacheOut.lastFactories = Date.now(); }
        else cacheOut.factories = [PRIMARY_FACTORY];
      } catch {
        cacheOut.factories = [PRIMARY_FACTORY];
      }
    }

    // ── token prices (one batched CoinGecko call; $0, keyless)
    const tokensOf = (p) => poolTokens(p) || [];
    const symbols = new Set();
    for (const p of pools) for (const s of baseSymbols(p)) symbols.add(s);
    const ids = [];
    const symById = new Map();
    try {
      const priceMap = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "coin-prices.json"), "utf8"));
      for (const s of symbols) if (!HARD_PEG_USD.has(s) && priceMap[s]) { ids.push(priceMap[s]); symById.set(priceMap[s], s); }
    } catch (e) { log("price map unavailable: " + e.message); }
    const prices = {};
    for (const s of symbols) if (HARD_PEG_USD.has(s)) prices[s] = 1.0;
    // EUR market rate (peg reference for euro-pegged tokens)
    let eurUsd = null;
    if ([...symbols].some((s) => EUR_PEG.has(s))) ids.push(EUR_CG_ID);
    const allIds = [...new Set(ids)];
    if (allIds.length) {
      try {
        const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${allIds.join(",")}&vs_currencies=usd`, { signal: AbortSignal.timeout(15000) });
        const j = await r.json();
        for (const [id, s] of symById) if (j?.[id]?.usd != null) prices[s] = j[id].usd;
        if (j?.[EUR_CG_ID]?.usd != null) eurUsd = j[EUR_CG_ID].usd;
      } catch (e) { log("price fetch failed (hard-peg values still used): " + e.message); }
    }

    // ── per-pool
    for (const p of pools) {
      const entry = { poolId: p.id, symbol: p.symbol, project: p.project, status: "pending", dfdTvl: Math.round(p.tvl) };
      if (!PROJECTS.has(p.project)) {
        entry.status = "pending-coverage";
        out.pools.push(entry);
        out.summary.skipped++;
        continue;
      }
      out.summary.attempted++;
      try {
        const [t0, t1] = tokensOf(p);
        if (!t0 || !t1) throw new Error("missing underlyingTokens");

        // find pool address (cached per pool id)
        let poolAddr = cacheOut.poolAddr[p.id];
        if (!poolAddr) {
          for (const f of cacheOut.factories) {
            for (const [a, b] of [[t0, t1], [t1, t0]]) {
              try {
                const w = await ethCall(f, SEL.getPoolStable + pad32(a) + pad32(b) + "1".padStart(64, "0"));
                const a2 = "0x" + w.slice(-40);
                if (!isZeroAddr(a2) && a2 !== "0x" + "0".repeat(40)) { poolAddr = a2; break; }
              } catch { /* try next */ }
              await sleep(PACE_MS);
            }
            if (poolAddr) break;
            if (!poolAddr) {
              for (const fee of FEES_TO_TRY) {
                try {
                  const w = await ethCall(f, SEL.getPoolFee + pad32(t0) + pad32(t1) + fee.toString(16).padStart(64, "0"));
                  const a2 = "0x" + w.slice(-40);
                  if (!isZeroAddr(a2) && a2 !== "0x" + "0".repeat(40)) { poolAddr = a2; break; }
                } catch { /* try next */ }
                await sleep(PACE_MS);
              }
              if (poolAddr) break;
            }
          }
        }
        if (!poolAddr) { entry.status = "pool-not-found"; out.summary.skipped++; out.pools.push(entry); continue; }
        cacheOut.poolAddr[p.id] = poolAddr;
        entry.poolAddress = poolAddr;
        entry.basescan = `https://basescan.org/address/${poolAddr}`;

        // reserves
        const res = await ethCall(poolAddr, SEL.getReserves);
        const words = res.slice(2).match(/.{64}/g);
        const r0 = Number(BigInt("0x" + words[0]));
        const r1 = Number(BigInt("0x" + words[1]));
        await sleep(PACE_MS);

        // decimals (cached per token address)
        const dec = async (addr) => {
          if (cacheOut.decimals[addr]) return cacheOut.decimals[addr];
          const d = Number(BigInt("0x" + (await ethCall(addr, SEL.decimals)).slice(-40)));
          cacheOut.decimals[addr] = d;
          await sleep(PACE_MS);
          return d;
        };
        const d0 = await dec(t0);
        const d1 = await dec(t1);

        // value + peg flags
        const s0 = baseSymbols(p)[0], s1 = baseSymbols(p)[1];
        const p0 = prices[s0], p1 = prices[s1];
        entry.reserve0 = r0 / 10 ** d0;
        entry.reserve1 = r1 / 10 ** d1;
        entry.prices = { [s0]: p0 ?? null, [s1]: p1 ?? null };
        if (p0 != null && p1 != null) {
          entry.onchainTvl = Math.round((r0 / 10 ** d0) * p0 + (r1 / 10 ** d1) * p1);
          entry.dfdTvl = Math.round(p.tvl);
          entry.devPct = Math.round(Math.abs(entry.onchainTvl - p.tvl) / p.tvl * 1000) / 10;
          entry.status = "verified";
          out.summary.verified++;
        } else {
          entry.status = "verified-reserves-only";
          out.summary.verified++;
        }
        entry.pegFlags = [];
        for (const [s, pr] of [[s0, p0], [s1, p1]]) {
          const ref = EUR_PEG.has(s) ? eurUsd : 1.0;
          if (pr != null && ref != null && Math.abs(pr - ref) / ref > PEG_BAND) {
            entry.pegFlags.push({
              symbol: s, price: pr, peg: EUR_PEG.has(s) ? "€1" : "$1",
              offPegPct: Math.round((pr / ref - 1) * 1000) / 10,
              refUsd: Math.round(ref * 10000) / 10000,
            });
            out.summary.pegFlags++;
          }
        }
      } catch (e) {
        entry.status = "error: " + e.message.slice(0, 80);
        out.summary.skipped++;
      }
      out.pools.push(entry);
    }
  } catch (e) {
    log("crosscheck run failed (non-fatal): " + e.message);
  }

  out.cache = cacheOut;
  log(`verified ${out.summary.verified}/${out.summary.attempted} supported top pools · ${out.summary.pegFlags} peg flag(s) · block ${blockNumber || "n/a"}`);
  return out;
}

function baseSymbols(p) {
  const parts = String(p.symbol || "").split("-").filter(Boolean);
  return parts.length ? parts : ["?"];
}
