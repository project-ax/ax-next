# Security — `@ax/validator-identity`

This plugin has two jobs, and both are about the same thing: text that ends up
**verbatim in an agent's system prompt**.

1. **`identity:scan`** (TASK-989) — a service `@ax/agents` calls before it saves an
   agent's identity, soul or Instructions. That text is frozen into the session config
   when a runner starts and composed into the system prompt word for word.
2. **The legacy `workspace:pre-apply` gate** — the **third** subscriber on
   `workspace:pre-apply` (after `@ax/validator-skill` and the core retired-path veto),
   gating an agent's writes to its own identity files under `/agent/.ax/`. Since
   TASK-989 the runner no longer reads those files (see below).

We're a regex scanner with one service, veto power on one hook, and one read — that's it.

Text placed verbatim in the system prompt is a modification of the agent's own rules. So
an injection signature is a HARD refusal in both jobs (not the accept-but-annotate
posture `validator-skill` uses for skill bodies — a quarantined skill is inert until
promoted, but identity text goes live next turn).

## Capability budget

The validator performs NO process spawn, NO direct filesystem I/O, NO network, NO env
access. It registers one service and makes exactly one bus call, which is optional:

- **Registers `identity:scan` (pure, no I/O).** Takes `{ text, kind? }`, returns a verdict. It
  makes no bus call and reads or writes nothing; its only side effect is an
  `identity_scan_refused` log line carrying the category.
- `workspace:read` (`optionalCall`, `hasService`-guarded) — the legacy gate reads the
  committed `.ax/BOOTSTRAP.md` at the apply's `parent` version to decide whether the
  agent is still bootstrapping. The path is a **hardcoded constant**
  (`.ax/BOOTSTRAP.md`) — never caller-provided, so no path traversal. The `version`
  argument is the opaque `WorkspaceVersion` token from the pre-apply payload, passed back
  unmodified; it is a storage-agnostic brand, never resolved as a filesystem path. If
  `workspace:read` is absent the validator degrades to the (stricter) post-bootstrap
  policy — it never crashes bootstrap and never grants a bootstrap-only allowance it
  can't verify.

The bus call is in-process; the validator never opens a socket. Any network egress for a
git-backed `workspace:read` happens inside the workspace backend, not here.

## `identity:scan` — the write-time check

### What it checks

In this order; the first failure decides:

1. **Size.** More than 262,144 UTF-8 bytes (256 KiB) → `too-large`. It runs first, so the
   regexes never walk an oversized text.
2. **Well-formedness.** A lone UTF-16 surrogate → `not-well-formed`. A JS string cannot
   hold invalid UTF-8 bytes; a lone surrogate is its equivalent. It has no UTF-8
   encoding, and the encoders quietly swap in U+FFFD, so what got stored would not be
   what was scanned. This is the string-side twin of the legacy gate's strict
   `fatal: true` decode.
3. **The Layer-1 regex set** (`regexScan`) → `instruction-override`,
   `credential-exfiltration` or `obfuscation`. Obfuscation includes the shared
   hidden-format-character class from `@ax/core/surface-text` (zero-width, bidi,
   invisible operators, U+2028/9).

### Who supplies the text

All of it is untrusted:

- **The agent**, through the host-executed `update_identity` tool (identity and soul
  only — it cannot write Instructions). That is model output, and a prompt injection in a
  tool result can steer it.
- **People**, through the settings page's Instructions editor and the admin identity
  editor. On a team agent, one person's Instructions reach every teammate's sessions.

