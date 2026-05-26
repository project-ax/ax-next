# Credentials UX redesign — destination-first creation

**Status:** Proposed
**Date:** 2026-05-19
**Related:**
- `packages/credentials/` — the `@ax/credentials` facade (table `credentials_v1_envelopes`).
- `packages/credentials-admin-routes/` — HTTP routes for the current admin + settings credential UIs (to be deleted in this PR).
- `packages/channel-web/src/components/credentials/` — the current `ApiKeyForm` / `CredentialAddMenu` / `CredentialsList` (to be deleted).
- `packages/chat-orchestrator/src/orchestrator.ts:830` — hardcoded `'anthropic-api'` provider ref.
- `packages/skills/src/types.ts` — `CapabilitySlot { slot, kind, description? }` and `agent.skillAttachments[].credentialBindings[slot] = ref`.
- `packages/mcp-client/src/config.ts:68` — `credentialRefs` / `headerCredentialRefs` per-MCP-server.
- `packages/routines/src/webhook-handler.ts:57` — `trigger.hmac.secretRef`.
- `MEMORY.md` — `project_credentials_admin_ui_pr51` (shipped 2026-05-07, 12 days old), `feedback_no_oauth_credentials` (provider creds are API-key-only).
- `CLAUDE.md` invariants 1, 3, 4, 5, 6.

---

## Goal

Stop asking end users (and admins) to know about credential **refs** and **kinds**. Today, adding a credential exposes the internal lookup key (`ref`) and the abstract `kind` as user-facing form fields. Worse, the user has to *coordinate* the ref name they invent with whoever later picks it from a dropdown on a skill / MCP / routine config page.

After this redesign:

- Credentials are only ever created **from the consumer surface that needs them** — a skill's slot, an MCP server's env var or header, a routine's webhook HMAC, or the provider config.
- The ref is computed deterministically from `(destination, slot)`; the user never sees it.
- One destination owns its credentials 1:1 — deleting the destination deletes its credentials.
- The standalone credentials page (`/admin/credentials`, `/settings/credentials`) is removed.

### Non-goals (deferred)

- **OAuth-paste flows.** Per `feedback_no_oauth_credentials`, provider credentials are API-key-only at MVP. If OAuth-paste returns later, it slots in as a new `kind` rendering inside `<CredentialSlotForm>`, not a new top-level page.
- **Hostname-only "ad-hoc" credentials.** HTTP egress only happens inside skills (or via the hardcoded provider path); there's no surface for "give me a credential for `api.example.com` with no skill behind it." If that becomes a need, it's a new destination kind.
- **Reusable credentials across destinations.** A single Anthropic key used by both the provider and a skill that calls Anthropic gets pasted twice. This is a deliberate trade for the simplicity of 1:1 ownership and no orphan lifecycle.
- **Credentials audit/inventory surface.** No read-only "all credentials" admin tab in v1. If a "who's using this?" view becomes load-bearing, it's an additive follow-up — the storage already records enough (scope, ownerId, ref, kind) to render one.
- **Big-bang migration of existing rows.** See §5.

---

## How this lands the invariants

