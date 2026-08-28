// YieldWire · src/findings.js — token-level findings ledger.
//
// A peg flag lives in ONE snapshot (latest.json) and disappears when the
// token recovers or leaves the index. That is honest "live" behavior — but
// it means the flagship evidence (e.g. MSUSD at ~$0.67 for ~30h) would only
// be discoverable by replaying old commits. This module maintains
// data/findings.json: one entry per token that has EVER been peg-flagged in
// a real on-chain cross-check, with first-seen / last-seen / worst reading,
// the pool contract it was read from, the block, and the related engine
// events (e.g. the APY that was being advertised while the peg was broken).
//
// Rules:
//   · Every field comes from real run data (crosscheck result, pools, events).
//     Nothing here is hand-written; the initial file was backfilled from the
//     committed run history by scripts/backfill-findings.mjs — equally real.
//   · "off-index" is a first-class status: when the data source stops listing
//     a token, the finding is preserved and the file says WHO ended the
//     monitoring (the source, not YieldWire).
//   · This is a record, not detection: it never fires events, never changes
//     a number, and can never fail a run.

const round4 = (n) => Math.round(n * 10000) / 10000;

export function updateFindings(file, { pools, crosscheck, events, ts }) {
  const prev = file && Array.isArray(file.findings) ? file : { findings: [] };
  const out = {
    note: prev.note ?? "Token-level findings maintained by the agent from real on-chain cross-checks (src/findings.js). One entry per token ever peg-flagged; preserved even after the token leaves the index. Every number is replayable from the ledger.",
    generatedBy: prev.generatedBy ?? null,
    updated: prev.updated ?? ts,
    findings: prev.findings.map((f) => ({ ...f, relatedEvents: [...(f.relatedEvents || [])] })),
  };

  const bySym = new Map(out.findings.map((f) => [f.symbol, f]));
  const monitoredSyms = new Set();
  for (const p of pools || []) String(p.symbol || "").split("-").filter(Boolean).forEach((s) => monitoredSyms.add(s));
  const ccPools = (crosscheck && crosscheck.pools) || [];
  const block = (crosscheck && crosscheck.blockNumber) || null;
  const apyByPool = new Map((pools || []).map((p) => [p.id, p]));
  let changed = false;

  // 1 ── upsert flags read this run
  for (const pool of ccPools) {
    for (const flag of pool.pegFlags || []) {
      let f = bySym.get(flag.symbol);
      if (!f) {
        f = { symbol: flag.symbol, peg: flag.peg || "$1", status: "flagged", firstSeen: ts, firstPrice: flag.price, cyclesFlagged: 0, relatedEvents: [] };
        out.findings.push(f);
        bySym.set(flag.symbol, f);
        changed = true;
      }
      const before = JSON.stringify(f);
      f.status = "flagged";
      f.peg = flag.peg || f.peg || "$1";
      f.lastSeen = ts;
      f.lastFlaggedAt = ts;
      f.lastPrice = flag.price;
      f.lastOffPegPct = flag.offPegPct;
      // Track the actual extreme READING (min price when below peg, max when
      // above) — offPegPct arrives rounded to 0.1pp, the price doesn't.
      if (f.worstPrice == null) f.worstPrice = flag.price;
      else f.worstPrice = (flag.offPegPct ?? 0) < 0 ? Math.min(f.worstPrice, flag.price) : Math.max(f.worstPrice, flag.price);
      const ref = typeof flag.refUsd === "number" && flag.refUsd > 0 ? flag.refUsd : 1;
      f.worstOffPegPct = Math.round((f.worstPrice / ref - 1) * 1000) / 10;
      f.lastBlock = block;
      f.poolSymbol = pool.symbol;
      f.projectId = pool.project;
      f.poolId = pool.poolId;
      if (pool.poolAddress) { f.poolAddress = pool.poolAddress; f.basescan = pool.basescan || `https://basescan.org/address/${pool.poolAddress}`; }
      f.poolTvl = pool.dfdTvl ?? f.poolTvl ?? null;
      const p = apyByPool.get(pool.poolId);
      if (p) f.poolApyAtLastFlag = p.apy;
      f.cyclesFlagged = (f.cyclesFlagged || 0) + 1;
      if (JSON.stringify(f) !== before) changed = true;
    }
  }

  // 2 ── statuses for findings not flagged this run
  for (const f of out.findings) {
    if (f.lastFlaggedAt === ts) continue;
    const inUniverse = monitoredSyms.has(f.symbol) || ccPools.some((p) => String(p.symbol || "").split("-").includes(f.symbol));
    const st = inUniverse ? "watch" : "off-index";
    if (f.status !== st) {
      f.status = st;
      if (st === "off-index") {
        f.offIndexAt = ts;
        f.offIndexNote = "No longer in the monitored universe — the data source stopped listing this token. Monitoring ended by the source, not by YieldWire; every past reading stays replayable in the ledger.";
      }
      changed = true;
    }
  }

  // 3 ── link related engine events (the yield that was being advertised)
  for (const f of out.findings) {
    const rel = (events || [])
      .filter((e) => String(e.pool?.symbol || "").split("-").includes(f.symbol))
      .map((e) => ({ id: e.id, type: e.type, ts: e.ts, apy: e.pool?.apy ?? null, poolSymbol: e.pool?.symbol ?? null }));
    for (const r of rel) {
      if (!(f.relatedEvents || []).some((x) => x.id === r.id)) { f.relatedEvents.push(r); changed = true; }
    }
    f.relatedEvents.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    if (f.relatedEvents.length > 12) f.relatedEvents = f.relatedEvents.slice(-12);
  }

  out.findings.sort((a, b) => String(b.lastFlaggedAt || "").localeCompare(String(a.lastFlaggedAt || "")));
  if (changed) out.updated = ts;
  const round = (v) => (typeof v === "number" ? round4(v) : v);
  for (const f of out.findings) for (const k of ["firstPrice", "lastPrice", "worstPrice"]) f[k] = round(f[k]);
  return out;
}