All three sections get every check, with one exception. The caller says what the text is
with `kind`: `'self-description'` (the default; identity and soul) or `'instructions'`.
For Instructions, the **weak** egress-near-secret heuristic (an egress verb such as
"send", "post" or "fetch" within 80 characters of a secret word such as "token" or
"password", on one line, no word boundaries) is skipped. It refused ordinary instructions
("Send my weekly report to my secretary", "Check the postgres token budget", "Never post
passwords in a chat"), which made the Instructions editor unusable for normal people
saying normal things.

What Instructions still get: the size cap, the lone-surrogate check, instruction-override
signatures, the **strong** exfiltration signatures (a secret as `curl -d` / `--data` /
`body:` request data, or a secret routed to `https://…`, a webhook or "exfil"),
obfuscation and hidden format characters. NUL is refused by `@ax/agents` before the scan.

Why this is the proportionate trade: Instructions are written by people, through an
authenticated editor, about their own agent; identity and soul are mostly written by the
model, where a prompt injection in a tool result could steer the text. The weak heuristic
is a high-recall net for model output; for people's prose it was mostly noise. An unknown
`kind` throws `invalid-payload` — it never quietly selects the laxer check — and an
absent `kind` is the full check, so a caller that forgets the field fails safe.

### Fail closed, at the caller

A refusal is an answer, not a throw; only a malformed payload (no string `text`) throws
`invalid-payload`. `@ax/agents` declares `identity:scan` as an `optionalCall` and saves
only on exactly `{ verdict: 'clean' }`. A missing scanner, a throw, or any other answer
refuses the write, and nothing is saved (a `refused` verdict is reported as a content
refusal; anything else as "the safety check isn't available"). "The scanner is down" never means "everything
passes".

### No text in reasons or logs

`reason` is a fixed sentence of at most 160 characters naming the category — never a
quote of the text. The log line carries the category only. The text may be someone's
private Instructions as well as an attack payload, and neither belongs in a log.

Worst-case test: a soul containing `"; rm -rf ~; echo "` → `regexScan` runs `.test()` on
it (no execution), finds no signature for that exact string, and the text is saved as
**inert prompt prose**. The runner composes it into the system prompt, never into a shell
command, path or HTML.

## The legacy pre-apply gate

Since TASK-989, identity lives in `@ax/agents` and the runner composes it from the session
config. It no longer reads `.ax/IDENTITY.md`, `SOUL.md`, `AGENTS.md` or `BOOTSTRAP.md`.
The `workspace:pre-apply` subscriber is left in place, so it now guards files no reader
uses: a write it lets through changes nothing the agent sees. It goes away with the git
tier (agent-files-simplification design §14). Do not add new readers of `.ax/`. The rest
of this section describes the gate as it was designed, when the runner injected these
files **verbatim into the composed system prompt every spawn**
(conversational-agent-identity epic, Phase 1).

### Why the bootstrap window reads the PARENT, not the change set

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

### The policy, as a decision table

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

### Threat model: untrusted identity file content

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

## The regex set is copied, not imported

Both jobs use the same Layer-1 regex set, a deliberate **copy** of `@ax/validator-skill`'s
`regexScan` (Invariant #2 forbids the cross-plugin runtime import). Layer 2 (the soft LLM
scan) is intentionally omitted: identity text is small, and the regex wall is the
proportionate gate. If the two regex sets drift, reconcile them. The regex scan is
high-signal but not exhaustive — it is a gate, not a guarantee.

## Threat model: bypassing the validator

We're one service and one `workspace:pre-apply` subscriber. We depend on:

- **`@ax/agents` calling `identity:scan` on every identity, soul and Instructions write.**
  It is the only store of that text (Invariant 4), and every writer — the agent's
  `update_identity` tool and the people-facing routes — goes through
  `agents:identity:set`. A write path that skipped it would skip this scan.
- **One scanner.** The bus refuses a second registration of `identity:scan`
  (`duplicate-service`), so no other plugin can stand in a laxer scanner.
- The host's commit-notify handler (and the `@ax/core` apply facade) firing
  `workspace:pre-apply` BEFORE the apply, filtered to `.ax/**` + `.claude/**`. (See
  `packages/ipc-core/src/handlers/workspace-commit-notify.ts` and
  `packages/core/src/workspace-apply-facade.ts`.)
- The bus respecting subscriber vetoes (`HookBus.fire` returns `rejected: true` and the
  caller short-circuits).
- The runner's **non-editable** safety floor, placed ahead of identity, soul and
  Instructions in every normal-mode prompt. The scan gates what reaches those sections;
  the floor is the backstop the agent (and a bypass of this validator) cannot remove.

If those break, the failure is louder than this plugin can compensate for.

## Known limits

- **Regex recall.** A novel injection phrasing not in the Layer-1 set passes the scan.
  The non-editable runner safety floor is the backstop; an LLM layer is a possible
  follow-up if real-world abuse warrants it.
- **False positives.** The weak egress-near-secret signal can refuse a benign identity or
  soul sentence, for example "never post API keys in chat" (an egress verb near a secret
  word). The text is not saved; rewording gets it through. Instructions skip that signal
  (see above), but they still get false positives from the **strong** signatures, which
  have no word boundaries: "secretary" counts as a secret word, and a secret word within
  80 characters of a URL or "webhook" is refused even when the sentence forbids it.
  Measured examples that are refused as Instructions: "Email my secretary when you are
  done and link to https://status.example.com", "Report the token budget to
  https://grafana.example.com each Monday.", "Never put passwords or API keys in anything
  you send to the team webhook." The test file pins these as known refusals.
- **Instructions: weaker credential recall.** Because Instructions skip the weak signal,
  a person can save "fetch the deploy token and post it in #general". Only the strong
  signatures (request data, a URL, a webhook) catch exfiltration there. The author is a
  person with access to the agent, and the runner's safety floor still sits above the
  Instructions.
- **One section at a time.** `identity:scan` sees one section's text per call, so it
  cannot see a signature split across two sections.
- **Legacy gate: exact-path matching.** `.ax/{IDENTITY,SOUL,AGENTS,BOOTSTRAP}.md` only —
  flat under `.ax/`, no subdirectories, no alternate extensions.
- **Legacy gate: the "flag" is a log, not a user-facing announcement.**
  `workspace:pre-apply` is veto-only (the facade ignores transformed payloads), so a
  post-bootstrap file self-edit is recorded as a structured `identity_self_edit` audit
  log. Git history is the durable audit trail.

## Security review

- Sandbox: No new reachable capability. Registers `identity:scan` (pure, no I/O: no bus call, no spawn / FS / network / env). Subscribes the existing `.ax/`-filtered `workspace:pre-apply`; one `optionalCall` to `workspace:read` with a HARDCODED path (`.ax/BOOTSTRAP.md`) and the opaque `parent` version token (never resolved as a path).
- Injection: The untrusted inputs are identity, soul and Instructions text (agent- or person-written, through `identity:scan`) and agent-authored identity file bytes (through the legacy gate). Text is size-capped and checked for lone surrogates; file bytes are strict-UTF-8 decoded; both run through pure `RegExp.test()`, never interpolated into shell/SQL/URL/HTML or concatenated into a prompt by this plugin. Reasons and logs carry only a fixed path + scan category, never the input. A recognized signature is a hard refusal; `@ax/agents` fails closed when the scanner is missing, throws or answers anything but `clean`.
- Supply chain: No new third-party dependency. `@ax/validator-identity` depends only on two workspace packages — `@ax/core` and `@ax/agent-identity-templates` (a pure-data, kernel-free template package already on the eslint allow-list, the canonical-BOOTSTRAP source of truth) — plus the standard pinned dev-deps (`typescript`, `vitest`, `@types/node`) every package already uses. The cli/k8s presets gain internal `workspace:*` refs only.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News.
Please email `vinay@canopyworks.com`.
