// YieldWire · src/llm.js — the only place a model is allowed to touch output.
//
// Scope: ONE plain sentence describing a finished deterministic event.
// Guards:
//   1. If no GEMINI_API_KEY is configured → keyless mode. The agent runs
//      fully on deterministic templates and the site says so. (A supported
//      mode, not a degraded one — the numbers never needed a model.)
//   2. Claim-checker: every number the model writes must appear in the
//      fact line (rounding-tolerant). One invented number → sentence
//      rejected, template used instead. Rejections are logged and counted,
//      and the count is published on the site.
//
// No other LLM use exists in this codebase.

const MODEL = "gemini-2.0-flash";
const NUMBERS_RE = /\d+(?:[.,]\d+)?/g;

export async function summarize(event, factLineText) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { text: null, source: "keyless — no LLM configured" };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text:
                `Write exactly ONE plain sentence (max 20 words) describing this ` +
                `Base stablecoin-yield event for a busy trader. ` +
                `Use ONLY the numbers given below. Do not add facts, forecasts, ` +
                `advice, or tokens not mentioned.\n\nEVENT:\n${factLineText}\n\nOne sentence:`,
            }],
          }],
        }),
        signal: AbortSignal.timeout(20000),
      }
    );
    const json = await res.json().catch(() => ({}));
    const reply = (json.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
    if (!reply) return { text: null, source: "LLM empty response → template" };
    if (claimCheck(reply, factLineText)) return { text: reply, source: "LLM, claim-checked" };
    return { text: null, source: "LLM rejected by claim-checker (invented number) → template" };
  } catch (err) {
    return { text: null, source: `LLM unavailable (${err.message}) → template` };
  }
}

// Every number in the reply must exist in the facts, tolerant of rounding:
// |reply - fact| ≤ max(5% of value, 0.05).
function claimCheck(reply, facts) {
  const factNums = (facts.match(NUMBERS_RE) ?? []).map((n) => parseFloat(n.replace(",", "")));
  const replyNums = (reply.match(NUMBERS_RE) ?? []).map((n) => parseFloat(n.replace(",", "")));
  for (const v of replyNums) {
    if (!factNums.some((f) => Math.abs(f - v) <= Math.max(0.05 * Math.abs(v), 0.05))) return false;
  }
  return true;
}
