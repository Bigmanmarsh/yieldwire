// YieldWire · src/run.js — one agent run.
//
//   fetch (DeFiLlama) → normalize + integrity → deterministic detection
//   → optional claim-checked LLM line → Telegram → write public history
//
// Design rules this file enforces:
//   · If the data source fails, the run fails loudly (red Actions run).
//     The agent never publishes a stale number as fresh. The site then
//     shows a STALE warning instead of pretending to be live.
//   · If Telegram is not configured, messages are printed to the log
//     (dry run) so the first deploys are testable before secrets exist.
//   · Every write to data/ is committed by the workflow → append-only
//     public history, timestamped by GitHub.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPools, ENDPOINT, FIELDS_USED } from "./data.js";
import { getCoinLogos, baseSymbol } from "./logos.js";
import {
  THRESHOLDS, normalize, leader, detectEvents, updateWindow24h, factLine,
} from "./engine.js";
import { summarize } from "./llm.js";
import { send, alertMessage, digestMessage } from "./telegram.js";
import { crosscheckPools, PROJECTS } from "./crosscheck.js";
import { crossReference } from "./xref.js";
import { updateFindings } from "./findings.js";
import { validateSnapshot } from "./validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(root, "data");
const SITE_BASE = (process.env.SITE_BASE || "https://bigmanmarsh.github.io/yieldwire").replace(/\/$/, "");
const SITE_BASE_GH = "https://raw.githubusercontent.com/Bigmanmarsh/yieldwire/main";

const readJson = (name, fallback) => {
  try { return JSON.parse(readFileSync(join(DATA, name), "utf8")); } catch { return fallback; }
};
const writeJson = (name, obj) => writeFileSync(join(DATA, name), JSON.stringify(obj, null, 2));

const log = (line) => console.log(`[YIELDWIRE] ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Cadence / dedupe (shared by the in-Actions loop and single runs) ─────────
// Inside GitHub Actions this file runs as a LONG-LIVED LOOP (up to 70 cycles):
// one full agent cycle, self-commit, sleep, repeat — holding the published
// ~5-minute cadence from a single trigger. GitHub does not let a workflow's
// own token re-trigger the workflow, and the scheduler on this account is
// unreliable, so the loop IS the autonomy. Locally (no GITHUB_ACTIONS) it
// runs exactly one cycle and never touches git.
const IS_ACTIONS = !!process.env.GITHUB_ACTIONS;
const PACE_MS = Number(process.env.YW_PACE_MS) || 5 * 60 * 1000;
const GUARD_MS = process.env.YW_GUARD_MS !== undefined ? Math.max(0, Number(process.env.YW_GUARD_MS)) : 4 * 60 * 1000;
const LOOP_ITERS = IS_ACTIONS ? (Number(process.env.YW_LOOP_ITERS) || 70) : 1;
const liveLatestTs = async () => {
  const onDisk = readJson("latest.json", null);
  let ts = onDisk?.ts || null;
  try {
    const r = await fetch(process.env.YW_LIVE_URL || `${SITE_BASE_GH}/data/latest.json`, { signal: AbortSignal.timeout(10000) });
    if (r.ok) { const j = await r.json(); if (j?.ts) ts = j.ts; }
  } catch { /* offline → fall back to the checked-out copy */ }
  return ts;
};

// When this job last pushed a data commit (ms epoch). The ONLY pacing signal
// the loop trusts: pure local arithmetic. Remote reads (HTTP or git) on
// Actions runners proved unreliable (raw cache frozen at checkout; and the
// loop's own pushes race any external view), so cadence is held locally.
let lastSelfCommitMs = 0;

// Self-commit inside Actions (per-cycle append-only history). The workflow's
// own commit step remains as a safety net (no-op once the loop has committed).
function gitCommitData(cycleNo) {
  const g = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  g(["config", "user.name", "yieldwire[bot]"]);
  g(["config", "user.email", "yieldwire-agent@users.noreply.github.com"]);
  g(["add", "data"]);
  if (g(["diff", "--cached", "--quiet"]).status === 0) { log("self-commit: no data changes this cycle"); return null; }
  const ts = new Date().toISOString().slice(11, 19);
  const c = g(["commit", "-m", `agent run #${process.env.GITHUB_RUN_NUMBER || "?"} · ${ts}Z · cycle ${cycleNo}`]);
  if (c.status !== 0) { log("self-commit FAILED: " + (c.stderr || c.stdout).slice(0, 200)); return null; }
  const sha = g(["rev-parse", "HEAD"]).stdout.trim();
  let p = g(["push", "origin", "HEAD:main"]);
  if (p.status !== 0) {
    // another writer (human push) raced us — rebase and retry once
    g(["pull", "--rebase", "origin", "main"]);
    p = g(["push", "origin", "HEAD:main"]);
  }
  if (p.status !== 0) { log("self-push FAILED (will retry next cycle): " + (p.stderr || p.stdout).slice(0, 200)); return null; }
  lastSelfCommitMs = Date.now();
  log(`self-commit: pushed ${sha.slice(0, 7)} (cycle ${cycleNo})`);
  return sha;
}

