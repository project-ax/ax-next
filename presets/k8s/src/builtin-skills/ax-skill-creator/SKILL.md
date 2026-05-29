---
name: ax-skill-creator
description: >-
  Use when the user wants to create, author, build, or modify a skill or
  integration — e.g. "make a skill for Linear", "add a Jira integration",
  "turn this into a skill". Guides writing a SKILL.md bundle and installing
  it with user approval.
---

# Authoring a skill for this assistant

A skill is a small folder of instructions you write into your own workspace and
then install for the user. Once installed, it becomes a capability you can reach
for on later turns — querying an API, running a CLI tool, following a fixed
workflow — without re-deriving it each time.

The key thing that makes this safe: **you propose the capabilities, a human
grants them.** You never get to silently reach a new server or spend a new
credential. When you install a skill, the user sees exactly one card listing the
hosts it talks to, the API keys it needs, and the package registries it pulls
from. Nothing the skill needs reaches the outside world until they approve it.
So author freely — the approval step is the backstop, and it's the user's, not
yours.

## The authoring loop

Four steps, all in this conversation:

1. **Understand what the skill should do** — and, specific to this system, which
   hosts, credentials, and package ecosystems it will need.
2. **Write the bundle** into your workspace at `.ax/skills/<id>/SKILL.md` (plus
   any helper files under that same directory).
3. **Install it** by calling `install_authored_skill({ skillId, hosts, slots,
   packages })`. The user approves one card and enters any API keys.
4. **Test and iterate** — try the skill on a realistic prompt; to change it,
   edit the bundle and install again.

## Step 1 — Capture intent

Before writing anything, get clear on what you're building. Often the
conversation already contains the answer — the user just walked you through a
workflow and said "make that a skill." If so, pull the details out of the
history (the API they hit, the steps in order, the corrections they made, the
output they wanted) rather than re-interrogating them.

Figure out:

- **What should this skill let you do?** The concrete capability.
- **When should it trigger?** The phrasings and contexts a user would actually
  say. This becomes the description, which is what decides whether the skill
  gets used at all.
- **What's the expected output?** A report, a file, a list, a side effect.
- **What does it need to reach the outside world?** This part is specific to
  this system, and it's what the user will approve:
  - **Hosts** — which servers it talks to (e.g. `api.linear.app`).
  - **Credentials** — which API keys it needs, named as slots.
  - **Packages** — whether it runs `npx`, `uvx`, or `pip` (which fetch from
    public registries).

Ask about edge cases, input/output shapes, and example data if it's not already
clear. Then confirm your understanding with the user before you start writing —
a quick "here's what I'm going to build" beats writing the wrong thing.

## Step 2 — Write the SKILL.md

### Anatomy

A skill is a directory. The only required file is `SKILL.md`:

```
.ax/skills/my-skill/
├── SKILL.md          (required: YAML frontmatter + markdown body)
└── (optional helper files: scripts, reference docs, templates)
```

`SKILL.md` is YAML frontmatter, then a markdown body. The frontmatter is just
two fields — `name` and `description` (more on why, below). The body is the
instructions you'll follow when the skill triggers.

### Progressive disclosure

Skills load in layers, so write with that in mind:

1. **Name + description** are always in context. They're how you decide whether
   to reach for the skill, so they have to earn that spot — keep them sharp.
2. **The body** loads only when the skill triggers. This is where the real
   instructions live. Keep it tight, ideally under 500 lines.
3. **Helper files** load only when the body points you to them. If the skill
   carries a lot of reference material or a script, put the bulk there and
   reference it from the body, rather than bloating `SKILL.md`.

### Writing the description

The description is the single most important field — it's the primary trigger.
Make it specific (what the skill does) *and* concrete about when to use it
(the contexts and phrasings that should pull it in). Lean slightly pushy: skills
today tend to *under*-trigger — to sit unused when they'd help — so it's worth
explicitly listing the situations where it applies, including ones where the
user describes the need without naming the skill. But keep it scoped to what the
skill actually does; a description that's too greedy hijacks unrelated requests,
which is just as bad as one that never fires.

**Keep it under 240 characters.** That's a hard limit — the install is rejected
above it, costing you a round-trip. So spend the budget well: lead with the
concrete capability, then pack in the highest-signal trigger phrases, and if
they don't all fit, keep the ones a user is most likely to actually type. One
trap to avoid: a multi-line folded (`>-`) description still counts *every* line
once folded, and it's easy to undercount. If you're anywhere near the limit,
write the description as a single line so its length is obvious at a glance.

