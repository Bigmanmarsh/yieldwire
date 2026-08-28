#!/usr/bin/env node
// YieldWire · scripts/check-consistency.mjs — cross-artifact consistency gate.
//
// src/validate.js guards ONE snapshot against itself (ts / pools / leader /
// crosscheck all from a single run). This guards the artifacts AGAINST EACH
// OTHER: the findings ledger against the event log it cites, the event log
// against the state counter that issued its ids, the rolling 24h window
// against the pools it claims to cover, and the on-chain block anchor against
// the BaseScan link that invites you to verify it.
//
// Every rule below is an equality that already holds in the committed history —
// this file exists so that "the artifacts agree" stays a checkable claim rather
// than an assertion. It reads only, never writes, and exits non-zero on drift.
//
//   node scripts/check-consistency.mjs             # working tree
//   node scripts/check-consistency.mjs --history   # + replay every committed snapshot
//
// Snapshots from before the on-chain crosscheck existed (run #1) legitimately
// have no `crosscheck` block; those rules are skipped, not failed.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const HISTORY = process.argv.includes("--history");

const problems = [];
const fail = (rule, msg) => problems.push(`[${rule}] ${msg}`);
const load = (name) => {
  const p = join(DATA, name);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { fail("parse", `${name}: ${e.message}`); return null; }
};

const pegRef = (peg) => {
  const n = parseFloat(String(peg ?? "$1").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 1;
};
const universeOf = (snap) => {
  const syms = new Set();
  for (const p of snap.pools || []) String(p.symbol || "").split("-").filter(Boolean).forEach((s) => syms.add(s));
  for (const p of snap.crosscheck?.pools || []) String(p.symbol || "").split("-").filter(Boolean).forEach((s) => syms.add(s));
  return syms;
};

// ── 1 ── one snapshot, against itself (the published artifact, not just pre-publish)
function checkSnapshot(snap, label, { requireCrosscheck = true } = {}) {
  const ts = Date.parse(snap.ts);
  if (!Number.isFinite(ts)) fail(label, `ts unparseable: ${String(snap.ts).slice(0, 40)}`);

  const ids = new Set();
  for (const p of snap.pools || []) {
    if (!p?.id) { fail(label, "pool record missing id"); break; }
    if (ids.has(p.id)) { fail(label, `duplicate pool id ${p.id}`); break; }
    ids.add(p.id);
  }

  if (snap.leader) {
    const rec = (snap.pools || []).find((p) => p.id === snap.leader.id);
    if (!rec) fail(label, `leader id ${snap.leader.id} not found in pools`);
    else {
      if (rec.apy !== snap.leader.apy) fail(label, `leader.apy ${snap.leader.apy} != pool record ${rec.apy}`);
      if (rec.tvl !== snap.leader.tvl) fail(label, `leader.tvl ${snap.leader.tvl} != pool record ${rec.tvl}`);
      if (rec.symbol !== snap.leader.symbol) fail(label, `leader.symbol ${snap.leader.symbol} != pool record ${rec.symbol}`);
    }
  }

  for (const [k, v] of Object.entries(snap.rejected || {})) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) fail(label, `rejected.${k} invalid: ${JSON.stringify(v)}`);
  }

  const cc = snap.crosscheck;
  if (!cc) {
    // Run #1 predates the on-chain crosscheck; anything newer must have one.
    if (requireCrosscheck && snap.cycle != null) fail(label, "crosscheck block missing");
    return;
  }

  // The block we say we read at must be the block the verify link points to.
  const inUrl = /block\/(\d+)/.exec(cc.verifyAt || "");
  if (cc.blockNumber && !inUrl) fail(label, `verifyAt has no block number: ${cc.verifyAt}`);
  else if (cc.blockNumber && inUrl && String(cc.blockNumber) !== inUrl[1]) {
    fail(label, `verifyAt points at block ${inUrl[1]} but reads were taken at ${cc.blockNumber}`);
  }

  // Same-run timestamps: a crosscheck stitched in from another run is stale evidence.
  for (const key of ["checkedAt", "blockTs"]) {
    if (!cc[key]) continue;
    const t = Date.parse(cc[key]);
    if (!Number.isFinite(t)) fail(label, `crosscheck.${key} unparseable: ${String(cc[key]).slice(0, 40)}`);
    else if (Number.isFinite(ts) && Math.abs(ts - t) > 10 * 60_000) {
      fail(label, `crosscheck.${key} is ${Math.round(Math.abs(ts - t) / 60_000)}min from ts — different runs`);
    }
  }
}

