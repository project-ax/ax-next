# Connectors as a first-class concept — unifying how agents reach data sources

**Status:** Design (brainstormed 2026-05-31, not yet decomposed into tasks)
**Author:** Vinay (with Claude)
**Supersedes / refines:** the credentials + skills UI as audited 2026-05-31; the
standalone admin "MCP servers" path.

## Problem

There are several different ways an agent can connect to a data source or service:

1. **MCP server over HTTP** — a remote service speaking MCP (URL + auth).
2. **MCP server over stdio** — a local MCP binary the sandbox spawns.
3. **A CLI binary** — e.g. the Salesforce `sf` CLI or GitLab `glab`, fetched via
   `npx` / `uvx` / `pip`, driven by the agent over Bash.
4. **Direct API calls** — the agent (or a skill's helper script) hits a REST API
   on an allowed host using an API key.

Today all four are expressed as `capabilities` *inside a skill manifest*
(`packages/skills-parser/src/capabilities.ts`):

```ts
interface SkillCapabilities {
  allowedHosts: string[];        // direct-API reach + CLI network reach
  credentials: CapabilitySlot[]; // the keys
  mcpServers: McpServerSpec[];   // MCP backing (http or stdio)
  packages: PackagesSpec;        // CLI/binary backing (npm/pypi)
}
```

The existing `ax-skill-creator` builtin even calls a skill "a skill **or
integration**" and installs hosts/slots/packages in one card. So the *skill* is
secretly also the *connector*. On top of that, MCP servers have a **second**
home — the standalone admin "MCP servers" form (`McpServerForm.tsx`), referenced
by agents as a comma-separated ID list (`AgentForm.tsx`). That violates
invariant #4 (one source of truth): MCP/credentials/packages live both inside
skills *and* in an admin form.

The downstream symptoms (from the 2026-05-31 UX audit): "connect to a service"
is fragmented across five surfaces under four names, the only entry point for
MCP is the jargon-heavy "MCP servers" form, and a non-technical user cannot
answer "where do I connect my Google Drive / Salesforce?".

The not-all-services-are-MCP fact is the crux: **Salesforce and GitLab have no
usable MCP server — the CLI or direct API is the only way in.** So a "connector"
cannot mean "MCP server." It must be mechanism-agnostic.

## The model: three orthogonal, first-class concepts

| Concept | What it is | The verb |
|---|---|---|
| **Credential** | A key/secret. The wallet. | *I have* a key |
| **Connector** | Authenticated **access** to a data source. Mechanism hidden (MCP \| CLI \| direct API). Reusable. Spends credentials. | *I connect to* a service |
| **Skill** | **Know-how** / behavior. References the connectors it uses. | *I teach* the agent |

- **Connector = access.** A Salesforce connector is `packages: { npm:
  ['@salesforce/cli'] } + credentials + allowedHosts` and **zero** mcpServers. A
  Google Drive connector is `mcpServers: [...]` and no packages. **Same object,
  different fill** — it's the existing `SkillCapabilities` shape, lifted out of
  the skill.
- **Skill = know-how.** A skill becomes pure content (SKILL.md body + helper
  files) plus a list of connectors it uses. "How to drive `sf` for our
  workflows" is a skill; the `sf` binary + key + network reach is its connector.
- A connector carries a **light usage note** (decision: option *b*) — a short
  "how to use me" blurb, mirroring how an MCP server self-describes its tools —
  so connecting a service yields a *working* capability out of the box. Richer
  workflow know-how still layers on top as skills.

### Skill → connector relationship

A skill **declares** the connectors it uses (soft dependency). Installing a
skill surfaces "this skill works with the *Salesforce* connector — connect it
now" and guides the user through connecting if it isn't already. A skill never
*contains* a connector.

## Access model (Vinay's reduction)

Everything derives from two primitives on the **agent**:

- An agent has one or more **managers** (users who can change it).
- An agent has one or more **viewers** (users who can see/use it; default = all
  managers).

Derived, not separate concepts:

- **Team** = a named group of users, pure convenience. "Visible to a team" ≡
  "visible to every user in that team." (Backed today by `owner_type='team'` /
  `visibility='team'` in `packages/agents`.)
- **Personal vs shared** = derived from the viewer set. Visible to 1 person =
  personal; visible to >1 = shared.

Sharing rules for the three concepts:

- **Skills and connectors** are either **in the Catalog** (the shared,
  admin-curated workspace pool) or **private** (just the owner's agents).
  "Public/private" *is* catalog membership: a user submits a private item to the
  catalog (admit-queue → admin approval) to share it; admins curate the catalog
  and flag which items are **default-on** for agents. A manager can add catalog
  items to their agent and manage their own private items; admins own a catalog
  item's *definition*. (The eventual model also lets a manager **remove** an
  admin default per-agent — but that per-agent opt-out is **deferred, out of
  scope for this build**; see Out of scope.)
- **Credentials** have **no public/private flag** — see below.

## Credentials: reach by attachment, never by visibility

A credential is categorically different from a skill/connector: **its value is a
secret that is never visible to anyone, including the person who entered it.**
ax-next stores it encrypted and never returns plaintext; the credential-proxy
(`packages/credential-proxy`) MITM-injects it into outbound requests *inside the
sandbox*, so the agent — and whoever drives it — **spends** the key without ever
**seeing** it.

Therefore the public/private *visibility* axis does not apply. There is nothing
to make visible. What varies is **which agents may spend it**, and that **derives
from where the key is attached** — matching the "everything derives from the
agent" model and mapping 1:1 onto the existing `global | user | agent` scope
(`packages/credentials/src/plugin.ts`):

| Attach the key to… | Who can spend it | Derived term |
|---|---|---|
| a personal agent (`agent`) | just that user | private |
| a shared / team agent (`agent`) | everyone who can use that agent | shared |
| all of a user's agents (`user`) | that user's agents | personal default |
| the workspace (`global`, admin) | every agent | the company key |

**Decision: credentials get no public/private flag.** Reach is purely derived
from the agent/workspace a key is bound to. "Share a key" = "bind it to a shared
agent"; the value still stays hidden from everyone.

### Consent caveat (invariant #5)

Sharing a key for *use* is not as harmless as sharing a skill. The proxy stops
key **theft**, not authorized **misuse** — anyone who can drive the shared agent
can make it **act as that identity** on the service. The consent, in plain
words, surfaced as one explicit moment (not fine print):

> "Sharing this key lets their assistant act as you on Salesforce. They can't
> copy the key — but they can use it."

### Connector `keyMode`

**Decision: a connector declares `keyMode: 'personal' | 'workspace'`** so the
connect flow knows whose key to use:

- `personal` — prompt **each** user for their own key the first time they use
  the connector; everyone acts as themselves. Right for per-user data (my Gmail,
  my Drive). Backed by the existing JIT `account:<service>` per-user vault flow.
- `workspace` — an admin provides **one** key; every allowed agent spends it as
  a shared service identity. Right for org-wide systems (the company Salesforce).

## Architecture: lift `capabilities` out of skills

1. **New first-class `Connector` object** = `{ id, name, description, usageNote,
   keyMode, visibility } + Capabilities` where `Capabilities` is today's
   `SkillCapabilities` shape (allowedHosts / credentials / mcpServers /
   packages). Owns its own table (one source of truth).
2. **Skill manifest loses the capability block**, gains a `connectors: string[]`
   reference list. SKILL.md frontmatter + body + helper files only.
3. **The standalone admin "MCP servers" form becomes the connector registry** —
   an MCP-backed connector is just a connector whose fill is `mcpServers`.
   `AgentForm`'s comma-separated MCP-ID list is replaced by attaching connectors.
4. **The orchestrator union** (`skills:list-defaults` + `agents.skill_attachments`)
   gains a parallel for connectors: an agent's effective set = catalog defaults
   **+** manager-added catalog items **+** private items. (Per-agent removal of a
   default — which would need a "suppressed defaults" store — is **deferred**;
   see Out of scope.)
5. **The credential-proxy already spends by ref** — connectors reference
   credential slots; no proxy change needed beyond resolving slots through the
   connector instead of the skill.

## Authoring: `ax-connector-creator`

A new builtin skill mirroring `ax-skill-creator`
(`presets/k8s/src/builtin-skills/`). When a user needs a service that isn't
connected and no connector exists, the agent authors one:

- **Loop:** capture intent (which hosts/creds/packages/MCP) → write a connector
  draft → `install_authored_connector({ connectorId, name, hosts, slots,
  packages, mcpServers, usageNote, keyMode })` → **one approval card** → test.
- **`ax-skill-creator` narrows** to pure know-how. "Make a Salesforce skill" →
  ensure the Salesforce connector exists (spin it up via connector-creator if
  not) → write the know-how skill that references it.

### Security — reuse the existing approval wall (invariant #5)

An agent-authored connector is model-generated content declaring network reach +
credential slots + binaries to install. This is **exactly** what the existing
capability-approval wall gates: `packages/skills/src/approved-caps-store.ts`,
`ApprovedCapKind = 'host' | 'slot' | 'npm' | 'pypi' | 'mcp'` — the full
mechanism-agnostic connector surface. Nothing reaches the outside world until a
human approves the card. The split does not widen the trust surface; it
*clarifies* it, because "I'm granting my agent access to Salesforce" becomes one
named consent instead of fine print inside a skill. The approval store's
compound key extends from `(owner, agent, skill, ...)` to cover connectors.

Invoke the `security-checklist` skill when implementing: this touches plugin
loading (new connector manifest), credential handling, and untrusted
(model-authored) capability declarations.

## UI / IA (agent-centric, scope as a source badge)

The agent — "your assistant" — is the unit everyone configures. Open it →
**Skills · Connectors · Credentials**. Each skill/connector wears at most one
**source badge**:

- **Catalog** — comes from your workspace's shared catalog (admin-curated; may
  be default-on). You don't manage its definition (unless you authored it).
