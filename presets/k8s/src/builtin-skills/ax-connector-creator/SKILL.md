---
name: ax-connector-creator
description: >-
  Use when the user wants to connect a service or data source — "connect my
  Salesforce", "set up Google Drive", "add a GitLab integration", "hook up an
  MCP server". Authors a connector (the access) and installs it with one
  approval card.
---

# Connecting a service for this assistant

A **connector** is authenticated access to a data source or service — your
Salesforce, a Google Drive, an internal API, an MCP server. It's the *access*:
the hosts it talks to, the key it spends, the binary it runs. The know-how for a
workflow ("how we triage Linear issues") is a separate thing — a *skill* — that
references a connector. This builtin authors the connector.

The connector hides its mechanism. Under the hood it might be an MCP server, a
CLI tool fetched from a package registry, or plain API calls over an allowed
host — but to everyone above it, it's just "connected to Salesforce." That
matters because not every service has an MCP server: Salesforce and GitLab, for
instance, are reached through their CLI or API, not MCP. So a connector is
mechanism-agnostic on purpose.

The safety model is the same one skills use: **you propose the access, a human
grants it.** When you install a connector, the user sees exactly one card listing
the hosts it reaches, the keys it needs, and the package registries it pulls
from. Nothing reaches the outside world until they approve. So author freely —
the approval card is the backstop, and it's the user's.

## The authoring loop

Four steps, all in this conversation:

1. **Capture intent** — what service, and how it's reached (MCP / CLI / direct
   API), which hosts, which key.
2. **Draft the connector** — decide the id, name, hosts, credential slots,
   packages, MCP backing, key mode, and a short usage note.
3. **Install it** by calling `connector_propose({ ... })`. The user approves one
   card and enters any key.
4. **Test and iterate** — once it's connected, exercise it; to change it, propose
   again with the same `connectorId`.

## Step 1 — Capture intent

Get clear on what the user wants to connect before drafting. Often the
conversation already says it ("connect my Salesforce") — pull the details from
there rather than re-interrogating.

Figure out:

