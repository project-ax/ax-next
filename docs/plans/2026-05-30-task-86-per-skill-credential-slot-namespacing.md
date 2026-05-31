# TASK-86 — per-skill credential-slot namespacing (fix skill-slot-collision lockout)

## Problem

Two ACTIVE authored skills that declare the SAME credential slot name (e.g. both
declare `LINEAR_API_KEY`) lock the user out of ALL chat: every turn terminates
with `skill-slot-collision` (runner exit 1). Root cause:
`packages/chat-orchestrator/src/orchestrator.ts` treats the **bare** credential
slot name as a GLOBAL namespace across all of a user's active skills
(`slotOwners` / `baseCreds`), so two skills wanting the same well-known
credential collide fatally — and the same fatal terminate fires when a skill's
slot collides with `agent.requiredCredentials` (the trusted base).

## Chosen approach (authoritative — from the card's `## Clarifications`)

**(a) Namespace credential slots PER-SKILL.** Scheme: `skill:<skillId>:<slot>`
for the runner/proxy credential map and the credential-binding ref. The runner
exposes the credential to the skill under the **bare env var name** (e.g.
`LINEAR_API_KEY`). The agent/trusted-credential collision is resolved by the same
namespacing — it must NO LONGER be a fatal terminate. Approach (b) (relevant-only
cap union) was rejected.

## Key architectural facts (verified in code)

1. The credential-proxy placeholder substitution is **value-based**: the proxy
   replaces `ax-cred:<hex>` tokens wherever they appear in egress, regardless of
   which env-var name carried them (`registry.ts` `replaceAll`). So the env-var
   NAME in the sandbox is just a vehicle for the placeholder; two distinct
   credentials need two distinct placeholders, which needs two distinct keys in
   the host-side credentials map handed to `proxy:open-session`.
2. `proxy:open-session.credentials` is `Record<envName,{ref,kind}>`; it returns
   `envMap: Record<envName, placeholder>`. The orchestrator threads `envMap` into
   `proxyConfig.envMap`, which BOTH sandbox backends stamp FLAT into the sandbox
   process env (`Object.assign(sessionEnv, proxyConfig.envMap)`).
3. Skills share ONE flat sandbox env — there is no per-skill process/env scope.
   So the bare env-var name a skill reads (`$LINEAR_API_KEY`) is inherently shared
   across skills. Two skills sharing a bare slot name can carry only ONE value in
   the flat env (last/precedence wins) — this is irreducible; the WIN of this
   change is no-lockout + each credential still reaching the proxy independently.
4. Per-skill credential STORAGE already exists: untagged slots use the
   `skill:<id>:<slot>` ref; `account:<svc>`-tagged slots share one vault entry
   (`applyCapabilityGrant`, `foldAuthoredSkillCaps`).
5. `buildGitCredentialEnv` (`@ax/sandbox-protocol`) wires git HTTP Basic auth
   per-skill-per-host from `envMap[slot]`. To keep per-skill git egress correct
   when two skills share a bare slot, git wiring must use the SKILL's OWN
   placeholder, not the flat-env winner.

## Design

### Namespacing rule
- **Agent/trusted base creds** (`agent.requiredCredentials` or the Anthropic
  default) keep their **bare** key in `baseCreds`/`slotOwners`. They are trusted,
  rotation keys off the bare name (`hasRefreshableKind`), and they always win the
  sandbox env stamp. They are NEVER namespaced.
- **Skill slots** (catalog attachments AND authored drafts) are keyed by
  `skill:<id>:<slot>` in the host-side credentials map. Two skills' same-named
  slots therefore never collide → no terminate.
- A skill slot whose **bare name** matches a trusted base name does NOT overwrite
  the trusted credential in the sandbox env (the trusted bare stamp wins). The
  skill's own namespaced credential still exists in the proxy map for the skill's
  own egress (e.g. git wiring), but it can't hijack the trusted env var. This
  preserves the old security guarantee as a benign no-op suppression, not a
  fatal lockout.

### Env-var name projection (host-side, orchestrator owns the scheme)
- `unionedCreds` → `proxy:open-session` with namespaced keys for skill slots.
- Proxy returns namespaced `envMap`. The orchestrator projects it to a
  **bare-keyed** env map for the FLAT sandbox env (`proxyConfig.envMap`):
  - trusted bare names win;
  - among skill slots sharing a bare name, a deterministic precedence wins
    (active-authored/first-attached first — same order the credentials loop runs),
    documented; the loser's bare stamp is dropped (its credential still reaches
    the proxy via its own placeholder + git wiring).
