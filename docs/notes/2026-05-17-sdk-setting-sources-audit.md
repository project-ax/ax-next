# SDK setting-source file audit (2026-05-17)

**SDK version:** `@anthropic-ai/claude-agent-sdk@0.2.119`
**Bundled CLI version:** `claude-code 2.1.119` (`@anthropic-ai/claude-agent-sdk-darwin-arm64@0.2.119`)
**Question:** With `settingSources: ['user', 'project']`, which files does the SDK read?

## TL;DR

The SDK option `settingSources` is forwarded verbatim to the bundled `claude` CLI as
`--setting-sources=user,project`. The CLI parses it into the internal tier set
`{userSettings, projectSettings}` (`xHq` function), and `policySettings` +
`flagSettings` are **always added** unconditionally (`Cu` function). `localSettings`
is **not enabled** unless `'local'` is passed.

For each tier the CLI looks up files via two helpers:

```text
fKH(tier)  → the *root directory* for that tier
hz(tier)   → the *settings.json file path* for that tier
```

with:

```text
fKH('userSettings')    = U6()                       // <CLAUDE_CONFIG_DIR> ?? ~/.claude
fKH('projectSettings') = K8()                       // originalCwd at process start
fKH('localSettings')   = K8()                       // same
hz('userSettings')     = <root>/settings.json       // e.g. ~/.claude/settings.json
hz('projectSettings')  = <root>/.claude/settings.json
hz('localSettings')    = <root>/.claude/settings.local.json
```

`CLAUDE.md` (memory) is loaded by a parallel resolver `BJH(memoryType)` and the
project loop walks upward from cwd to FS root, gathering one `CLAUDE.md` per
ancestor dir. Skills, agents, and commands are also discovered from both roots
(user dir + project ancestor walk) and gated on the same `fY('userSettings')` /
`fY('projectSettings')` checks.

The agent attack surface that matters is the **`'project'` source** because that
is the only root reachable from workspace writes the agent can author. The
`'user'` root (`<CLAUDE_CONFIG_DIR>`) lives outside the workspace tree; it is
populated by host code (via `runner-host-dist` symlink) and is not writable by
the sandbox.

## Method

1. Located the SDK→CLI handoff in `sdk.mjs` (line offsets 252670 + 280709 +
   254594): the SDK option `settingSources` is forwarded as
   `--setting-sources=${T.join(",")}` to a child process.

2. Identified the actual CLI binary at
   `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.2.119/…/claude`
   (213 MB Mach-O native binary embedding the Node-bundled CLI).

3. Ran `strings` on the binary, filtered for `^[A-Za-z_/.-]+$` to isolate
   file-basename / path constants, then drilled into call sites with `dd` to
   extract context around the minified function definitions (`xHq`, `fKH`,
   `hz`, `BJH`, `Cu`, `lM8`, `rM8`).

## Files loaded from `'user'` source (CLAUDE_CONFIG_DIR or ~/.claude)

`<USER_ROOT>` ≔ `process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")`
(resolved by `U6()`, identical to the wrapper resolver in `sdk.mjs:163742`).

| Path | Purpose | Loader | Required for skills? | Phase 0 stance |
|---|---|---|---|---|
| `<USER_ROOT>/settings.json` | User settings (tier `userSettings`) | `hz('userSettings')` | NO | Outside workspace — host populates via runner-host-dist symlink; agent cannot write |
| `<USER_ROOT>/skills/*/SKILL.md` | User-level skill discovery | `lM8` | YES | Allow — symlinked into HOME by sandbox-subprocess (Task 4) |
| `<USER_ROOT>/skills/SKILL.md` | Single-skill flat layout (same dir) | `DS7` (skill loader) | NO (alt layout) | Same as above |
| `<USER_ROOT>/CLAUDE.md` | User memory | `BJH('User')` | NO | Outside workspace — n/a |
| `<USER_ROOT>/rules/**` | User rules dir (memory-style) | `kB_()` + `h3H` | NO | Outside workspace — n/a |
| `<USER_ROOT>/agents/*.md` | User custom-agents | (`<U6()>/agents`) | NO | Outside workspace — n/a |
| `<USER_ROOT>/commands/*.md` | User slash-commands | (`<U6()>/commands`) | NO | Outside workspace — n/a |
| `<USER_ROOT>/.credentials.json` | User auth (always loaded, not gated by settingSources) | resume code path | NO | Outside workspace — n/a |
| `<USER_ROOT>/.claude.json` (note: under HOME, not under `.claude/`) | Legacy single-file user config (always loaded) | resume code path | NO | Outside workspace — n/a |