| Invariant | How this design satisfies it |
|---|---|
| **I1** — Transport/storage-agnostic hooks | No facade-shape change to `credentials:get` / `credentials:set` / `credentials:delete` / `credentials:list`. One new service hook `credentials:purge-by-owner({ scope, ownerId })` uses vocabulary already in the credentials surface — `scope` and `ownerId` are not backend-specific. Alternate impl (vault-backed) implements the same purge by scoping its delete to its vault path. No subscriber chain. |
| **I3** — No half-wired plugins | One PR ships all six wiring sites: Providers admin tab + skill-attachment edit + MCP server config + routine webhook config end-to-end, plus deletion of the old credentials components and HTTP routes in the same PR. No "wire later" stubs. Canary acceptance test covers the destination-first happy path before merge. |
| **I4** — One source of truth | `@ax/credentials` remains the single store. Refs are still its only addressing primitive. The deterministic ref convention lives in **one file** (`packages/credentials/src/refs.ts`, new) — every consumer imports the same helper, so renaming a convention is one edit. |
| **I5** — Capabilities explicit and minimized | The destination-first model makes the per-credential capability boundary visible: "this secret exists because skill X declared it needs slot Y." Provider keys are admin-only. User-scope credentials are user-only. No new IPC actions; the existing HTTP routes for `credentials:set`/`credentials:delete` are kept (re-pointed to the new entrypoints) so the wire surface narrows, not widens. |
| **I6** — One UI design language | All four wiring sites and the new Providers tab live in `packages/channel-web` and compose existing shadcn primitives (`Sheet`, `Button`, `Input`, `FieldGroup`/`Field`, `Card`). `<CredentialSlotForm>` is one component reused everywhere. No new design system, no hand-rolled forms. |

---

## Vocabulary

