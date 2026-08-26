# YieldWire — the wire for Base yield

**You don't monitor yield. The wire does.**

YieldWire is an autonomous agent that watches every stablecoin pool on Base (TVL ≥ $500K) every 5 minutes. The moment the board changes — the yield leader swaps, an APY jumps or collapses, TVL shifts — it messages you on Telegram with the before, the after, and the math attached. No wallet. No custody. No trades. Receipts on everything.

Built for the [Orion Agents Builder Hackathon](https://orionagents.org/hackathon).

## The 60-second version

1. **Fetch** — the free, keyless [DeFiLlama yields endpoint](https://yields.llama.fi/pools), every 5 minutes via GitHub Actions. One source. It's published on the site.
2. **Normalize** — Base · stablecoin · TVL ≥ $500K. Stale, outlier (APY > 500%), and dead pools are rejected, and the rejection counts are published.
3. **Integrity** — wherever all three APY components exist, `apy = apyBase + apyReward` must hold (±0.5pp). Failures are counted and shown.
4. **Detect** — four deterministic triggers, all thresholds published:

   | Trigger | Condition |
   |---|---|
   | 🔀 LEADER_CHANGE | Highest-APY stablecoin pool (TVL ≥ $1M) changed |
   | 📈 APY_JUMP | APY rose ≥ 2.0pp between consecutive scans |
   | 📉 APY_COLLAPSE | APY fell ≥ 2.0pp between consecutive scans |
   | 🌊 TVL_SHIFT | TVL moved ≥ 25% vs ~24h ago |

5. **Deliver** — Telegram alert + a public receipt page per event. The LLM (free Gemini tier, optional) writes exactly one summary sentence — and any number it invents gets the sentence rejected by a claim-checker. **The LLM did not calculate this result.**

Every run commits its snapshot, events, and state to this repository. The append-only git history — timestamped by GitHub, with the public Actions run log as an independent record — is the public record. Any figure on the site can be reproduced from the snapshot at its timestamp.

## Architecture

```
GitHub Actions cron (*/5)
        │
        ▼
DeFiLlama /yields ──► normalize + integrity ──► 4 deterministic triggers ──► event objects
                                                                          │
                                                        optional: 1 LLM sentence (claim-checked)
                                                                          │
                              ┌───────────────────────────────────────────┤
                              ▼                                           ▼
                      Telegram alerts + daily digest            data/*.json committed
                              │                                           │
                              ▼                                           ▼
                       receipt.html pages ◄── raw.githubusercontent ◄── public site (GitHub Pages)
```

| Piece | File |
|---|---|
| Entry point (one run) | `src/run.js` |
| Deterministic core + thresholds | `src/engine.js` |
| Data source | `src/data.js` |
| LLM one-liner + claim-checker (optional) | `src/llm.js` |
| Telegram templates | `src/telegram.js` |
| Cron + public-history commit | `.github/workflows/agent.yml` |
| Site + receipts | `public/` |
| Public record | `data/` (committed every run) |

Zero runtime dependencies. Node 20. $0/month.

## Run it locally

```bash
cp .env.example .env   # fill in TG_BOT_TOKEN / TG_CHAT_ID (optional GEMINI_API_KEY)
node src/run.js        # no key? messages print to the log (dry run)
```

Without Telegram secrets, the run is a dry run: fetch → detect → print the exact messages it would send. Perfect for threshold tuning.

## Design rules

- **If the data source fails, the run fails loudly.** A red Actions run and a STALE banner on the site are more honest than a stale number dressed as fresh.
- **No simulated numbers, anywhere.** Nothing the agent hasn't actually computed in a real run appears on the site or in Telegram.
- **The LLM is a guest.** One sentence, validated, clearly labeled with its provenance. Keyless mode (no model at all) is fully supported and shown on the site when active.
- **Thresholds are published, not hidden.** Audit them.
- **Failures are published.** Rejected pools, claim-checker rejections, integrity failures — the error handling is part of the product.

## Roadmap

YieldWire is a detector pipeline. **Shipped: detector 1 of 3 — Yield Regime.** Wallet Flow and Liquidity Migration plug into the same fetch → detect → receipt architecture. One detector, done perfectly, first.

## Links

- Site (GitHub Pages) · Telegram · [GitHub](https://github.com/Bigmanmarsh/yieldwire)

*Data: DeFiLlama. Not financial advice.*
