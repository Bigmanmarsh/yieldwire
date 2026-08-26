// YieldWire · src/telegram.js — the delivery layer.
//
// Message body is a deterministic template built from the event object.
// The optional LLM line sits at the top and is clearly labeled.
// Plain text + emoji: renders identically everywhere, no parse-mode risk.

const API = "https://api.telegram.org/bot";

export async function send(token, chatId, text) {
  const res = await fetch(`${API}${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${j.error_code}: ${j.description}`);
  return j;
}

const usd = (n) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`;
const pct = (n) => `${n.toFixed(2)}%`;
const ts = (v) => new Date(v).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function alertMessage(ev, { siteBase, summary, summarySource }) {
  const head = `YIELDWIRE · ${ev.type.replace("_", " ")}`;
  const p = ev.pool;
  let body = "";

  switch (ev.type) {
    case "LEADER_CHANGE":
      body =
        `🔀 LEADER CHANGE · Base stablecoin yield\n\n` +
        `${ev.before.symbol} (${pct(ev.before.apy)}) → ${p.symbol} (${pct(p.apy)})\n` +
        `Old leader: ${ev.before.project} · TVL ${usd(ev.before.tvl)}\n` +
        `New leader: ${p.project} · TVL ${usd(p.tvl)}\n` +
        `Gap moved ${ev.delta > 0 ? "+" : ""}${ev.delta}pp\n`;
      break;
    case "APY_JUMP":
      body =
        `📈 APY JUMP · ${p.symbol} (${p.project})\n\n` +
        `${pct(ev.before.apy)} → ${pct(p.apy)}  (+${ev.delta}pp)\n` +
        `TVL ${usd(p.tvl)}\n`;
      break;
    case "APY_COLLAPSE":
      body =
        `📉 APY COLLAPSE · ${p.symbol} (${p.project})\n\n` +
        `${pct(ev.before.apy)} → ${pct(p.apy)}  (${ev.delta}pp)\n` +
        `TVL ${usd(p.tvl)}\n`;
      break;
    case "TVL_SHIFT":
      body =
        `🌊 TVL SHIFT · ${p.symbol} (${p.project})\n\n` +
        `${usd(ev.before.tvl)} → ${usd(p.tvl)}  (${ev.delta > 0 ? "+" : ""}${ev.delta}% vs ~24h ago)\n` +
        `APY now ${pct(p.apy)}\n`;
      break;
  }

  body += `Trigger: ${ev.trigger}\n`;
  body += `Data: DeFiLlama yields · ${ts(ev.ts)}\n`;
  if (summary?.text) {
    body += `» ${summary.text}\n   (one-line summary: ${summarySource})\n`;
  }
  body += `Receipt: ${siteBase}/receipt.html?id=${ev.id}\n`;
  return `${head}\n\n${body}`;
}

export function digestMessage({ leaderNow, top, events24h, quality, integrity, siteBase, tsNow }) {
  const byType = {};
  for (const e of events24h) byType[e.type] = (byType[e.type] ?? 0) + 1;
  const t = (k) => byType[k] ?? 0;

  let out = `☀️ YIELDWIRE DAILY · ${tsNow.toISOString().slice(0, 10)}\n\n`;
  if (leaderNow) {
    out += `Leader: ${leaderNow.symbol} (${leaderNow.project}) · ${pct(leaderNow.apy)} · TVL ${usd(leaderNow.tvl)}\n\n`;
  }
  out += `Top 3 by APY:\n`;
  for (const p of top.slice(0, 3)) out += `  · ${p.symbol} — ${pct(p.apy)} (base ${p.apyBase != null ? pct(p.apyBase) : "—"} / reward ${p.apyReward != null ? pct(p.apyReward) : "—"}) · ${usd(p.tvl)}\n`;

  out += `\nLast 24h: ${events24h.length} events — ${t("LEADER_CHANGE")} leader · ${t("APY_JUMP")} jumps · ${t("APY_COLLAPSE")} collapses · ${t("TVL_SHIFT")} TVL shifts\n`;
  out += `Data quality: ${quality.rejected.stale + quality.rejected.outlier + quality.rejected.dead} pools rejected (stale ${quality.rejected.stale} · outlier ${quality.rejected.outlier} · dead ${quality.rejected.dead}) · source integrity ${integrity.pass}/${integrity.checked}\n`;
  out += `Data: DeFiLlama yields · ${ts(tsNow)}\n`;
  out += `All events: ${siteBase}\n`;
  return out;
}
