---
name: ax-connector-creator
description: >-
  Use when the user wants to connect a service or data source — "connect my
  Salesforce", "set up Google Drive", "add a GitLab integration", "hook up an
  MCP server". Drafts a connector (the access) and sends it to your
  workspace admin.
---

# Connecting a service for this assistant

A **connector** is authenticated access to a data source or service — your
Salesforce, a Google Drive, an internal API, an MCP server. It's the *access*:
the hosts it talks to, the key it spends, the binary it runs. The know-how for a
workflow ("how we triage Linear issues") is a separate thing — a *skill* — that
references a connector. This builtin drafts the connector.

The connector hides its mechanism. Under the hood it might be an MCP server, a
CLI tool fetched from a package registry, or plain API calls over an allowed
host — but to everyone above it, it's just "connected to Salesforce." That
matters because not every service has an MCP server: Salesforce and GitLab, for
instance, are reached through their CLI or API, not MCP. So a connector is
mechanism-agnostic on purpose.

The safety model: **you ask for the access, a human grants it.** Only a
workspace admin can create a connector. Your proposal goes into the admin's
"Awaiting approval" list in Admin > Connectors, showing the hosts it reaches, the
keys it needs, and the package registries it pulls from. Nothing reaches the
outside world until an admin sets it up. So draft freely — the admin's review is
the backstop.

## The authoring loop

Four steps, all in this conversation:

1. **Capture intent** — what service, and how it's reached (MCP / CLI / direct
   API), which hosts, which key.
2. **Draft the connector** — decide the id, name, hosts, credential slots,
   packages, MCP backing, key mode, and a short usage note.
3. **Send it** by calling `connector_propose({ ... })`. It goes to the workspace
   admin, who sets it up and enters any key.
4. **Test and iterate** — once the admin has set it up and the user has added it
   to this agent from the Connectors tab, exercise it. To change what you asked
   for, propose again with the same `connectorId`.

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
  - **MCP server** — a service speaking MCP over `http` (a URL). Fill: `mcpServers`. Local (stdio) MCP servers are not supported.
  - A connector can mix these, but most are one mechanism.
- **Whose key?** This is the `keyMode`, and it's important:
  It's a hint — the admin makes the final call when they set it up:
  - `personal` — each agent adds **its own** key; everyone acts as themselves.
    Right for per-user data — my Gmail, my Drive.
  - `workspace` — **one** shared key that the admin enters and every allowed
    agent spends as a shared service identity. Right for org-wide systems — the
    company Salesforce.

Confirm your understanding with the user before drafting — "here's what I'll
connect" beats connecting the wrong thing.

## Step 2 — The rules specific to this system

These are the mechanics. Get them right and the install goes through; get them
wrong and the request is rejected or hits a wall at runtime.

### The grammars (validated when you send it)

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
`$SF_API_KEY`. **Never write a literal key anywhere** — name the slot; the admin
supplies the value when they set it up. You never see it.

### Only the hosts the admin sets up are reachable

Network egress goes through a proxy that only lets through the hosts the admin set up
for the connector. List every host it talks to in `hosts` — miss one and
requests to it fail at runtime, not when you send the request.

### Declare packages if the connector runs a binary

If the connector's mechanism is a CLI fetched via `npx` / `uvx` / `pip`, those
registries (npmjs.org, pypi.org) are behind the same egress wall. Pass
`packages: { npm: [...], pypi: [...] }` so the registries are allowlisted too. npm names may be scoped (`@scope/package`).

## Step 3 — Send it to the admin

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

The request lists exactly those hosts, slots, and registries for a workspace admin
to review. The reply tells you whether it was sent or the connector already
exists. Either way, the person adds it to this agent from the Connectors tab once
it exists.

A few points of discipline:

- **Be honest about what happened.** You've asked their admin; you haven't
  connected anything. Say so in a sentence and say what comes next (the admin
  sets it up, then they add it from the Connectors tab).
- **Don't restate any key.** The admin enters it privately; you never see or
  repeat it.
- **A connector you ask for isn't available this turn.** Don't try to use it in
  the same turn. If they asked you to connect *and* use a service in one breath,
  send the request and offer to continue once it's set up.

## Step 4 — Test and iterate

Once the admin has set it up and it's been added to this agent, exercise it with
a realistic prompt and confirm it does what you intended. To change what you
asked for, call `connector_propose` again with the **same `connectorId`** — it
goes to the admin like the first request. If a connector with that id already
exists, you'll be told so; changing a live connector is an admin's job.

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

(Mechanism details — transport, url — live *inside* each
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

The whole approval model rests on the admin trusting that the request they're
shown describes the access they're granting. Keep that promise honest.