**Veto stance for the user root:** none of these paths are writable by an agent
authoring `FileChange[]` against the workspace bundle, so they are not part of
the veto list. They're listed here for completeness so the design doc has the
full surface.

## Files loaded from `'project'` source (cwd)

`<PROJECT_ROOT>` ≔ `K8()` = `originalCwd` at process start (= workspace
checkout, in our runner). For project memory the loader walks from cwd
**upward to FS root** (stopping at homedir or git-root); for project settings
it does NOT walk — only `K8()` itself.

| Path | Purpose | Loader | Required for skills? | Phase 0 stance |
|---|---|---|---|---|
| `<PROJECT_ROOT>/.claude/settings.json` | Project settings (tier `projectSettings`) | `hz('projectSettings')` | NO | **VETO** — agent writes to this can re-enable disabled tools, change permissions, register hooks |
| `<PROJECT_ROOT>/.claude/skills/<name>/SKILL.md` | Project-level skill discovery | `lM8` → `rM8('skills', cwd)` walks ancestors | YES | Allow — this is the only path the install workflow legitimately writes |
| `<PROJECT_ROOT>/.claude/agents/*.md` | Project custom-agents | walked the same way | NO | **VETO** — sub-agent definitions can carry tools/permissions; opt-in via skill install only if/when needed |
| `<PROJECT_ROOT>/.claude/commands/*.md` | Project slash-commands | walked the same way | NO | **VETO** — slash-commands are model-invokable prompts with embedded tool budgets |
| `<PROJECT_ROOT>/.claude/rules/**` | Project rules (memory-style) | `h3H` | NO | **VETO** — pulled into system prompt; pure prompt-injection vector |
| `<PROJECT_ROOT>/CLAUDE.md` (and every ancestor `<P>/CLAUDE.md`) | Project memory | `BJH('Project')` + ancestor walk | NO | **VETO** — pulled verbatim into the system prompt |
| `<PROJECT_ROOT>/.claude/CLAUDE.md` (and every ancestor) | Project memory (variant location) | same loop | NO | **VETO** — same reason |
| `<PROJECT_ROOT>/.claude/settings.local.json` | Tier `localSettings` (NOT loaded by us — needs `'local'` in settingSources) | `hz('localSettings')` | NO | **VETO defense-in-depth** — not live today, becomes live the moment anyone adds `'local'`; cheap to veto now |
| `<PROJECT_ROOT>/CLAUDE.local.md` (and every ancestor) | Tier `Local` memory (also gated on `localSettings`) | `BJH('Local')` | NO | **VETO defense-in-depth** — same as above |

**Always-on tiers (not gated by settingSources):**