// ── 2 ── the findings ledger, against the event log it cites
function checkFindingsAgainstEvents(findings, events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  for (const f of findings) {
    for (const r of f.relatedEvents || []) {
      const e = byId.get(r.id);
      if (!e) { fail("findings↔events", `${f.symbol}: related event ${r.id} is not in data/events.json`); continue; }
      if (e.type !== r.type) fail("findings↔events", `${r.id}: type ${e.type} != cited ${r.type}`);
      if (e.ts !== r.ts) fail("findings↔events", `${r.id}: ts ${e.ts} != cited ${r.ts}`);
      if ((e.pool?.apy ?? null) !== r.apy) fail("findings↔events", `${r.id}: apy ${e.pool?.apy} != cited ${r.apy}`);
      if ((e.pool?.symbol ?? null) !== r.poolSymbol) fail("findings↔events", `${r.id}: pool ${e.pool?.symbol} != cited ${r.poolSymbol}`);
    }
  }
}

// ── 3 ── the findings ledger, against the live snapshot and its own arithmetic
function checkFindingsAgainstSnapshot(findings, snap) {
  const uni = universeOf(snap);
  const snapTs = Date.parse(snap.ts);
  const flaggedNow = new Set(
    (snap.crosscheck?.pools || []).flatMap((p) => (p.pegFlags || []).map((f) => f.symbol))
  );

  for (const f of findings) {
    const isFlagged = f.status === "flagged";
    // A live flag must have a ledger entry, and a "flagged" entry must be a live flag.
    if (isFlagged && !flaggedNow.has(f.symbol)) {
      fail("findings↔latest", `${f.symbol} is marked "flagged" but the latest snapshot has no peg flag for it`);
    }
    // "off-index" means the source stopped listing it — it cannot also be listed.
    if (f.status === "off-index" && uni.has(f.symbol)) {
      fail("findings↔latest", `${f.symbol} is marked "off-index" but is in the monitored universe`);
    }
    // The ledger is a record of the past; it can never be ahead of the snapshot.
    for (const k of ["firstSeen", "lastSeen", "lastFlaggedAt"]) {
      const t = Date.parse(f[k]);
      if (Number.isFinite(t) && Number.isFinite(snapTs) && t > snapTs + 1000) {
        fail("findings↔latest", `${f.symbol}.${k} ${f[k]} is after the snapshot ts ${snap.ts}`);
      }
    }
    if (Date.parse(f.firstSeen) > Date.parse(f.lastSeen)) {
      fail("findings", `${f.symbol}: firstSeen ${f.firstSeen} is after lastSeen ${f.lastSeen}`);
    }
    if (!(f.cyclesFlagged > 0)) fail("findings", `${f.symbol}: cyclesFlagged is ${f.cyclesFlagged}`);

    // offPegPct is published rounded to 0.1pp while the price is not — allow the
    // rounding, reject anything larger. This is what makes "$0.6687 = -33.1%" auditable.
    const ref = pegRef(f.peg);
    for (const [priceKey, pctKey] of [["lastPrice", "lastOffPegPct"], ["worstPrice", "worstOffPegPct"]]) {
      const price = f[priceKey], pct = f[pctKey];
      if (typeof price !== "number" || typeof pct !== "number") continue;
      const implied = Math.round((price / ref - 1) * 1000) / 10;
      if (Math.abs(implied - pct) > 0.15) {
        fail("findings", `${f.symbol}: ${priceKey} $${price} against peg ${f.peg} implies ${implied}% but ${pctKey} says ${pct}%`);
      }
    }
    // "worst" must actually be the extreme reading, not just the latest one.
    if (typeof f.worstPrice === "number" && typeof f.lastPrice === "number") {
      const worse = (f.worstOffPegPct ?? 0) < 0 ? f.worstPrice > f.lastPrice : f.worstPrice < f.lastPrice;
      if (worse) fail("findings", `${f.symbol}: worstPrice $${f.worstPrice} is less extreme than lastPrice $${f.lastPrice}`);
    }
  }

  // Every live peg flag must be in the ledger — the ledger is the durable record.
  for (const sym of flaggedNow) {
    if (!findings.some((f) => f.symbol === sym)) {
      fail("findings↔latest", `latest snapshot peg-flags ${sym} but the ledger has no entry for it`);
    }
  }
}

