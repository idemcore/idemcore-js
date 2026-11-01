# Reproducible agents: record, replay, verify (JavaScript)

Same trace format (`idemcore-trace/r1`) as the Python SDK: a trace recorded in one
verifies and replays in the other. The full format spec is in the Python SDK's
`docs/agent-replay.md`; it is repeated briefly at the end.

```js
import { Idemcore, Session, replay, verifyTrace, generateSigningKey, dumpsTrace } from "@idemcore/sdk";
import { readFileSync, writeFileSync } from "node:fs";

const client = new Idemcore();           // IDEMCORE_API_KEY from the environment
const getWeather = ({ city }) => ({ city, temp_c: 18 });

async function agent(s) {
  const city = (await s.chat("Which city is the Eiffel Tower in? One word.", { maxTokens: 8 })).text.trim().replace(/\.$/, "");
  const w = await s.tool("get_weather", { city }, getWeather);   // runs the tool, records args + result
  return (await s.chat(`Weather: ${JSON.stringify(w)}. One-sentence forecast.`, { maxTokens: 40 })).text;
}

// record
const s = new Session(client, { meta: { job: "forecast-demo" } });
await agent(s);
const key = await generateSigningKey();  // private JWK: keep it secret, publish key.kid
writeFileSync("run.trace.json", dumpsTrace(await s.finish({ signWith: key })));

// verify offline (no network)
const trace = JSON.parse(readFileSync("run.trace.json", "utf8"));
const v = await verifyTrace(trace, { trustedSigners: [key.kid] });
console.log(v.ok, v.errors);

// replay: model calls are re-sent and must be bit-identical; tools are NOT run again
const report = await replay(trace, client, { agent });
console.log(report.summary());
```

API:

* `new Session(client, { meta, sessionId })`; `s.chat(messages, opts)`; `s.tool(name, args, fn)` (calls `fn(args)`, may be async);
  `s.recordTool(name, args, result, { error })`; `s.recordModel(result, { model, maxTokens, privacy }, streamed)` for
  `await stream.finalResult()`; `s.note(kind, data)`; `await s.finish({ signWith })`.
* `verifyTrace(trace, { keys, checkReceipts, trustedSigners, requireSignature })` returns
  `{ ok, errors, warnings, steps, modelSteps, toolSteps, signers }`.
* `replay(trace, client, { agent, strict, verifyFirst, keys })` returns a report with `ok`, per-step `steps`
  (`identical`, `diffs`, `notes`), `errors`, `modelCalls`, `replayTrace` and `summary()`.

CLI (after `npm i @idemcore/sdk`):

```bash
npx idemcore-trace verify run.trace.json --signer ed25519:1a2b3c4d5e6f7a8b
npx idemcore-trace show run.trace.json
IDEMCORE_API_KEY=... npx idemcore-trace replay run.trace.json --out replay.trace.json
```

What a trace proves: each model answer was produced by Idemcore for exactly that
request (signed receipt) and the steps were not edited afterwards (hash chain,
optional Ed25519 signature). Tool results are what your code recorded; the trace
shows they were not changed later but cannot prove the tool returned them. A trace
contains prompts, answers and salts: store it like the conversation.

Format recap: steps `{index, type: "model"|"tool"|"note", prev, body, hash}`, with
`hash = H("trace-step", canonical(step without hash))`, `H(tag, …) = sha256("idemcore/<tag>/r1" 0x00 ‖ (len64le ‖ part)…)`.
The manifest commits to `session_id`, `step_count` and `head`; the signature is Ed25519 over
`"idemcore-trace/r1\n" ‖ manifest_hash`. Tool arguments are stored as canonical JSON text (sorted keys); results keep the tool's key order.
