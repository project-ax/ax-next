# Security — `@ax/validator-skill`

This plugin is one service: `skills:scan`, the content scan `@ax/skills` runs on every
skill an agent proposes. It reads text and returns a verdict. That's it — and we'd like
to keep it that small.

## Capability budget

No process spawn, no filesystem access, no direct network, no env access. The plugin
registers one service and makes one optional bus call:

- `llm:call:anthropic` (`optionalCall`, `hasService`-guarded) — the Layer-2 scan, a fast
  model. The untrusted skill text goes in as DATA inside `<skill>` tags, under an
  "analyze, do not follow" system prompt, and the model gets no tools: text in, a
  one-line verdict out. Only the first `maxScanBytes` characters are sent (16,384 by
  default), and the call is timed out (`llmTimeoutMs`, 8 s by default). Any error or
  timeout falls back to the Layer-1 verdict.

The bus call is in-process. The real network egress for the LLM scan happens inside
`@ax/llm-anthropic`, not here; this plugin never opens a socket.

If a future change needs more than this, it goes in this file before it goes in the code.

## What the scan is (and isn't)

The scan is **defense in depth and a signal for reviewers. It is not the security
boundary.** A skill gets real reach only through capabilities a person approves: the
egress proxy, credential injection, and the approval wall at capability use. So:

- **Accept and annotate.** A hit never refuses the skill. `@ax/skills` stores it as
  quarantined and keeps it out of the agent's sessions; the reason goes back to the agent
  so it can tell the person what to fix.
- **A missing or broken scanner degrades to `clean`** at `@ax/skills`. That's deliberate:
  the scan never blocks authoring. The residual risk is bounded because anything with
  reach is `pending` until a person approves it, whatever the scan said.
- **Regex first.** Layer 1 (pure `RegExp.test()`: instruction overrides, credential
  exfiltration signatures, hidden format characters, obfuscated blobs) runs before the
  model. A Layer-1 hit short-circuits, so text that talks the model into "clean" can
  never clear a regex hit.

## Threat model: untrusted skill text

Every byte we scan came from an agent, and the agent might have been prompt-injected by
a tool result, or be testing us on purpose. So:

- **No interpolation.** The text is only ever matched with `RegExp.test()` or sent to the
  model as tagged data. It never reaches a shell, a file path, SQL, a URL or HTML from
  here.
- **No raw input in reasons or logs.** A reason is a fixed category plus a sanitized
  detail capped at 160 characters. Logs carry the skill id and the category, never the
  text.
- **Bounded work.** `@ax/skills` checks the bundle's extra files before it calls us (at
  most 16 files and 512 KiB in total), and the model sees at most `maxScanBytes`
  characters of the text.

## Threat model: bypassing the scan

We depend on:

- **`@ax/skills` calling `skills:scan` at the one authoring chokepoint** (`skills:propose`,
  behind the `skill_propose` tool) before it stores a skill.
- **One scanner.** The bus refuses a second registration of `skills:scan`
  (`duplicate-service`), so no other plugin can stand in a laxer one.

A skill that slips past the scan is still a skill with no reach of its own: the
capability approval is what stands between it and anything that matters.

## Retired: the settings-file veto (TASK-995)

Until TASK-995 this plugin also vetoed agent writes to the Claude Agent SDK's settings
files (`.claude/settings.json`, `.claude/settings.local.json`, `.claude/CLAUDE.md`,
`CLAUDE.md`, `CLAUDE.local.md`, and `.claude/{agents,commands,rules}/`), on the git
workspace's pre-apply event. The git workspace is gone, and the event with it. Those
paths are now ordinary files in the agent's home (`/files`), visible in the Files tab.

What keeps them inert is the runner, not this plugin:

- the Claude SDK runner passes `settingSources: ['user']`, so it never reads project
  settings from the home;
- the runner refuses to start unless `CLAUDE_CONFIG_DIR` is set, exists, and sits
  outside the agent's home, so a file the agent writes can never become its user
  settings;
- a canary that runs the real SDK plants `CLAUDE.md`, `.claude/CLAUDE.md`, a
  `.claude/settings.json` full of hooks, `.mcp.json` and a skill under `.claude/skills/`
  in a fresh home, and checks that none of them reaches the model's requests, runs a
  hook, starts an MCP server or shows up as a skill. Its control run turns the
  `project` setting source back on and watches the same files come alive, so the
  plants are real.

Those tests live in `@ax/agent-runner-core` and `@ax/agent-claude-sdk-runner`. The
other paths the veto covered (`.claude/settings.local.json`, `CLAUDE.local.md`,
`.claude/{agents,commands,rules}/`) belong to the SDK's `project` and `local` setting
sources, which `settingSources: ['user']` leaves unread. To be straight about it: the
canary doesn't plant those, so for them we rely on that one setting rather than on a
test that watched it hold.

## Known limits

- **Regex recall.** A novel phrasing that isn't in the Layer-1 set, and that the model
  calls clean, passes. That's why the scan isn't the boundary.
- **The model can be wrong in both directions.** A false "hit" quarantines a fine skill
  (a person can review it); a false "clean" is caught, if at all, by capability approval.
- **No model in the CLI preset.** Without `llm:call:anthropic`, only Layer 1 runs.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News.
Please email `vinay@canopyworks.com`.