- *(no badge)* — **private**: your own, just your agents, yours to manage.

So the badge is a calm, single tag — present only when an item comes from the
shared catalog, absent for the private default. **Scope reveals itself
progressively:** a solo user with one assistant sees no badges and no "catalog"
anything; once an admin curates a catalog, "Catalog" tags appear on the
defaults; teams add a team layer. Non-technical users never get the word
"scope." The verb for sharing your own item is **"Submit to catalog"**; avoid
"public" — it misreads as internet-public.

- **Admins** get one extra surface — the **Catalog** — to curate the shared
  skills/connectors and flag which are default-on. Defaults flow into agents,
  but managers can opt out per agent. The only place the "manage for everyone"
  job lives.
- **Connector tile:** service name, what it needs (a key / nothing),
  connected / not. Mechanism (MCP / stdio / transport / args) lives only behind
  **Advanced**. The connect flow respects `keyMode` (prompt each user vs spend
  the shared key).
- This collapses the audit's fragmentation: "Connections" tab (mislabeled) + the
  "MCP servers" form merge into **Connectors**; "Keys" + "Providers" merge into
  **Credentials**; "My Skills" + "Catalog" become **Skills** under the source
  badge.

**Naming:** canonical term is **Connector**; user-facing copy may prefer
**"Connected services"** for warmth. Settle during implementation; not a blocker.

