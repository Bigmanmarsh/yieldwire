# YieldWire — the wire for Base yield

**You don't monitor yield. The wire does.**

> **Every yield dashboard answers "how much?". YieldWire answers "can I actually trust it?"**
> An autonomous agent reads the Base market every five minutes, refuses pools that fail its
> published rules, contract-reads the top pools in its supported protocols on-chain, and
> appends everything to a public ledger. **On the record:** for ~30 hours (Aug 26–28) the agent
> read a "stablecoin" called **MSUSD at $0.67–0.68 — up to 33.1% below its $1 peg** — across
> **270 consecutive on-chain verified cycles**, while pools containing it advertised up to
> ~46% APY and briefly ranked #1 on Base. The token has since left the data source's index
> (monitoring ended by the source, not by us) — the full evidence lives in
> `data/findings.json` and is replayable commit-by-commit from the public ledger.
> The index showed the yield. The wire checked the body.

YieldWire is an autonomous agent that monitors every stablecoin pool on Base (TVL ≥ $500K) on a 5-minute cadence, **contract-reads the top pools in its supported protocols (currently Aerodrome v1) directly on-chain**, and leaves a public, versioned record of every snapshot. Pools outside contract coverage are labeled as such — monitored via the index, cross-checked the moment coverage exists. The moment the board changes — leader swap, APY jump, collapse, TVL shift, a token drifting off its peg — the before, the after, and the math are committed to a public, replayable ledger. A Telegram delivery layer is built into the agent (deterministic templates, claim-checked); this deployment runs it log-only, and the exact messages the agent composes are in every run's log. No wallet. No custody. No trades.