- **What service?** The concrete thing (Salesforce, a Drive, an internal API).
- **How is it reached?** This decides the connector's fill:
  - **Direct API** — the agent (or a skill) hits a REST/GraphQL endpoint on an
    allowed host with an API key. Fill: `hosts` + a credential `slot`.
  - **CLI tool** — a binary fetched via `npx` / `uvx` / `pip` (e.g. the
    Salesforce `sf` CLI, GitLab `glab`). Fill: `packages` + usually `hosts`
    (the CLI's network reach) + a `slot`.
  - **MCP server** — a service speaking MCP, over `http` (a URL) or `stdio` (a
    local binary). Fill: `mcpServers`.
  - A connector can mix these, but most are one mechanism.
- **Whose key?** This is the `keyMode`, and it's important:
  - `personal` — each user supplies **their own** key the first time they use
    the connector; everyone acts as themselves. Right for per-user data — my
    Gmail, my Drive.
  - `workspace` — an admin provides **one** key that every allowed agent spends
    as a shared service identity. Right for org-wide systems — the company
    Salesforce.

Confirm your understanding with the user before drafting — "here's what I'll
connect" beats connecting the wrong thing.

## Step 2 — The rules specific to this system

These are the mechanics. Get them right and the install goes through; get them
wrong and it's rejected at install or hits a wall at runtime.

### The grammars (validated on install)

- **Connector id** (`connectorId`): `^[a-z0-9][a-z0-9_-]*$`, max 128 chars —
  start with a lowercase letter or digit, then lowercase letters, digits,
  hyphens, underscores. No dots, no spaces, no uppercase.
- **Name**: a short human label (e.g. `Salesforce`), max 200 chars.
- **Credential slot names**: SCREAMING_SNAKE, `^[A-Z][A-Z0-9_]{0,63}$` (e.g.
  `SF_API_KEY`). The only credential kind is an API key.
- **Hosts**: bare hostnames — `login.salesforce.com`, not `https://...` and not
  a wildcard.
- **usageNote**: a short "how to use me" blurb, max 4000 chars. Write one — it's
  what makes a freshly-connected service work out of the box (it tells later
  turns how to drive the connector). Think of it the way an MCP server describes
  its own tools.

### Credentials are environment variables

A credential slot shows up to whatever uses the connector as an environment
variable of the same name. Declare the slot `SF_API_KEY`, and it's read as
`$SF_API_KEY`. **Never write a literal key anywhere** — name the slot; the user
supplies the value on the approval card. You never see it.

### Only approved hosts are reachable

Network egress goes through a proxy that only lets through the hosts approved at
install. List every host the connector talks to in `hosts` — miss one and
requests to it fail at runtime, not at install.

### Declare packages if the connector runs a binary

If the connector's mechanism is a CLI fetched via `npx` / `uvx` / `pip`, those
registries (npmjs.org, pypi.org) are behind the same egress wall. Pass
`packages: { npm: [...], pypi: [...] }` so the registries are allowlisted on the
same card. npm names may be scoped (`@scope/package`).

## Step 3 — Install it

Once you've decided the fill, call:

```
connector_propose({
  connectorId: 'salesforce',
  name:        'Salesforce',
  hosts:       ['login.salesforce.com'],     // every host it reaches; may be empty
  slots:       [{ slot: 'SF_API_KEY', kind: 'api-key' }],  // keys it needs; may be empty
  packages:    { npm: ['@salesforce/cli'] }, // registries it pulls from; omit if none
  mcpServers:  [],                           // MCP backing; omit if none
  usageNote:   'Run the sf CLI; auth with $SF_API_KEY.',
  keyMode:     'workspace',                   // 'personal' | 'workspace'
})
```

The user is shown one card listing exactly those hosts, slots, and registries.
They approve and enter any key. On approval the connector activates.

A few points of discipline:

- **Don't narrate the approval step.** The card speaks for itself — don't say
  "I'll now ask you to approve."
- **Don't restate the user's key.** They enter it privately on the card; you
  never see or repeat it.
- **A connector you propose this turn isn't connected this turn.** After the user
  approves, it's resolved when their next message starts — so don't try to use it
  in the same turn. Tell the user it'll be ready on their next message. If they
  asked you to connect *and* use a service in one breath, propose it and offer to
  continue once they reply.

## Step 4 — Test and iterate

Once it's connected (next turn), exercise it with a realistic prompt and confirm
it does what you intended. To change it, call `connector_propose` again with the
**same `connectorId`** — the re-propose goes through the same one-card approval.
Write, install, try, adjust.

## Worked examples

### Example A — Salesforce (CLI + a shared key)

The user wants their assistant to act on the company Salesforce. Salesforce has
no usable MCP server — the `sf` CLI is the way in. It's an org-wide system, so
one shared admin key (`workspace`).

```
connector_propose({
  connectorId: 'salesforce',
  name:        'Salesforce',
  hosts:       ['login.salesforce.com', 'my-org.my.salesforce.com'],
  slots:       [{ slot: 'SF_API_KEY', kind: 'api-key' }],
  packages:    { npm: ['@salesforce/cli'] },
  usageNote:   'Run the sf CLI for queries/DML; authenticate with $SF_API_KEY.',
  keyMode:     'workspace',
})
```

### Example B — a personal Google Drive (MCP, per-user key)

The user wants their assistant to reach *their own* Drive via an MCP server. It's
per-user data, so each user brings their own key (`personal`).

```
connector_propose({
  connectorId: 'google-drive',
  name:        'Google Drive',
  mcpServers:  [{
    name: 'gdrive',
    transport: 'http',
    url: 'https://mcp.example.com/gdrive',
    allowedHosts: ['mcp.example.com'],
    credentials: [{ slot: 'GDRIVE_TOKEN', kind: 'api-key' }],
  }],
  slots:       [{ slot: 'GDRIVE_TOKEN', kind: 'api-key' }],
  usageNote:   'Use the gdrive MCP tools to list and read files.',
  keyMode:     'personal',
})
```

(Mechanism details — transport, url, command, args — live *inside* each
`mcpServers` entry, never as top-level connector fields.)

## A connector vs. a skill

Don't put workflow know-how in a connector — keep it lean (just the access). If
the user also wants the assistant to *know how* to drive the service for their
workflows, that's a skill (built with `ax-skill-creator`) that references this
connector by id. Connector = access; skill = know-how.

## Principle of lack of surprise

A connector's reach must match what it's for — no surprises. Don't author a
connector that quietly reaches hosts or spends keys the user didn't agree to, and
don't help anyone build one designed to exfiltrate data or facilitate
unauthorized access. If a request's stated purpose doesn't match the access it
asks for, that's the signal to stop.

The whole approval model rests on the user trusting that the card they're shown
describes the access they're granting. Keep that promise honest.