## Migration

Existing authored skills that bundle `capabilities` are split: the capability
block extracts into a connector (named after the skill/service), and the skill
keeps its body + a reference to the new connector. The standalone MCP-server rows
become MCP-backed connectors. Per-agent MCP-ID lists become connector
attachments. This is data migration + a manifest-schema change, sequenced before
the UI flips.

## Phasing (to be decomposed by writing-plans)

1. **Connector data model + registry** (table, hooks, manifest schema; extract
   `Capabilities`). Keep skills' capability block working in parallel
   (half-wired window) until the UI + authoring land.
2. **Authoring** — `install_authored_connector` + approval-wall extension +
   `ax-connector-creator` builtin; narrow `ax-skill-creator`.
3. **Credentials** — reach-by-attachment + `keyMode` connect flow (personal JIT
   vs workspace shared).
4. **Orchestrator union** for connectors; replace `AgentForm` MCP-ID list with
   connector attachment; standalone "MCP servers" form → connector registry.
5. **UI/IA reorg** — agent-centric Skills/Connectors/Credentials with the
   Catalog/private source badge; admin Catalog surface; mechanism behind
   Advanced.
6. **Migration** — split existing skills' capabilities into connectors; close the
   half-wired window (remove the capability block from the skill manifest).

## Out of scope (deferred)

- **Per-agent removal of a catalog default** (the "suppressed defaults" opt-out
  store). In this build, catalog defaults flow into agents and a manager adds
  more catalog items / manages their own private items; *removing an admin
  default per-agent* comes later. No card should be cut for it.
- **Team-scoped catalog visibility** — catalog items are workspace-wide for now;
  team-only catalog scoping is a later refinement.

## Boundary review (new/changed hooks)

- **Alternate impl a connector-registry hook could have:** a connector backed by
  MCP-http vs stdio vs a CLI package vs direct API — the hook surface must name
  none of those in payload field names (`url`, `command`, `transport` belong to
  the spec object, not the hook verb). A `connectors:resolve` / `connectors:list`
  hook returns mechanism-agnostic descriptors.
- **Payload fields that might leak:** `transport`, `command`, `stdio`, `url`,
  `mcp` — these are fine *inside* the connector spec but must not appear as
  first-class hook fields or in UI copy outside Advanced. `keyMode`,
  `visibility`, `usageNote` are storage-agnostic and fine.
- **Subscriber risk:** a subscriber must key off the connector *id* and its
  declared `credentials`/`allowedHosts`, never off "is this MCP?" — a connector's
  backing mechanism can change (a service ships an MCP server later) without its
  identity changing.
- **One source of truth:** after migration, MCP/credentials/packages live only on
  the connector. Assert no skill manifest carries a capability block (lint/test).

## Open questions (non-blocking)

1. Whether the `account:<service>` vault key should be the connector's natural
   credential identity (so two connectors to the same service share one key) or
   stay per-connector. Lean: share by service.
2. Whether `ax-skill-creator` auto-invokes `ax-connector-creator` inline, or just
   instructs the agent to. Lean: instruct (skills compose via the model, not via
   imports — invariant #2).
