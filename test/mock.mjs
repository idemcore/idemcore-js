// Mocked fetch for the Idemcore API, built from the receipt test vectors (ephemeral key).
import { readFileSync } from "node:fs";
export const V = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
export const KEY = "ick_" + "A".repeat(43); // obviously fake

const json = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
const err = (status, type, message, headers) => json(status, { error: { type, message } }, headers);

export function chatBody(r) {
  return {
    id: "chatcmpl-" + r.receipt_id.slice(5), object: "chat.completion", created: 1, model: r.model_id,
    choices: [{ index: 0, message: { role: "assistant", content: V.output_text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
    idemcore_receipt: r, idemcore_salt: V.salt_b64u, idemcore_salt_warning: "keep the salt private",
    idemcore: { receipt: r, disclosure: { salt: V.salt_b64u, output_token_ids: V.output_ids, warning: "keep the salt private" } },
  };
}

function sse(r, fail) {
  const base = { id: "chatcmpl-x", object: "chat.completion.chunk", created: 1, model: r.model_id };
  const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const parts = [ev({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }), ": keep-alive\n\n"];
  if (fail) parts.push(ev({ error: { type: "service_unavailable", message: "inference backend unavailable" } }));
  else {
    const fin = chatBody(r);
    parts.push(
      ev({ ...base, choices: [{ index: 0, delta: { content: V.output_text.slice(0, 10) }, finish_reason: null }] }),
      ev({ ...base, choices: [{ index: 0, delta: { content: V.output_text.slice(10) }, finish_reason: null }] }),
      ev({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], idemcore_receipt: r, idemcore_salt: fin.idemcore_salt, idemcore: fin.idemcore }),
      ev({ ...base, choices: [], usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 } }),
      "data: [DONE]\n\n");
  }
  // deliver in awkward 7-byte pieces to exercise the parser's buffering
  const bytes = new TextEncoder().encode(parts.join(""));
  return new ReadableStream({
    start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); },
  });
}

export function mock() {
  const state = { requests: [], failNext: [] };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push({ method: init.method, path: u.pathname + u.search, headers, body });
    if (u.pathname === "/health") return json(200, { ok: true, service: "idemcore-receipts", version: "0.1.0" });
    if (headers.authorization !== "Bearer " + KEY) return err(401, "authentication_error", "invalid or missing API key");
    if (state.failNext.length) { const [s, t, h] = state.failNext.shift(); return err(s, t, "injected", h); }
    if (u.pathname === "/v1/models") return json(200, { object: "list", data: [{ id: "qwen2.5-7b-instruct-q4", object: "model", owned_by: "idemcore" }] });
    if (u.pathname === "/v1/keys") return json(200, { keys: V.keys });
    if (u.pathname === "/v1/chat/completions") {
      const r = V.receipts.hash_only_text;
      if (body.stream) return new Response(sse(r, body.messages[0].content === "FAIL"), { status: 200, headers: { "content-type": "text/event-stream" } });
      return json(200, chatBody(r), { "idemcore-receipt-id": r.receipt_id, "x-ratelimit-limit-requests": "60" });
    }
    const m = u.pathname.match(/^\/v1\/receipts\/(rcpt_[0-9a-f]{24})(\/log)?$/);
    if (m) {
      const rec = Object.values(V.receipts).find((x) => x.receipt_id === m[1]);
      if (!rec) return err(404, "not_found_error", "receipt not found");
      if (m[2]) return json(200, { receipt_id: m[1], receipt: rec, log_format: "idemcore-log/r1-public", log_text: V.log_text });
      return json(200, { receipt: rec });
    }
    if (u.pathname === "/v1/receipts/verify") return json(200, { ok: true, levels: { L1: { level: "L1", ok: true, errors: [] } } });
    if (u.pathname === "/v1/receipts/replay") return json(200, { ok: true, level: "L3", errors: [], mode: "score" });
    if (u.pathname === "/v1/audit/export") {
      if (body?.format === "json") return json(200, { format: "idemcore-audit-export/r1", receipts: [] });
      const lines = [{ type: "header", format: "idemcore-audit-export/r1" }, { type: "receipt", receipt: V.receipts.full }];
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
    }
    return err(404, "not_found_error", "unknown endpoint");
  };
  return { state, fetch };
}
