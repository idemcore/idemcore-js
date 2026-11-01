// Reproducible agent sessions: record, replay and verify (trace format `idemcore-trace/r1`).
// Same format and hashes as the Python SDK; a trace recorded by one verifies in the other.
import { canonicalBytes } from "./canonical.js";
import { b64u, b64uDecode, concat, hex, sha256, subtle, utf8 } from "./bytes.js";
import { taggedHash } from "./hash.js";
import { keyIdFor, type TrustedKey } from "./keys.js";
import { loadKeys, verifyReceipt } from "./verify.js";
import type { ChatOptions, ChatResult, Idemcore, Message, Privacy } from "./client.js";
import { VERSION } from "./version.js";

export const TRACE_FORMAT = "idemcore-trace/r1";
const SIG_DOMAIN = utf8("idemcore-trace/r1\n");
const SAME = ["model_id", "weights_hash", "decoding", "seed", "prompt_tokens", "output_tokens", "chain_digest", "chain_fnv", "finish_reason"];
const ENV = ["engine_build", "kernel_version"];

export type StepType = "model" | "tool" | "note";
export interface TraceStep { index: number; type: StepType; prev: string; body: Record<string, any>; hash: string }
export interface TraceManifest {
  format: string; session_id: string; created_at: string; sdk: string; meta_json: string;
  genesis: string; head: string; step_count: number;
}
export interface TraceSignature { alg: "Ed25519"; kid: string; x: string; signature: string }
export interface Trace { manifest: TraceManifest; manifest_hash: string; steps: TraceStep[]; signatures: TraceSignature[] }
/** Private Ed25519 JWK (`d` is secret: never put it in a trace). */
export interface SigningJwk { kty: "OKP"; crv: "Ed25519"; x: string; d: string; kid?: string }

// ------------------------------------------------------------------ hashing
function cmp(a: string, b: string): number {
  const A = Array.from(a), B = Array.from(b);
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const d = A[i].codePointAt(0)! - B[i].codePointAt(0)!;
    if (d) return d;
  }
  return A.length - B.length;
}
function sortDeep(v: unknown, path: string, sort = true): unknown {
  if (typeof v === "number" && !Number.isFinite(v)) throw new TypeError(`${path}: NaN/Infinity are not JSON`);
  if (Array.isArray(v)) return v.map((x, i) => sortDeep(x === undefined ? null : x, `${path}[${i}]`, sort));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof (o as { toJSON?: unknown }).toJSON === "function") return sortDeep((o as any).toJSON(), path, sort);
    const out: Record<string, unknown> = {};
    const keys = Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== "function");
    for (const k of sort ? keys.sort(cmp) : keys) out[k] = sortDeep(o[k], `${path}.${k}`, sort);
    return out;
  }
  if (typeof v === "bigint" || typeof v === "function" || typeof v === "symbol") throw new TypeError(`${path}: not JSON-serialisable`);
  return v === undefined ? null : v;
}
/** Canonical JSON text for tool arguments/results: keys sorted, no whitespace, finite numbers. */
export const traceJson = (v: unknown): string => JSON.stringify(sortDeep(v, "$"));
/** JSON text for tool results: like traceJson but keeps the tool's key order, so a replayed agent
 *  sees exactly the object the tool returned (key order can change a prompt built from it). */
export const resultJson = (v: unknown): string => JSON.stringify(sortDeep(v, "$", false));

const h = (tag: string, ...parts: Uint8Array[]) => taggedHash(tag, ...parts);
export const genesisHash = (sessionId: string) => h("trace-genesis", utf8(sessionId));
export const stepHash = (s: Omit<TraceStep, "hash"> | TraceStep) => {
  const { hash: _h, ...rest } = s as TraceStep;
  return h("trace-step", canonicalBytes(rest));
};
export const manifestHash = (m: TraceManifest) => h("trace-manifest", canonicalBytes(m));
export const requestHash = (r: unknown) => h("trace-request", canonicalBytes(r));
export const textSha = (t: string) => h("trace-text", utf8(t));
const intDict = (d: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries((d ?? {}) as Record<string, unknown>).filter(([, v]) => Number.isSafeInteger(v))) as Record<string, number>;
const normMsgs = (m: string | Message[]): Message[] =>
  typeof m === "string" ? [{ role: "user", content: m }] : m.map((x) => ({ role: x.role, content: x.content }));
