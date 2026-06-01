---
name: ax-skill-creator
description: >-
  Use when the user wants to create, author, build, or modify a skill — e.g.
  "make a skill for Linear", "turn this workflow into a skill", "teach the
  assistant how to do X". Writes the know-how and references the connector it
  needs.
---

# Authoring a skill for this assistant

A skill is **know-how** — a small folder of instructions you write into your
workspace and then propose for the user. Once it's available, it becomes a
behavior you can reach for on later turns — a fixed workflow, a way of querying
an API you already have access to, a report you produce — without re-deriving it
each time.

Here's the important distinction. A skill is *not* the access to a service. The
access — the hosts it talks to, the key it spends, the binary it runs — is a
separate first-class thing called a **connector**. A skill **references** the
connectors it uses; it never contains them. "How we triage our Linear issues" is
a skill; the Linear API host + key is its connector.

So a skill's two parts are: the **content** (a `SKILL.md` body + any helper
files) and a **list of the connectors it relies on**. That's it. No hosts, no
keys, no packages live in a skill anymore — those live on the connector.

## The flow

1. **Understand the know-how** — what should the skill let you do, when should it
   trigger, what's the output.
2. **Make sure the connector exists** — if the skill needs to reach a service,
   there must be a connector for it (see "Ensure the connector" below).
3. **Write the bundle** into `/ephemeral/skill-draft/<id>/SKILL.md` (plus any
   helper files), referencing the connector(s) by id.
4. **Propose it** by calling `skill_propose({ path })`. A skill that needs no
   access becomes available on the user's next message; anything else is held for
   their approval.

## Step 1 — Capture the know-how

Get clear on the behavior before writing. Often the conversation already contains
it — the user just walked you through a workflow and said "make that a skill."
Pull the details from the history (the steps in order, the corrections, the
output they wanted) rather than re-interrogating.

Figure out:

- **What should this skill let you do?** The concrete behavior.
- **When should it trigger?** The phrasings and contexts a user would actually
  say. This becomes the description — the thing that decides whether the skill
  gets used at all.
- **What's the expected output?** A report, a file, a list, a side effect.
- **Does it need to reach a service?** If yes, that reach is a *connector* — not
  part of this skill. Handle it in Step 2.

Confirm your understanding before writing — "here's what I'll build" beats
writing the wrong thing.

## Step 2 — Ensure the connector exists

If the skill needs to reach a service (an API, a CLI tool, an MCP server), it
needs a **connector** for that access. The skill will just name the connector;
the connector carries the hosts, key, and packages.

So before writing a skill that reaches a service:

1. **Check whether a connector already exists** for that service.
2. **If it doesn't, create one first** — author it with the
   **`ax-connector-creator`** skill (it drives the connect-and-approve flow:
   capture which hosts/key/packages/MCP, install with one approval card). Once
   the connector is connected, note its `connectorId`.
3. **Then write the skill** referencing that connector id.

(You compose these by *using* the connector-creator skill in the conversation —
not by importing anything. Each is its own thing; the skill just names the
connector it depends on.)

If the skill is pure behavior with no external reach — a writing style, a
formatting routine, a fixed analysis over content the user provides — it needs no
connector at all. Skip straight to writing it.

## Step 3 — Write the SKILL.md

### Anatomy

A skill is a directory under `/ephemeral/skill-draft/<id>/`. The only required
file is `SKILL.md`:

```
/ephemeral/skill-draft/my-skill/
├── SKILL.md          (required: YAML frontmatter + markdown body)
└── (optional helper files: scripts, reference docs, templates)
```

`SKILL.md` is YAML frontmatter, then a markdown body.

### Frontmatter

The frontmatter declares the skill's identity and which connectors it uses:

```yaml
---
name: linear-triage          # lowercase slug, /^[a-z][a-z0-9-]{0,63}$/
description: <one line — what it does + when to use it>
version: 1                   # a non-negative integer (not a semver string)
connectors: [linear]         # the connector ids this skill uses; omit if none
---
```

- **`name`** — a lowercase slug, not an "id". Max 64 chars.
- **`description`** — the single most important field; it's the primary trigger
  (more below). **≤ 240 characters** — a hard limit; the proposal is rejected
  above it.
- **`version`** — a non-negative integer.
- **`connectors`** — the list of connector ids the skill relies on (from Step 2).
  A flat list of lowercase slugs. Omit it (or leave it empty) for a skill that
  needs no external access.