async function runCycle(cycleNo) {
  const now = new Date();
  const nowMs = now.getTime();
  log(`cycle ${cycleNo}${LOOP_ITERS > 1 ? "/" + LOOP_ITERS : ""} start · ${now.toISOString()}`);

  // Dedupe guard: if another cycle (this loop or a fresh trigger) committed
  // less than 4 min ago, do no work this cycle — the loop paces onward.
  const prevTs = await liveLatestTs();
  if (prevTs) {
    const ageMs = nowMs - Date.parse(prevTs);
    if (ageMs < GUARD_MS) {
      log(`dedupe guard: last committed run ${Math.round(ageMs / 1000)}s ago (< ${Math.round(GUARD_MS / 60000)} min) — skipping work this cycle`);
      return false;
    }
  }

  // 1 ── Load public history
  const prev = readJson("latest.json", null);
  const eventsFile = readJson("events.json", { events: [] });
  const findingsFile = readJson("findings.json", { findings: [] });
  const state = readJson("state.json", { seq: 0, cooldowns: {}, lastDigestDate: null, llm: { attempts: 0, rejected: 0 } });
  const window24h = readJson("window24h.json", {});

  // 2 ── Fetch (a failure here = failed run, by design)
  const raw = await fetchPools();
  const { pools, rejected, rejectedNamed, integrity } = normalize(raw);
  // The only rows the engine can read: Base + stablecoin, slimmed to the
  // fields it uses. Committed (70 KB) on event runs → every event is
  // reproducible from its own committed inputs via `node src/run.js --replay <sha>`.
  const rawSlice = raw
    .filter((p) => p.chain === THRESHOLDS.chain && p.stablecoin === true)
    .map((p) => ({
      pool: p.pool, chain: p.chain, project: p.project, symbol: p.symbol, stablecoin: p.stablecoin,
      tvlUsd: p.tvlUsd ?? null, apy: p.apy ?? null, apyBase: p.apyBase ?? null,
      apyReward: p.apyReward ?? null, apyPct1D: p.apyPct1D ?? null, underlyingTokens: p.underlyingTokens ?? null,
    }));
  const top = [...pools].sort((a, b) => b.apy - a.apy);
  const leaderNow = leader(pools);

  log(`fetched ${raw.length.toLocaleString("en-US")} pools universe → ${pools.length} monitored (Base · stablecoin · TVL ≥ $${THRESHOLDS.tvlFloor.toLocaleString("en-US")})`);
  log(`rejected: ${rejected.stale} stale · ${rejected.outlier} outlier · ${rejected.dead} dead · ${rejected.belowFloor} below floor · source integrity ${integrity.pass}/${integrity.checked}`);

  // 3 ── Deterministic detection
  const { events, suppressed, cooldowns } = detectEvents(prev, { pools }, window24h, state, nowMs);
  const isNewRun = !prev?.pools?.length;
  if (isNewRun) log("first run — baseline established, comparisons start next run");
  if (suppressed) log(`${suppressed} event(s) suppressed by ${THRESHOLDS.cooldownHours}h cooldown`);

  // 4 ── Enrich: ids, fact line, claim-checked summary
  const LLM_ON = !!process.env.GEMINI_API_KEY;
  for (const ev of events) {
    state.seq += 1;
    ev.id = `EVT-${String(state.seq).padStart(4, "0")}`;
    ev.ts = now.toISOString();
    ev.factLine = factLine(ev);
    ev.source = { endpoint: ENDPOINT, fields: FIELDS_USED, fetchedAt: ev.ts };
    const sum = await summarize(ev, ev.factLine);
    if (LLM_ON) state.llm.attempts += 1; // keyless mode: no attempt is made, none is counted
    if (sum.source.includes("rejected by claim-checker")) state.llm.rejected += 1;
    ev.summary = sum;
    ev.thresholds = THRESHOLDS;
  }
  if (events.length) {
    const rawFile = `raw-base-stable-${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
    writeJson(rawFile, rawSlice);
    for (const ev of events) ev.rawFile = rawFile;
    log(`events: ${events.map((e) => `${e.id} ${e.type} ${e.pool.symbol}`).join(" · ")}`);
    log(`raw slice committed for replay: data/${rawFile} (${(JSON.stringify(rawSlice).length / 1024).toFixed(0)} KB)`);
  } else {
    log("events: none (no threshold crossed since last run)");
  }

  // 4.5 ── On-chain cross-check: read reserves straight from pool contracts
  // (decorative + data-quality; read-only, $0, can never fail the run)
  let crosscheck = { pools: [], summary: { attempted: 0, verified: 0, pegFlags: 0, skipped: 0 }, note: "unavailable this run" };
  try {
    // Verification set (published on the site): within the supported
    // protocols (currently Aerodrome v1 on Base), the top pools by TVL —
    // where the most user money sits — plus carry-over: any pool that was
    // verified or peg-flagged in the previous snapshot keeps being checked
    // while it's relevant. Once we catch something, we keep watching it.
    // (A global top-by-TVL list would be dominated by vaults we don't
    // have contract coverage for — that's "pending-coverage", not skipped.)
    const prevCcPools = (prev && prev.crosscheck && prev.crosscheck.pools) || [];
    const carryIds = prevCcPools.filter(x => x.status === "verified" || (x.pegFlags || []).length).map(x => x.poolId);
    const ccSet = pools.filter(p => PROJECTS.has(p.project)).sort((a, b) => (b.tvl || 0) - (a.tvl || 0)).slice(0, 10);
    for (const id of carryIds) {
      const p = pools.find(x => x.id === id);
      if (p && !ccSet.includes(p)) ccSet.push(p);
    }
    crosscheck = await crosscheckPools(ccSet, state.crosscheckCache || {});
    state.crosscheckCache = crosscheck.cache;
    delete crosscheck.cache;
  } catch (e) {
    log("crosscheck failed (non-fatal): " + e.message);
  }
  const xcByPool = new Map(crosscheck.pools.map((x) => [x.poolId, x]));

  // 4.6 ── Claim cross-reference for each event (independent sources; no LLM)
  let priceMap = {};
  try { priceMap = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "coin-prices.json"), "utf8")); } catch {}
  for (const ev of events) {
    const xcEntry = xcByPool.get(ev.pool?.id) || null;
    ev.crosscheckEntry = xcEntry ? { ...xcEntry, blockNumber: crosscheck.blockNumber, blockTs: crosscheck.blockTs } : null;
    ev.crossRef = await crossReference(ev, pools, priceMap).catch((e) => {
      log("xref failed for " + (ev.id || "?") + " (non-fatal): " + e.message);
      return { claims: [{ id: "ALL", claim: "all claims", verdict: "UNVERIFIED", detail: "cross-reference failed this run: " + e.message.slice(0, 60), via: null, link: null }], sources: [], checkedAt: ev.ts };
    });
  }

  // Persist events WITH their evidence attached (crosscheckEntry + crossRef).
  // This snapshot must be taken AFTER step 4.6 — the claims are the receipts;
  // an event published without them is a claim without evidence.
  if (events.length) {
    eventsFile.events = [...events.map(({ thresholds, ...rest }) => rest), ...eventsFile.events].slice(0, 500);
  }
  const xrefStats = state.xrefStats || { events: 0, corroborated: 0, deviations: 0, unverified: 0 };
  for (const ev of events) {
    xrefStats.events += 1;
    for (const c of ev.crossRef.claims) {
      if (c.verdict === "CORROBORATED" || c.verdict === "INDEPENDENT-SOURCE-MATCH") xrefStats.corroborated += 1;
      else if (c.verdict === "PEG DEVIATION" || c.verdict === "DEVIATION") xrefStats.deviations += 1;
      else if (c.verdict === "UNVERIFIED") xrefStats.unverified += 1;
    }
  }
  state.xrefStats = xrefStats;

  // 5 ── Persist public history
  const nextWindow = updateWindow24h(window24h, pools, nowMs);
  const today = now.toISOString().slice(0, 10);
  // Coin logos (decorative only — never read by detection, never fail a run).
  // state.coinLogos persists newly resolved URLs (see src/logos.js layers).
  state.coinLogos = state.coinLogos || {};
  const logos = await getCoinLogos(top.map((p) => baseSymbol(p.symbol)), state.coinLogos);

  const poolsOut = top.map((p) => ({
    ...p,
    logo: logos[baseSymbol(p.symbol)] ?? null,
    hist: { apy: nextWindow[p.id]?.apyHist ?? [p.apy], tvl: nextWindow[p.id]?.tvlHist ?? [p.tvl] },
  }));

  const out = {
    ts: now.toISOString(),
    run: process.env.GITHUB_RUN_NUMBER || null, // matches the commit message — a file whose run/cycle/ts don't match its commit is a version mix, and that's now visible
    cycle: cycleNo,
    thresholds: THRESHOLDS,
    pools: poolsOut, // full monitored set, sorted by APY desc (site board uses top 10)
    rejected,
    rejectedNamed, // rejection receipts: names + reasons (capped at 100, outliers first)
    integrity,
    leader: leaderNow,
    llm: { mode: LLM_ON ? "on" : "keyless", attempts: LLM_ON ? state.llm.attempts : 0, rejected: state.llm.rejected },
    crosscheck,
    xrefStats,
  };

  // ── Atomicity gate: refuse to publish a snapshot whose parts disagree ──
  // Every field above is from this run's one in-process state; the gate
  // makes that provable — a leader that doesn't match its pool record, or a
  // crosscheck timestamp from a different run, fails the cycle (red run)
  // instead of shipping an inconsistent file. See src/validate.js.
  const { ok, problems } = validateSnapshot(out, nowMs);
  if (!ok) {
    log("SNAPSHOT VALIDATION FAILED — nothing published: " + problems.join("; "));
    throw new Error("snapshot validation failed: " + problems.join("; "));
  }
  log("snapshot validation: ok (ts/leader/pools/crosscheck internally consistent)");

  writeJson("latest.json", out);
  writeJson("events.json", eventsFile);
  writeJson("window24h.json", nextWindow);

  // 5.5 ── Findings ledger (record, not detection — see src/findings.js).
  // Written only when something actually changed, so quiet markets stay quiet.
  try {
    const updatedFindings = updateFindings(findingsFile, { pools, crosscheck, events, ts: now.toISOString() });
    if (JSON.stringify(updatedFindings) !== JSON.stringify(findingsFile)) {
      writeJson("findings.json", updatedFindings);
      const flagged = updatedFindings.findings.filter((f) => f.status === "flagged").length;
      log(`findings ledger: ${updatedFindings.findings.length} token finding(s) · ${flagged} flagged this cycle`);
    }
  } catch (e) {
    log("findings update failed (non-fatal): " + e.message);
  }

  // 6 ── Telegram delivery
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  const dry = !token || !chatId;
  if (dry) log("telegram: DRY RUN (no TG_BOT_TOKEN / TG_CHAT_ID) — messages below go to the log only");

  // One-time welcome: proof of delivery the moment the wire goes live.
  if (!state.welcomed && pools.length) {
    const msg =
      `🟢 YIELDWIRE IS LIVE\n\n` +
      `Watching ${pools.length} stablecoin pools on Base (TVL ≥ $${THRESHOLDS.tvlFloor.toLocaleString("en-US")}), refreshed every 5 minutes.\n` +
      `First alert the moment a published threshold is crossed. Daily digest at 08:00 UTC.\n` +
      `The LLM did not calculate this result.\n` +
      `${SITE_BASE}`;
    if (dry) { log("telegram welcome message:\n" + msg); }
    else {
      await send(token, chatId, msg);
      log(`telegram: sent welcome to ${chatId}`);
    }
    state.welcomed = true;
  }

  for (const ev of events) {
    const msg = alertMessage(ev, { siteBase: SITE_BASE, summary: ev.summary, summarySource: ev.summary.source });
    if (dry) { log("telegram message:\n" + msg); }
    else {
      await send(token, chatId, msg);
      log(`telegram: sent ${ev.id} (${ev.type}) to ${chatId}`);
    }
  }

  // Daily digest — 08:00 UTC window, once per day (state-guarded)
  if (now.getUTCHours() === 8 && state.lastDigestDate !== today && pools.length) {
    const events24h = eventsFile.events.filter((e) => nowMs - Date.parse(e.ts) < 86_400_000);
    const msg = digestMessage({
      leaderNow, top, events24h, quality: { rejected }, integrity,
      siteBase: SITE_BASE, tsNow: now,
    });
    if (dry) { log("telegram daily digest:\n" + msg); }
    else {
      await send(token, chatId, msg);
      log(`telegram: sent daily digest to ${chatId}`);
    }
    state.lastDigestDate = today;
  }
  writeJson("state.json", { seq: state.seq, cooldowns, lastDigestDate: state.lastDigestDate, llm: state.llm, crosscheckCache: state.crosscheckCache, xrefStats: state.xrefStats, coinLogos: state.coinLogos || {} });

  // In Actions: commit this cycle's history ourselves (append-only, per cycle).
  if (IS_ACTIONS) gitCommitData(cycleNo);
  log(`cycle ${cycleNo} done · ${pools.length} pools · ${events.length} event(s)`);
  return true;
}

// ── Replay mode ──────────────────────────────────────────────────────────────
// `node src/run.js --replay <run-sha>` — recompute a past run's events from
// that run's own committed inputs (previous snapshot + committed raw slice).
// READ-ONLY: no fetch, no writes, no Telegram. If every committed event
// recomputes, the pipeline is deterministically reproducible — that is the
// 30-second judge path.
function replay(sha) {
  const rlog = (l) => console.log(`[YIELDWIRE:replay] ${l}`);
  const show = (rev, path) => {
    const r = spawnSync("git", ["show", `${rev}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  };
  const curLatest = show(sha, "data/latest.json");
  if (!curLatest) { rlog(`✗ no data/latest.json at ${sha} — is this a run commit?`); process.exit(2); }
  const cur = JSON.parse(curLatest);
  const ts = cur.ts;
  const tree = spawnSync("git", ["ls-tree", "--name-only", sha, "data/"], { cwd: root, encoding: "utf8" });
  const rawPath = (tree.stdout || "").split("\n").map((s) => s.trim()).filter((f) => f.startsWith("data/raw-base-stable-")).pop();
  if (!rawPath) { rlog(`no raw slice committed at ${sha} (predates replay history) — replay unavailable for this run`); process.exit(3); }
  const raw = JSON.parse(show(sha, rawPath));

  let prev = null, window24h = {}, state = { seq: 0, cooldowns: {}, lastDigestDate: null, llm: { attempts: 0, rejected: 0 } };
  const parent = spawnSync("git", ["rev-parse", `${sha}^`], { cwd: root, encoding: "utf8" });
  if (parent.status === 0 && parent.stdout.trim()) {
    const pl = show(parent.stdout.trim(), "data/latest.json"); if (pl) prev = JSON.parse(pl);
    const pw = show(parent.stdout.trim(), "data/window24h.json"); if (pw) window24h = JSON.parse(pw);
    const ps = show(parent.stdout.trim(), "data/state.json"); if (ps) state = JSON.parse(ps);
  }

  // Same code path as a live run — this is the point.
  const { pools, rejected, integrity } = normalize(raw);
  const computed = detectEvents(prev, { pools }, window24h, state, Date.parse(ts));
  const evFile = JSON.parse(show(sha, "data/events.json"));
  const committed = (evFile.events || []).filter((e) => e.ts === ts);

  rlog(`run ${ts} · ${raw.length} raw rows (Base·stablecoin slice) · committed ${committed.length} event(s)`);
  rlog(`recomputed: ${computed.events.length} event(s) · rejected ${rejected.stale} stale / ${rejected.outlier} outlier / ${rejected.dead} dead / ${rejected.belowFloor} below-floor · source integrity ${integrity.pass}/${integrity.checked}`);
  const key = (e) => `${e.type}:${e.pool?.id ?? e.pool?.symbol}:${e.before?.apy ?? e.before?.tvl}`;
  let ok = true;
  for (const ce of committed) {
    if (computed.events.some((e) => key(e) === key(ce))) rlog(`✓ REPRODUCED ${ce.id} ${ce.type} ${ce.pool.symbol} — ${ce.factLine}`);
    else { ok = false; rlog(`✗ NOT REPRODUCED ${ce.id} ${ce.type} ${ce.pool.symbol} — engine now produces: ${computed.events.map(key).join(" | ") || "(none)"}`); }
  }
  if (!committed.length && !computed.events.length) rlog("quiet run — no events committed, none recomputed ✓");
  rlog(ok ? "RESULT: every committed event reproduced exactly. The pipeline is deterministic." : "RESULT: MISMATCH — do not trust this run until investigated.");
  process.exit(ok ? 0 : 1);
}

