// High-level offline verification.
import { b64uDecode } from "./bytes.js";
import { DEFAULT_TRUSTED_KEYS } from "./default-keys.js";
import { importKeySet, type TrustedKey } from "./keys.js";
import { verifyDisclosure, verifyL1, verifyL2, type Receipt, type Result } from "./receipt.js";

export interface VerificationResult { ok: boolean; levels: Record<string, Result> }

export interface VerifyOptions {
  /** Trusted keys: a JWK, a JWK array, a JWKS, or already-imported keys. Default: bundled production key. */
  keys?: unknown;
  /** Public token log text (`idemcore-log/r1-public`); enables L2. */
  logText?: string;
  /** The exact messages sent; checks prompt_hash. */
  messages?: unknown;
  /** base64url salt (or raw bytes) of a hash_only receipt. */
  salt?: string | Uint8Array | null;
  outputTokenIds?: number[];
  outputText?: string;
  /** Default true. Set false to skip L1. */
  checkSignature?: boolean;
}

export async function loadKeys(keys?: unknown): Promise<TrustedKey[]> {
  if (keys === undefined || keys === null) return importKeySet(DEFAULT_TRUSTED_KEYS, "bundled");
  if (Array.isArray(keys) && keys.length && typeof (keys[0] as TrustedKey).verify === "function") return keys as TrustedKey[];
  return importKeySet(keys, "caller");
}

/** Verify a receipt offline: L1 signature, L2 token-log chain, disclosure commitments. */
export async function verifyReceipt(receipt: Receipt, opts: VerifyOptions = {}): Promise<VerificationResult> {
  const levels: Record<string, Result> = {};
  if (opts.checkSignature !== false) levels.L1 = await verifyL1(receipt, await loadKeys(opts.keys));
  if (opts.logText !== undefined) levels.L2 = await verifyL2(receipt, opts.logText);
  if (opts.messages !== undefined || opts.outputTokenIds !== undefined || opts.outputText !== undefined) {
    let salt: Uint8Array | null | undefined;
    try { salt = typeof opts.salt === "string" ? b64uDecode(opts.salt) : opts.salt; }
    catch { levels.disclosure = { level: "disclosure", ok: false, errors: ["salt is not base64url"] }; }
    if (!levels.disclosure) levels.disclosure = await verifyDisclosure(receipt, {
      messages: opts.messages, outputIds: opts.outputTokenIds, outputText: opts.outputText, salt,
    });
  }
  const vals = Object.values(levels);
  return { ok: vals.length > 0 && vals.every((l) => l.ok), levels };
}
