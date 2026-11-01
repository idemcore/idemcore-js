# @idemcore/sdk

JavaScript / TypeScript client for the [Idemcore](https://idemcore.net) API. Every chat
answer comes with a signed receipt, and this package can check that receipt locally.

* Chat completions (plain or streaming) that return the answer text **and** its receipt id.
* Fetch a receipt and its public token log.
* Verify receipts locally: Ed25519 signature (L1), token-log chain (L2), and your
  prompt / answer against the receipt's salted commitments (disclosure).
* Server-side checks: remote verify, replay on an independent build (L3), audit export.
* Zero dependencies, `fetch` + WebCrypto only. ESM with TypeScript types.
  Node 18+, Deno, Bun, Cloudflare Workers and other edge runtimes.

Decoding is greedy: **temperature is fixed at 0**. Any other temperature throws
`InvalidRequestError` before a request is made.

## Install

```sh
npm install @idemcore/sdk
```

## Get an API key

1. Sign in to the console at <https://console.idemcore.net/#/login> (the public
   preview is free, with preview limits).
2. Create an API key. It starts with `ick_` and is shown only once.
3. Export it:

```sh
export IDEMCORE_API_KEY="ick_..."
```

On Node the client reads `IDEMCORE_API_KEY` (and optionally `IDEMCORE_BASE_URL`,
default `https://api.idemcore.net`). Elsewhere pass `new Idemcore({ apiKey })`.
Keep keys on the server: the API does not accept browser calls from other sites (CORS),
so call it from your backend or a Worker.

## Quickstart

```ts
import { Idemcore } from "@idemcore/sdk";

const client = new Idemcore();
const model = (await client.models())[0].id;   // pass a model id explicitly

const r = await client.chat("Name the three primary colours.", { model, maxTokens: 64 });
console.log(r.text);
console.log(r.receiptId);            // rcpt_...

// Verify on this machine: signature, token-log chain, and that the receipt
// commits to exactly this prompt and this answer.
const v = await client.verifyLocal(r);
console.log(v.ok);                   // true
console.log(v.levels);               // { L1, L2, disclosure }
```

`r.receipt` is the full signed receipt and `r.salt` the base64url salt of a
`hash_only` receipt (the default privacy mode). Anyone with the salt and the text can
check the commitments, so store the salt with the conversation.

### Streaming

```ts
const stream = client.chatStream("Write a haiku about receipts.", { model });
for await (const chunk of stream) process.stdout.write(chunk.delta);
const result = await stream.finalResult();   // receipt arrives with the last chunk
console.log("\n" + result.receiptId);
```

### Receipts, logs and server-side checks

```ts
await client.getReceipt("rcpt_...");                 // GET  /v1/receipts/{id}
const log = await client.getReceiptLog("rcpt_...");  // GET  /v1/receipts/{id}/log
await client.verifyRemote(r.receipt, { messages: r.messages, salt: r.salt, outputTokenIds: r.outputTokenIds });
await client.replayResult(r);                        // POST /v1/receipts/replay (L3)
await client.auditExport({ since: "2026-10-01", until: "2026-10-31" }); // NDJSON lines
await client.models();                               // GET  /v1/models
await client.keys();                                 // GET  /v1/keys (JWKS)
```

### Offline verification without the client

```ts
import { verifyReceipt } from "@idemcore/sdk";

const res = await verifyReceipt(receipt, { logText, messages, salt, outputTokenIds });
```

The production receipt-signing public key is bundled (`DEFAULT_TRUSTED_KEYS`); pass
`keys: await client.keys()` to use the live key set instead.

## Errors

All errors extend `IdemcoreError` with `status`, `type` and `message`:
`AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404),
`ConflictError` (409), `InvalidRequestError` (400/415), `RateLimitError` (429,
`.retryAfter`), `InsufficientQuotaError` (429), `ServiceUnavailableError` (503),
`InternalServerError` (5xx), `APIConnectionError` (network). GET requests are retried on
429/503 (`maxRetries`, default 2). Chat is never retried automatically, so a retry never
creates a second receipt behind your back.

## Using the OpenAI SDK instead

The API is OpenAI-compatible: `new OpenAI({ baseURL: "https://api.idemcore.net/v1", apiKey })`
works, with the receipt in the response's `idemcore_receipt` field. This package adds
typed receipts and local verification.

## License

Apache-2.0
