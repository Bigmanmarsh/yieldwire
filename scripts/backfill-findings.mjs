#!/usr/bin/env node
// YieldWire · scripts/backfill-findings.mjs — one-time history backfill.
//
// Rebuilds data/findings.json from the COMMITTED RUN HISTORY: it walks every
// agent commit of data/latest.json and replays each snapshot's crosscheck
// peg flags through the same updateFindings() code the live agent uses
// (src/findings.js). Nothing is invented here — every price, block, and
// timestamp in the output comes from a real committed snapshot, and any of
// them can be re-checked with `node src/run.js --replay <sha>` or on the
// site's ledger tab.
//
// Run again any time; it is idempotent (same history → same file).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { updateFindings } from "../src/findings.js";

const rev = spawnSync("git", ["rev-parse", "--verify", "origin/main"], { encoding: "utf8" }).stdout.trim()
  ? "origin/main" // full agent history lives on main; feature branches start at a squash point
  : "HEAD";
const shas = spawnSync("git", ["log", "--format=%H", "--reverse", rev, "--", "data/latest.json"], { encoding: "utf8" })
  .stdout.trim().split("\n").filter(Boolean);

let file = { findings: [] };
let lastPools = [];
let scanned = 0, flaggedRuns = 0;

for (const sha of shas) {
  const r = spawnSync("git", ["show", `${sha}:data/latest.json`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) continue;
  let snap;
  try { snap = JSON.parse(r.stdout); } catch { continue; }
  if (!snap?.ts || !Array.isArray(snap.pools)) continue;
  scanned++;
  lastPools = snap.pools.map((p) => ({ id: p.id, symbol: p.symbol, apy: p.apy, tvl: p.tvl }));
  const crosscheck = snap.crosscheck && Array.isArray(snap.crosscheck.pools) ? snap.crosscheck : { pools: [] };
  const hasFlag = crosscheck.pools.some((p) => (p.pegFlags || []).length);
  const before = JSON.stringify(file);
  file = updateFindings(file, { pools: lastPools, crosscheck, events: [], ts: snap.ts });
  if (hasFlag && JSON.stringify(file) !== before) flaggedRuns++;
}

// Final pass: link the related engine events from the public event log.
let events = [];
try { events = JSON.parse(readFileSync("data/events.json", "utf8")).events || []; } catch {}
file = updateFindings(file, { pools: lastPools, crosscheck: { pools: [] }, events, ts: new Date().toISOString() });

file.generatedBy =
  "Backfilled from committed run history by scripts/backfill-findings.mjs: it replays every agent commit of " +
  "data/latest.json through the same updateFindings() code the live agent runs (src/findings.js). " +
  "Every price, block, and timestamp comes from a real committed snapshot — verify any of them with " +
  "`node src/run.js --replay <sha>` or the site's ledger tab. The agent maintains this file from here on.";

writeFileSync("data/findings.json", JSON.stringify(file, null, 2));
console.log(`[backfill] scanned ${scanned} committed snapshots (${shas.length} commits) · ${flaggedRuns} flag-bearing updates`);
for (const f of file.findings) {
  console.log(`[backfill] ${f.symbol}: ${f.status} · first ${f.firstSeen} @ $${f.firstPrice} · last flagged ${f.lastFlaggedAt} @ $${f.lastPrice} · worst $${f.worstPrice} (${f.worstOffPegPct}%) · ${f.cyclesFlagged} cycles · related events: ${(f.relatedEvents || []).map((e) => e.id).join(", ") || "none"}`);
}