- **Destination** — a consumer that needs a credential. Five kinds today: `provider`, `skill-slot`, `mcp-env`, `mcp-header`, `routine-hmac`.
- **Slot** — a single named secret a destination needs (e.g., a skill's `CapabilitySlot.slot`, an MCP server's env-var name, etc.).
- **Deterministic ref** — the storage key for a credential, computed from `(destination, slot)` via the helper in `packages/credentials/src/refs.ts`. Opaque to users.
- **Owner** — the destination that brought a credential into existence. When the destination goes away, its credentials do too. Owner identity is implicit in the ref (the ref *is* the owner's slot address).

---

## Architecture

### Storage — no change

`@ax/credentials` keeps the current `(scope, ownerId, ref, kind, encrypted-payload)` shape and all existing service hooks. Runtime consumers (`@ax/chat-orchestrator`, `@ax/credential-proxy`, `@ax/mcp-client`, `@ax/routines`) continue to call `credentials:get({ ref, userId })` with no protocol change.

The leak we're fixing is purely at the **creation/editing surface**.

### Deterministic ref convention

One new module: `packages/credentials/src/refs.ts`:

```ts
export type Destination =
  | { kind: 'provider'; provider: 'anthropic' }
  | { kind: 'skill-slot'; skillId: string; slot: string }
  | { kind: 'mcp-env'; serverId: string; envName: string }
  | { kind: 'mcp-header'; serverId: string; headerName: string }
  | { kind: 'routine-hmac'; agentId: string; routinePath: string };

export function refForDestination(dest: Destination): string {
  switch (dest.kind) {
    case 'provider':       return `provider:${dest.provider}`;
    case 'skill-slot':     return `skill:${dest.skillId}:${dest.slot}`;
    case 'mcp-env':        return `mcp:${dest.serverId}:env:${dest.envName}`;
    case 'mcp-header':     return `mcp:${dest.serverId}:header:${dest.headerName}`;
    case 'routine-hmac':   return `routine:${dest.agentId}:${dest.routinePath}:hmac`;
  }
}
```

The `chat-orchestrator` provider-default ref renames from `'anthropic-api'` to `'provider:anthropic'` in this PR. Wipe-and-re-enter migration (§5) makes that safe — no old credential rows survive that the rename would orphan.

### Scope is supplied by context

The (scope, ownerId) axis is determined by **which page the user is on**, not by a form field:

| Page | scope | ownerId |
|---|---|---|
| Admin → Providers | `global` | `null` |
| Admin → Agent X → Skills | `agent` | `X` |
| Admin → MCP servers (system-wide) | `global` | `null` |
| Admin → Routines → routine on agent X | `agent` | `X` |
| User Settings → My agent X → Skills | `agent` | `X` |
| User Settings → Provider override | `user` | `actor.id` |

Existing scope-precedence in the facade (user > agent > global) handles overlap unchanged.

### Lifecycle — owners delete their credentials

The 1:1 ownership invariant is upheld by the owning plugin firing deletes when destinations go away. Six wiring obligations:

| Trigger | Owner plugin | Deletes |
|---|---|---|
| `skills:delete` for skill `<id>` | `@ax/skills` | `credentials:delete` for each `skill:<id>:<slot>` across all (scope, ownerId) that had bindings. |
| Skill manifest edited to remove slot `<s>` | `@ax/skills` | per-slot `credentials:delete` for `skill:<id>:<s>`. |
| MCP server deleted | `@ax/mcp-client` | `credentials:delete` for every declared `mcp:<serverId>:env:*` and `mcp:<serverId>:header:*`. |
| MCP server config edit drops env/header | `@ax/mcp-client` | per-slot `credentials:delete`. |
| Routine deleted | `@ax/routines` | `credentials:delete` for `routine:<agentId>:<path>:hmac` if any. |
| Agent deleted | `@ax/agents` | `credentials:purge-by-owner({ scope: 'agent', ownerId: agentId })`. |
| User deleted | `@ax/auth-better` | `credentials:purge-by-owner({ scope: 'user', ownerId: userId })`. |

The provider destination never goes away, so its credentials are only deleted when an admin clicks **Clear** on the Providers tab.

### One new service hook

`credentials:purge-by-owner`:

```ts
type CredentialsPurgeByOwnerInput =
  | { scope: 'user';  ownerId: string }
  | { scope: 'agent'; ownerId: string };
type CredentialsPurgeByOwnerOutput = { deleted: number };
```

Registered by `@ax/credentials`. Called by `@ax/agents` and `@ax/auth-better` on actor deletion. Scope `'global'` is rejected (no bulk "delete every global credential" operation).

**Boundary review:**
- *Alternate impl:* a vault-backed credentials plugin implements the same purge by scoping its delete to a per-scope/per-owner vault path. No backend vocabulary leak.
- *Payload field names:* `scope` and `ownerId` are existing credentials vocabulary, not backend-specific.
- *Subscriber risk:* none — service hook, not subscriber fanout. No subscriber can key off a backend-specific field because none exists.
- *Wire surface:* not exposed as a new HTTP route. Only callable in-process from the owning plugins.

---

## UI components

### `<CredentialSlotForm>` — one component, mounted everywhere

```ts
interface CredentialSlotFormProps {
  destination: Destination;
  slot: { label: string; kind: 'api-key'; description?: string };
  scope: { scope: 'global' | 'user' | 'agent'; ownerId: string | null };
  // Current state of the credential at this destination/scope:
  current: { set: boolean; rotatedAt?: string };
  onSaved: () => void;
  onCleared: () => void;
}
```

The form internals are basically today's `ApiKeyForm`'s `payload` field — base64-encoded before leaving the component, sent via the existing `credentials:set` HTTP route (which keeps its scope+ownerId parameters as today but now sourced from props, not from user input). No `ref` field, no `kind` selector.

Mounted inside a shadcn `Sheet` triggered from a `Set credential ▸` / `Replace ▸` button. Sheet title shows the destination and slot in human terms ("Set credential for skill `linear-tracker`, slot `LINEAR_TOKEN`"). The optional `slot.description` from the skill manifest renders under the title.

### `<CredentialSlotRow>` — the row that hosts the trigger button

Used on each of the five consumer surfaces:

```ts
interface CredentialSlotRowProps {
  destination: Destination;
  slot: { label: string; kind: 'api-key'; description?: string };
  scope: { scope: 'global' | 'user' | 'agent'; ownerId: string | null };
}
```

Renders: `<slot.label>  [status pill]  [Set credential ▸]`. The row owns its own state — fetches via existing `credentials:list` filtered by ref, opens the sheet, refetches on save/clear.

### Wiring sites

**(1) Providers admin tab — new surface.**

A new file: `packages/channel-web/src/components/admin/ProvidersPanel.tsx`. One row per known provider (just Anthropic today). The list is a small hardcoded manifest exported from `@ax/chat-orchestrator` (`KNOWN_PROVIDERS: Array<{ provider: 'anthropic'; slot: 'ANTHROPIC_API_KEY'; description: string }>`) since the orchestrator owns the provider concept. Adding a second provider is one entry in that array plus the orchestrator's host/credential wiring.

Replaces the credentials admin tab in the admin navigation.

**(2) Skill attachment edit.**

In `packages/channel-web/src/components/admin/SkillAttachmentsSection.tsx` (mounted from `AgentForm.tsx`), replace the "pick existing ref" dropdown per `CapabilitySlot` with a `<CredentialSlotRow>` per slot. The agent record's `credentialBindings[slot]` field becomes vestigial — it now always equals `refForDestination({ kind: 'skill-slot', skillId, slot })`. Either keep it (set deterministically on save, never read by the UI) or drop it from the agent shape (more invasive; defer to a follow-up).

**Decision:** keep the field, write the deterministic ref into it on save. The orchestrator still reads it. No protocol change to the agent shape, just a stricter writer. Drops to "remove this field" become a one-line follow-up once we're confident.

**(3) MCP server config.**

In the MCP server admin form, replace the `credentialRefs` / `headerCredentialRefs` JSON-blob inputs with discoverable per-env / per-header rows: enumerate from the MCP server's declared transport config (env vars + headers), render a `<CredentialSlotRow>` per. Same "keep the field, write deterministic refs" pattern.

**(4) Routine webhook HMAC.**

In the routine config screen for webhook-triggered routines, replace the "HMAC secret ref" text input with a single `<CredentialSlotRow>` for the deterministic ref `routine:<agentId>:<path>:hmac`. The routine's `trigger.hmac.secretRef` field is set to the deterministic ref on save.

### Removed surfaces

- `packages/channel-web/src/components/credentials/ApiKeyForm.tsx` — deleted.
- `packages/channel-web/src/components/credentials/CredentialAddMenu.tsx` — deleted.
- `packages/channel-web/src/components/credentials/CredentialsList.tsx` — deleted.
- Credentials tab in the admin navigation — removed.
- Credentials tab in `SettingsPanel` — removed.
- HTTP routes `/admin/credentials` (POST list + DELETE), `/admin/credentials/kinds`, `/admin/credentials/oauth/*`, `/settings/credentials` — deleted in the same PR. The underlying `credentials:set` / `credentials:delete` / `credentials:list` service hooks remain (the new `<CredentialSlotForm>` HTTP wrapper calls them — see below). `credentials:list-kinds` is also retained at the service-hook layer (it's how a future credentials-store-vault could declare its kinds) but has no remaining caller in this PR.

### New HTTP routes

Two routes, both for `<CredentialSlotForm>`:

- `POST /admin/destinations/:destinationKind/credential` and `POST /settings/destinations/:destinationKind/credential` — body carries the destination's identifying fields + base64 payload. Server computes the ref, derives (scope, ownerId) from auth context + the destination kind, calls `credentials:set`.
- `DELETE` equivalents for the clear case.

Both routes live in a new `packages/credentials-admin-routes/src/destination-routes.ts` (the same package as today's routes). Existing settings/admin routes are removed in the same PR. The package keeps its name and the HTTP-route registration plumbing.

---

## Data flow

### Setting a credential (skill slot example)

1. Admin opens Admin → Agent X → Skills, sees skill `linear-tracker` attached with one slot `LINEAR_TOKEN` (status: Not set).
2. Admin clicks `Set credential ▸` → sheet opens with `<CredentialSlotForm destination={{ kind: 'skill-slot', skillId: 'linear-tracker', slot: 'LINEAR_TOKEN' }} scope={{ scope: 'agent', ownerId: X }} ...>`.
3. Admin pastes the token, clicks Save.
4. Form POSTs to `/admin/destinations/skill-slot/credential` with body `{ skillId, slot, scope, ownerId, payloadB64 }`.
5. Server computes `ref = refForDestination(destination)` → `skill:linear-tracker:LINEAR_TOKEN`.
6. Server calls `credentials:set({ scope: 'agent', ownerId: X, ref, kind: 'api-key', payload })`.
7. UI refetches; status pill flips to `Set (just now)`.
8. On the next chat send for agent X, the orchestrator reads `agent.skillAttachments[i].credentialBindings.LINEAR_TOKEN`, which already equals `skill:linear-tracker:LINEAR_TOKEN`, calls `credentials:get`, the value flows to the runner env.

### Deleting a destination (skill uninstall example)

1. Admin uninstalls skill `linear-tracker` from Admin → Skills.
2. `@ax/skills` `skills:delete` handler enumerates which agents have this skill attached (existing query).
3. For each `(agent, slot)` pair, fires `credentials:delete({ scope: 'agent', ownerId: agentId, ref: 'skill:linear-tracker:LINEAR_TOKEN' })`.
4. Also tries `credentials:delete` for any global-scope row at the same ref (`scope: 'global'`, `ownerId: null`) and any user-scope rows for users who attached this skill at user-scope.
5. The skill row itself is deleted.

(Implementation detail at §6 — the "enumerate which scopes to delete from" sub-query is the only non-trivial piece; in practice deduping via `credentials:list` filtered to `ref = skill:<id>:*` is cheaper than walking every agent.)

### Deleting an agent

1. Admin deletes agent X.
2. `@ax/agents` `agents:delete` handler calls `credentials:purge-by-owner({ scope: 'agent', ownerId: X })`.
3. One bulk DELETE inside `@ax/credentials`; returns count.
4. Agent row deleted.

---

## §5 — Migration of existing data

**Wipe-and-re-enter.** During the upgrade, drop all rows from `credentials_v1_envelopes`. The release note in the PR says:

> Credentials UX redesigned (2026-05-19). If you set up credentials via the old admin/settings credentials page, re-set them from the new destination-aware UIs: Admin → Providers (for Anthropic), the per-skill slot row on skill attachments, the per-env/per-header row on MCP server configs, and the HMAC field on webhook-triggered routines.

Rationale:

- Pre-MVP; deployed environments are dev/kind only.
- Credentials admin UI is 12 days old (PR #51, 2026-05-07).
- A big-bang ref-rewrite migration is hard to validate — if any consumer's binding isn't included in the script, runtime breaks silently when the lookup ref doesn't match the stored ref.
- Coexistence (old refs keep working at runtime, new UI uses deterministic refs) leaves cruft invisible from the new UI and adds a second mental model.

A wipe script (`packages/credentials/scripts/wipe-pre-redesign.ts`) runs once at the upgraded server's first boot, idempotent via a marker row.

---

## §6 — Testing

### Unit (per plugin)

- **`@ax/credentials`** — new test `purge-by-owner.test.ts`: happy-path bulk delete, no-match no-op, scope='global' rejected, tombstone-on-delete semantics preserved. Existing scope/precedence/list tests unchanged. New `refs.test.ts` covering the deterministic ref helper for all five destination kinds, including pathological inputs. **Escape rule:** the helper rejects identifiers containing `:` (the only reserved character) with a `PluginError` — every other character including slashes is fine because refs are opaque strings, never parsed back. Skill IDs, slot names, MCP server IDs, env-var names, header names, agent IDs, and routine paths are all already constrained by their respective plugins to avoid colons; the helper enforces the constraint at the credential-ref boundary as defense-in-depth.
- **`@ax/skills`** — `skills:delete` handler test: with N agents attaching the skill, the right per-slot deletes fire across all (scope, ownerId). Manifest-edit-drops-slot test: per-slot delete fires only for removed slots, others untouched.
- **`@ax/mcp-client`** — server-delete test: every declared env+header slot gets deleted. Config-edit-drops-env test: only the dropped slot's credential is deleted.
- **`@ax/routines`** — webhook routine delete fires the hmac credential delete.
- **`@ax/agents`** — `agents:delete` calls `credentials:purge-by-owner({ scope: 'agent', ownerId })` exactly once.
- **`@ax/auth-better`** — user-delete calls `credentials:purge-by-owner({ scope: 'user', ownerId })` exactly once.
- **`@ax/chat-orchestrator`** — existing orchestrator tests pass after the `'anthropic-api'` → `'provider:anthropic'` rename. One new test: with no provider credential set at all, `chat:end` fires a structured `terminated` outcome (rides the existing `proxy-open-failed` path) rather than a runner crash.

### Component (channel-web)

- **`<CredentialSlotForm>`** — one test per `destination.kind` proving the right deterministic ref is computed and the right HTTP route is hit. Status pill renders correctly for `set` / `not-set`. Payload base64-encoded before leaving the component (existing `ApiKeyForm` invariant carried forward).
- **`<CredentialSlotRow>`** — opens sheet on click, refetches on save, refetches on clear.
- **Providers admin tab** — lists Anthropic, opens form on click, status pill flips on save.
- **Skill attachment editor** — per-`CapabilitySlot` row replaces the old "pick ref" dropdown; sheet pre-fills with the right destination.
- **MCP server config** — per-env + per-header rows render from declared transport config.
- **Routine webhook config** — HMAC slot row renders + opens sheet.

### Integration / canary

- Existing chat canary (`acceptance.test.ts`) passes with the provider credential set via the new Providers tab — covers the rename and the destination-first set path end-to-end.
- New canary: install a skill with one declared slot, bind via the new sheet, send a message that triggers the skill, prove the credential value reaches the runner env.
- (Optional, second PR) MANUAL-ACCEPTANCE walk in kind cluster covering all five wiring sites.

### Negative / lifecycle

- Delete-the-destination tests above already cover the cleanup invariant per-plugin.
- One cross-plugin test in `acceptance.test.ts`: create a credential at every destination kind, then delete each destination, assert `credentials_v1_envelopes` ends empty.

---

## Open questions

1. **MCP server "system-wide" vs "user-personal" scope.** Today MCP servers are admin-configured globally. If a user-personal MCP server concept lands, the credential scope for `mcp-env` / `mcp-header` destinations becomes a function of where the server is configured. The deterministic ref doesn't change shape, but the (scope, ownerId) derivation does. Not blocking — single-tenant admin-only MCP today.
2. **Routine webhook HMAC on routine path renames.** If an admin renames a routine's path, the deterministic ref `routine:<agentId>:<path>:hmac` changes. We need either (a) a copy-on-rename in the routines plugin, or (b) reject the rename if the routine has a webhook HMAC credential set. Decision deferred to impl time — (b) is one line.
3. **Per-`<CredentialSlotRow>` `credentials:list` fan-out cost.** Each slot row makes one list call to determine status. A skill with five slots = five HTTP round-trips. Acceptable for v1; if we feel it, add a batch `credentials:status-many({ refs })` hook later — additive.

---

## Implementation order (one PR)

Per **I3 — no half-wired plugins**, this ships as a single PR with all six wiring sites. The internal commit order inside that PR (for review readability) is:

1. `packages/credentials/src/refs.ts` + tests.
2. `credentials:purge-by-owner` service hook + tests.
3. Provider rename `'anthropic-api'` → `'provider:anthropic'` in `chat-orchestrator` + tests.
4. Wipe script + first-boot marker.
5. `<CredentialSlotForm>` + `<CredentialSlotRow>` components + tests.
6. New HTTP routes (`destination-routes.ts`).
7. Wiring site (1) Providers admin tab.
8. Wiring site (2) Skill attachment editor — old dropdown replaced.
9. Wiring sites (3a) MCP env + (3b) MCP header.
10. Wiring site (4) Routine webhook HMAC.
11. Delete old credentials components, admin/settings credentials tabs, old HTTP routes.
12. Owning-plugin delete handlers (skills, mcp-client, routines, agents, auth-better).
13. Cross-plugin lifecycle canary.

The half-wired window opens at step 5 and closes at step 11 inside the same PR.
