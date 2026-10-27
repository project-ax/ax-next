# node-forge signature validation backport: retired

Both consumers now pin `node-forge@1.4.1`. The installed release passes our
[CVE-2026-85393 regression](../scripts/__tests__/node-forge-signature-validation.test.js):
malformed DigestAlgorithm sequences are rejected with and without NULL
parameters, and valid signatures still verify.

The local 1.4.0 patch, its registration and the advisory exception have been
removed. The regression tests remain in the unconditional scripts suite and
exercise both the credential proxy and the Kubernetes preset.

The update adds no install-time scripts or transitive dependencies.
