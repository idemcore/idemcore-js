// Canonical JSON for receipts r1: keys sorted by code point, no whitespace,
// UTF-8, non-ASCII literal, integers only (no floats).
function cmp(a: string, b: string): number {
  const A = Array.from(a), B = Array.from(b);
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const d = A[i].codePointAt(0)! - B[i].codePointAt(0)!;
    if (d) return d;
  }
  return A.length - B.length;
}

function enc(v: unknown, path: string): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`${path}: only integers are allowed`);
    return String(v);
  }
  if (Array.isArray(v)) return "[" + v.map((x, i) => enc(x, `${path}[${i}]`)).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(cmp);
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + enc(o[k], `${path}.${k}`)).join(",") + "}";
  }
  throw new Error(`${path}: unsupported type`);
}

export const canonicalString = (v: unknown): string => enc(v, "$");
export const canonicalBytes = (v: unknown): Uint8Array => new TextEncoder().encode(canonicalString(v));
