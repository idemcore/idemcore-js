import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { b64u, b64uDecode, checkFormat, DEFAULT_TRUSTED_KEYS, importKeySet, importJwk, logDigests, verifyDisclosure,
  verifyL1, verifyL2, verifyReceipt, loadKeys, RECEIPT_VERSION, RECEIPT_VERSIONS, chainCheckField } from "../dist/index.js";
import { V } from "./mock.mjs";
const _dir = dirname(fileURLToPath(import.meta.url));
const V1 = JSON.parse(readFileSync(join(_dir, "fixtures/vectors_r1.json"), "utf8"));
const V2 = JSON.parse(readFileSync(join(_dir, "fixtures/vectors_r2.json"), "utf8"));

test("vector expectations", async () => {
  const keys = await importKeySet(V.keys, "test");
  for (const [name, exp] of Object.entries(V.expect)) {
    const r = name === "bad_log" ? V.receipts.full : V.receipts[name];
    if ("l1" in exp) assert.equal((await verifyL1(r, keys)).ok, exp.l1, name);
    if ("l2" in exp) assert.equal((await verifyL2(r, name === "bad_log" ? V.bad_log_text : V.log_text)).ok, exp.l2, name);
  }
});

test("disclosure", async () => {
  const salt = b64uDecode(V.salt_b64u);
  for (const name of ["hash_only", "hash_only_text", "full", "full_text"]) {
    const d = await verifyDisclosure(V.receipts[name], { messages: V.messages, salt, outputIds: V.output_ids,
      outputText: name.endsWith("_text") ? V.output_text : undefined });
    assert.ok(d.ok, name + " " + d.errors);
  }
  const r = V.receipts.hash_only;
  assert.equal((await verifyDisclosure(r, { messages: V.messages })).ok, false);
  assert.equal((await verifyDisclosure(r, { salt, outputIds: V.output_ids.slice(0, -1) })).ok, false);
  assert.equal((await verifyDisclosure(r, { salt, outputText: "x" })).ok, false);
  const spaced = "  The capital\u00a0of France\n is   Paris. ";
  assert.ok((await verifyDisclosure(V.receipts.hash_only_text, { salt, outputText: spaced })).ok);
});

test("base64url round trip", () => {
  for (let n = 0; n < 40; n++) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
    const s = b64u(b);
    assert.equal(s, Buffer.from(b).toString("base64url"));
    assert.deepEqual(b64uDecode(s), b);
  }
  assert.throws(() => b64uDecode("a+b/"));
});

test("log and format", async () => {
  const d = await logDigests(V.log_text);
  assert.equal(d.chain_fnv, d.all_line);
  const six = V.log_text.replace("\nALL", " 1 2\nALL");
  assert.equal((await verifyL2(V.receipts.full, six)).ok, false);
  assert.ok(checkFormat({ ...V.receipts.full, extra: 1 }).includes("unknown field extra"));
  assert.ok(checkFormat({ ...V.receipts.full, seed: 1.5 }).length > 0);
});

test("keys", async () => {
  const ks = await loadKeys();
  assert.equal(ks[0].keyId, DEFAULT_TRUSTED_KEYS[0].kid);
  await assert.rejects(importKeySet([{ ...V.keys[0], kid: "ed25519:0000000000000000" }], "t"));
});

test("verifyReceipt", async () => {
  const ok = await verifyReceipt(V.receipts.full, { keys: V.keys, logText: V.log_text, messages: V.messages, outputTokenIds: V.output_ids });
  assert.ok(ok.ok);
  assert.deepEqual(Object.keys(ok.levels), ["L1", "L2", "disclosure"]);
  assert.equal((await verifyReceipt(V.receipts.tampered, { keys: V.keys })).ok, false);
  const ho = await verifyReceipt(V.receipts.hash_only, { keys: V.keys, messages: V.messages, salt: V.salt_b64u, outputTokenIds: V.output_ids });
  assert.ok(ho.ok, JSON.stringify(ho.levels));
});

test("r1 and r2 reference vectors verify", async () => {
  assert.equal(RECEIPT_VERSION, "r2");
  assert.deepEqual([...RECEIPT_VERSIONS], ["r1", "r2"]);
  for (const [name, R, jwk] of [["r1", V1.receipt, V1.public_jwk], ["r2", V2.receipt, V2.public_jwk]]) {
    const keys = [await importJwk(jwk, "test")];
    assert.equal(R.receipt_version, name);
    assert.equal(chainCheckField(R), name === "r2" ? "chain_check" : "chain_fnv");
    assert.equal((await verifyL1(R, keys)).ok, true, name + " L1");
    assert.equal((await verifyL2(R, V1.log)).ok, true, name + " L2");
  }
  const r = V2.receipt;
  assert.ok(!("seed" in r) && !("chain_fnv" in r) && !("kernel_version" in r));
  assert.ok(checkFormat({ ...r, seed: 0 }).includes("unknown field seed"));
  assert.ok(checkFormat({ ...r, receipt_version: "r3" }).some((e) => e.includes("unsupported")));
  const keys = [await importJwk(V2.public_jwk, "test")];
  assert.equal((await verifyL1({ ...r, variant: 1 }, keys)).ok, false);
  assert.ok((await verifyL2({ ...r, chain_check: "0".repeat(16) }, V1.log)).errors.includes("chain_check mismatch"));
});
