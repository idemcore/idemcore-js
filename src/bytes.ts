// Byte helpers that work the same in Node 18+, browsers, Deno, Bun and Workers.
const te = new TextEncoder();
export const utf8 = (s: string): Uint8Array => te.encode(s);

export function hex(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += x.toString(16).padStart(2, "0");
  return s;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const REV: Record<string, number> = Object.fromEntries([...ALPHA].map((c, i) => [c, i]));

/** base64url without padding. */
export function b64u(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += ALPHA[(n >> 18) & 63] + ALPHA[(n >> 12) & 63];
    if (i + 1 < b.length) s += ALPHA[(n >> 6) & 63];
    if (i + 2 < b.length) s += ALPHA[n & 63];
  }
  return s;
}

export function b64uDecode(s: string): Uint8Array {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("not base64url");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => (i + k < s.length ? REV[s[i + k]] : 0));
    const n = (c[0] << 18) | (c[1] << 12) | (c[2] << 6) | c[3];
    out[o++] = (n >> 16) & 255;
    if (i + 2 < s.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < s.length) out[o++] = n & 255;
  }
  return out.slice(0, o);
}

let subtleP: Promise<SubtleCrypto> | null = null;
/** WebCrypto SubtleCrypto: globalThis.crypto when present, node:crypto on Node 18. */
export function subtle(): Promise<SubtleCrypto> {
  if (!subtleP) {
    subtleP = (async () => {
      const g = (globalThis as { crypto?: Crypto }).crypto;
      if (g?.subtle) return g.subtle;
      const spec = "node:crypto";
      const m = (await import(/* @vite-ignore */ /* webpackIgnore: true */ spec)) as { webcrypto: Crypto };
      return m.webcrypto.subtle;
    })();
  }
  return subtleP;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await (await subtle()).digest("SHA-256", data as BufferSource));
}

export function le64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, n), true);
  return b;
}
