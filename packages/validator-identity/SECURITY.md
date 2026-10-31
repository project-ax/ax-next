# Security — `@ax/validator-identity`

This plugin has one job, and it's about text that ends up **verbatim in an agent's
system prompt**: **`identity:scan`** (TASK-989), a service `@ax/agents` calls before it
saves an agent's identity, soul or Instructions. That text is frozen into the session
config when a runner starts and composed into the system prompt word for word.

We're a regex scanner with one service — that's it.

Text placed verbatim in the system prompt is a modification of the agent's own rules. So
an injection signature is a HARD refusal (not the accept-but-annotate posture
`validator-skill` uses for skill bodies — a quarantined skill is inert until promoted,
but identity text goes live next turn).

## Capability budget

The validator performs NO process spawn, NO filesystem I/O, NO network, NO env access,
and makes NO bus calls. It registers one service and subscribes to nothing.

- **Registers `identity:scan` (pure, no I/O).** Takes `{ text, kind? }`, returns a
  verdict. It reads or writes nothing; its only side effect is an `identity_scan_refused`
  log line carrying the category.

## `identity:scan` — the write-time check

### What it checks

In this order; the first failure decides:

1. **Size.** More than 262,144 UTF-8 bytes (256 KiB) → `too-large`. It runs first, so the
   regexes never walk an oversized text.
2. **Well-formedness.** A lone UTF-16 surrogate → `not-well-formed`. A JS string cannot
   hold invalid UTF-8 bytes; a lone surrogate is its equivalent. It has no UTF-8
   encoding, and the encoders quietly swap in U+FFFD, so what got stored would not be
   what was scanned.
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
refusal; anything else as "the safety check isn't available"). "The scanner is down"
never means "everything passes".

### No text in reasons or logs

`reason` is a fixed sentence of at most 160 characters naming the category — never a
quote of the text. The log line carries the category only. The text may be someone's
private Instructions as well as an attack payload, and neither belongs in a log.

Worst-case test: a soul containing `"; rm -rf ~; echo "` → `regexScan` runs `.test()` on
it (no execution), finds no signature for that exact string, and the text is saved as
**inert prompt prose**. The runner composes it into the system prompt, never into a shell
command, path or HTML.

## The regex set is copied, not imported

The Layer-1 regex set is a deliberate **copy** of `@ax/validator-skill`'s `regexScan`
(Invariant #2 forbids the cross-plugin runtime import). Layer 2 (the soft LLM scan) is
intentionally omitted: identity text is small, and the regex wall is the proportionate
gate. If the two regex sets drift, reconcile them. The regex scan is high-signal but not
exhaustive — it is a gate, not a guarantee.

## Threat model: bypassing the validator

We're one service. We depend on:

- **`@ax/agents` calling `identity:scan` on every identity, soul and Instructions write.**
  It is the only store of that text (Invariant 4), and every writer — the agent's
  `update_identity` tool and the people-facing routes — goes through
  `agents:identity:set`. A write path that skipped it would skip this scan.
- **One scanner.** The bus refuses a second registration of `identity:scan`
  (`duplicate-service`), so no other plugin can stand in a laxer scanner.
- The runner's **non-editable** safety floor, placed ahead of identity, soul and
  Instructions in every normal-mode prompt. The scan gates what reaches those sections;
  the floor is the backstop the agent (and a bypass of this validator) cannot remove.
- **The runner composing identity from the session config, and only from there.** An
  agent can still write a file called `SOUL.md` (or `IDENTITY.md`, `AGENTS.md`,
  `BOOTSTRAP.md`) anywhere in its home; that is an ordinary file nobody reads. The
  runner's agent-files canary plants one in a fresh home and checks it never reaches the
  prompt.

If those break, the failure is louder than this plugin can compensate for.

## Retired: the identity-file gate (TASK-995)

Until TASK-995 the plugin had a second job: a veto on the git workspace's pre-apply
event for the agent's writes to its identity files. It read a bootstrap window back from
the workspace (through an optional workspace read), hard-vetoed any bootstrap script
that wasn't byte-identical to the canonical template, hard-vetoed identity files that
weren't strict UTF-8 or carried an injection signature, and logged every post-bootstrap
self-edit. That gate made sense while the runner put those files into the system prompt
verbatim. Since TASK-989 the runner composes identity from the session config instead,
and TASK-995 removed the git workspace and its events, so the gate (and its read of the
workspace) is gone. Its replacement is the first bullet of the list above plus this
service: identity is DB rows written only through `agents:identity:set`, which runs this
scan and fails closed.

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

## Security review

- Sandbox: No reachable capability. Registers `identity:scan` (pure: no bus call, no spawn / FS / network / env). Subscribes to nothing, calls nothing. TASK-995 removed the git workspace pre-apply gate and its one optional workspace read, which shrinks the plugin's reach to the service alone.
- Injection: The untrusted input is identity, soul and Instructions text (agent- or person-written, through `identity:scan`). It is size-capped, checked for lone surrogates and run through pure `RegExp.test()`; it is never interpolated into shell/SQL/URL/HTML or concatenated into a prompt by this plugin. Reasons and logs carry only a scan category, never the input. A recognized signature is a hard refusal; `@ax/agents` fails closed when the scanner is missing, throws or answers anything but `clean`.
- Supply chain: No third-party dependency. At runtime the plugin imports only the workspace package `@ax/core`, plus the standard pinned dev-deps (`typescript`, `vitest`, `@types/node`) every package already uses.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News.
Please email `vinay@canopyworks.com`.