// ── 4 ── the event log, the state counter, and the snapshot's xref tally
function checkCounters(latest, state, events) {
  const seen = new Set();
  for (const e of events) {
    if (!e.id) { fail("events", "event with no id"); continue; }
    if (seen.has(e.id)) fail("events", `duplicate event id ${e.id}`);
    seen.add(e.id);
  }
  if (state?.seq != null && state.seq !== events.length) {
    fail("state↔events", `state.seq ${state.seq} != ${events.length} events in data/events.json`);
  }
  if (latest?.xrefStats && state?.xrefStats && JSON.stringify(latest.xrefStats) !== JSON.stringify(state.xrefStats)) {
    fail("latest↔state", `xrefStats differ: ${JSON.stringify(latest.xrefStats)} vs ${JSON.stringify(state.xrefStats)}`);
  }
  if (latest?.xrefStats?.events != null && latest.xrefStats.events !== events.length) {
    fail("latest↔events", `xrefStats.events ${latest.xrefStats.events} != ${events.length} events`);
  }
}

// ── 5 ── the rolling 24h window must cover every pool the snapshot publishes
function checkWindow(latest, window) {
  if (!window || typeof window !== "object") { fail("window24h", "missing or not an object"); return; }
  for (const p of latest.pools || []) {
    if (!window[p.id]) fail("latest↔window24h", `pool ${p.symbol} (${p.id}) has no 24h history entry`);
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
const latest = load("latest.json");
const findingsFile = load("findings.json");
const eventsFile = load("events.json");
const state = load("state.json");
const window24h = load("window24h.json");
const events = eventsFile?.events ?? [];
const findings = findingsFile?.findings ?? [];

if (latest) {
  checkSnapshot(latest, "latest", { requireCrosscheck: true });
  checkCounters(latest, state, events);
  checkWindow(latest, window24h);
  if (findingsFile) checkFindingsAgainstSnapshot(findings, latest);
} else fail("latest", "data/latest.json missing");

if (findingsFile) checkFindingsAgainstEvents(findings, events);

let scanned = 0;
if (HISTORY) {
  const rev = spawnSync("git", ["rev-parse", "--verify", "origin/main"], { encoding: "utf8", cwd: ROOT }).status === 0 ? "origin/main" : "HEAD";
  const shas = spawnSync("git", ["log", "--format=%H", "--reverse", rev, "--", "data/latest.json"], { encoding: "utf8", cwd: ROOT, maxBuffer: 1 << 28 })
    .stdout.trim().split("\n").filter(Boolean);
  for (const sha of shas) {
    const r = spawnSync("git", ["show", `${sha}:data/latest.json`], { encoding: "utf8", cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) continue;
    let snap;
    try { snap = JSON.parse(r.stdout); } catch { fail("history", `${sha.slice(0, 7)}: data/latest.json is not valid JSON`); continue; }
    if (!snap?.ts || !Array.isArray(snap.pools)) continue;
    scanned++;
    checkSnapshot(snap, `history:${sha.slice(0, 7)}`, { requireCrosscheck: false });
  }
}

if (problems.length) {
  console.error(`✗ cross-artifact consistency: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log(
  `✓ cross-artifact consistency: ${findings.length} finding(s) · ${events.length} event(s) · ` +
  `${latest?.pools?.length ?? 0} pool(s) · ${Object.keys(window24h || {}).length} window entr(ies)` +
  (HISTORY ? ` · ${scanned} committed snapshot(s) replayed` : "")
);
