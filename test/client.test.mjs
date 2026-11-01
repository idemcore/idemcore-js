import { test } from "node:test";
import assert from "node:assert/strict";
import { Idemcore, AuthenticationError, InvalidRequestError, NotFoundError, RateLimitError,
  InsufficientQuotaError, ServiceUnavailableError } from "../dist/index.js";
import { KEY, V, mock } from "./mock.mjs";

const setup = () => { const m = mock(); return { m, c: new Idemcore({ apiKey: KEY, baseURL: "https://api.test/v1", fetch: m.fetch, maxRetries: 1 }) }; };
const last = (m) => m.state.requests.at(-1);

test("health needs no key", async () => {
  const m = mock();
  const h = await new Idemcore({ apiKey: "", baseURL: "https://api.test", fetch: m.fetch }).health();
  assert.equal(h.ok, true);
  assert.equal(last(m).headers.authorization, undefined);
});

test("api key from env, never serialised", async () => {
  const m = mock();
  process.env.IDEMCORE_API_KEY = KEY;
  try {
    const c = new Idemcore({ baseURL: "https://api.test", fetch: m.fetch });
    assert.equal((await c.models())[0].id, "qwen2.5-7b-instruct-q4");
    assert.ok(!JSON.stringify(c).includes(KEY));
    assert.ok(!require_inspect(c).includes(KEY));
  } finally { delete process.env.IDEMCORE_API_KEY; }
});
import { inspect } from "node:util";
function require_inspect(o) { return inspect(o, { showHidden: true, depth: 5 }); }

test("missing or wrong key", async () => {
  const m = mock();
  await assert.rejects(new Idemcore({ apiKey: "", baseURL: "https://api.test", fetch: m.fetch }).models(), AuthenticationError);
  await assert.rejects(new Idemcore({ apiKey: "ick_" + "B".repeat(43), baseURL: "https://api.test", fetch: m.fetch }).models(), AuthenticationError);
});

test("chat returns text and receipt", async () => {
  const { m, c } = setup();
  const r = await c.chat("What is the capital of France?", { maxTokens: 64, privacy: "hash_only" });
  const q = last(m);
  assert.equal(q.path, "/v1/chat/completions");
  assert.equal(q.headers["content-type"], "application/json");
  assert.deepEqual(q.body, { messages: [{ role: "user", content: "What is the capital of France?" }], max_tokens: 64, idemcore: { privacy: "hash_only" } });
  assert.equal(r.text, V.output_text);
  assert.match(r.receiptId, /^rcpt_[0-9a-f]{24}$/);
  assert.equal(r.salt, V.salt_b64u);
  assert.deepEqual(r.outputTokenIds, V.output_ids);
  assert.equal(r.usage.total_tokens, 27);
  assert.equal(r.rateLimit["x-ratelimit-limit-requests"], "60");
});

test("chat validates locally", async () => {
  const { m, c } = setup();
  for (const o of [{ temperature: 0.7 }, { maxTokens: 0 }, { maxTokens: 4096 }, { privacy: "public" }])
    await assert.rejects(c.chat("hi", o), InvalidRequestError);
  await assert.rejects(c.chat([]), InvalidRequestError);
  await c.chat("hi", { temperature: 0 });
  assert.equal("temperature" in last(m).body, false);
});

test("verifyLocal: L1 + L2 + disclosure", async () => {
  const { c } = setup();
  const r = await c.chat(V.messages);
  const res = await c.verifyLocal(r, { keys: V.keys });
  assert.ok(res.ok, JSON.stringify(res.levels));
  assert.deepEqual(Object.keys(res.levels), ["L1", "L2", "disclosure"]);
  assert.deepEqual(res.levels.disclosure.checked, ["prompt_hash", "output_token_hash", "output_text_hash"]);
  const bundled = await c.verifyLocal(r);
  assert.equal(bundled.ok, false);
  assert.match(bundled.levels.L1.errors[0], /unknown key_id/);
  r.text = "The capital of France is Lyon.";
  assert.equal((await c.verifyLocal(r, { keys: V.keys, fetchLog: false })).ok, false);
});

test("receipt endpoints", async () => {
  const { m, c } = setup();
  const id = V.receipts.full.receipt_id;
  assert.deepEqual(await c.getReceipt(id), V.receipts.full);
  const log = await c.getReceiptLog(id);
  assert.equal(log.logFormat, "idemcore-log/r1-public");
  assert.equal(log.logText, V.log_text);
  assert.equal(last(m).path, `/v1/receipts/${id}/log`);
  await assert.rejects(c.getReceipt("rcpt_../admin"), InvalidRequestError);
  await assert.rejects(c.getReceipt("rcpt_" + "0".repeat(24)), NotFoundError);
  assert.deepEqual((await c.keys()).keys, V.keys);
});

test("verifyRemote, replay, audit export", async () => {
  const { m, c } = setup();
  const r = await c.chat(V.messages);
  assert.equal((await c.verifyRemote(r.receipt, { messages: r.messages, salt: r.salt, outputTokenIds: r.outputTokenIds })).ok, true);
  assert.equal(last(m).body.disclosure.salt, V.salt_b64u);
  assert.equal((await c.replayResult(r, "alt")).level, "L3");
  assert.equal(last(m).body.receipt_id, r.receiptId);
  const lines = await c.auditExport({ since: "2026-10-01", until: "2026-10-31", includeLogs: true });
  assert.equal(lines[0].type, "header");
  assert.deepEqual(last(m).body, { since: "2026-10-01", until: "2026-10-31", include_logs: true });
  assert.equal((await c.auditExport({ format: "json" })).format, "idemcore-audit-export/r1");
});

test("errors and retries", async () => {
  const { m, c } = setup();
  m.state.failNext = [[429, "rate_limit_error", { "retry-after": "0" }]];
  assert.ok(await c.models());
  m.state.failNext = [[429, "rate_limit_error", { "retry-after": "0" }]];
  const e = await c.chat("hi").catch((x) => x);
  assert.ok(e instanceof RateLimitError);
  assert.equal(e.status, 429);
  assert.equal(e.retryAfter, 0);
  m.state.failNext = [[429, "insufficient_quota", {}]];
  await assert.rejects(c.models(), InsufficientQuotaError);
  m.state.failNext = [[503, "service_unavailable", {}], [503, "service_unavailable", {}]];
  await assert.rejects(c.models(), ServiceUnavailableError);
});

test("streaming", async () => {
  const { m, c } = setup();
  const s = c.chatStream(V.messages);
  let text = "";
  for await (const ch of s) text += ch.delta;
  assert.equal(text, V.output_text);
  const r = await s.finalResult();
  assert.equal(r.text, V.output_text);
  assert.match(r.receiptId, /^rcpt_/);
  assert.equal(r.usage.total_tokens, 27);
  assert.equal(r.salt, V.salt_b64u);
  assert.deepEqual(last(m).body.stream_options, { include_usage: true });
  assert.ok((await c.verifyLocal(r, { keys: V.keys })).ok);
  const r2 = await c.chatStream(V.messages).finalResult();
  assert.equal(r2.receiptId, r.receiptId);
});

test("stream error event", async () => {
  const { c } = setup();
  await assert.rejects(c.chatStream("FAIL").finalResult(), ServiceUnavailableError);
});

test("live /health smoke (IDEMCORE_LIVE=1)", { skip: process.env.IDEMCORE_LIVE !== "1" }, async () => {
  const h = await new Idemcore({ apiKey: "" }).health();
  assert.equal(h.ok, true);
});
