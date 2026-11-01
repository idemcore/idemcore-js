#!/usr/bin/env node
// idemcore-trace verify|show|replay FILE  (replay needs IDEMCORE_API_KEY)
import { readFileSync, writeFileSync } from "node:fs";
import { Idemcore, replay, verifyTrace, dumpsTrace } from "../dist/index.js";

const [cmd, file, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const all = (name) => rest.flatMap((x, i) => (x === name ? [rest[i + 1]] : []));
if (!["verify", "show", "replay"].includes(cmd) || !file) {
  console.error("usage: idemcore-trace verify FILE [--keys JWKS] [--signer KID]... [--no-receipts]\n       idemcore-trace show FILE\n       idemcore-trace replay FILE [--out FILE]");
  process.exit(2);
}
const t = JSON.parse(readFileSync(file, "utf8"));
if (cmd === "verify") {
  const signers = all("--signer");
  const r = await verifyTrace(t, { keys: opt("--keys") ? JSON.parse(readFileSync(opt("--keys"), "utf8")) : undefined,
    checkReceipts: !rest.includes("--no-receipts"), trustedSigners: signers.length ? signers : undefined });
  console.log(`${r.ok ? "OK" : "FAILED"}: ${r.steps} steps (${r.modelSteps} model, ${r.toolSteps} tool)` + (r.signers.length ? `, signed by ${r.signers.join(", ")}` : ""));
  for (const e of r.errors) console.log("  error:", e);
  for (const w of r.warnings) console.log("  note:", w);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === "show") {
  const m = t.manifest;
  console.log(`${m.session_id}  ${m.created_at}  ${m.step_count} steps  head ${m.head.slice(0, 16)}`);
  for (const s of t.steps) {
    const b = s.body;
    if (s.type === "model") console.log(`  #${s.index} model ${b.receipt_id} ${b.receipt.output_tokens} tok: ${b.output_text.replace(/\n/g, " ").slice(0, 70)}`);
    else if (s.type === "tool") console.log(`  #${s.index} tool  ${b.name}(${b.args_json.slice(0, 50)}) -> ${(b.result_json ?? b.error ?? "").slice(0, 50)}`);
    else console.log(`  #${s.index} note  ${b.kind} ${b.data_json.slice(0, 60)}`);
  }
} else {
  const r = await replay(t, new Idemcore());
  console.log(r.summary());
  for (const s of r.steps.filter((x) => x.type === "model"))
    console.log(`  #${s.index} ${s.identical ? "identical" : "DIFFERENT"} ${s.receiptId} -> ${s.replayReceiptId}` + [...s.diffs, ...s.notes].map((d) => `\n      ${d}`).join(""));
  if (opt("--out") && r.replayTrace) writeFileSync(opt("--out"), dumpsTrace(r.replayTrace));
  process.exit(r.ok ? 0 : 1);
}
