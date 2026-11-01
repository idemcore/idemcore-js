// Offline verification of Idemcore receipts r1 (L1 signature, L2 chain, disclosure).
import { canonicalBytes, canonicalString } from "./canonical.js";
import { b64uDecode, concat, utf8 } from "./bytes.js";
import { logDigests, promptHash, textHash, tokenHash } from "./hash.js";
import type { TrustedKey } from "./keys.js";

export const RECEIPT_VERSION = "r1";
const SIG_DOMAIN = utf8("idemcore-receipt/r1\n");
const HEX64 = /^[0-9a-f]{64}$/, HEX16 = /^[0-9a-f]{16}$/;

const REQUIRED: Record<string, "str" | "int"> = {
  receipt_version: "str", receipt_id: "str", issued_at: "str", tenant_id: "str", model_id: "str",
  weights_hash: "str", kernel_version: "str", engine_build: "str", privacy: "str", prompt_hash: "str",
  params_hash: "str", seed: "int", decoding: "str", prompt_tokens: "int", output_tokens: "int",
  output_token_hash: "str", chain_digest: "str", chain_fnv: "str", log_ref: "str", key_id: "str", signature: "str",
};
const OPTIONAL: Record<string, "str"> = { finish_reason: "str", request_id: "str", output_text_hash: "str" };
const HASH_FIELDS = ["weights_hash", "prompt_hash", "params_hash", "output_token_hash", "chain_digest"];

export type Receipt = Record<string, unknown>;
export interface Result { level: string; ok: boolean; errors: string[]; [k: string]: unknown }
const result = (level: string, errors: string[], extra: Record<string, unknown> = {}): Result =>
  ({ level, ok: errors.length === 0, errors, ...extra });

export function signingPayload(r: Receipt): Uint8Array {
  const { signature: _s, ...body } = r;
  return concat(SIG_DOMAIN, canonicalBytes(body));
}

export function checkFormat(r: unknown): string[] {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return ["receipt is not an object"];
  const o = r as Record<string, unknown>, errs: string[] = [];
  for (const [k, t] of Object.entries(REQUIRED)) {
    if (!(k in o)) errs.push(`missing field ${k}`);
    else if (t === "int" ? !Number.isSafeInteger(o[k]) : typeof o[k] !== "string") errs.push(`field ${k} must be ${t}`);
  }
  for (const k of Object.keys(o)) if (!(k in REQUIRED) && !(k in OPTIONAL)) errs.push(`unknown field ${k}`);
  for (const k of Object.keys(OPTIONAL)) if (k in o && typeof o[k] !== "string") errs.push(`field ${k} must be str`);
  if (errs.length) return errs;
  if (o.receipt_version !== RECEIPT_VERSION) errs.push(`unsupported receipt_version ${String(o.receipt_version)}`);
  for (const k of HASH_FIELDS) if (!HEX64.test(o[k] as string)) errs.push(`${k} must be 64 lowercase hex`);
  if ("output_text_hash" in o && !HEX64.test(o.output_text_hash as string)) errs.push("output_text_hash must be 64 lowercase hex");
  if (!HEX16.test(o.chain_fnv as string)) errs.push("chain_fnv must be 16 lowercase hex");
  if (o.privacy !== "hash_only" && o.privacy !== "full") errs.push("privacy must be hash_only or full");
  if ((o.prompt_tokens as number) < 1 || (o.output_tokens as number) < 0) errs.push("token counts out of range");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/.test(o.issued_at as string)) errs.push("issued_at must be RFC 3339 UTC (Z)");
  try { canonicalString(o); } catch (e) { errs.push((e as Error).message); }
  return errs;
}

export async function verifyL1(r: unknown, keys: TrustedKey[]): Promise<Result> {
  const errs = checkFormat(r);
  if (errs.length) return result("L1", errs);
  const rc = r as Receipt;
  const pk = keys.find((k) => k.keyId === rc.key_id);
  if (!pk) return result("L1", [`unknown key_id ${String(rc.key_id)} (not in the trusted key set)`]);
  let sig: Uint8Array;
  try { sig = b64uDecode(rc.signature as string); } catch { return result("L1", ["signature is not base64url"]); }
  if (sig.length !== 64 || !(await pk.verify(sig, signingPayload(rc)))) return result("L1", ["signature does not verify"]);
  return result("L1", [], { key_id: pk.keyId, key_source: pk.source });
}

export async function verifyL2(r: Receipt, logText: string): Promise<Result> {
  let d;
  try { d = await logDigests(logText); } catch (e) { return result("L2", [`log parse error: ${(e as Error).message}`]); }
  const errs: string[] = [];
  if (d.chain_digest !== r.chain_digest) errs.push("chain_digest mismatch");
  if (d.chain_fnv !== r.chain_fnv) errs.push("chain_fnv mismatch");
  if (d.all_line !== null && d.all_line !== d.chain_fnv) errs.push("log ALL line inconsistent with its own lines");
  const want = Number(r.prompt_tokens ?? 0) + Number(r.output_tokens ?? 0);
  if (d.positions !== want) errs.push(`log covers ${d.positions} positions, receipt says ${want}`);
  return result("L2", errs, { positions: d.positions });
}

export interface Disclosure { messages?: unknown; outputIds?: number[]; outputText?: string; salt?: Uint8Array | null }

export async function verifyDisclosure(r: Receipt, d: Disclosure): Promise<Result> {
  const salt = r.privacy === "full" ? new Uint8Array(0) : d.salt;
  if (salt == null) return result("disclosure", ["salt required for hash_only receipts"]);
  const errs: string[] = [], checked: string[] = [];
  if (d.messages !== undefined) {
    checked.push("prompt_hash");
    if ((await promptHash(d.messages, salt)) !== r.prompt_hash) errs.push("prompt_hash mismatch");
  }
  if (d.outputIds !== undefined) {
    checked.push("output_token_hash");
    if ((await tokenHash(d.outputIds, salt)) !== r.output_token_hash) errs.push("output_token_hash mismatch");
  }
  if (d.outputText !== undefined) {
    if (typeof r.output_text_hash !== "string") {
      errs.push("receipt has no output_text_hash; displayed text cannot be bound (use output token ids instead)");
    } else {
      checked.push("output_text_hash");
      if ((await textHash(d.outputText, salt)) !== r.output_text_hash) errs.push("output_text_hash mismatch");
    }
  }
  return result("disclosure", errs, { checked });
}
