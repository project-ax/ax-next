# TASK-79 — skill_propose manifest contract align + close capability-loss gate bypass

## Problem

Two coupled defects, both surfaced by the TASK-72 acceptance walk:

1. **Contract mismatch (usability).** The `skill_propose` tool description
   (`packages/tool-skill-propose/src/descriptor.ts`) tells the model to write
   frontmatter `id` + a semver `version`, with capability keys (`allowedHosts`,
   `credentials`, `packages`) at the **top level**. But the authoritative parser
   (`packages/skills-parser/src/manifest.ts` `parseSkillManifest`) requires:
   - `name` (NOT `id`) — `id` → `invalid-name` → "malformed" + the 120s retry/timeouts;
   - integer `version` (not semver);
   - capabilities nested under a `capabilities:` **mapping object**.

2. **SECURITY — silent capability-loss → active.** When the model follows the
   broken docs and puts caps at the top level, the parser **silently ignores**
   them (it only reads `doc['capabilities']`). The proposal's parsed caps are
   then empty, so the hybrid gate (`classifyProposal`) sees `origin='authored'` +
   zero caps → **`active`**. A cap-bearing-in-intent skill (e.g. Linear) installs
   as a zero-cap ACTIVE skill with **no approval card** — the capability-loss path
   bypasses the materialization gate.

## Root cause of the security bug

The gate is correct *given its input*; the bug is upstream — the parser drops
misplaced capability keys instead of flagging them, so the gate never sees the
caps the author intended. The single-source-of-truth fix is **at the parser**:
treat a capability-shaped key outside `capabilities:` as a structural error, so
a dropped/stripped-cap manifest is a loud `invalid-manifest` reject (the model
re-drafts) — never a silent zero-cap active. Defense-in-depth that holds even if
the docs drift again.

## Approach — ONE documented contract

Canonical frontmatter (what the parser already enforces; we align everything to it):

```yaml
name: linear                       # lowercase slug, ^[a-z][a-z0-9-]{0,63}$ (NOT `id`)
description: Work with Linear issues.
version: 1                         # non-negative INTEGER (NOT semver)
capabilities:                      # mapping object; omit entirely for a zero-cap skill
  allowedHosts:
    - api.linear.app
  credentials:
    - slot: LINEAR_API_KEY
      kind: api-key
```

## Tasks (each independent + testable; TDD — test first)

1. **Parser: reject misplaced top-level capability keys (SECURITY core).**
   In `parseSkillManifest`, after the `capabilities` block handling, reject a
   manifest that declares any of `allowedHosts` / `credentials` / `mcpServers` /
   `packages` at the **top level** (outside `capabilities:`) with
   `invalid-manifest` and a message that names the misplaced key + says it belongs
   under `capabilities:`. Test in `manifest.test.ts` (parser unit) — must fail
   before the change (today it parses to zero caps).

2. **Propose chokepoint: prove no silent-active capability-loss (SECURITY).**
   In `packages/skills/src/__tests__/propose.test.ts`, add a test feeding a
   manifest with caps at the top level (the bug repro) and assert `skills:propose`
   **rejects** (malformed) and writes **no** active row — it is NEVER silently
   active. Plus a test that the correctly-nested cap-bearing manifest lands
   `pending`. The top-level-caps test must fail before task 1.

3. **Docs/contract alignment.** Fix `descriptor.ts` description to use `name`
   (not `id`), integer `version`, and capabilities under a `capabilities:`
   mapping with a short inline example. Fix the executor split-error wording in
   `skill-propose-executor.ts` (`id/description/version` → `name/description/version`).
   Update `descriptor.test.ts` to assert the corrected contract (mentions `name`,
   `capabilities:`).

4. **Well-formed round-trip test.** Confirm/extend a test that a well-formed
   `skill_propose` manifest parses + materializes (zero-cap → active; cap-bearing
   → pending). The existing `propose.test.ts` `HOST_MANIFEST` already uses the
   correct contract; add explicit coverage tying it to the documented frontmatter.

## Invariants

- I4 one-source-of-truth: the parser is the single contract authority; docs/prompt
  conform to it (we move docs to the parser, not the reverse). No second parser.
- I5 capabilities strict + minimized: the parser fix makes a dropped-cap manifest
  loud; the gate stays strict (any cap / non-authored → pending).
- I2 no cross-plugin import: parser change is internal to `@ax/skills-parser`;
  the runner executor keeps its re-implemented splitter (no parser import across
  the sandbox edge).
- Boundary review: no hook-surface signature change (the `skills:propose` payload
  and the `skill.propose` IPC schema are unchanged). The only behavioral change is
  stricter parser validation (an internal impl detail of an existing reject path).

## Security note (for PR body)

- Sandbox: N/A — no new reachable capability; this PR *tightens* an existing
  validation path (rejects misplaced caps) and changes no FS/network/spawn reach.
- Injection: untrusted adversarial model frontmatter is parsed; the fix makes the
  parser reject (not silently drop) misplaced capability keys, closing a path where
  a cap-bearing skill installed active without approval. Bundle text stays opaque
  bytes; never shell/SQL/prompt interpolated.
- Supply chain: N/A — no package.json changes, no new deps.