### Writing style for the body

Write in the imperative — you're giving instructions to a capable reader.
Explain *why* things matter rather than leaning on ALL-CAPS MUSTs; the model
reading this is smart and does better with reasoning than with rigid commands.
Draft it, then reread with fresh eyes and tighten.

## Step 3 — The rules specific to this system

These are the non-negotiable mechanics. Get them right and installs go through
cleanly; get them wrong and the install is rejected or the skill hits a wall at
runtime.

### Frontmatter is `name` + `description` only — never `capabilities`

This is the rule that matters most. The frontmatter must contain **only** `name`
and `description`. Do **not** add a `capabilities:` block, and do not list
hosts, credentials, MCP servers, or packages there. Any capability block in the
frontmatter is **stripped on write** — it does nothing.

Here's why: everything a skill needs to reach the outside world is declared as
**arguments to `install_authored_skill`**, where the human sees and approves it.
If the frontmatter could grant capabilities, a skill could quietly widen its own
reach without anyone seeing. So the rule is simple — the agent proposes
capabilities in the install call; the human grants them on the card. Frontmatter
stays inert.

### Where the bundle goes

Write the skill to `.ax/skills/<id>/SKILL.md`. Helper files go under that same
directory.

### The grammars

These are validated on install. Follow them so a name you choose isn't quietly
dropped or rejected:

- **Description**: **≤ 240 characters** — a hard limit; the install is rejected
  above it (see "Writing the description" above for how to spend the budget).
- **Skill id** (`<id>`): `^[a-z][a-z0-9-]{0,63}$` — the id must start with a
  lowercase letter and contain only lowercase letters, digits, and hyphens (no
  dots or underscores), max 64 characters. (The install tool accepts a slightly
  looser charset, but the sandbox that runs the skill enforces this stricter
  rule — so an id with a dot or underscore can pass install and get approved,
  then silently fail to materialize. Stay within this form.)
