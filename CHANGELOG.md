# Changelog

## 0.3.0 (2026-11-05)

- Receipt verification accepts format **r2** as well as r1. r2 only renames three
  fields (`seed`→`variant`, `chain_fnv`→`chain_check`, `kernel_version`→`engine_version`);
  the signing domain and algorithm are unchanged. Existing r1 receipts still verify.
- The live API returns r2 receipts to this SDK (User-Agent 0.3.0). SDKs ≤0.2.x still
  receive r1.
- Trace replay compares aliased receipt fields across r1/r2.
- Interchangeable with the Python SDK (`idemcore` 0.3.0).

## 0.2.0 (2026-11-01)

- Reproducible agents: `Session` records a whole agent run (model calls with their signed
  receipts, tool calls, approvals and other notes) as a hash-chained trace
  (`idemcore-trace/r1`), optionally signed with your own Ed25519 key (`generateSigningKey`).
- `verifyTrace()` checks a trace offline: chain, step hashes, receipt signatures and
  commitments, and trace signatures (pin signers with `trustedSigners`).
- `replay()` re-sends the recorded model requests and checks that every answer is
  bit-identical (token ids, text, chain digest). With `agent`, your agent code runs again
  and recorded tool results are fed back, so tools are never executed twice; any change
  in calls or arguments is reported as a divergence.
- CLI: `npx idemcore-trace verify|show|replay FILE`.
- Traces are interchangeable with the Python SDK (`idemcore` 0.2.0).
- Docs: `docs/agent-replay.md`, example `examples/agent-replay.mjs`.

## 0.1.2 (2026-11-01)

- Published with an npm provenance attestation: each version links to the public
  source repository, commit and GitHub Actions run that built it.
- Adds SECURITY.md and CONTRIBUTING.md; package metadata now lists the issue tracker.
- No code changes.

## 0.1.1 (2026-11-01)

- README: the quickstart and streaming examples now pass `model` explicitly
  (read from `client.models()`), since the API requires a model id.
- Release published from GitHub Actions with npm trusted publishing (OIDC, no token).

## 0.1.0 (2026-11-01)

- First release: chat and streaming client, signed receipts and local receipt
  verification. Zero dependencies; Node 18+, browsers, Workers.
