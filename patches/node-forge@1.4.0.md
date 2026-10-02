# node-forge signature validation backport

`node-forge@1.4.0` is pinned and patched for
[GHSA-86w9-cpqp-85rv / CVE-2026-85393](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
There is no patched npm release as of 2026-10-02.

The patch reproduces the `lib/rsa.js` change proposed in
[upstream PR #1152](https://github.com/digitalbazaar/forge/pull/1152), commit
`ceba34402e329f0365134f23fe19898756527d65`. It rejects extra children inside
DigestInfo's nested DigestAlgorithm sequence. The upstream PR is still open;
this is a local backport, not a released upstream fix.

The root manifest excludes only this advisory from `pnpm audit` because the
registry checks the version number and cannot see the patch. All other advisories
remain checked. `scripts/__tests__/node-forge-signature-validation.test.js` runs
against the installed dependency in both consumers, rejects malformed signatures
with and without NULL parameters, and accepts valid signatures. It failed against
the unpatched release before the backport was applied. The scripts suite runs
unconditionally in CI.

The credential proxy uses forge to generate and sign local certificates; Node TLS
verifies upstream certificates. The Kubernetes preset uses forge in test fixtures.
No install-time scripts or transitive dependencies are added by this backport.

When a fixed upstream release is available, upgrade both consumers and remove the
patch, audit exception, and exception-specific manifest assertions. Keep the
signature regression tests.
