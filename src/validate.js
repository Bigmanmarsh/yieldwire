// YieldWire · src/validate.js — snapshot atomicity gate.
//
// One agent run must publish ONE internally consistent file:
//   · ts, pools, leader, rejected, integrity — from this run's single fetch
//   · crosscheck — from this run's on-chain reads (checkedAt within seconds)
//   · leader — the same object as its record in pools
// A snapshot that fails this gate is NOT published; the run fails loudly
// instead (the pipeline's existing "fail loud, never publish stale" rule).
//
// The 24h rolling hist arrays on pool records are deliberately cross-run —
// they are labeled history ("LAST N SNAPSHOTS"), not a claim that every
// number in the file is from one moment.

const MIN = 60_000;

export function validateSnapshot(o, nowMs) {
  const problems = [];
  if (!o || typeof o !== "object") return { ok: false, problems: ["snapshot is not an object"] };

  // ts: valid ISO, close to wall clock
  const ts = Date.parse(o.ts);
  if (!Number.isFinite(ts)) problems.push(`ts unparseable: ${String(o.ts).slice(0, 40)}`);
  else if (Math.abs(nowMs - ts) > 15 * MIN) problems.push(`ts drift ${Math.round(Math.abs(nowMs - ts) / MIN)}min (> 15min) — file may have been assembled across runs`);

  // crosscheck timestamps, when present, must be from the same run
  const cc = o.crosscheck;
  if (cc) {
    for (const key of ["checkedAt", "blockTs"]) {
      if (cc[key]) {
        const t = Date.parse(cc[key]);
        if (!Number.isFinite(t)) problems.push(`crosscheck.${key} unparseable: ${String(cc[key]).slice(0, 40)}`);
        else if (Number.isFinite(ts) && Math.abs(ts - t) > 10 * MIN) problems.push(`crosscheck.${key} is ${Math.round(Math.abs(ts - t) / MIN)}min away from ts — different runs`);
      }
    }
  }

  // pools: present, unique ids
  const pools = o.pools;
  if (!Array.isArray(pools) || !pools.length) problems.push("pools missing or empty");
  else {
    const ids = new Set();
    for (const p of pools) {
      if (!p || !p.id) { problems.push("pool record missing id"); break; }
      if (ids.has(p.id)) { problems.push(`duplicate pool id ${p.id}`); break; }
      ids.add(p.id);
    }
  }

  // leader: must be the same object as its pool record (exact values)
  if (o.leader && Array.isArray(pools)) {
    const rec = pools.find((p) => p.id === o.leader.id);
    if (!rec) problems.push(`leader id ${o.leader.id} not found in pools`);
    else {
      if (rec.apy !== o.leader.apy) problems.push(`leader.apy ${o.leader.apy} != pool record apy ${rec.apy}`);
      if (rec.tvl !== o.leader.tvl) problems.push(`leader.tvl ${o.leader.tvl} != pool record tvl ${rec.tvl}`);
      if (rec.symbol !== o.leader.symbol) problems.push(`leader.symbol ${o.leader.symbol} != pool record symbol ${rec.symbol}`);
    }
  }

  // rejection counts: non-negative integers
  if (o.rejected) {
    for (const [k, v] of Object.entries(o.rejected)) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) problems.push(`rejected.${k} invalid: ${JSON.stringify(v)}`);
    }
  }

  return { ok: problems.length === 0, problems };
}
