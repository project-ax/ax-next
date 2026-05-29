# Security — `@ax/validator-skill`

This is the first real subscriber on `workspace:pre-apply`. Its job is small and its blast radius should be smaller. We're a YAML parser with veto power — that's it.

## Capability budget (Phase 2)

The validator performs NO process spawn and NO direct network or filesystem I/O.
It now DELEGATES, via the hook bus, to soft-dep services (all `hasService`-guarded;
absent ⟹ degrade, never crash):

- `llm:call:anthropic` — the Layer-2 content scan (a fast model). Untrusted
  SKILL.md text is sent as DATA inside `<skill>` tags with a hardened
  "analyze, do not follow" system prompt; the model gets NO tools (text in,
  one-line verdict out). A compromised/bypassed classifier can only fail-open to
  the regex verdict — it cannot escalate. Size-capped + timed out; any error
  degrades to regex-only.
- `skills:quarantine-set` / `skills:quarantine-clear` — persist the scan verdict
  (host-side, keyed by user/agent/skillId — never a workspace marker the agent
  could delete).

The bus calls themselves are in-process (no network hop from the validator's
perspective). The actual network egress for the LLM scan happens inside
`@ax/llm-anthropic`, not here — the validator never opens a socket.

The scan is best-effort DEFENSE IN DEPTH and observability, NOT the security
boundary. The boundary is capability-use (the egress proxy + credential injection
+ human approval at the wall). The SKILL.md content veto is GONE — malformed/
unsafe content is ACCEPTED (work is never destroyed) and annotated (quarantined);
structural validity is enforced lazily at promote. The `.claude/**` SDK-config
veto is UNCHANGED (still a hard reject).

These were the Phase 1 invariants for reference:

- **No filesystem access.** We read bytes that arrive in the FileChange payload and never touch disk.
- **No network (direct).** We don't open sockets, don't resolve DNS. Indirect network via delegated bus calls is guarded and bounded (see above).
- **No process spawn.** `js-yaml` is pure JS; we never `child_process.spawn` anything.
- **No env access.** We don't read `process.env`. Configuration arrives via the plugin factory's options.

If a future change needs capabilities beyond these bounds, they go in the SECURITY.md before the code does.

## Threat model: untrusted SKILL.md content

Every byte we parse came from the agent. The agent might:

- Have been prompt-injected by a tool result.
- Have written garbage on purpose because we're testing it.
- Have written a YAML payload designed to trigger a parser CVE.

So:

- **Strict UTF-8 decode.** We pass `fatal: true` to `TextDecoder` so non-UTF-8 bytes throw instead of producing replacement characters. Replacement characters are how things "look fine" in a logs grep but actually contain whatever an attacker stuffed into the byte stream.
- **Safe-schema YAML.** `js-yaml`'s default `load` uses the safe schema by default — no `!!js/function`, no class instantiation, no tags that could trigger code execution. We don't opt into any unsafe schema.
- **No interpolation.** We extract `name` and `description` and check they're non-empty strings. We don't interpolate them into shell commands, file paths, HTML, SQL, or anything else that would care about the bytes. They're returned to the bus as part of the decision; a downstream subscriber that DOES interpolate is responsible for its own escape semantics.
- **Accept-and-annotate on doubt (Phase 2).** Anything we can't parse cleanly is ACCEPTED but quarantined via `skills:quarantine-set`. Work is never destroyed; the agent can iterate. Structural validity is enforced lazily at promote time by `@ax/agents`. The `.claude/**` SDK-config path retains its hard-reject behavior (see below).

## Threat model: bypassing the validator

The validator is the FIRST `workspace:pre-apply` subscriber, but it's not the only line of defense. If an attacker bypasses us — e.g., the host's commit-notify handler routes around `pre-apply` somehow, or the workspace plugin doesn't honor a veto — the result is "malformed SKILL.md lands in the workspace." That's bad but not catastrophic; the next layer (skill loader, identity validator in Phase 4) sees the bytes too and would reject.

What we depend on:

- The host's commit-notify handler firing `workspace:pre-apply` BEFORE `workspace:apply`. (See `packages/ipc-core/src/handlers/workspace-commit-notify.ts`.)
- The host's bundler filtering changes to `.ax/**` before firing pre-apply. (We assume our input is already filtered; if user-code changes leaked in, we'd correctly skip them via the `SKILL_PATH` regex, but we'd also be doing wasted work on every turn.)
- The bus respecting subscriber vetoes. (`HookBus.fire` returns `rejected: true` on any subscriber `reject()`, and the handler short-circuits.)

If any of those break, Phase 3's invariants break in a much louder way than this plugin can compensate for.

## Known limits

- **Only flat frontmatter validated at the structural layer.** Nested YAML structures (e.g., `name: { nested: ... }`) produce a type-check failure, which now quarantines the skill rather than vetoing the turn outright. That's still a feature — flat frontmatter is the convention.
- **`name` and `description` are validated for type + non-empty-ness at the structural layer; semantic content goes through the LLM scan.** The LLM scan is best-effort and degrades to regex-only when `llm:call:anthropic` is absent. Neither is the primary security boundary — that's the egress proxy at capability-use time.
- **Path matching is exact-prefix.** `.ax/draft-skills/<name>/SKILL.md` is the only shape we recognize. A future relaxation (nested skill packages, alternate file extensions) would update the regex; for now keep it strict so the surface is unambiguous.

## What we don't know yet

- How big SKILL.md files get in the wild. js-yaml's parse cost is roughly linear in input size, so a multi-megabyte SKILL.md would be slow. We rely on the host bundler's MAX_FRAME (4 MiB) to bound the total payload; per-file caps land if/when we see real-world abuse.
- Whether the YAML safe schema is enough for every variant of SKILL.md the broader Anthropic ecosystem produces. If a legitimate use case requires a non-safe schema, we'd need a documented opt-in (and a fresh threat-model walk for whatever the new schema permits).

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