const REPLAY_AT = process.argv.indexOf("--replay");
if (REPLAY_AT !== -1) {
  const sha = process.argv[REPLAY_AT + 1];
  if (!sha) { log("usage: node src/run.js --replay <run-sha>"); process.exit(2); }
  replay(sha);
}

// ── Runner: one cycle locally; a paced ~5-min loop inside Actions ────────────
async function runAll() {
  // Seed the pacing clock from the checked-out snapshot (last job's commit).
  const bootTs = readJson("latest.json", null)?.ts;
  if (bootTs && Number.isFinite(Date.parse(bootTs))) lastSelfCommitMs = Date.parse(bootTs);
  for (let i = 1; i <= LOOP_ITERS; i++) {
    try {
      await runCycle(i);
    } catch (err) {
      // A failed cycle must not kill the loop (public repo, free minutes):
      // log loudly and retry next cycle (~5 min). Persistent source failure
      // shows up as a STALE badge on the site — honest, by design.
      log(`cycle ${i} FAILED (loop continues, retry in ~5 min): ${err.message}`);
    }
    if (i < LOOP_ITERS) {
      const age = lastSelfCommitMs ? Date.now() - lastSelfCommitMs : 0;
      const rem = PACE_MS - age;
      if (rem > 15000) {
        log(`pacing: last self-commit ${Math.round(age / 1000)}s ago — sleeping ${Math.round(rem / 1000)}s before cycle ${i + 1}`);
        await sleep(rem);
      }
    }
  }
  if (LOOP_ITERS > 1) log(`loop complete after ${LOOP_ITERS} cycles — job ends; next trigger starts the next ~6h of coverage`);
}

runAll().catch((err) => {
  log(`RUN FAILED · ${err.message}`);
  process.exit(1);
});
