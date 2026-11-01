// Idemcore API client: fetch-based, no dependencies. Node 18+, browsers, Workers, Deno, Bun.
import { APIConnectionError, AuthenticationError, IdemcoreError, InvalidRequestError, errorFrom } from "./errors.js";
import type { Receipt } from "./receipt.js";
import { verifyReceipt, type VerificationResult } from "./verify.js";
import { VERSION } from "./version.js";

export type Role = "system" | "user" | "assistant";
export interface Message { role: Role; content: string }
export type Privacy = "hash_only" | "full";
export interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number }

export interface ClientOptions {
  /** Defaults to the IDEMCORE_API_KEY environment variable (where one exists). */
  apiKey?: string;
  /** Defaults to IDEMCORE_BASE_URL or https://api.idemcore.net. A trailing /v1 is accepted. */
  baseURL?: string;
  /** Per-request timeout in ms (default 120000). */
  timeout?: number;
  /** Retries for GET requests on 429/503 and network errors (default 2). Chat is never retried. */
  maxRetries?: number;
  /** Custom fetch (tests, proxies). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  privacy?: Privacy;
  /** Decoding is greedy: only undefined, null or 0 are accepted. */
  temperature?: number | null;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  receiptId: string;
  receipt: Receipt;
  id: string;
  model: string;
  finishReason: string | null;
  usage: Usage | null;
  privacy: Privacy;
  /** base64url salt of a hash_only receipt (keep it private, store it with the conversation). */
  salt: string | null;
  outputTokenIds: number[] | null;
  /** The messages exactly as sent (needed to check prompt_hash). */
  messages: Message[];
  rateLimit: Record<string, string>;
  raw: Record<string, unknown>;
}

export interface StreamChunk { delta: string; finishReason: string | null; raw: Record<string, unknown> }
export interface ReceiptLog { receiptId: string; receipt: Receipt; logFormat: string; logText: string }

const RID = /^rcpt_[0-9a-f]{24}$/;
const env = (k: string): string | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[k];

function headerObj(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => { o[k.toLowerCase()] = v; });
  return o;
}

function rid(id: string): string {
  if (typeof id !== "string" || !RID.test(id)) throw new InvalidRequestError(`invalid receipt id: ${String(id)}`, { type: "invalid_request_error" });
  return id;
}