- `policySettings` — loaded from system policy paths (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/managed-settings.json` on Linux, `/Library/Managed Preferences/com.anthropic.claudecode.plist` for MDM). Outside workspace; outside container; not in scope.
- `flagSettings` — only set if we pass `--settings <path>` CLI flag. We don't, so it resolves to nothing. n/a.
- `Managed` memory (`<system-policy-dir>/CLAUDE.md`) — outside workspace; n/a.

**Always-on side-effects from the user root (not gated):**

- `<USER_ROOT>/projects/<encoded-cwd>/<sessionId>.jsonl` — JSONL transcript mirror.
  Already covered by the workspace-Phase-B sync; the SDK *writes* here, the agent
  doesn't author it.
- `<USER_ROOT>/.credentials.json` — copied into a temp resume area at resume
  time. Not workspace-writable.

## Veto list for Task 2

Paths the `workspace:pre-apply` validator MUST reject when the change author is
anything other than `actor: 'host'`. Match against the file's path *relative to
project root*:

```text
.claude/settings.json
.claude/settings.local.json
.claude/agents/                  (entire directory)
.claude/commands/                (entire directory)
.claude/rules/                   (entire directory)
CLAUDE.md
CLAUDE.local.md
.claude/CLAUDE.md
```

**Plus** any `CLAUDE.md` or `CLAUDE.local.md` at any ancestor of the project
root within the workspace tree, if such writes are ever surfaced by the bundle
format. In practice the bundle is rooted at project root, so the ancestor walk
inside the bundle is bounded by the bundle root — i.e. only `<root>/CLAUDE.md`
and `<root>/CLAUDE.local.md` are reachable.

**Allowed (must NOT be vetoed):**

```text
.claude/skills/<name>/SKILL.md
.claude/skills/<name>/**         (skill body assets — scripts, references)
.claude/skills/SKILL.md          (flat single-skill layout, if we choose to support)
```

## Notes / unresolved

1. **The `Skill` tool itself.** This audit covers what files *get loaded* when
   `settingSources` is flipped. The actual `Skill` tool (the one the model
   invokes to enter a skill subprocess) is gated separately by the CLI — but
   skill *discovery* happens at startup based on `settingSources`. Once
   discovered, a skill is in the prompt index regardless of further gating.
   Phase 0 plan accounts for this.

2. **Ancestor-walk for project memory.** The `CLAUDE.md` loader walks upward
   from cwd until it hits the homedir or the FS root. In our runner the
   workspace root is the cwd and there is no parent `CLAUDE.md` outside the
   bundle, so the walk is bounded. **Caveat:** the walker stops at
   `os.homedir()` — if the workspace happens to be mounted under HOME (which
   it shouldn't, but is worth a sandbox-runtime invariant), the walk would
   leak into HOME. Worth a one-line assertion in the runner that
   `process.cwd()` is not under `os.homedir()`.

3. **`localSettings` defense-in-depth.** We are not enabling `'local'`, so
   `.claude/settings.local.json` is not currently read. Vetoing it anyway is
   cheap and protects future-us from regression if someone widens
   `settingSources`.

4. **`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` env var.** Setting this
   env var causes the CLI to load `CLAUDE.md` from extra dirs. The runner
   MUST NOT set it. Worth a one-line invariant in the runner config code
   that scrubs `CLAUDE_CODE_*` env vars except the ones we explicitly opt
   into.

5. **`.git/hooks` and friends.** Strings includes `/.git/hooks` and the
   sandbox-permission-list builder adds `<cwd>/.git/hooks` to its read-allow
   list. That's a separate path entirely (not under `.claude/`) and not
   covered by `settingSources`. Worth flagging for the broader workspace
   security model: an agent that can write to `.git/hooks/post-commit`
   gets code-exec on the next commit. **This is out of scope for Task 2 (the
   SDK-config-file veto)** but should be tracked separately in the
   workspace-security backlog.

6. **`marketplace.json` and `.claude-plugin/`.** Strings include
   `.claude-plugin/marketplace.json`, `installed_plugins.json`,
   `flagged-plugins.json`. These are part of the plugin system, which is
   off in our config and not enabled by `settingSources`. Not in scope for
   Phase 0.

## Confidence levels

- **HIGH confidence** that the veto list covers everything `settingSources:
  ['user', 'project']` exposes as agent-writable: settings files, memory
  files, sub-agents/commands/rules directories. These are the only
  workspace-rooted paths the CLI reads based on the tier gates.

- **MEDIUM confidence** on `localSettings` being fully isolated when `'local'`
  is absent — I verified `xHq` doesn't add `localSettings` unless `'local'`
  is in the input, and `fY('localSettings')` gates all loaders. Defense-in-
  depth veto recommended regardless.

- **LOW confidence** on whether any *other* code path in the binary reads
  files from `<cwd>/.claude/` outside the settings/memory/skill systems
  surveyed here. The binary is 213 MB; I scanned for filename constants but
  did not exhaustively trace every `readFile` callsite. The categories
  covered (settings tiers + memory + skills + agents + commands + rules)
  match the documented `claude-code` config model, so I'm confident the
  surface is captured, but a paranoid follow-up would add an integration
  test that strace's the runner subprocess to confirm no other workspace
  reads occur during startup.
