# Remote MCP PR — node-forge audit gate

| Date | Decision | Rationale | Alternatives |
|---|---|---|---|
| 2026-10-02 | Pin node-forge 1.4.0 and backport upstream PR #1152's nested DigestAlgorithm validation; exclude only GHSA-86w9-cpqp-85rv from the registry audit while retaining an unconditional installed-dependency regression test for both consumers. | All product tests passed, but CI's audit failed on CVE-2026-85393 with no fixed npm release. Audit cannot recognize a local pnpm patch. Remove the backport and exception once both consumers upgrade to a fixed upstream release. | Suppress all unfixable advisories; rejected because it would hide unrelated vulnerabilities. Replace the certificate generator; unnecessarily broad for this fix. |
