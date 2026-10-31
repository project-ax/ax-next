# @ax/validator-identity

One job, one small regex scanner: **`identity:scan`**, the write-time check on an
agent's identity, soul and Instructions. `@ax/agents` calls it on every write, whether
the agent or a person made it.

## `identity:scan` — the write-time check

`@ax/agents` stores an agent's identity, its soul and its people's Instructions. When a
runner starts, they are frozen into its session config and placed **verbatim into the
system prompt**. Text that lands there unchecked is a way to rewrite the agent's rules,
so every write gets checked first.

- **Input:** `{ text: string, kind?: 'self-description' | 'instructions' }`, one
  section's text and what it is. `kind` defaults to `'self-description'` (an agent's
  identity or soul). Anything that isn't an object with a string `text`, or that names
  any other `kind`, throws a `PluginError` with code `invalid-payload`.
- **Output:** `{ verdict: 'clean' }`, or `{ verdict: 'refused', category, reason }`.
  `reason` is a fixed sentence of at most 160 characters that names the category. It
  never quotes the text.

The checks run in this order, and the first one that fails decides:

| # | Check | `category` |
|---|---|---|
| 1 | More than 262,144 UTF-8 bytes (256 KiB) | `too-large` |
| 2 | A lone UTF-16 surrogate, so the text has no valid UTF-8 encoding | `not-well-formed` |
| 3 | An injection signature from the Layer-1 regex set | `instruction-override`, `credential-exfiltration` or `obfuscation` |

Size goes first, so the regexes never run over an oversized text.

**`kind: 'instructions'`** (people's Instructions, which `@ax/agents` sends) runs every
check above except one: the weak "egress verb near a secret word" heuristic. People write
instructions like "Send my weekly report to my secretary" or "Never post passwords in a
chat", and that heuristic refused them all. Instruction overrides, the strong
exfiltration signatures (a secret sent as request data, or to a URL or webhook),
obfuscation, hidden characters, lone surrogates and the size cap all still apply. The
identity and the soul keep the full check.

A refusal is an answer, not an error. `@ax/agents` saves the text only when the answer
is exactly `{ verdict: 'clean' }`; anything else means nothing is saved. A missing or
throwing scanner means nothing is saved either: `@ax/agents` fails closed. The service is
pure (no I/O, no bus calls) and logs `identity_scan_refused` with the category only,
never the text.

## Retired: the identity-file gate (TASK-995)

This plugin started life guarding markdown files: the agent's identity, soul and
bootstrap script, which the runner once read out of the agent's git workspace and put in
the system prompt word for word. It vetoed risky writes to them, with a bootstrap window
and a byte-exact check on the bootstrap script. Since TASK-989 identity lives in
`@ax/agents` and the runner no longer reads those files; TASK-995 removed the git
workspace, and the gate went with it. A file by one of those names in the agent's home is
an ordinary file now, and the runner's agent-files canary plants one to prove it changes
nothing. See [SECURITY.md](./SECURITY.md).

## Capabilities

Registers `identity:scan` (pure, no I/O). No calls, no subscriptions, no process spawn,
no filesystem I/O, no network, no env access. See [SECURITY.md](./SECURITY.md) for the
three-threat-model walk.

## Wiring

Loaded in both the CLI preset (`@ax/cli`) and the k8s preset (`@ax/preset-k8s`, which
`@ax/preset-memory` builds on). `@ax/agents` calls `identity:scan` (declared as an
`optionalCall`, failing closed without it), and the `@ax/preset-memory` canary drives it
through the real assembly. It is a leaf plugin — nothing imports it at runtime except the
presets.
