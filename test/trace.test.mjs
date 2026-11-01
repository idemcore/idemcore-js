import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Idemcore, Session, replay, verifyTrace, generateSigningKey, traceJson, stepHash, manifestHash, dumpsTrace } from "../dist/index.js";
import { taggedHash } from "../dist/hash.js";
import { KEY, V, mock } from "./mock.mjs";

const KEYS = { keys: V.keys };
const Q = V.messages;
const setup = () => { const m = mock(); return { m, c: new Idemcore({ apiKey: KEY, baseURL: "https://api.test/v1", fetch: m.fetch, maxRetries: 1 }) }; };
const weather = ({ city }) => ({ city, temp_c: 18.5, sky: "cloudy" });
async function agent(s) {
  const a = await s.chat(Q, { maxTokens: 16 });
  const w = await s.tool("get_weather", { city: "Paris" }, weather);
  await s.note("approval", { by: "ops", ok: true });
  const b = await s.chat(Q, { maxTokens: 16 });
  return [a.text, w, b.text];
}
async function rec(c, opts = {}) {
  const s = new Session(c, { meta: { task: "demo", n: 1 } });
  await agent(s);
  return s.finish(opts);
}
const clone = (x) => JSON.parse(JSON.stringify(x));

test("record and verify", async () => {
  const { c } = setup();
  const t = await rec(c);
  assert.deepEqual(t.steps.map((s) => s.type), ["model", "tool", "note", "model"]);
  const v = await verifyTrace(t, { keys: KEYS });
  assert.ok(v.ok, v.errors.join("; "));
  assert.equal(v.modelSteps, 2);
  assert.ok((await verifyTrace(JSON.parse(dumpsTrace(t)), { keys: KEYS })).ok);
  assert.equal((await verifyTrace(t)).ok, false); // production keys reject test receipts
  assert.ok((await verifyTrace(t, { checkReceipts: false })).ok);
});

test("tamper detection", async () => {
  const { c } = setup();
  const t = await rec(c);
  const cases = {
    "tool result": (x) => { x.steps[1].body.result_json = '{"temp_c":30}'; },
    "output text": (x) => { x.steps[0].body.output_text = "Lyon."; },
    "drop step": (x) => { x.steps.splice(2, 1); },
    "reorder": (x) => { x.steps.reverse(); },
    "receipt": (x) => { x.steps[3].body.receipt.output_tokens = 8; },
    "meta": (x) => { x.manifest.meta_json = "{}"; },
    "truncate": (x) => { x.steps.pop(); },
  };
  for (const [name, f] of Object.entries(cases)) {
    const bad = clone(t); f(bad);
    assert.equal((await verifyTrace(bad, { keys: KEYS })).ok, false, name);
  }
  const bad = clone(t);
  const b = bad.steps[1].body;
  b.result_json = '{"temp_c":30}';
  b.result_hash = await taggedHash("trace-tool-result", new TextEncoder().encode(b.result_json));
  bad.steps[1].hash = await stepHash(bad.steps[1]);
  const v = await verifyTrace(bad, { keys: KEYS });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("prev")));
});

test("signatures", async () => {
  const { c } = setup();
  const k = await generateSigningKey(), other = await generateSigningKey();
  const t = await rec(c, { signWith: k });
  assert.ok(!JSON.stringify(t).includes(k.d));
  const v = await verifyTrace(t, { keys: KEYS, trustedSigners: [k.kid] });
  assert.ok(v.ok, v.errors.join("; "));
  assert.deepEqual(v.signers, [k.kid]);
  assert.equal((await verifyTrace(t, { keys: KEYS, trustedSigners: [other.kid] })).ok, false);
  assert.ok((await verifyTrace(t, { keys: KEYS, trustedSigners: [{ x: k.x }] })).ok);
  const bad = clone(t);
  bad.manifest.created_at = "2020-01-01T00:00:00.000Z";
  bad.manifest_hash = await manifestHash(bad.manifest);
  assert.equal((await verifyTrace(bad, { keys: KEYS, trustedSigners: [k.kid] })).ok, false);
  assert.equal((await verifyTrace(await rec(c), { keys: KEYS, requireSignature: true })).ok, false);
});

test("replay model-only and with agent", async () => {
  const { m, c } = setup();
  const t = await rec(c);
  const n = m.state.requests.length;
  const r = await replay(t, c, { keys: KEYS });
  assert.ok(r.ok, r.summary());
  assert.equal(r.modelCalls, 2);
  assert.equal(m.state.requests.length - n, 2);
  assert.ok((await verifyTrace(r.replayTrace, { keys: KEYS })).ok);
  const calls = [];
  const r2 = await replay(t, c, { keys: KEYS, agent: async (s) => {
    await s.chat(Q, { maxTokens: 16 });
    const w = await s.tool("get_weather", { city: "Paris" }, (a) => calls.push(a));
    assert.equal(w.temp_c, 18.5);
    await s.note("approval", { by: "ops", ok: true });
    await s.chat(Q, { maxTokens: 16 });
  } });
  assert.ok(r2.ok, r2.summary());
  assert.deepEqual(calls, []);
});

