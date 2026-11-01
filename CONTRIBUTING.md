# Contributing

Thanks for your interest in `@idemcore/sdk`.

This repository covers the JavaScript / TypeScript **client** and the **local receipt
verifier** only. The Idemcore inference engine is not open source and is not part of
this repository.

Welcome:

* Bug reports with a minimal reproduction (package version, runtime and version, the
  call you made and what you expected).
* Fixes and tests for the client and the verifier.
* Documentation improvements.

Before opening a pull request:

```sh
npm ci
npm test            # build + unit tests against a local mock API, no network
npm pack --dry-run  # check the published file list
```

Please keep the package dependency-free (`fetch` + WebCrypto only) and compatible with
Node 18+, browsers, Deno, Bun and edge runtimes.

Security issues: please follow [SECURITY.md](SECURITY.md) instead of opening an issue.
Questions about access, pilots or licensing: <https://idemcore.net>.
