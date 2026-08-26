// YieldWire · src/engine.js — THE DETERMINISTIC CORE.
//
// RULE 0 (the whole product rests on this): no model touches a number.
// Every figure produced here is plain arithmetic on values fetched in
// this run. The LLM (src/llm.js) may write at most one summary sentence,
// and any number it invents gets the sentence rejected (claim-checker).
//
// All thresholds are published in THRESHOLDS below and on the site,
// so anyone can audit exactly what fires an alert.

export const THRESHOLDS = {
  chain: "Base",
  tvlFloor: 500_000,        // pools under $500k TVL are noise — not monitored (documented)
  leaderTvlFloor: 1_000_000, // only pools with real depth can be "the leader"
  apyJumpPp: 2.0,           // percentage points, between consecutive scans
  apyCollapsePp: 2.0,
  tvlShiftPct: 25,          // % vs ~24h ago
  apyOutlierPct: 500,       // APY above this = incentive farm, rejected as data
  cooldownHours: 12,        // same pool + trigger cannot re-fire within 12h
  integrityTolPp: 0.5,      // |apy - (apyBase + apyReward)| must be within this
};

const HOUR = 3_600_000;
const round2 = (n) => Math.round(n * 100) / 100;

// ── Normalization ────────────────────────────────────────────────────────────
// Filter the full DeFiLlama universe down to the monitored set and count
// every rejection with a reason. The rejection counts are published —
// a vetting system can check our error handling, not just our hits.
export function normalize(raw, T = THRESHOLDS) {
  const pools = [];
  const rejected = { stale: 0, outlier: 0, dead: 0, belowFloor: 0 };

  for (const p of raw) {
    if (p.chain !== T.chain) continue;
    if (p.stablecoin !== true) continue;
    if (!p.tvlUsd || p.tvlUsd <= 0) { rejected.dead++; continue; }
    if (p.tvlUsd < T.tvlFloor) { rejected.belowFloor++; continue; }
    if (typeof p.apy !== "number" || Number.isNaN(p.apy) || p.apy < 0) { rejected.stale++; continue; }
    if (p.apy > T.apyOutlierPct) { rejected.outlier++; continue; }

    pools.push({
      id: p.pool,
      project: p.project,
      symbol: p.symbol,
      tvl: p.tvlUsd,
      apy: p.apy,
      apyBase: typeof p.apyBase === "number" ? p.apyBase : null,
      apyReward: typeof p.apyReward === "number" ? p.apyReward : null,
      apyPct1D: typeof p.apyPct1D === "number" ? p.apyPct1D : null,
      underlyingTokens: p.underlyingTokens ?? null, // on-chain cross-check input (published, documented)
    });
  }

  // Source integrity check: wherever DeFiLlama publishes all three APY
  // components, the total must equal base + reward (within tolerance).
  // This is our verification step, applied to the source itself.
  let integrityPass = 0, integrityChecked = 0;
  for (const p of pools) {
    if (p.apyBase != null && p.apyReward != null) {
      integrityChecked++;
      if (Math.abs(p.apy - (p.apyBase + p.apyReward)) <= T.integrityTolPp) integrityPass++;
    }
  }

  return { pools, rejected, integrity: { pass: integrityPass, checked: integrityChecked } };
}

// ── Leader ───────────────────────────────────────────────────────────────────
export function leader(pools, T = THRESHOLDS) {
  const eligible = pools.filter((p) => p.tvl >= T.leaderTvlFloor);
  if (eligible.length === 0) return null;
  return eligible.reduce((a, b) => (b.apy > a.apy ? b : a));
}

