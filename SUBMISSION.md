# YieldWire — Orion submission pack

Everything below is ready to paste. Prepared from the calibrated rubric: finding first, numbers in the first breath, every claim checkable.

---

## 1. Entry description (paste into the submission form)

YieldWire is an autonomous verification agent for stablecoin yield on Base. It doesn't trust the yield index — it checks the chain and publishes what it finds, every five minutes, with receipts.

**The finding, on the record:** on Aug 26 the agent flagged that MSUSD — a "stablecoin" — was trading at $0.67–0.68, up to **33.1% below its $1 peg**. It then re-verified the pool's contract on-chain across **270 verified cycles over ~30 hours** (reserves read directly via getReserves() at pinned blocks — e.g. block 50,550,688 on contract 0xcefc8b79…64aaf7), while pools containing MSUSD advertised **up to 92.6% APY** and briefly ranked **#1 on Base**. Every yield dashboard showed the number. YieldWire showed what the number was hiding. The token has since vanished from the data source's index — monitoring ended by the source, not by us — and the full evidence is preserved in data/findings.json, replayable commit-by-commit.

**The loop, running since Aug 26:** every 5 minutes the agent reads every Base stablecoin pool above $500K TVL (~80 right now) from one public index, applies published deterministic rules — APY jumps/collapses, TVL shifts, leader changes; stale, outlier and dead pools are refused, and **every refusal is published with its reason** (161 refused in the latest cycle). For pools in its supported protocols it then reads the actual contracts on-chain: reserve-derived TVL and peg checks at a pinned block, block number and contract address attached to every read. Anything crossing a threshold becomes an event with its evidence attached: before, after, the math, and independent-source verdicts (on-chain reserves, CoinGecko prices, recomputed rankings).

**The record:** one public commit every ~5 minutes — 490+ and counting, median gap 5.0 minutes — an append-only, replayable history. Anyone can reproduce any past event from its committed inputs `node src/run.js --replay <commit>`) and get the identical result. Tamper-evident, fully public.

**The AI rule:** a deterministic engine computes every number. An optional LLM may write exactly one summary sentence about already-verified facts, and a claim-checker rejects any sentence containing an invented number. The production deployment runs keyless — no model at all — and the site says so. The AI never decides whether a number is true.

**No wallet. No custody. No trades. No paid APIs.** Read-only public RPCs, $0/month.

**Verify it in 60 seconds:** open the site — the MSUSD record is on the homepage with the contract and block links → open the ledger and replay any snapshot from Aug 26–28 to see the peg flag exactly as the agent recorded it → click "watch it run live" and watch green runs land on GitHub Actions every 5 minutes.

---

## 2. Short version (if the form caps length)

YieldWire is an autonomous agent that verifies stablecoin yield on Base every 5 minutes and publishes public receipts. Its flagship catch, on the record: MSUSD, a "stablecoin," trading at $0.67–0.68 — up to 33.1% below its $1 peg — verified on-chain across 270 cycles over ~30 hours (reserves read from the pool contract at pinned blocks), while pools containing it advertised up to 92.6% APY and briefly ranked #1 on Base. Every refusal, every event, every on-chain read ships with its evidence in an append-only public ledger (490+ commits, median gap 5.0 min, replayable with one command). A deterministic engine computes every number; the optional LLM may write one claim-checked sentence and is keyless in production. No wallet, no custody, no trades, no paid APIs.

---

## 3. Repository "About" string (Settings → About → description)

YieldWire — the autonomous agent that watches Base stablecoin yield every 5 minutes and publishes public receipts on everything it finds. No custody. No trades.

(Also updated in package.json; GitHub's About field must be edited by hand or with `gh repo edit --description "..."`.)

---

## 4. Links for the form

| Field | Value |
|---|---|
| Website | [https://bigmanmarsh.github.io/yieldwire/](https://bigmanmarsh.github.io/yieldwire/) |
| Demo | [https://bigmanmarsh.github.io/yieldwire/](https://bigmanmarsh.github.io/yieldwire/) (the live system IS the demo; "watch it run live" is one click) |
| GitHub | [https://github.com/Bigmanmarsh/yieldwire](https://github.com/Bigmanmarsh/yieldwire) |

## 5. Submission checklist (the rules require these)

- [ ] Registered wallet → submit from it before **Sept 2, 23:59 UTC**
- [ ] Website link ✓ (above)
- [ ] **X profile** — required by the rules. Either your own account or create one for the agent; one pinned tweet linking the MSUSD record would mirror what top entries did
- [ ] GitHub ✓ (above)
- [ ] **Discord or Telegram link** — required by the rules. If nothing exists, point it at your X/GitHub discussions or stand up a minimal public Telegram channel announcing findings
- [ ] Repo "About" string updated (Section 3)
- [ ] New coding session → push the local commit on `arena/01a0484b-yieldwire` (index.html "watch it run live" links + package.json) and merge to main
- [ ] After merging, wait 2 minutes and reload the site once to confirm the new hero button renders
