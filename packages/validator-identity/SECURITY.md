# Security — `@ax/validator-identity`

This is the **third** subscriber on `workspace:pre-apply` (after `@ax/validator-skill`
and `@ax/validator-routine`). Its job: gate an agent's writes to its own identity files
under `/agent/.ax/`. We're a regex scanner with veto power and one read — that's it.

The blast radius matters more here than for the other two validators, because the runner
injects these files **verbatim into the composed system prompt every spawn**
(conversational-agent-identity epic, Phase 1). An identity self-edit is a
self-modification of the agent's own system prompt. So this validator IS the
prompt-injection mitigation for self-edits, and an injection signature is a HARD veto
(not the accept-but-annotate posture `validator-skill` uses for skill bodies — a
quarantined skill is inert until promoted, but an identity file goes live next turn).

## Capability budget

The validator performs NO process spawn, NO direct filesystem I/O, NO network, NO env
access. It makes exactly one bus call, and it's optional:

- `workspace:read` (`optionalCall`, `hasService`-guarded) — reads the committed
  `.ax/BOOTSTRAP.md` at the apply's `parent` version to decide whether the agent is
  still bootstrapping. The path is a **hardcoded constant** (`.ax/BOOTSTRAP.md`) — never
  caller-provided, so no path traversal. The `version` argument is the opaque
  `WorkspaceVersion` token from the pre-apply payload, passed back unmodified; it is a
  storage-agnostic brand, never resolved as a filesystem path. If `workspace:read` is
  absent the validator degrades to the (stricter) post-bootstrap policy — it never
  crashes bootstrap and never grants a bootstrap-only allowance it can't verify.

The bus call is in-process; the validator never opens a socket. Any network egress for a
git-backed `workspace:read` happens inside the workspace backend, not here.

## Why the bootstrap window reads the PARENT, not the change set

`.ax/BOOTSTRAP.md`'s presence is the one signal that means "still bootstrapping." It is
**host-seeded** (created at agent-create) and the agent only ever **deletes** it (the
completion ritual). The bootstrap window must reflect the **host-committed state**, never
anything the agent supplied this turn — otherwise an agent (or a prompt-injection) could
re-create `.ax/BOOTSTRAP.md` to re-open the window and, via the runner's bootstrap-mode
branch, suppress the safety floor on the next spawn. (This is the un-gated bootstrap-trust
window flagged in Phase 1; this validator closes it.)

Two mechanisms enforce host-seeding:

1. The window is resolved by `workspace:read('.ax/BOOTSTRAP.md', version=parent)` — the
   committed state going into the turn — not by inspecting `changes`.
2. A `put` to `.ax/BOOTSTRAP.md` is allowed **only when its content is byte-identical to
   the canonical `BOOTSTRAP_TEMPLATE`** (the trusted compile-time constant the host
   seeds). Any other content is **hard-vetoed in every window state**. The agent's only
   other legitimate operation on that file is the completion `delete`.

   Why content and not actor: the host seeds BOOTSTRAP.md through the *same*
   `workspace:apply` → `workspace:pre-apply` path an agent write takes (`parent: null`,
   first apply), and pre-apply carries no trusted origin signal — `reason` is
   agent-influenceable free-text, so keying the allow on `reason: 'agent-bootstrap-seed'`
   would be a trivially-spoofable bypass. The canonical template, by contrast, is a
   compile-time constant the agent cannot forge into anything *different* while still
   passing the byte-equality check. A re-`put` of the *exact* canonical script is benign
   (it re-enters the same trusted, floor-by-design bootstrap), so it's allowed; any
   deviation — even one trailing byte — is the attack and is vetoed.

## The policy, as a decision table

| change | window OPEN (`BOOTSTRAP.md`@parent found) | window CLOSED (post-bootstrap) |
|---|---|---|
| `put` `IDENTITY.md` / `SOUL.md` / `AGENTS.md` | allow (+ injection scan) | allow + log `identity_self_edit` (+ injection scan) |
| `put` `BOOTSTRAP.md` (canonical bytes) | allow (the host seed / a benign re-seed) | allow (canonical re-seed) |
| `put` `BOOTSTRAP.md` (any other bytes) | **HARD VETO** | **HARD VETO** |
| `delete` `BOOTSTRAP.md` | allow (graduation) | allow (idempotent) |
| `delete` an identity file | allow | allow |
| any non-identity path | pass-through | pass-through |

The injection scan runs on every identity-file `put` **regardless of window** — a
signature is always a hard veto.

## Threat model: untrusted identity content

Every byte we scan came from the agent, which might have been prompt-injected by a tool
result, or be writing a payload on purpose to test us. So:

- **Strict UTF-8 decode (`fatal: true`).** A non-UTF-8 byte throws instead of producing a
  U+FFFD replacement char — replacement chars are how a payload "looks fine" in a logs
  grep while hiding bytes that would land verbatim in the system prompt. A decode failure
  on an identity file is itself suspect → veto.
- **Regex scan, no interpolation.** The scanned text is run through pure
  `RegExp.test()` (instruction-override / credential-exfiltration / obfuscation
  signatures). It is never interpolated into a shell command, file path, SQL query, URL,
  or HTML, and never concatenated into another LLM prompt by this validator.
- **No raw bytes in the veto reason or logs.** The reject reason carries only the fixed
  path constant + a fixed scan category + a length-capped (≤160 char) sanitized detail
  — never the attacker's raw input. Logs carry `path` + `category` (+ the host-set apply
  `reason`), never file content.

Worst-case test: a `SOUL.md` containing `"; rm -rf ~; echo "` → `regexScan` runs `.test()`
on it (no execution), finds no recognized signature for that exact string, the write passes
and the bytes land in git as **inert data** (the runner injects them as prompt text, not as
a command). A recognized signature (`ignore all previous instructions`, a secret routed to
an external URL, a zero-width/bidi Trojan-Source run, an `eval(atob(...))` blob) → hard veto.

### Scan is defense-in-depth, copied not imported

The Layer-1 regex set is a deliberate **copy** of `@ax/validator-skill`'s `regexScan`
(Invariant #2 forbids the cross-plugin runtime import). Layer 2 (the soft LLM scan) is
intentionally omitted: identity self-edits are small and were authored by the agent
in-session (lower injection surface than an installed third-party skill), so the regex
wall is the proportionate gate for Phase 3. If the two regex sets drift, reconcile them.
The regex scan is high-signal but not exhaustive — it is a gate, not a guarantee.

## Threat model: bypassing the validator

We're one `workspace:pre-apply` subscriber. We depend on:

- The host's commit-notify handler (and the `@ax/core` apply facade) firing
  `workspace:pre-apply` BEFORE the apply, filtered to `.ax/**` + `.claude/**`. (See
  `packages/ipc-core/src/handlers/workspace-commit-notify.ts` and
  `packages/core/src/workspace-apply-facade.ts`.)
- The bus respecting subscriber vetoes (`HookBus.fire` returns `rejected: true` and the
  caller short-circuits).
- The runner's **non-editable** safety floor, which is the always-injected layer even in
  bootstrap mode. The validator gates what reaches `IDENTITY`/`SOUL`/`AGENTS`/the
  bootstrap window; the floor is the backstop the agent (and a bypass of this validator)
  cannot remove.

If those break, the failure is louder than this plugin can compensate for.

## Known limits

- **Exact-path matching.** `.ax/{IDENTITY,SOUL,AGENTS,BOOTSTRAP}.md` only — flat under
  `.ax/`, no subdirectories, no alternate extensions. A future relaxation updates the set.
- **Regex recall.** A novel injection phrasing not in the Layer-1 set passes the scan.
  The non-editable runner safety floor is the backstop; an LLM layer is a possible
  follow-up if real-world abuse warrants it.
- **The "flag" is a log, not a user-facing announcement.** `workspace:pre-apply` is
  veto-only (the facade ignores transformed payloads), so the post-bootstrap "tell the
  user — it's your soul" announcement is the runner's evolution-guidance job; here it is a
  structured `identity_self_edit` audit log. Git history is the durable audit trail.

## Security review

- Sandbox: No new reachable capability. Subscribes the existing `.ax/`-filtered `workspace:pre-apply`; one `optionalCall` to `workspace:read` with a HARDCODED path (`.ax/BOOTSTRAP.md`) and the opaque `parent` version token (never resolved as a path). No spawn / FS / network / env.
- Injection: The only untrusted input is agent-authored identity bytes — strict-UTF-8 decoded, run through pure `RegExp.test()`, never interpolated into shell/SQL/URL/HTML or concatenated into a prompt; veto reasons + logs carry only fixed path + scan category, never raw bytes. A recognized signature is a hard veto.
- Supply chain: No new third-party dependency. `@ax/validator-identity` depends only on two workspace packages — `@ax/core` and `@ax/agent-identity-templates` (a pure-data, kernel-free template package already on the eslint allow-list, the canonical-BOOTSTRAP source of truth) — plus the standard pinned dev-deps (`typescript`, `vitest`, `@types/node`) every package already uses. The cli/k8s presets gain internal `workspace:*` refs only.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News.
Please email `vinay@canopyworks.com`.