**Do not put a `capabilities:` block in the frontmatter.** Hosts, credential
slots, packages, and MCP servers do **not** belong in a skill — they live on the
connector. A skill only *references* connectors by id. (This is the connectors-
first-class split: the access is the connector's; the know-how is the skill's.)

### Writing the description

The description is the primary trigger, so make it specific (what the skill does)
*and* concrete about when to use it (the phrasings that should pull it in). Lean
slightly pushy — skills tend to *under*-trigger — but keep it scoped to what the
skill actually does; a too-greedy description hijacks unrelated requests. Keep it
**under 240 characters** (a hard limit). A folded (`>-`) multi-line description
still counts every line; if you're near the limit, write it as one line so the
length is obvious.

### Writing style for the body

Write in the imperative — you're giving instructions to a capable reader. Explain
*why* things matter rather than leaning on ALL-CAPS MUSTs; the model reading this
does better with reasoning than rigid commands. When the body needs a service,
read its credentials from the environment — a connector's credential slot shows
up as an environment variable of the same name (declare slot `LINEAR_API_KEY` on
the connector, reference `$LINEAR_API_KEY` in the body). Never write a literal
key. Draft it, then reread with fresh eyes and tighten — ideally under 500 lines;
push bulky reference material into helper files the body points to.

### Helper file paths

Relative to the skill dir: lowercase `[a-z0-9._-]`, may nest with `/` (e.g.
`references/api.md`). No `..`, no leading `/`, no backslashes, max 256 chars.
`SKILL.md`, `.mcp.json`, `.claude`, and `.git` are reserved.

## Step 4 — Propose it

Once the bundle is written under `/ephemeral/skill-draft/<id>/`, call:

```
skill_propose({ path: '/ephemeral/skill-draft/my-skill' })
```

What happens next:

- A skill that needs no connectors becomes available on the user's **next**
  message — tell them it's ready next turn.
- A skill that references a connector the user hasn't approved yet is held until
  they approve that connector (on an inline card). Once approved, it's ready next
  turn.
- **A skill you propose this turn is not available this turn** — skills are
  discovered when your session starts. Don't try to invoke it now; tell the user
  it'll be ready on their next message. If they asked you to create *and* use a
  skill in one breath, propose it and offer to continue once they reply.

A few points of discipline:

- **Don't narrate the approval step.** Any connector card speaks for itself.
- **Don't restate the user's keys.** They're entered privately on the connector
  card; you never see or repeat them.

## Worked example — a Linear triage skill

The user walks you through how they triage their Linear cycle and says "make that
a skill." Linear is reached over its GraphQL API with a key — that's a
*connector*, not part of the skill.

1. **Ensure the connector.** If there's no `linear` connector yet, author one
   with `ax-connector-creator` (hosts: `api.linear.app`, slot: `LINEAR_API_KEY`,
   keyMode: `personal`). Once it's connected, you have `connectorId: linear`.

2. **Write the skill** at `/ephemeral/skill-draft/linear-triage/SKILL.md`:

```markdown
---
name: linear-triage
description: >-
  Use when the user wants to triage their current Linear cycle — "triage my
  cycle", "what needs attention in Linear". Groups issues by state and flags
  stale ones.
version: 1
connectors: [linear]
---

# Triage the current Linear cycle

Query the Linear GraphQL API at `https://api.linear.app/graphql`, authenticating
with `$LINEAR_API_KEY` in the `Authorization` header. List the active cycle's
issues, group them by state, and flag any in In Progress with no update in 3+
days. Summarize what needs attention first.
```

Note: the frontmatter has `connectors: [linear]` and **no `capabilities:`
block** — the host, key, and registry all live on the `linear` connector. The key
is referenced as `$LINEAR_API_KEY`, never written out.

3. **Propose it:** `skill_propose({ path: '/ephemeral/skill-draft/linear-triage' })`.

## Principle of lack of surprise

A skill's behavior must match its description — no surprises. Don't write skills
that contain malware or exfiltrate data, and don't help anyone build a skill
designed to facilitate unauthorized access, hide what it's really doing, or
quietly send data somewhere it shouldn't. If a request's stated purpose doesn't
match what the skill would actually do, that's the signal to stop. (Ordinary
creative things — "roleplay as a pirate code reviewer" — are completely fine.)

The whole approval model rests on the user being able to trust that what they see
describes what they're getting. Keep that promise honest.
