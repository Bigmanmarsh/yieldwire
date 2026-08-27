# YieldWire — the wire for Base yield

**You don't monitor yield. The wire does.**

YieldWire is an autonomous agent that monitors every stablecoin pool on Base (TVL ≥ $500K) on a 5-minute cadence, **verifies the top pools by reading their own contracts on-chain**, and leaves a public, versioned record of every snapshot. The moment the board changes — leader swap, APY jump, collapse, TVL shift, a token drifting off its peg — it messages you on Telegram with the before, the after, and the math attached. No wallet. No custody. No trades.

Built for the [Orion Agents Builder Hackathon](https://orionagents.org/hackathon).

## What YieldWire actually does

1. Finds stablecoin yield pools on Base (one public index: DeFiLlama).
2. Records the advertised yield and liquidity for each.
3. Rejects pools that fail published rules — and publishes every rejection, counted, with named receipts for the most severe.
4. **Checks the top pools directly against the blockchain** (on-chain reserve verification).
5. Detects meaningful changes with deterministic thresholds (all published).
6. Sends alerts with the evidence attached.
7. Publishes the data, events, and state permanently in public, versioned history.

## What YieldWire does NOT do

- Does not hold money, custody anything, or execute trades.
- Does not recommend that you invest in anything. A high APY is a number, not a verdict.
- Does not let the LLM calculate or decide financial numbers (see below).
- Does not pretend APY is guaranteed, or that on-chain reserve checks prove APY.
- Does not claim blockchain-grade immutability for its history — it's public, versioned, and tamper-evident, which is exactly what it claims to be.

## The pipeline (60-second version)

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

   Plus **peg monitoring**: any stablecoin in a verified pool trading more than 5% off its peg gets flagged with its price, the peg, and the block it was read at.
6. **Deliver** — Telegram alert + site refresh. An optional LLM (free tier, keyless mode fully supported) may write exactly one summary sentence — and a claim-checker rejects any number it invents. **The LLM did not calculate any number on this site.**

## On-chain cross-check — the part that proves we don't trust the index

**File: `src/crosscheck.js`.** For the top pools by TVL each cycle, the agent:

1. Resolves the pool's actual contract address from the protocol's factory registry on Base.
2. Calls `getReserves()` on that contract via **public, read-only Base RPC** (no wallet, no keys, no funds).
3. Fetches token prices from CoinGecko (one batched call) and converts reserves to USD.
4. Compares against the index-reported TVL (published tolerance: 0.5%) and records the **block number and timestamp** of the read.
5. Checks each stablecoin's price against its peg — this is how the live MSUSD flag is produced (a "stablecoin" trading $0.68 while its pool advertises ~36% APY).

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
                    Telegram alerts + daily digest          data/*.json committed (public, versioned)
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
| Public record | `data/` (committed every ~5 min) |

Zero runtime dependencies. Node 20. **$0/month.**

## The 5-minute cadence, honestly

The workflow is scheduled to fire every 5 minutes, and each job also runs a **self-paced loop** (a verified snapshot every ~5 minutes) for the ~6 hours a job is allowed to run, then hands off to the next job. The git history of `data/` — timestamped by GitHub — is the *observed* cadence, and the site's ledger tab lets anyone replay any snapshot. If a cycle is missed, the site shows STALE rather than dressing up a stale number as fresh.

## What a technical reviewer might ask (and the honest answers)

1. **"Where does your APY actually come from?"** — DeFiLlama's public yields endpoint. We preserve the source data with every snapshot and never let the LLM calculate numbers.
2. **"How do you know DeFiLlama isn't wrong?"** — We don't assume it's infallible. We run source-consistency checks, and we independently read the top pools' contracts on Base (`src/crosscheck.js`) to verify on-chain state against the index.
3. **"Does `getReserves` prove APY?"** — No. It proves the pool's reported reserves at a specific block. APY comes from the yield index. We keep those claims separate and label them as such.
4. **"Why only the top pools on-chain?"** — Free public-RPC stack. We prioritize verification where the largest pools have the greatest user impact; the full universe is still monitored and screened through the index.
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
