// Domain-separated hashes and token-log chain digests (receipts r1).
import { canonicalBytes } from "./canonical.js";
import { concat, hex, le64, sha256, utf8 } from "./bytes.js";

export async function taggedHash(tag: string, ...parts: Uint8Array[]): Promise<string> {
  const chunks: Uint8Array[] = [utf8(`idemcore/${tag}/r1`), new Uint8Array([0])];
  for (const p of parts) chunks.push(le64(BigInt(p.length)), p);
  return hex(await sha256(concat(...chunks)));
}

export function tokenBytes(ids: number[]): Uint8Array {
  const b = new Uint8Array(ids.length * 4);
  const dv = new DataView(b.buffer);
  ids.forEach((id, i) => {
    if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new Error(`token id out of range at ${i}`);
    dv.setUint32(i * 4, id, true);
  });
  return b;
}

export const promptHash = (messages: unknown, salt: Uint8Array) => taggedHash("prompt", salt, canonicalBytes(messages));
export const tokenHash = (ids: number[], salt: Uint8Array) => taggedHash("tokens", salt, tokenBytes(ids));
// Display-text normalisation: NFC, every whitespace run becomes one U+0020, trimmed.
const WS = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
export const normalizeText = (s: string): string => s.normalize("NFC").replace(WS, " ").replace(/^ | $/g, "");
/** Hash of the displayed answer text (receipt field `output_text_hash`). */
export const textHash = (text: string, salt: Uint8Array) => taggedHash("text", salt, utf8(normalizeText(text)));

/** One position of the public token log (`idemcore-log/r1-public`): `pi j h hc`. */
export interface LogLine { pi: bigint; j: bigint; h: bigint; hc: bigint }

export function parseLog(text: string): { lines: LogLine[]; all: string | null } {
  const lines: LogLine[] = [];
  let all: string | null = null;
  text.split(/\r?\n/).forEach((raw, n) => {
    const s = raw.trim();
    if (!s || s.startsWith("#")) return;
    const f = s.split(/\s+/);
    if (f[0] === "ALL") {
      if (f.length !== 2 || !/^[0-9a-fA-F]{1,16}$/.test(f[1])) throw new Error(`log line ${n + 1}: malformed ALL line`);
      all = f[1].toLowerCase(); return;
    }
    if (!/^\d+$/.test(f[0])) return; // reserved keyword lines
    if (f.length !== 4) throw new Error(`log line ${n + 1}: not a public log line (expected 4 fields: pi j h hc)`);
    if (!/^\d+$/.test(f[1]) || !/^[0-9a-fA-F]{1,16}$/.test(f[2]) || !/^[0-9a-fA-F]{1,16}$/.test(f[3]))
      throw new Error(`log line ${n + 1}: malformed field`);
    const ln: LogLine = { pi: BigInt(f[0]), j: BigInt(f[1]), h: BigInt("0x" + f[2]), hc: BigInt("0x" + f[3]) };
    if (ln.pi >= 2n ** 64n || ln.j >= 2n ** 64n) throw new Error(`log line ${n + 1}: index out of range`);
    lines.push(ln);
  });
  return { lines, all };
}

const FNV_OFFSET = 0xcbf29ce484222325n, FNV_PRIME = 0x100000001b3n, MASK = (1n << 64n) - 1n;

function fnv(data: Uint8Array, start: bigint): bigint {
  let h = start;
  for (const b of data) h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK;
  return h;
}

export function chainFnv(lines: LogLine[]): string {
  let a = FNV_OFFSET;
  for (const l of lines) { a = fnv(le64(l.h), a); a = fnv(le64(l.hc), a); }
  return a.toString(16).padStart(16, "0");
}

export async function chainDigest(lines: LogLine[]): Promise<string> {
  let c = await sha256(utf8("idemcore/chain/r1\0"));
  for (const l of lines) c = await sha256(concat(c, le64(l.pi), le64(l.j), le64(l.h), le64(l.hc)));
  return hex(c);
}

export async function logDigests(text: string) {
  const p = parseLog(text);
  return { positions: p.lines.length, chain_digest: await chainDigest(p.lines), chain_fnv: chainFnv(p.lines), all_line: p.all };
}