// ── Event detection ──────────────────────────────────────────────────────────
// Four triggers, nothing else. `prev` is the previous snapshot, `window24h`
// holds the ~24h-ago TVL anchor per pool, `state` carries cooldowns.
export function detectEvents(prev, now, window24h, state, nowMs, T = THRESHOLDS) {
  const events = [];
  const prevById = new Map((prev?.pools ?? []).map((p) => [p.id, p]));
  const prevLeader = prev?.pools?.length ? leader(prev.pools, T) : null;
  const newLeader = leader(now.pools, T);

  if (!prev?.pools?.length) return { events, suppressed: 0 };

  if (prevLeader && newLeader && prevLeader.id !== newLeader.id) {
    events.push({
      type: "LEADER_CHANGE",
      poolId: newLeader.id,
      pool: newLeader,
      before: { id: prevLeader.id, symbol: prevLeader.symbol, project: prevLeader.project, apy: prevLeader.apy, tvl: prevLeader.tvl },
      after: { apy: newLeader.apy, tvl: newLeader.tvl },
      delta: round2(newLeader.apy - prevLeader.apy),
      trigger: `Highest-APY stablecoin pool (TVL ≥ $${T.leaderTvlFloor.toLocaleString("en-US")}) changed`,
    });
  }

  for (const p of now.pools) {
    const q = prevById.get(p.id);
    if (!q) continue;

    const d = p.apy - q.apy;
    if (d >= T.apyJumpPp) {
      events.push({
        type: "APY_JUMP",
        poolId: p.id,
        pool: p,
        before: { apy: q.apy, tvl: q.tvl },
        after: { apy: p.apy, tvl: p.tvl },
        delta: round2(d),
        trigger: `APY rose ≥ ${T.apyJumpPp} percentage points between consecutive scans`,
      });
    } else if (d <= -T.apyCollapsePp) {
      events.push({
        type: "APY_COLLAPSE",
        poolId: p.id,
        pool: p,
        before: { apy: q.apy, tvl: q.tvl },
        after: { apy: p.apy, tvl: p.tvl },
        delta: round2(d),
        trigger: `APY fell ≥ ${T.apyCollapsePp} percentage points between consecutive scans`,
      });
    }

    const w = window24h?.[p.id];
    if (w?.anchorTvl) {
      const shift = ((p.tvl - w.anchorTvl) / w.anchorTvl) * 100;
      if (Math.abs(shift) >= T.tvlShiftPct) {
        events.push({
          type: "TVL_SHIFT",
          poolId: p.id,
          pool: p,
          before: { tvl: w.anchorTvl, ts: w.anchorTs },
          after: { tvl: p.tvl },
          delta: round2(shift),
          trigger: `TVL moved ≥ ${T.tvlShiftPct}% vs ~24h ago`,
        });
      }
    }
  }

  return withCooldowns(events, state, nowMs, T);
}

function withCooldowns(events, state, nowMs, T) {
  const cooldowns = state?.cooldowns ?? {};
  const kept = [];
  let suppressed = 0;
  const next = { ...cooldowns };

  for (const ev of events) {
    const key = `${ev.type}:${ev.poolId}`;
    const last = next[key] ?? 0;
    if (nowMs - last < T.cooldownHours * HOUR) { suppressed++; continue; }
    next[key] = nowMs;
    kept.push(ev);
  }
  // prune old cooldown entries so state.json stays small
  const pruned = {};
  for (const [k, v] of Object.entries(next)) if (nowMs - v < 48 * HOUR) pruned[k] = v;

  return { events: kept, suppressed, cooldowns: pruned };
}

// ── 24h window ───────────────────────────────────────────────────────────────
// Per pool: a TVL "anchor" (the value at entry creation, refreshed every 24h —
// our "~24h ago" reference) plus ring buffers of APY/TVL (max 288 points =
// 24h at 5-min cadence) used by the site's sparklines.
export function updateWindow24h(window24h, pools, nowMs) {
  const w = { ...(window24h ?? {}) };
  for (const p of pools) {
    const e = w[p.id];
    if (!e || nowMs - e.anchorTs >= 24 * HOUR) {
      w[p.id] = {
        anchorTvl: p.tvl, anchorTs: nowMs, lastSeen: nowMs,
        apyHist: [p.apy], tvlHist: [p.tvl],
      };
    } else {
      w[p.id] = {
        ...e,
        lastSeen: nowMs,
        apyHist: [...(e.apyHist ?? []), p.apy].slice(-288),
        tvlHist: [...(e.tvlHist ?? []), p.tvl].slice(-288),
      };
    }
  }
  for (const id of Object.keys(w)) {
    if (nowMs - (w[id].lastSeen ?? 0) > 25 * HOUR) delete w[id];
  }
  return w;
}

// ── Fact line (for the LLM prompt + claim-checker) ───────────────────────────
export function factLine(ev) {
  const p = ev.pool;
  const usd = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
  switch (ev.type) {
    case "LEADER_CHANGE":
      return `${ev.before.symbol} (${ev.before.project}) at ${ev.before.apy}% APY lost the top spot to ${p.symbol} (${p.project}) at ${p.apy}% APY on Base. New leader TVL ${usd(p.tvl)}, old leader TVL ${usd(ev.before.tvl)}. APY gap change ${ev.delta} percentage points. Source: DeFiLlama yields endpoint.`;
    case "APY_JUMP":
      return `${p.symbol} (${p.project}) on Base: APY moved from ${ev.before.apy}% to ${p.apy}% (+${ev.delta} percentage points). TVL ${usd(p.tvl)}. Source: DeFiLlama yields endpoint.`;
    case "APY_COLLAPSE":
      return `${p.symbol} (${p.project}) on Base: APY moved from ${ev.before.apy}% to ${p.apy}% (${ev.delta} percentage points). TVL ${usd(p.tvl)}. Source: DeFiLlama yields endpoint.`;
    case "TVL_SHIFT":
      return `${p.symbol} (${p.project}) on Base: TVL moved from ${usd(ev.before.tvl)} to ${usd(p.tvl)} (${ev.delta > 0 ? "+" : ""}${ev.delta}% vs ~24h ago). APY is ${p.apy}%. Source: DeFiLlama yields endpoint.`;
    default:
      return "";
  }
}
