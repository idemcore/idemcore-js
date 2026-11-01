# Changelog

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
