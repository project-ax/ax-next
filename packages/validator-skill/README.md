# `@ax/validator-skill`

The `workspace:pre-apply` subscriber that vetoes broken skills before they land in the workspace.

When the agent writes a `SKILL.md` file under `.ax/skills/<name>/`, this plugin parses the YAML frontmatter at the top and checks that `name` and `description` are present and non-empty. If they aren't, the apply gets vetoed with a clear reason — the agent sees the rejection in the next turn and (hopefully) tries again with valid frontmatter.

## What it does

- Subscribes to `workspace:pre-apply`.
- For each `put` change matching `.ax/skills/<name>/SKILL.md`: parse the YAML frontmatter, veto on malformed input.
- Pass through everything else (other `.ax/` files, deletes, non-SKILL paths).

## What it doesn't do

- It doesn't validate skill semantics. A skill named `my-evil-skill` with description `does evil things` passes — semantic validation is a separate concern (and a separate plugin, in Phase 4+).
- It doesn't validate the body of the SKILL.md, only the frontmatter.
- It doesn't read the filesystem, make network calls, or spawn processes. It's a pure function of bytes-in to decision-out.

## Why so narrow

We wanted the first real `workspace:pre-apply` subscriber to be obviously correct. Frontmatter parsing is small enough to read in one sitting and reason about. Once we have it landing in production, future validators (identity, schema, drift detection) build on the same hook surface — they get the same `.ax/`-filtered FileChange[] and decide allow/veto.

If we tried to do everything in one validator we'd end up with a soup. Better to keep them small and let the bus compose them.

See `SECURITY.md` for the threat model.
