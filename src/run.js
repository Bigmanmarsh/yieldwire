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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPools, ENDPOINT, FIELDS_USED } from "./data.js";
import { getCoinLogos, baseSymbol } from "./logos.js";
import {
  THRESHOLDS, normalize, leader, detectEvents, updateWindow24h, factLine,
} from "./engine.js";
import { summarize } from "./llm.js";
import { send, alertMessage, digestMessage } from "./telegram.js";
import { crosscheckPools } from "./crosscheck.js";
import { crossReference } from "./xref.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(root, "data");
const SITE_BASE = (process.env.SITE_BASE || "https://bigmanmarsh.github.io/yieldwire").replace(/\/$/, "");

const readJson = (name, fallback) => {
  try { return JSON.parse(readFileSync(join(DATA, name), "utf8")); } catch { return fallback; }
};
const writeJson = (name, obj) => writeFileSync(join(DATA, name), JSON.stringify(obj, null, 2));

const log = (line) => console.log(`[YIELDWIRE] ${line}`);

async function main() {
  const now = new Date();
  const nowMs = now.getTime();
  log(`run start · ${now.toISOString()}`);

  // 1 ── Load public history
  const prev = readJson("latest.json", null);
  const eventsFile = readJson("events.json", { events: [] });
  const state = readJson("state.json", { seq: 0, cooldowns: {}, lastDigestDate: null, llm: { attempts: 0, rejected: 0 } });
  const window24h = readJson("window24h.json", {});

  // 2 ── Fetch (a failure here = failed run, by design)
  const raw = await fetchPools();
  const { pools, rejected, integrity } = normalize(raw);
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
  for (const ev of events) {
    state.seq += 1;
    ev.id = `EVT-${String(state.seq).padStart(4, "0")}`;
    ev.ts = now.toISOString();
    ev.factLine = factLine(ev);
    ev.source = { endpoint: ENDPOINT, fields: FIELDS_USED, fetchedAt: ev.ts };
    const sum = await summarize(ev, ev.factLine);
    state.llm.attempts += 1;
    if (sum.source.includes("rejected by claim-checker")) state.llm.rejected += 1;
    ev.summary = sum;
    ev.thresholds = THRESHOLDS;
  }
  if (events.length) {
    eventsFile.events = [...events.map(({ thresholds, ...rest }) => rest), ...eventsFile.events].slice(0, 500);
    log(`events: ${events.map((e) => `${e.id} ${e.type} ${e.pool.symbol}`).join(" · ")}`);
  } else {
    log("events: none (no threshold crossed since last run)");
  }

  // 4.5 ── On-chain cross-check: read reserves straight from pool contracts
  // (decorative + data-quality; read-only, $0, can never fail the run)
  let crosscheck = { pools: [], summary: { attempted: 0, verified: 0, pegFlags: 0, skipped: 0 }, note: "unavailable this run" };
  try {
    crosscheck = await crosscheckPools(top.slice(0, 10), state.crosscheckCache || {});
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
  // Coin logos (decorative only — never read by detection, never fail a run)
  const logos = await getCoinLogos(top.map((p) => baseSymbol(p.symbol)));

  const poolsOut = top.map((p) => ({
    ...p,
    logo: logos[baseSymbol(p.symbol)] ?? null,
    hist: { apy: nextWindow[p.id]?.apyHist ?? [p.apy], tvl: nextWindow[p.id]?.tvlHist ?? [p.tvl] },
  }));

  writeJson("latest.json", {
    ts: now.toISOString(),
    thresholds: THRESHOLDS,
    pools: poolsOut, // full monitored set, sorted by APY desc (site board uses top 10)
    rejected,
    integrity,
    leader: leaderNow,
    llm: { mode: process.env.GEMINI_API_KEY ? "on" : "keyless", ...state.llm },
    crosscheck,
    xrefStats,
  });
  writeJson("events.json", eventsFile);
  writeJson("window24h.json", nextWindow);

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
  writeJson("state.json", { seq: state.seq, cooldowns, lastDigestDate: state.lastDigestDate, llm: state.llm, crosscheckCache: state.crosscheckCache, xrefStats: state.xrefStats });

  log(`run done · ${pools.length} pools · ${events.length} events · history committed by next workflow step`);
}

main().catch((err) => {
  log(`RUN FAILED · ${err.message}`);
  process.exit(1);
});