function normMessages(m: string | Message[]): Message[] {
  const list = typeof m === "string" ? [{ role: "user" as Role, content: m }] : m;
  if (!Array.isArray(list) || list.length < 1 || list.length > 64)
    throw new InvalidRequestError("messages must be a non-empty list of at most 64 messages", { type: "invalid_request_error" });
  return list.map((x, i) => {
    if (!x || !["system", "user", "assistant"].includes(x.role) || typeof x.content !== "string")
      throw new InvalidRequestError(`messages[${i}] must be {role: system|user|assistant, content: string}`, { type: "invalid_request_error" });
    return { role: x.role, content: x.content };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Idemcore {
  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries: number;
  #apiKey: string;
  #fetch: typeof fetch;
  #headers: Record<string, string>;

  constructor(opts: ClientOptions = {}) {
    this.#apiKey = opts.apiKey ?? env("IDEMCORE_API_KEY") ?? "";
    this.baseURL = (opts.baseURL ?? env("IDEMCORE_BASE_URL") ?? "https://api.idemcore.net").replace(/\/+$/, "").replace(/\/v1$/, "");
    this.timeout = opts.timeout ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 2;
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new IdemcoreError("no fetch implementation available (Node 18+ required)");
    this.#fetch = f.bind(globalThis);
    this.#headers = opts.headers ?? {};
  }

  toJSON() { return { baseURL: this.baseURL, apiKey: this.#apiKey ? "set" : "missing" }; }

  async #raw(method: "GET" | "POST", path: string, body?: unknown, auth = true, signal?: AbortSignal): Promise<Response> {
    if (auth && !this.#apiKey) throw new AuthenticationError("no API key: pass apiKey or set IDEMCORE_API_KEY", { type: "authentication_error" });
    const headers: Record<string, string> = { Accept: "application/json", ...this.#headers };
    // Browsers forbid setting User-Agent; send a separate client header instead.
    headers["X-Idemcore-Client"] = `idemcore-js/${VERSION}`;
    if (auth) headers.Authorization = `Bearer ${this.#apiKey}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const tries = method === "GET" ? this.maxRetries + 1 : 1;
    for (let attempt = 1; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeout);
      const onAbort = () => ctl.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let res: Response;
      try {
        res = await this.#fetch(this.baseURL + path, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) throw e;
        if (attempt < tries) { await sleep(500 * attempt); continue; }
        throw new APIConnectionError(`connection failed: ${(e as Error)?.message ?? e}`, { type: "connection_error" });
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (res.ok) return res;
      const h = headerObj(res.headers);
      let payload: unknown = null;
      try { payload = await res.json(); } catch { /* not JSON */ }
      const err = errorFrom(res.status, payload, h);
      const retryable = (res.status === 429 && err.type !== "insufficient_quota") || res.status === 503;
      if (retryable && attempt < tries) {
        const ra = Number(h["retry-after"]);
        await sleep(Number.isFinite(ra) && h["retry-after"] !== undefined ? Math.min(ra, 30) * 1000 : 1000 * attempt);
        continue;
      }
      throw err;
    }
  }

  async #json<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown, auth = true): Promise<T> {
    const res = await this.#raw(method, path, body, auth);
    return (await res.json()) as T;
  }

  /** GET /health (no key needed). */
  health() { return this.#json<{ ok: boolean; service: string; version: string }>("GET", "/health", undefined, false); }

  /** GET /v1/models */
  async models(): Promise<Array<{ id: string; object: string; owned_by: string }>> {
    return (await this.#json<{ data: Array<{ id: string; object: string; owned_by: string }> }>("GET", "/v1/models")).data;
  }

  /** GET /v1/keys: the live receipt-signing public keys (JWKS). */
  keys() { return this.#json("GET", "/v1/keys"); }

  #chatBody(messages: Message[], o: ChatOptions, stream: boolean) {
    if (o.temperature !== undefined && o.temperature !== null && o.temperature !== 0)
      throw new InvalidRequestError("temperature is fixed at 0 (greedy decoding)", { type: "invalid_request_error" });
    if (o.maxTokens !== undefined && (!Number.isInteger(o.maxTokens) || o.maxTokens < 1 || o.maxTokens > 2048))
      throw new InvalidRequestError("maxTokens must be an integer from 1 to 2048", { type: "invalid_request_error" });
    if (o.privacy !== undefined && o.privacy !== "hash_only" && o.privacy !== "full")
      throw new InvalidRequestError("privacy must be hash_only or full", { type: "invalid_request_error" });
    const b: Record<string, unknown> = { messages };
    if (o.model) b.model = o.model;
    if (o.maxTokens !== undefined) b.max_tokens = o.maxTokens;
    if (o.privacy) b.idemcore = { privacy: o.privacy };
    if (stream) { b.stream = true; b.stream_options = { include_usage: true }; }
    return b;
  }

  /** POST /v1/chat/completions. Returns the answer text and its signed receipt. */
  async chat(messages: string | Message[], opts: ChatOptions = {}): Promise<ChatResult> {
    const msgs = normMessages(messages);
    const res = await this.#raw("POST", "/v1/chat/completions", this.#chatBody(msgs, opts, false), true, opts.signal);
    const d = (await res.json()) as Record<string, any>;
    return toResult(d, msgs, headerObj(res.headers));
  }

  /** Streaming chat. Iterate for text deltas; `await stream.finalResult()` gives the ChatResult with its receipt. */
  chatStream(messages: string | Message[], opts: ChatOptions = {}): ChatStream {
    const msgs = normMessages(messages);
    const body = this.#chatBody(msgs, opts, true);
    return new ChatStream(() => this.#raw("POST", "/v1/chat/completions", body, true, opts.signal), msgs);
  }

  /** GET /v1/receipts/{id} */
  async getReceipt(receiptId: string): Promise<Receipt> {
    return (await this.#json<{ receipt: Receipt }>("GET", `/v1/receipts/${rid(receiptId)}`)).receipt;
  }

  /** GET /v1/receipts/{id}/log: the receipt with its public token log. */
  async getReceiptLog(receiptId: string): Promise<ReceiptLog> {
    const d = await this.#json<Record<string, any>>("GET", `/v1/receipts/${rid(receiptId)}/log`);
    return { receiptId: d.receipt_id, receipt: d.receipt, logFormat: d.log_format, logText: d.log_text };
  }

  /** POST /v1/receipts/verify: server-side L1/L2 (+ disclosure when given). */
  verifyRemote(receipt: Receipt, opts: { logText?: string; messages?: Message[]; salt?: string | null; outputTokenIds?: number[] | null; outputText?: string } = {}) {
    const b: Record<string, unknown> = { receipt };
    if (opts.logText !== undefined) b.log_text = opts.logText;
    const disc: Record<string, unknown> = {};
    if (opts.messages) disc.messages = opts.messages;
    if (opts.salt) disc.salt = opts.salt;
    if (opts.outputTokenIds) disc.output_token_ids = opts.outputTokenIds;
    if (opts.outputText !== undefined) disc.output_text = opts.outputText;
    if (Object.keys(disc).length) b.disclosure = disc;
    return this.#json("POST", "/v1/receipts/verify", b);
  }

  /** POST /v1/receipts/replay: re-run the computation on an independent build (L3). */
  replay(receiptId: string, opts: { messages?: Message[]; salt?: string | null; outputTokenIds?: number[] | null; build?: "main" | "alt" } = {}) {
    const b: Record<string, unknown> = { receipt_id: rid(receiptId) };
    if (opts.messages) b.messages = opts.messages;
    if (opts.salt) b.salt = opts.salt;
    if (opts.outputTokenIds) b.output_token_ids = opts.outputTokenIds;
    if (opts.build) b.build = opts.build;
    return this.#json("POST", "/v1/receipts/replay", b);
  }

  /** Replay a ChatResult, passing the messages and salt a hash_only receipt needs. */
  replayResult(r: ChatResult, build?: "main" | "alt") {
    return this.replay(r.receiptId, { messages: r.messages, salt: r.salt, outputTokenIds: r.outputTokenIds, build });
  }

  /** POST /v1/audit/export. NDJSON lines by default; `format: "json"` returns one object. Window up to 31 days, `until` exclusive. */
  async auditExport(opts: { since?: string; until?: string; includeLogs?: boolean; format?: "ndjson" | "json" } = {}): Promise<any> {
    const b: Record<string, unknown> = {};
    if (opts.since) b.since = opts.since;
    if (opts.until) b.until = opts.until;
    if (opts.includeLogs) b.include_logs = true;
    if (opts.format === "json") b.format = "json";
    const res = await this.#raw("POST", "/v1/audit/export", b);
    if (opts.format === "json") return res.json();
    return (await res.text()).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  /** Verify a ChatResult on this machine: L1 signature, L2 token log (fetched), and disclosure. */
  async verifyLocal(r: ChatResult, opts: { keys?: unknown; fetchLog?: boolean; checkSignature?: boolean; outputText?: string } = {}): Promise<VerificationResult> {
    const logText = opts.fetchLog === false ? undefined : (await this.getReceiptLog(r.receiptId)).logText;
    const hasText = typeof r.receipt.output_text_hash === "string";
    return verifyReceipt(r.receipt, {
      keys: opts.keys, logText, messages: r.messages, salt: r.salt,
      outputTokenIds: r.outputTokenIds ?? undefined,
      outputText: opts.outputText ?? (hasText ? r.text : undefined),
      checkSignature: opts.checkSignature,
    });
  }
}

function toResult(d: Record<string, any>, messages: Message[], headers: Record<string, string>): ChatResult {
  const ch = d.choices?.[0] ?? {};
  const receipt = (d.idemcore_receipt ?? d.idemcore?.receipt) as Receipt;
  if (!receipt || typeof receipt.receipt_id !== "string") throw new IdemcoreError("response carried no receipt", { type: "server_error" });
  const disc = d.idemcore?.disclosure ?? {};
  const rateLimit: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (k.startsWith("x-ratelimit-")) rateLimit[k] = v;
  return {
    text: ch.message?.content ?? "",
    receiptId: receipt.receipt_id as string,
    receipt,
    id: d.id,
    model: d.model,
    finishReason: ch.finish_reason ?? null,
    usage: d.usage ?? null,
    privacy: receipt.privacy as Privacy,
    salt: d.idemcore_salt ?? disc.salt ?? null,
    outputTokenIds: disc.output_token_ids ?? null,
    messages,
    rateLimit,
    raw: d,
  };
}

/** A streaming chat response: an async iterable of text chunks. */
export class ChatStream implements AsyncIterable<StreamChunk> {
  #start: () => Promise<Response>;
  #messages: Message[];
  #result: ChatResult | null = null;
  #started = false;
  #done: Promise<void> | null = null;

  constructor(start: () => Promise<Response>, messages: Message[]) {
    this.#start = start;
    this.#messages = messages;
  }

  /** The final result (available once the stream has finished). */
  get result(): ChatResult | null { return this.#result; }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
    if (this.#started) throw new IdemcoreError("a ChatStream can only be iterated once");
    this.#started = true;
    const res = await this.#start();
    const headers = headerObj(res.headers);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "", text = "", final: Record<string, any> | null = null, usage: Usage | null = null;
    let meta: Record<string, any> = {};
    const handle = (data: string): StreamChunk | null => {
      const ev = JSON.parse(data) as Record<string, any>;
      if (ev.error) throw errorFrom(null, ev, headers);
      if (ev.usage) usage = ev.usage;
      if (ev.id) meta = { id: ev.id, model: ev.model };
      const c = ev.choices?.[0];
      if (!c) return null;
      if (c.finish_reason) final = ev;
      const delta = c.delta?.content ?? "";
      text += delta;
      return delta || c.finish_reason ? { delta, finishReason: c.finish_reason ?? null, raw: ev } : null;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
          const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
          if (!data) continue; // comments such as ": keep-alive"
          if (data === "[DONE]") { buf = ""; break; }
          const chunk = handle(data);
          if (chunk) yield chunk;
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    if (!final) throw new IdemcoreError("stream ended without a receipt", { type: "server_error" });
    const f = final as Record<string, any>;
    const d = {
      ...meta, ...f, usage: f.usage ?? usage,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: f.choices[0].finish_reason }],
    };
    this.#result = toResult(d, this.#messages, headers);
  }

  /** Consume the stream (if not already) and return the final ChatResult. */
  async finalResult(): Promise<ChatResult> {
    if (!this.#started) {
      this.#done = (async () => { for await (const _ of this) { /* drain */ } })();
    }
    if (this.#done) await this.#done;
    if (!this.#result) throw new IdemcoreError("stream has not finished");
    return this.#result;
  }
}