// Session ids are identifiers, not secrets; the Math.random fallback only runs where WebCrypto is not global (Node 18).
const hexId = (): string => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) return hex(c.getRandomValues(new Uint8Array(12)));
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
};

// ------------------------------------------------------------------ signing
export async function generateSigningKey(): Promise<SigningJwk> {
  const s = await subtle();
  const kp = (await s.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const j = (await s.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  return { kty: "OKP", crv: "Ed25519", x: j.x!, d: j.d!, kid: await keyIdFor(b64uDecode(j.x!)) };
}
async function sign(manifestH: string, jwk: SigningJwk): Promise<TraceSignature> {
  const s = await subtle();
  const k = await s.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d } as JsonWebKey, { name: "Ed25519" }, false, ["sign"]);
  const sig = new Uint8Array(await s.sign({ name: "Ed25519" }, k, concat(SIG_DOMAIN, utf8(manifestH)) as BufferSource));
  return { alg: "Ed25519", kid: await keyIdFor(b64uDecode(jwk.x)), x: jwk.x, signature: b64u(sig) };
}
async function checkSig(sg: TraceSignature, manifestH: string): Promise<string | null> {
  try {
    const raw = b64uDecode(sg.x);
    const kid = await keyIdFor(raw);
    if (sg.kid !== kid) return null;
    const s = await subtle();
    const k = await s.importKey("raw", raw as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return (await s.verify({ name: "Ed25519" }, k, b64uDecode(sg.signature) as BufferSource, concat(SIG_DOMAIN, utf8(manifestH)) as BufferSource)) ? kid : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ recording
type ToolFn = (args: any) => unknown | Promise<unknown>;
export interface SessionOptions { meta?: Record<string, unknown>; sessionId?: string }

/**
 * Record an agent session.
 * ```js
 * const s = new Session(client, { meta: { task: "weather" } });
 * const a = await s.chat([{ role: "user", content: "..." }], { maxTokens: 64 });
 * const w = await s.tool("get_weather", { city: "Paris" }, getWeather);
 * const trace = await s.finish({ signWith: myPrivateJwk });
 * ```
 */
export class Session {
  readonly sessionId: string;
  createdAt: string;
  readonly metaJson: string;
  readonly steps: TraceStep[] = [];
  #head: Promise<string>;
  #queue: Promise<unknown> = Promise.resolve();
  #finished: Trace | null = null;

  constructor(readonly client: Idemcore | null = null, opts: SessionOptions = {}) {
    this.sessionId = opts.sessionId ?? "ses_" + hexId();
    this.createdAt = new Date().toISOString();
    this.metaJson = traceJson(opts.meta ?? {});
    this.#head = genesisHash(this.sessionId);
  }

  head(): Promise<string> { return this.#head; }

  /** Steps are appended in call order, even when calls overlap. */
  protected append(type: StepType, body: Record<string, any>): Promise<TraceStep> {
    if (this.#finished) throw new Error("session already finished");
    const p = this.#queue.then(async () => {
      const step = { index: this.steps.length, type, prev: await this.#head, body } as TraceStep;
      step.hash = await stepHash(step);
      this.steps.push(step);
      this.#head = Promise.resolve(step.hash);
      return step;
    });
    this.#queue = p.catch(() => undefined);
    return p;
  }

  async chat(messages: string | Message[], opts: ChatOptions = {}): Promise<ChatResult> {
    if (!this.client) throw new Error("Session has no client; pass one or use recordModel()");
    const r = await this.client.chat(messages, opts);
    await this.recordModel(r, opts);
    return r;
  }

  /** Add a finished ChatResult (e.g. `await stream.finalResult()`). Options must be what you sent. */
  async recordModel(r: ChatResult, opts: { model?: string; maxTokens?: number; privacy?: Privacy } = {}, streamed = false): Promise<TraceStep> {
    const request = { messages: r.messages.map((m) => ({ role: m.role, content: m.content })), model: opts.model ?? null,
      max_tokens: opts.maxTokens ?? null, privacy: opts.privacy ?? null };
    const receipt = { ...r.receipt };
    return this.append("model", {
      request, request_hash: await requestHash(request), receipt_id: r.receiptId, receipt,
      receipt_hash: await h("trace-receipt", canonicalBytes(receipt)), salt: r.salt ?? null,
      output_token_ids: r.outputTokenIds ? [...r.outputTokenIds] : null, output_text: r.text,
      output_text_sha: await textSha(r.text), finish_reason: r.finishReason ?? null, usage: intDict(r.usage), streamed,
    });
  }

  /** Run `fn(args)` and record the call. A thrown error is recorded and re-thrown. */
  async tool<T = unknown>(name: string, args: unknown, fn: ToolFn, opts: { callId?: string } = {}): Promise<T> {
    const argsJson = traceJson(args);
    let result: unknown;
    try { result = await fn(args); }
    catch (e) {
      const err = e as Error;
      await this.recordTool(name, args, undefined, { error: `${err?.name ?? "Error"}: ${err?.message ?? String(e)}`, callId: opts.callId, argsJson });
      throw e;
    }
    await this.recordTool(name, args, result, { callId: opts.callId, argsJson });
    return result as T;
  }

  /** Record a tool call you executed yourself. */
  async recordTool(name: string, args: unknown, result?: unknown, opts: { error?: string; callId?: string; argsJson?: string } = {}): Promise<TraceStep> {
    if (typeof name !== "string" || !name) throw new Error("tool name must be a non-empty string");
    const argsJson = opts.argsJson ?? traceJson(args);
    const resultJsonText = opts.error != null ? null : resultJson(result === undefined ? null : result);
    return this.append("tool", {
      name, call_id: opts.callId ?? `call_${this.steps.length}`, args_json: argsJson,
      args_hash: await h("trace-tool-args", utf8(argsJson)), result_json: resultJsonText,
      result_hash: await h("trace-tool-result", utf8(resultJsonText ?? "")), error: opts.error ?? null,
    });
  }

  /** Free-form step, e.g. `note("approval", { by: "ops" })`. */
  async note(kind: string, data: unknown = null): Promise<TraceStep> {
    const dataJson = traceJson(data);
    return this.append("note", { kind: String(kind), data_json: dataJson, data_hash: await h("trace-note", utf8(dataJson)) });
  }

  async manifest(): Promise<TraceManifest> {
    await this.#queue;
    return { format: TRACE_FORMAT, session_id: this.sessionId, created_at: this.createdAt, sdk: `idemcore-js/${VERSION}`,
      meta_json: this.metaJson, genesis: await genesisHash(this.sessionId), head: await this.#head, step_count: this.steps.length };
  }

  /** Close the session and return the trace (JSON-ready). */
  async finish(opts: { signWith?: SigningJwk } = {}): Promise<Trace> {
    if (!this.#finished) {
      const manifest = await this.manifest();
      this.#finished = { manifest, manifest_hash: await manifestHash(manifest), steps: this.steps, signatures: [] };
    }
    if (opts.signWith) this.#finished.signatures.push(await sign(this.#finished.manifest_hash, opts.signWith));
    return this.#finished;
  }
}

export const record = (client: Idemcore, opts?: SessionOptions) => new Session(client, opts);
export const dumpsTrace = (t: Trace) => JSON.stringify(t, null, 1) + "\n";

// ------------------------------------------------------------------ verification
export interface TraceVerification {
  ok: boolean; errors: string[]; warnings: string[]; steps: number; modelSteps: number; toolSteps: number; signers: string[];
}
export interface VerifyTraceOptions {
  /** Trusted receipt keys (JWK/JWKS). Default: bundled Idemcore keys. */
  keys?: unknown;
  checkReceipts?: boolean;
  /** Key ids (`ed25519:...`) or public JWKs; at least one valid signature from this list is required. */
  trustedSigners?: (string | { x: string })[];
  requireSignature?: boolean;
}

/** Verify a trace offline: chain, hashes, receipt signatures and commitments, tool hashes, signatures. */
export async function verifyTrace(trace: Trace, opts: VerifyTraceOptions = {}): Promise<TraceVerification> {
  const errors: string[] = [], warnings: string[] = [];
  const out: TraceVerification = { ok: false, errors, warnings, steps: 0, modelSteps: 0, toolSteps: 0, signers: [] };
  const man = trace?.manifest, steps = trace?.steps;
  if (!man || !Array.isArray(steps)) { errors.push("not a trace: manifest and steps are required"); return out; }
  if (man.format !== TRACE_FORMAT) { errors.push(`unsupported format ${String(man.format)}`); return out; }
  let mh: string;
  try { mh = await manifestHash(man); } catch (e) { errors.push(`manifest is not canonical: ${(e as Error).message}`); return out; }
  if (mh !== trace.manifest_hash) errors.push("manifest_hash mismatch");
  const sid = man.session_id;
  const gen = typeof sid === "string" ? await genesisHash(sid) : "";
  if (!gen || gen !== man.genesis) errors.push("genesis does not match session_id");
  if (man.step_count !== steps.length) errors.push(`step_count ${man.step_count} != ${steps.length} steps`);
  const check = opts.checkReceipts !== false;
  const keys: TrustedKey[] = check ? await loadKeys(opts.keys) : [];
  let prev = gen;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i], p = `step ${i}`;
    if (!st || typeof st !== "object") { errors.push(`${p}: not an object`); continue; }
    if (st.index !== i) errors.push(`${p}: index ${st.index}`);
    if (st.prev !== prev) errors.push(`${p}: prev does not link to the previous step`);
    let sh: string | null = null;
    try { sh = await stepHash(st); } catch (e) { errors.push(`${p}: not canonical (${(e as Error).message})`); }
    if (sh !== st.hash) errors.push(`${p}: hash mismatch`);
    prev = st.hash;
    const b = st.body ?? {};
    if (st.type === "model") {
      out.modelSteps++;
      for (const e of await verifyModelStep(b, check, keys)) errors.push(`${p}: ${e}`);
    } else if (st.type === "tool") {
      out.toolSteps++;
      if (b.args_hash !== await h("trace-tool-args", utf8(String(b.args_json)))) errors.push(`${p}: args_hash mismatch`);
      if (b.result_hash !== await h("trace-tool-result", utf8(typeof b.result_json === "string" ? b.result_json : ""))) errors.push(`${p}: result_hash mismatch`);
      for (const k of ["args_json", "result_json"]) if (typeof b[k] === "string") { try { JSON.parse(b[k]); } catch { errors.push(`${p}: ${k} is not JSON`); } }
    } else if (st.type === "note") {
      if (b.data_hash !== await h("trace-note", utf8(String(b.data_json)))) errors.push(`${p}: data_hash mismatch`);
    } else errors.push(`${p}: unknown step type ${String(st.type)}`);
  }
  if (steps.length && prev !== man.head) errors.push("head does not match the last step");
  if (!steps.length && man.head !== man.genesis) errors.push("empty trace: head must equal genesis");
  out.steps = steps.length;
  for (const sg of trace.signatures ?? []) {
    const kid = await checkSig(sg, String(trace.manifest_hash));
    if (kid) out.signers.push(kid); else errors.push(`signature ${String(sg?.kid)} invalid`);
  }
  if (opts.trustedSigners) {
    const pinned = new Set(await Promise.all(opts.trustedSigners.map((s) => typeof s === "string" ? s : keyIdFor(b64uDecode(s.x)))));
    if (!out.signers.some((k) => pinned.has(k))) errors.push("no valid signature from a trusted signer");
  } else if (opts.requireSignature && !out.signers.length) errors.push("trace is not signed");
  else if (out.signers.length) warnings.push("signature valid but signer not pinned (pass trustedSigners)");
  out.ok = errors.length === 0;
  return out;
}

async function verifyModelStep(b: Record<string, any>, check: boolean, keys: TrustedKey[]): Promise<string[]> {
  const errs: string[] = [];
  const req = b.request ?? {};
  try { if (b.request_hash !== await requestHash(req)) errs.push("request_hash mismatch"); }
  catch (e) { errs.push(`request not canonical (${(e as Error).message})`); }
  const rc = b.receipt ?? {};
  if (rc.receipt_id !== b.receipt_id) errs.push("receipt_id mismatch");
  try { if (b.receipt_hash !== await h("trace-receipt", canonicalBytes(rc))) errs.push("receipt_hash mismatch"); }
  catch (e) { errs.push(`receipt not canonical (${(e as Error).message})`); }
  if (typeof b.output_text !== "string" || b.output_text_sha !== await textSha(b.output_text)) errs.push("output_text_sha mismatch");
  if (check) {
    const res = await verifyReceipt(rc, {
      keys, messages: req.messages, salt: b.salt ?? null, outputTokenIds: b.output_token_ids ?? undefined,
      outputText: "output_text_hash" in rc ? b.output_text : undefined,
    });
    for (const lv of Object.values(res.levels)) for (const e of lv.errors) errs.push(`receipt ${lv.level}: ${e}`);
  }
  return errs;
}

// ------------------------------------------------------------------ replay
export interface StepReport { index: number; type: StepType; identical: boolean; diffs: string[]; notes: string[]; receiptId?: string; replayReceiptId?: string }
export interface ReplayReport { ok: boolean; steps: StepReport[]; errors: string[]; modelCalls: number; replayTrace?: Trace; summary(): string }
export class ReplayDivergence extends Error {
  constructor(readonly report: ReplayReport, message: string) { super(message); this.name = "ReplayDivergence"; }
}

/** Compare a recorded model step body with a fresh ChatResult. */
export function compareModel(rec: Record<string, any>, n: ChatResult): StepReport {
  const a = rec.receipt ?? {}, b = (n.receipt ?? {}) as Record<string, unknown>;
  const rep: StepReport = { index: -1, type: "model", identical: true, diffs: [], notes: [], receiptId: rec.receipt_id, replayReceiptId: n.receiptId };
  const A: number[] | null = rec.output_token_ids, B = n.outputTokenIds;
  if (A && B) {
    if (A.length !== B.length || A.some((x, i) => x !== B[i])) {
      let k = 0; while (k < Math.min(A.length, B.length) && A[k] === B[k]) k++;
      rep.diffs.push(`output tokens differ at position ${k} (${A.length} vs ${B.length} tokens)`);
    }
  } else rep.notes.push("token ids not disclosed on one side; compared chain digest and text");
  if (rec.output_text !== n.text) rep.diffs.push("output text differs");
  for (const k of SAME) if (a[k] !== b[k]) rep.diffs.push(`receipt ${k} differs`);
  if (a.privacy === "full" && b.privacy === "full" && a.output_token_hash !== b.output_token_hash) rep.diffs.push("receipt output_token_hash differs");
  for (const k of ENV) if (a[k] !== b[k]) rep.notes.push(`${k} changed: ${String(a[k])} -> ${String(b[k])}`);
  rep.identical = rep.diffs.length === 0;
  return rep;
}

function newReport(): ReplayReport {
  const r: ReplayReport = {
    ok: true, steps: [], errors: [], modelCalls: 0,
    summary() {
      const m = r.steps.filter((s) => s.type === "model");
      return `${r.ok ? "OK" : "DIVERGED"}: ${m.filter((s) => s.identical).length}/${m.length} model steps bit-identical, `
        + `${r.steps.length - m.length} tool/note steps fed from the trace` + (r.errors.length ? `; errors: ${r.errors.join("; ")}` : "");
    },
  };
  return r;
}

/** What your agent function receives during replay(): chat() is checked, tool() returns recorded results. */
export class ReplaySession extends Session {
  #steps: TraceStep[]; #pos = 0;
  constructor(client: Idemcore, trace: Trace, private report: ReplayReport, private strict: boolean) {
    super(client, { meta: { replay_of: trace.manifest.session_id, replay_of_manifest_hash: trace.manifest_hash } });
    this.#steps = [...trace.steps];
  }
  #fail(msg: string): never {
    this.report.errors.push(msg); this.report.ok = false;
    throw new ReplayDivergence(this.report, msg);
  }
  #next(type: StepType): TraceStep {
    if (this.#pos >= this.#steps.length) this.#fail(`agent made an extra ${type} call after the recorded session ended`);
    const st = this.#steps[this.#pos];
    if (st.type !== type) this.#fail(`step ${this.#pos}: agent made a ${type} call, trace has a ${st.type} step`);
    this.#pos++;
    return st;
  }
  override async chat(messages: string | Message[], opts: ChatOptions = {}): Promise<ChatResult> {
    const st = this.#next("model");
    const req = { messages: normMsgs(messages), model: opts.model ?? null, max_tokens: opts.maxTokens ?? null, privacy: opts.privacy ?? null };
    if (await requestHash(req) !== st.body.request_hash) this.#fail(`step ${st.index}: the agent sent a different request than the trace`);
    const r = await this.client!.chat(messages, opts);
    await this.recordModel(r, opts);
    const rep = compareModel(st.body, r);
    rep.index = st.index;
    this.report.steps.push(rep); this.report.modelCalls++;
    if (!rep.identical) {
      this.report.ok = false;
      if (this.strict) throw new ReplayDivergence(this.report, `step ${st.index}: ${rep.diffs.join("; ")}`);
    }
    return r;
  }
  override async tool<T = unknown>(name: string, args: unknown, _fn?: ToolFn, _opts: { callId?: string } = {}): Promise<T> {
    const st = this.#next("tool"), b = st.body;
    const aj = traceJson(args);
    let same = b.args_hash === await h("trace-tool-args", utf8(aj));
    if (!same) { try { same = deepEqual(JSON.parse(b.args_json), JSON.parse(aj)); } catch { same = false; } }
    if (b.name !== name || !same) this.#fail(`step ${st.index}: tool call ${name} differs from the trace (${b.name})`);
    this.report.steps.push({ index: st.index, type: "tool", identical: true, diffs: [], notes: ["result fed from trace"] });
    if (b.error != null) {
      await this.recordTool(name, args, undefined, { error: b.error, callId: b.call_id, argsJson: aj });
      throw new Error(`recorded tool error: ${b.error}`);
    }
    const result = JSON.parse(b.result_json);
    await this.recordTool(name, args, result, { callId: b.call_id, argsJson: aj });
    return result as T;
  }
  override async note(kind: string, data: unknown = null): Promise<TraceStep> {
    const st = this.#next("note");
    this.report.steps.push({ index: st.index, type: "note", identical: true, diffs: [], notes: [] });
    return super.note(kind, data);
  }
  finishCheck(): void {
    if (this.#pos !== this.#steps.length) {
      this.report.errors.push(`agent stopped after ${this.#pos} of ${this.#steps.length} steps`); this.report.ok = false;
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || !a || !b || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}

export interface ReplayOptions {
  /** Re-run your agent code; model calls are checked, tool calls get recorded results. */
  agent?: (s: ReplaySession) => unknown | Promise<unknown>;
  /** Stop at the first divergence. */
  strict?: boolean;
  /** Verify the trace offline first (default true). */
  verifyFirst?: boolean;
  keys?: unknown;
}

/** Replay a recorded session against the API and check model answers are bit-identical. */
export async function replay(trace: Trace, client: Idemcore, opts: ReplayOptions = {}): Promise<ReplayReport> {
  const report = newReport();
  if (opts.verifyFirst !== false) {
    const v = await verifyTrace(trace, { keys: opts.keys });
    if (!v.ok) { report.ok = false; report.errors.push("trace failed verification: " + v.errors.slice(0, 5).join("; ")); return report; }
  }
  const rs = new ReplaySession(client, trace, report, !!opts.strict);
  if (opts.agent) {
    try { await opts.agent(rs); rs.finishCheck(); }
    catch (e) { if (!(e instanceof ReplayDivergence)) throw e; }
  } else {
    for (const st of trace.steps) {
      const b = st.body;
      try {
        if (st.type === "model") {
          const q = b.request;
          await rs.chat(q.messages, { model: q.model ?? undefined, maxTokens: q.max_tokens ?? undefined, privacy: q.privacy ?? undefined });
        } else if (st.type === "tool") {
          try { await rs.tool(b.name, JSON.parse(b.args_json)); } catch (e) { if (e instanceof ReplayDivergence) throw e; }
        } else await rs.note(b.kind, JSON.parse(b.data_json));
      } catch (e) { if (e instanceof ReplayDivergence) break; throw e; }
    }
  }
  report.replayTrace = await rs.finish();
  return report;
}
