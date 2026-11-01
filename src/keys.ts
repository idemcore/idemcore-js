// Trusted Ed25519 public keys (JWK) for receipt signatures.
import { b64uDecode, hex, sha256, subtle } from "./bytes.js";

export interface Jwk { kty: string; crv: string; x: string; kid?: string }
export interface TrustedKey { keyId: string; jwk: Jwk; source: string; verify(sig: Uint8Array, msg: Uint8Array): Promise<boolean> }

export async function keyIdFor(raw: Uint8Array): Promise<string> {
  return "ed25519:" + hex((await sha256(raw)).slice(0, 8));
}

export async function importJwk(jwk: Jwk, source: string): Promise<TrustedKey> {
  if (jwk?.kty !== "OKP" || jwk?.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error("not an Ed25519 public JWK");
  const raw = b64uDecode(jwk.x);
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  const keyId = await keyIdFor(raw);
  if (jwk.kid && jwk.kid !== keyId) throw new Error(`kid ${jwk.kid} does not match key bytes (${keyId})`);
  const pk = await (await subtle()).importKey("raw", raw as BufferSource, { name: "Ed25519" }, false, ["verify"]);
  return {
    keyId, jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, kid: keyId }, source,
    verify: async (sig, msg) => { try { return await (await subtle()).verify({ name: "Ed25519" }, pk, sig as BufferSource, msg as BufferSource); } catch { return false; } },
  };
}

/** Accepts a JWK, an array of JWKs, or a JWKS ({ keys: [...] }). */
export async function importKeySet(data: unknown, source: string): Promise<TrustedKey[]> {
  const list = Array.isArray(data) ? data : (data && typeof data === "object" && Array.isArray((data as { keys?: unknown }).keys))
    ? (data as { keys: unknown[] }).keys : [data];
  return Promise.all(list.map((j) => importJwk(j as Jwk, source)));
}