- Each `installedSkillsForSandbox[].credentials[]` entry carries the skill's
  resolved **placeholder** (opaque `ax-cred:<hex>`) so `buildGitCredentialEnv`
  wires per-skill git auth from the skill's OWN placeholder regardless of the
  flat-env winner. Back-compat: when absent, git wiring falls back to
  `envMap[slot]` (the pre-TASK-86 path).

## Tasks (independent, testable)

### T1 — pure namespacing helpers + collision removal (chat-orchestrator)
- Add `skillCredentialEnvName(skillId, slot) => 'skill:<id>:<slot>'` (single
  source of the scheme) + `projectEnvMapToBareNames(...)` (namespaced→bare,
  trusted-wins, deterministic skill precedence) as pure functions.
- Rewrite the catalog credential loop (orchestrator ~L1504-1542) and
  `foldAuthoredSkillCaps` (`authored-egress.ts`) so a skill slot is stored under
  its namespaced key and NEVER terminates on a bare-name clash. Keep the
  `skill-binding-missing` terminate (a real misconfig).
- `slotOwners` becomes namespaced-key-owned; the only fatal case removed is the
  bare-name collision. Trusted base stays bare.
- Update the two existing collision tests (orchestrator.test.ts ~L3185, ~L3243)
  to assert COEXISTENCE (turn succeeds, proxy:open-session called once with both
  creds present under namespaced keys) instead of terminate.
- **Regression test (card Acceptance):** two active authored skills declaring the
  same slot name → chat turns succeed, each resolves its own credential, no
  collision. (TDD: written first, RED before the fix.)

### T2 — thread placeholder to git-cred wiring (sandbox-protocol + backends)
- Extend `InstalledSkillSchema.credentials[]` with optional
  `placeholder: z.string().regex(ax-cred RE).optional()` (and the matching
  orchestrator `InstalledSkillForSandbox` type).
- `buildGitCredentialEnv`: prefer `credential.placeholder` (the skill's own),
  else `envMap[slot]` (back-compat). Re-validate placeholder shape (already does).
- Orchestrator stamps each skill's resolved placeholder onto
  `installedSkillsForSandbox[].credentials[]` from the namespaced `envMap`.
- Drift/golden tests for `buildGitCredentialEnv` updated; both backends pass the
  field through (subprocess + k8s) — verify no schema break.

### T3 — bare-env projection wired into proxyConfig (chat-orchestrator)
- After `proxy:open-session`, run `projectEnvMapToBareNames` and pass the
  bare-keyed map to `endpointToProxyConfig`. Add a test asserting the sandbox
  sees bare env names + the right placeholders, trusted-wins on a name clash.

### T4 — cap-skill scanner heuristic tuning (validator-skill)
- Narrow `CRED_EXFIL` so a skill that legitimately USES its own credential via
  `curl -H "Authorization: Bearer $X_API_KEY"` against an allowed host doesn't
  false-trip `credential-exfiltration`, while still catching real exfil (secret
  → webhook / external URL / "send … to https://"). Add tests for both the
  benign-use (now CLEAN) and true-exfil (still HIT) cases.

### T5 — scope pending cap-skill JIT card to the proposing conversation (chat-orchestrator)
- Track in-memory `pendingSkillConversation: Map<skillId, conversationId>` set in
  the `onSkillsProposed` subscriber (which has `ctx.conversationId`). When firing
  the upfront authored card (~L1947-1983), only fire a PENDING skill's card in its
  proposing conversation (active skills / catalog unaffected). Single-replica
  in-memory, same posture as `respawnSessions`/`upfrontCardsByConv`. Evict on
  resolve/conversation-delete. Test: pending skill proposed in conv A → card
  fires in A, not in unrelated conv B.

## Security review (filled in PR body)
- Sandbox: reshapes the host credential map keys + sandbox env-var projection.
  Trusted base bare names always win the env stamp (skill cannot hijack
  `ANTHROPIC_API_KEY`); namespaced keys (`skill:<id>:<slot>`) never become literal
  sandbox env vars (projected to validated bare names); each skill resolves only
  its own credential (per-skill ref → per-skill placeholder). git wiring uses the
  skill's own placeholder, re-validated `ax-cred:<hex>`.
- Injection: skill IDs (`^[a-z][a-z0-9-]{0,63}$`) + slot names
  (`^[A-Z][A-Z0-9_]{0,63}$`) are validated upstream; the composed namespaced key
  is structurally safe and is re-projected to a validated bare env name before any
  sandbox stamp.
- Supply chain: no new dependencies.

## Out of scope / follow-ups
- Per-skill SANDBOX env scoping (so two skills could each read a DIFFERENT value
  for the same bare name) — needs per-skill process/env isolation the runner
  doesn't have; not required for the no-lockout fix.