test("replay divergence", async () => {
  const { c } = setup();
  const t = await rec(c);
  let r = await replay(t, c, { keys: KEYS, agent: async (s) => { await s.chat(Q, { maxTokens: 16 }); await s.tool("get_weather", { city: "Rome" }); } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /differs/);
  r = await replay(t, c, { keys: KEYS, agent: async (s) => { await s.chat(Q, { maxTokens: 16 }); } });
  assert.equal(r.ok, false);
  r = await replay(t, c, { keys: KEYS, agent: async (s) => { await s.chat("hi", { maxTokens: 16 }); } });
  assert.equal(r.ok, false);
  const real = c.chat.bind(c);
  c.chat = async (...a) => {
    const x = await real(...a);
    x.outputTokenIds = [...x.outputTokenIds.slice(0, -1), x.outputTokenIds.at(-1) + 1];
    x.receipt = { ...x.receipt, chain_digest: "0".repeat(64), engine_build: "other" };
    return x;
  };
  r = await replay(t, c, { keys: KEYS });
  assert.equal(r.ok, false);
  assert.ok(r.steps[0].diffs.some((d) => d.includes("position 6")), r.steps[0].diffs.join());
  assert.ok(r.steps[0].diffs.some((d) => d.includes("chain_digest")));
  assert.ok(r.steps[0].notes.some((d) => d.includes("engine_build")));
  r = await replay(t, c, { keys: KEYS, agent, strict: true });
  assert.equal(r.ok, false);
  assert.equal(r.modelCalls, 1);
  const bad = clone(t); bad.steps[1].body.result_json = "{}";
  r = await replay(bad, c, { keys: KEYS });
  assert.equal(r.ok, false); assert.equal(r.modelCalls, 0);
});

test("tool errors, floats, canonical args", async () => {
  const { c } = setup();
  const s = new Session(c);
  await assert.rejects(s.tool("boom", { a: 1 }, () => { throw new TypeError("nope"); }));
  await s.recordTool("ext", [1, 2.5, "é"], { ok: true });
  assert.throws(() => traceJson({ x: NaN }));
  assert.equal(traceJson({ b: 1, a: { d: [1, { z: 0, y: 1 }], c: null } }), '{"a":{"c":null,"d":[1,{"y":1,"z":0}]},"b":1}');
  const t = await s.finish();
  assert.equal(t.steps[0].body.error, "TypeError: nope");
  assert.equal(t.steps[1].body.args_json, '[1,2.5,"é"]');
  assert.ok((await verifyTrace(t, { keys: KEYS })).ok);
  await assert.rejects(s.note("late"));
});

test("tool result key order survives replay", async () => {
  const { c } = setup();
  const seen = [];
  const ag = async (s) => {
    await s.chat(Q, { maxTokens: 16 });
    seen.push(JSON.stringify(await s.tool("t", { q: 1 }, () => ({ z: 1, a: { y: 2, b: 3 } }))));
  };
  const s = new Session(c);
  await ag(s);
  const t = await s.finish();
  assert.equal(t.steps[1].body.result_json, '{"z":1,"a":{"y":2,"b":3}}');
  const r = await replay(t, c, { agent: ag, keys: KEYS });
  assert.ok(r.ok, r.errors.join("; "));
  assert.equal(seen[0], seen[1]);
});

test("streamed answer via recordModel", async () => {
  const { c } = setup();
  const s = new Session();
  const st = c.chatStream(Q, { maxTokens: 16 });
  for await (const _ of st) { /* drain */ }
  await s.recordModel(await st.finalResult(), { maxTokens: 16 }, true);
  const t = await s.finish();
  assert.ok((await verifyTrace(t, { keys: KEYS })).ok);
  assert.ok((await replay(t, c, { keys: KEYS })).ok);
});

test("cross-language: Python trace verifies and replays here", async () => {
  const t = JSON.parse(readFileSync(new URL("./fixtures/py.trace.json", import.meta.url), "utf8"));
  const v = await verifyTrace(t, { keys: KEYS });
  assert.ok(v.ok, v.errors.join("; "));
  const { c } = setup();
  const r = await replay(t, c, { keys: KEYS, agent: async (s) => {
    await agent(s);
    await s.tool("floats", { x: 0.1, y: [1e-7, 2.5] }); // Python wrote 1e-07: compared by value
  } });
  assert.ok(r.ok, r.summary());
  // write a JS fixture for the Python side
  const s = new Session(c, { meta: { fixture: "js", unicode: "Hà Nội ✓" }, sessionId: "ses_000000000000000000000002" });
  await agent(s);
  await s.recordTool("floats", { x: 0.1, y: [1e-7, 2.5] }, { ok: true });
  s.createdAt = "2026-11-01T00:00:00.000Z";
  writeFileSync(new URL("./fixtures/js.trace.json", import.meta.url), dumpsTrace(await s.finish()));
});

test("cli", async () => {
  const { c } = setup();
  const t = await rec(c, { signWith: await generateSigningKey() });
  const d = mkdtempSync(join(tmpdir(), "trace-"));
  const p = join(d, "run.trace.json"), kp = join(d, "keys.json");
  writeFileSync(p, dumpsTrace(t)); writeFileSync(kp, JSON.stringify(KEYS));
  const bin = new URL("../bin/idemcore-trace.mjs", import.meta.url).pathname;
  assert.match(execFileSync("node", [bin, "show", p]).toString(), /tool +get_weather/);
  assert.match(execFileSync("node", [bin, "verify", p, "--keys", kp]).toString(), /^OK/);
  t.steps[1].body.result_json = "{}"; writeFileSync(p, dumpsTrace(t));
  assert.throws(() => execFileSync("node", [bin, "verify", p, "--keys", kp], { stdio: "pipe" }));
});
