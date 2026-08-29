# YieldWire — Orion submission pack

Final version. Live numbers move every 5 minutes — the site's record card is always current; this file states dated facts and ranges only.

---

## 1. Entry description (paste into the submission form)

YieldWire is an autonomous verification agent for stablecoin yield on Base. It doesn't trust the yield index — it checks the chain and publishes what it finds, every five minutes, with receipts.

The finding — live right now: MSUSD, a "stablecoin," is trading at ~$0.66 — up to 35.5% below its $1 peg — while pools containing it advertise yields that spiked past 400% APY and have ranked #1 on Base three times. YieldWire has re-verified the pool's contract on-chain across 470+ verified cycles over three days (reserves read via getReserves() at pinned blocks, e.g. block 50,604,266 on contract 0xcefc8b79…64aaf7), first flagging it Aug 26 at $0.68. When the token briefly vanished from the data source's index, the agent preserved the record and marked monitoring "ended by the source, not by us" — then picked it up again automatically when it returned. Every yield dashboard shows the number. YieldWire shows what the number is hiding.

The loop, running since Aug 26: every 5 minutes the agent reads every Base stablecoin pool above $500K TVL (~80) from one public index, applies published deterministic rules — APY jumps/collapses, TVL shifts, leader changes; stale, outlier and dead pools are refused, and every refusal is published with its reason (~160 per cycle). For pools in its supported protocols it reads the actual contracts on-chain: reserve-derived TVL and peg checks at a pinned block, block number and contract address attached to every read. Anything crossing a threshold becomes an event with its evidence attached: before, after, the math, and independent-source verdicts.

The record: one public commit every ~5 minutes — 500+ and counting, median gap 5.0 minutes — an append-only, replayable history. Anyone can reproduce any past event from its committed inputs (node src/run.js --replay <commit>) and get the identical result.

The AI rule: a deterministic engine computes every number. An optional LLM may write exactly one summary sentence about already-verified facts, and a claim-checker rejects any sentence containing an invented number. The production deployment runs keyless — no model at all — and the site says so. The AI never decides whether a number is true.

No wallet. No custody. No trades. No paid APIs. Read-only public RPCs, $0/month.

Verify it in 60 seconds: open the site — the live MSUSD anomaly is the first thing on the homepage, with contract and block links → the record card shows the full history with current figures → click "watch it run live" and watch green runs land on GitHub Actions every 5 minutes.

---

## 2. Short version (if the form caps length)

YieldWire is an autonomous agent that verifies stablecoin yield on Base every 5 minutes and publishes public receipts. Its flagship finding, live now: MSUSD, a "stablecoin," trading ~35% below its $1 peg while pools containing it advertise yields that spiked past 400% APY and ranked #1 on Base three times — verified on-chain across 470+ cycles over three days at pinned blocks. Every refusal, event, and on-chain read ships with evidence in an append-only public ledger (500+ commits, median gap 5.0 min, replayable with one command). A deterministic engine computes every number; the optional LLM writes at most one claim-checked sentence and is keyless in production. No wallet, no custody, no trades, no paid APIs.

---

## 3. Links for the form

Website / Demo: https://bigmanmarsh.github.io/yieldwire/
GitHub: https://github.com/Bigmanmarsh/yieldwire

## 4. Before submitting (deadline Sept 2, 23:59 UTC)

- Submit from the registered wallet
- X profile and Discord/Telegram links are required by the rules
- Numbers in Section 1 are dated facts; for current figures, read the live record card on the site