- **Helper file paths** (relative to the skill dir): lowercase
  `[a-z0-9._-]`, may nest with `/` (e.g. `references/api.md`). No `..`, no
  leading `/`, no backslashes. Max path length 256 characters. Three names are
  **reserved** and rejected as either a file or a directory prefix: `.mcp.json`,
  `.claude`, and `.git`. (`SKILL.md` itself is also reserved — it's
  reconstructed from the manifest, so don't list it as a helper file.)
- **Credential slot names**: SCREAMING_SNAKE, `^[A-Z][A-Z0-9_]{0,63}$` (e.g.
  `LINEAR_API_KEY`). The only credential kind is an API key.

### Credentials are environment variables

A credential slot shows up to the skill at runtime as an environment variable of
the same name. So if you declare the slot `LINEAR_API_KEY`, the body references
it as `$LINEAR_API_KEY`. Never write a literal key into the skill — name the slot
and read it from the environment. The user supplies the actual value on the
approval card.

### Only approved hosts are reachable

Network egress goes through a proxy that only lets through the hosts approved at
install. Everything else is blocked. So list every host the skill talks to in
the `hosts` argument — if you forget one, requests to it fail at runtime, not at
install.

### Declare packages at install time

If the skill runs `npx`, `uvx`, or `pip` at runtime, it fetches from public
package registries (npmjs.org for npm, pypi.org for PyPI). Those registries are
behind the same egress wall. So pass a `packages` argument at install:
`packages: { npm: [...], pypi: [...] }`. That allowlists the registries on the
same approval card. Without it, the package fetch hits the wall and the tool
fails. npm names may be scoped (`@scope/package`).

### MCP servers are not self-authorable — say so

`install_authored_skill` deliberately has **no** argument for MCP servers.
Bundling an MCP server is the highest-risk capability, so a skill that needs one
can't be self-authored — it has to be authored by an admin through the catalog.
If the user asks for a skill that requires bundling an MCP server, don't try to
work around it. Tell them plainly that this kind of skill needs an admin to add
it via the catalog, and offer to build whatever part *can* be done as a normal
skill (e.g. a workflow over a plain HTTP API instead).

## Step 4 — Install it

Once the bundle is written, call:

```
install_authored_skill({
  skillId: 'my-skill',
  hosts:    ['api.example.com'],   // every host the skill reaches; may be empty
  slots:    ['MY_API_KEY'],        // credential slot names; may be empty
  packages: { npm: [], pypi: [] }, // registries it pulls from; omit if none
})
```

The user is shown one approval card listing exactly those hosts, credential
slots, and package registries, under a banner noting this is a new skill you just
wrote. They approve and enter any API keys. On approval, the draft is promoted to
an installed skill and materialized — it's usable on the very next turn.

A few points of discipline around this call:

- **Don't narrate the approval step.** Don't say "I'll now ask you to approve
  this" — the card speaks for itself.
- **Don't restate the user's API keys.** They enter them privately on the card;
  you never see or repeat them.
- **Don't re-ask the user's original request.** After they approve, the
  conversation continues automatically — pick up where the skill leaves off.

## Step 5 — Test and iterate

After install, exercise the skill with a realistic prompt — the kind of thing
the user would actually type — and see that it does what you intended.

To change it, edit the bundle in `.ax/skills/<id>/` and call
`install_authored_skill` again with the same `skillId`. The re-install goes
through the same one-card approval. This stays lightweight and human-in-the-loop
on purpose: write, install, try, adjust.

## Worked examples

### Example A — a Linear integration (host + credential)

The user wants to list the issues in their current Linear cycle. Linear has a
GraphQL API at `api.linear.app` and authenticates with an API key. So the skill
needs one host and one credential slot.

`.ax/skills/linear/SKILL.md`:

```markdown
---
name: linear
description: >-
  Use when the user asks about their Linear issues, cycles, or sprints — e.g.
  "what's in my current cycle" or "list my open Linear issues". Queries the
  Linear GraphQL API and summarizes the results.
---

# Linear issues

Query the Linear GraphQL API at `https://api.linear.app/graphql`. Authenticate
with the API key in the `$LINEAR_API_KEY` environment variable — send it as the
`Authorization` header.

To list issues in the current cycle, POST this query:

\`\`\`graphql
query {
  cycles(filter: { isActive: { eq: true } }) {
    nodes {
      name
      issues {
        nodes { identifier title state { name } assignee { name } }
      }
    }
  }
}
\`\`\`

Summarize the result grouped by state (e.g. In Progress, Todo, Done).
```

Note the frontmatter is `name` + `description` only — no capabilities block, and
the description stays well under the 240-char cap. The key is referenced as
`$LINEAR_API_KEY`, never written out. Then install:

```
install_authored_skill({
  skillId: 'linear',
  hosts:   ['api.linear.app'],
  slots:   ['LINEAR_API_KEY'],
})
```

The user approves reaching `api.linear.app` and enters their Linear API key on
the card. Done.

### Example B — a skill that runs a package (no host or credential)

The user wants to pretty-print and lint JSON files using a tool they like. The
skill runs a PyPI tool via `uvx`, and that's all it needs — no API, no key. The
only thing to approve is the package registry.

`.ax/skills/json-tidy/SKILL.md`:

```markdown
---
name: json-tidy
description: >-
  Use when the user wants to format, tidy, validate, or lint a JSON or YAML
  file — e.g. "clean up this config", "is this JSON valid", "reformat
  settings.json". Runs the `check-jsonschema` tool to validate, and reformats
  the file in place. Use whenever the user hands over a JSON/YAML file that
  looks malformed or messy.
---

# JSON tidy

Validate a JSON or YAML file by running:

\`\`\`bash
uvx check-jsonschema --check-metaschema <file>
\`\`\`

Report any errors it finds with the line numbers, then offer to reformat the
file.
```

Since the skill fetches `check-jsonschema` from PyPI at runtime, declare it as a
package — but there's no host or credential to request:

```
install_authored_skill({
  skillId:  'json-tidy',
  packages: { pypi: ['check-jsonschema'] },
})
```

The user approves the PyPI registry on the card. No keys to enter.

## Principle of lack of surprise

A skill's behavior must match its description — no surprises. Don't write skills
that contain malware or exfiltrate data, and don't help anyone build a skill
designed to facilitate unauthorized access, hide what it's really doing, or
quietly send data somewhere it shouldn't. If a request's stated purpose doesn't
match what the skill would actually do, that's the signal to stop. (Ordinary
creative things — "roleplay as a pirate code reviewer" — are completely fine.)

The whole approval model rests on the user being able to trust that the card
they're shown describes the skill they're getting. Keep that promise honest.
