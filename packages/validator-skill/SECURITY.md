# Security — `@ax/validator-skill`

This is the first real subscriber on `workspace:pre-apply`. Its job is small and its blast radius should be smaller. We're a YAML parser with veto power — that's it.

## Capability budget

- **No filesystem access.** We read bytes that arrive in the FileChange payload and never touch disk.
- **No network.** We don't make HTTP calls, don't open sockets, don't resolve DNS.
- **No process spawn.** `js-yaml` is pure JS; we never `child_process.spawn` anything.
- **No env access.** We don't read `process.env`. Configuration arrives via the plugin factory's options (currently none).
- **No write to anything.** We accept or veto. We don't transform the FileChange[]; we don't store anything cross-call. We're stateless.

If a future change needs any of those capabilities, they go in the SECURITY.md before the code does. We'd rather have a boring plugin than a clever one.

## Threat model: untrusted SKILL.md content

Every byte we parse came from the agent. The agent might:

- Have been prompt-injected by a tool result.
- Have written garbage on purpose because we're testing it.
- Have written a YAML payload designed to trigger a parser CVE.

So:

- **Strict UTF-8 decode.** We pass `fatal: true` to `TextDecoder` so non-UTF-8 bytes throw instead of producing replacement characters. Replacement characters are how things "look fine" in a logs grep but actually contain whatever an attacker stuffed into the byte stream.
- **Safe-schema YAML.** `js-yaml`'s default `load` uses the safe schema by default — no `!!js/function`, no class instantiation, no tags that could trigger code execution. We don't opt into any unsafe schema.
- **No interpolation.** We extract `name` and `description` and check they're non-empty strings. We don't interpolate them into shell commands, file paths, HTML, SQL, or anything else that would care about the bytes. They're returned to the bus as part of the decision; a downstream subscriber that DOES interpolate is responsible for its own escape semantics.
- **Veto on doubt.** Anything we can't parse cleanly gets vetoed. Better to make the agent retry with a fixed SKILL.md than to silently accept malformed metadata that could cascade into worse decisions later.

## Threat model: bypassing the validator

The validator is the FIRST `workspace:pre-apply` subscriber, but it's not the only line of defense. If an attacker bypasses us — e.g., the host's commit-notify handler routes around `pre-apply` somehow, or the workspace plugin doesn't honor a veto — the result is "malformed SKILL.md lands in the workspace." That's bad but not catastrophic; the next layer (skill loader, identity validator in Phase 4) sees the bytes too and would reject.

What we depend on:

- The host's commit-notify handler firing `workspace:pre-apply` BEFORE `workspace:apply`. (See `packages/ipc-core/src/handlers/workspace-commit-notify.ts`.)
- The host's bundler filtering changes to `.ax/**` before firing pre-apply. (We assume our input is already filtered; if user-code changes leaked in, we'd correctly skip them via the `SKILL_PATH` regex, but we'd also be doing wasted work on every turn.)
- The bus respecting subscriber vetoes. (`HookBus.fire` returns `rejected: true` on any subscriber `reject()`, and the handler short-circuits.)

If any of those break, Phase 3's invariants break in a much louder way than this plugin can compensate for.

## Known limits

- **Only flat frontmatter validated.** Nested YAML structures (e.g., `name: { nested: ... }`) would parse fine but our `typeof name !== 'string'` check would reject. That's a feature, not a bug — flat frontmatter is the convention.
- **`name` and `description` are validated for type + non-empty-ness, NOT semantic content.** A skill named `my-evil-skill` with description `does evil things` passes the validator. That's the right boundary — semantic-content validation is a Phase 4+ concern (skill schema, identity drift detection) and would compose with this plugin, not replace it.
- **Path matching is exact-prefix.** `.ax/skills/<name>/SKILL.md` is the only shape we recognize. A future relaxation (nested skill packages, alternate file extensions) would update the regex; for now keep it strict so the surface is unambiguous.

## What we don't know yet

- How big SKILL.md files get in the wild. js-yaml's parse cost is roughly linear in input size, so a multi-megabyte SKILL.md would be slow. We rely on the host bundler's MAX_FRAME (4 MiB) to bound the total payload; per-file caps land if/when we see real-world abuse.
- Whether the YAML safe schema is enough for every variant of SKILL.md the broader Anthropic ecosystem produces. If a legitimate use case requires a non-safe schema, we'd need a documented opt-in (and a fresh threat-model walk for whatever the new schema permits).

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
