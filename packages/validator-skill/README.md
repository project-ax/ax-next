# `@ax/validator-skill`

The safety scan for skills an agent writes.

When an agent proposes a skill (the `skill_propose` tool), `@ax/skills` hands the whole
bundle's text to `skills:scan` before it stores anything. This plugin answers with a
verdict: `clean`, or `hit` plus a short reason. A hit doesn't throw the skill away. The
skill is stored but **quarantined**, so it isn't loaded into the agent's sessions.

## What it does

- Registers the `skills:scan` service.
- Scans the SKILL.md frontmatter, the body and every extra file's contents, all joined
  into one text, so an injection tucked into a helper script is caught too.
- **Layer 1** is a small set of regexes for the obvious signatures: instruction
  overrides ("ignore all previous instructions"), a secret headed somewhere it
  shouldn't go, and hidden or obfuscated text.
- **Layer 2** asks a fast model, but only when Layer 1 found nothing and
  `llm:call:anthropic` is loaded. If the model is missing, slow or broken, the scan falls
  back to the Layer-1 verdict. It never blocks authoring.

## What it doesn't do

- It doesn't refuse anything. Accept-and-annotate: the verdict goes back to
  `@ax/skills`, which decides what a quarantine means.
- It isn't the security boundary. A skill only gets real reach through the capabilities
  a person approves (the egress proxy, credential injection, the approval wall). The scan
  is defense in depth and a signal for the people reviewing skills.
- It doesn't read the filesystem, open sockets or spawn processes.

It used to guard one more door: a veto on agent writes to Claude Agent SDK settings
files (`.claude/settings.json`, `CLAUDE.md` and friends) in the agent's git workspace.
That workspace is gone (TASK-995). Those files are now ordinary files in the agent's
home, and the runner never loads them as settings. See `SECURITY.md`.

See `SECURITY.md` for the threat model.