Built for the [Orion Agents Builder Hackathon](https://orionagents.org/hackathon).

## What YieldWire actually does

1. Finds stablecoin yield pools on Base (one public index: DeFiLlama).
2. Records the advertised yield and liquidity for each.
3. Rejects pools that fail published rules — and publishes every rejection, counted, with named receipts for the most severe.
4. **Checks the top pools in its supported protocols directly against the blockchain** (on-chain reserve verification; coverage is per-protocol and published).
5. Detects meaningful changes with deterministic thresholds (all published).
6. Sends alerts with the evidence attached.
7. Publishes the data, events, and state permanently in public, versioned history.

## What YieldWire does NOT do

- Does not hold money, custody anything, or execute trades.
- Does not recommend that you invest in anything. A high APY is a number, not a verdict.
- Does not let the LLM calculate or decide financial numbers (see below).
- Does not pretend APY is guaranteed, or that on-chain reserve checks prove APY.
- Does not claim blockchain-grade immutability for its history — it's public, versioned, and tamper-evident, which is exactly what it claims to be.

## Snapshot atomicity

Every 5-minute cycle writes `data/latest.json` as **one atomic object**: `ts`,
`pools`, `leader`, `rejected`, and `integrity` come from that run's single
fetch; `crosscheck.*` comes from that run's on-chain reads (seconds later).
Before each publish, `src/validate.js` refuses to ship a snapshot whose leader
doesn't exactly match its pool record, or whose crosscheck timestamps drift
far from `ts` — a failed gate turns the run **red** instead of publishing an
inconsistent file. Each snapshot also stamps its `run` and `cycle`, so any
file can be matched against the commit that published it.

Two honest caveats:

- **Delivery is cached.** `raw.githubusercontent.com` and the GitHub UI can
  serve a file minutes behind the newest commit. Reading the URL twice within
  a minute can show you two *different* snapshots — each internally consistent
  on its own (self-check: `ts` ≈ `crosscheck.checkedAt`, leader `apy`/`tvl`
  equal to its pool record, `run`/`cycle` matching the commit message).
- **`hist` arrays are deliberately cross-run** — a labeled 24-hour rolling
  window ("LAST N SNAPSHOTS") powering the charts, not a claim that every
  number in the file is from one instant.

## The pipeline (60-second version)

```text
              every 5 min
  DeFiLlama ──────────────────►┌──────────────────────────────────────┐
  (index)                      │ YIELDWIRE AGENT — GitHub Actions, $0 │
                               │                                      │
  Base L1  ◄── hex RPC reads ──│ 1 INDEX     read the market           │
  (contracts)                  │ 2 FILTER    published rules,          │
                               │              receipts published       │
                               │ 3 CHECK     reserves @ pinned block   │
                               │ 4 COMPARE   pegs, source consistency  │
                               │ 5 RECORD    append-only public ledger │
                               └──────────────┬───────────────────────┘
        ┌──────────────────────┬──────────────┴──────────────┐
        ▼                      ▼                             ▼
 GitHub Pages site       run log (exact messages)    data/*.json in git
 the evidence UI         before · after · math       replay any moment
```

1. **Fetch** — the free, keyless [DeFiLlama yields endpoint](https://yields.llama.fi/pools), every 5 minutes via GitHub Actions. One source, published on the site.
2. **Normalize** — Base · stablecoin · TVL ≥ $500K. Stale, outlier (APY > 500% ceiling), and dead pools are rejected; **every rejection is counted** and named receipts (up to 100 per snapshot, most severe first) are published.
3. **Source-consistency check** — wherever all three APY components exist, `apy = apyBase + apyReward` must hold (±0.5pp). This checks the *source's internal consistency* — it does not prove the APY is economically real. Pass/fail counts ship in every snapshot.
4. **On-chain cross-check** (`src/crosscheck.js`) — see below. This is the part that makes us not blindly trust the index.
5. **Detect** — four deterministic triggers, all thresholds published:

   | Trigger | Condition |
   |---|---|
   | 🔀 LEADER_CHANGE | Highest-APY stablecoin pool (TVL ≥ $1M) changed |
   | 📈 APY_JUMP | APY rose ≥ 2.0pp between consecutive scans |
   | 📉 APY_COLLAPSE | APY fell ≥ 2.0pp between consecutive scans |
   | 🌊 TVL_SHIFT | Reported TVL moved ≥ 25% vs ~24h ago |

   Plus **peg monitoring**: any stablecoin in a verified pool trading more than **3%** off its peg gets flagged with its price, the peg, and the block it was read at (band: `PEG_BAND = 0.03` in `src/crosscheck.js`).
6. **Deliver** — public snapshot + site refresh. The Telegram delivery layer is included (deterministic templates; this deployment composes the exact messages into the run log instead of sending them). An optional LLM (free tier, keyless mode fully supported) may write exactly one summary sentence — and a claim-checker rejects any number it invents. **The LLM did not calculate any number on this site.**

## On-chain cross-check — the part that proves we don't trust the index

**File: `src/crosscheck.js`.** Each cycle, the verification set is the **top pools by TVL within the supported protocols (v1: Aerodrome v1 on Base)**, plus any pool verified or peg-flagged in the previous snapshot (once caught, still watched). For each, the agent:

1. Resolves the pool's actual contract address from the protocol's factory registry on Base.
2. Captures the current Base block and **pins every subsequent read to that block** — so "reserves at block X" is literally true, not an approximation.
3. Calls `getReserves()` on that contract via **public, read-only Base RPC** (no wallet, no keys, no funds).
4. Fetches token prices from CoinGecko (one batched call) and converts reserves to USD — "reserve-derived TVL": on-chain reserves × external prices, each labeled as such in the UI.
5. Records the difference vs the index-reported TVL as a data-quality signal — large gaps are shown, never hidden, and no tolerance is claimed that the code doesn't enforce.
6. Checks each stablecoin's price against its peg — this is how the MSUSD finding was produced (Aug 26–28: a "stablecoin" reading ~$0.67–0.68 on-chain-verified cycles while pools containing it advertised up to ~46% APY). Every peg flag is preserved in `data/findings.json` (`src/findings.js`), including findings whose token later left the index.

**What this proves:** the contract's token reserves at a specific, publicly checkable block (every verified pool links to its contract on BaseScan).
**What it does not prove:** the protocol's reported APY. YieldWire deliberately keeps those claims separate and says so on the site.

## Architecture

```
GitHub Actions (triggered; self-paced 5-min loop inside each job, ~6h handoff)
        │
        ▼
DeFiLlama /yields ──► normalize + source-consistency ──► 4 deterministic triggers ──► event objects
        │                                                       │
        │        ┌──────────────────────────────────────────────┘
        │        ▼
        │  crosscheck.js: top pools by TVL ──► Base RPC getReserves() + CoinGecko prices
        │        │                     (peg flags, block-stamped receipts)
        │        ▼
        │  xref.js: independent-source claims per event (claim-checked)
        │        │
        │  optional: 1 LLM sentence (claim-checked)
        │        │
        └────────┴──────────────┬───────────────────────────────────────┐
                                ▼                                       ▼
                    alert messages (log-only in this        data/*.json committed (public, versioned)
                    deployment; templates in src/telegram.js)
                                │                                       │
                                ▼                                       ▼
                          public site (GitHub Pages) ◄── raw.githubusercontent ◄── repo
```

| Piece | File |
|---|---|
| Entry point (one run / paced loop) | `src/run.js` |
| Deterministic core + thresholds | `src/engine.js` |
| Data source (single yield index) | `src/data.js` |
| **On-chain cross-check (Base RPC `getReserves`)** | **`src/crosscheck.js`** |
| Independent-source claim checker | `src/xref.js` |
| LLM one-liner + claim-checker (optional) | `src/llm.js` |
| Coin logos (3-layer, decorative only) | `src/logos.js` |
| Telegram templates | `src/telegram.js` |
| Triggers + public-history commit | `.github/workflows/agent.yml` |
| Site | repo root (`index.html`) |
| Token-level findings ledger (preserved evidence) | `data/findings.json` via `src/findings.js` |
| One-time history backfill (same engine, replayed) | `scripts/backfill-findings.mjs` |
| Public record | `data/` (committed every ~5 min) |

Zero runtime dependencies. Node 20. **$0/month.**

## The 5-minute cadence, honestly

The workflow is scheduled to fire every 5 minutes, and each job also runs a **self-paced loop** (a verified snapshot every ~5 minutes) for the ~6 hours a job is allowed to run, then hands off to the next job. The git history of `data/` — timestamped by GitHub — is the *observed* cadence, and the site's ledger tab lets anyone replay any snapshot. If a cycle is missed, the site shows STALE rather than dressing up a stale number as fresh.

## What a technical reviewer might ask (and the honest answers)

1. **"Where does your APY actually come from?"** — DeFiLlama's public yields endpoint. We preserve the source data with every snapshot and never let the LLM calculate numbers.
2. **"How do you know DeFiLlama isn't wrong?"** — We don't assume it's infallible. We run source-consistency checks, and we independently read the top covered pools' contracts on Base (`src/crosscheck.js`) to verify on-chain state against the index. Coverage is per-protocol and published; what isn't covered yet is labeled, not hidden.
3. **"Does `getReserves` prove APY?"** — No. It proves the pool's reported reserves at a specific block. APY comes from the yield index. We keep those claims separate and label them as such.
4. **"Why only some pools on-chain?"** — Contract coverage is per-protocol (factories + reserve interfaces). v1 covers Aerodrome v1 pools; within it, the top pools by TVL are checked where user money concentrates, plus anything previously flagged. Pools outside coverage are labeled `pending-coverage` — still monitored and screened through the index, cross-checked the moment coverage exists. No tolerance or guarantee is claimed beyond what the code enforces.
5. **"Why 2 percentage points / 25% / 500%?"** — Published deterministic thresholds designed to separate meaningful change (or obvious data garbage) from noise. They are noise filters, not claims about what's possible.
6. **"Can you manipulate the historical records?"** — The history is public and versioned in Git, and every monitoring run is visible in GitHub Actions. We don't claim blockchain-level immutability; we claim everything is publicly inspectable and replayable — and we mean exactly that.
7. **"Where is the AI?"** — The AI doesn't decide financial facts. The deterministic agent gathers, filters, calculates, and verifies. The optional LLM only converts already-verified facts into one human-readable, claim-checked sentence.

## Run it locally

```bash
cp .env.example .env   # fill in TG_BOT_TOKEN / TG_CHAT_ID (optional GEMINI_API_KEY)
node src/run.js        # no key? messages print to the log (dry run)
```

Without Telegram secrets, the run is a dry run: fetch → detect → cross-check → print the exact messages it would send.

## Design rules

- **If the data source fails, the run fails loudly.** A red Actions run and a STALE banner are more honest than a stale number dressed as fresh.
- **No simulated numbers, anywhere.** Nothing the agent hasn't actually computed in a real run appears on the site or in Telegram.
- **Claims are scoped.** "On-chain verified" means what the code proves — reserves at a block — and nothing more.
- **The LLM is a guest.** One sentence, validated, clearly labeled. Keyless mode (no model at all) is fully supported and shown on the site.
- **Thresholds are published, not hidden.** Check them.
- **Failures are published.** Rejected pools, claim-checker rejections, consistency failures — error handling is part of the product.

## Roadmap

YieldWire is a detector pipeline. **Shipped: detector 1 of 3 — Yield Regime.** Wallet Flow and Liquidity Migration plug into the same fetch → detect → receipt architecture. One detector, done properly, first.

## Links

- Site (GitHub Pages) · [GitHub](https://github.com/Bigmanmarsh/yieldwire) · ledger = the commit history of `data/`

*Data: DeFiLlama (yield index), Base RPC (on-chain reserves), CoinGecko (prices). Not financial advice.*
