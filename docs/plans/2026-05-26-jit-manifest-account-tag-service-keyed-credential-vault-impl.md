# JIT — Manifest `account` Tag + Service-Keyed Credential Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a credential slot an optional **`account`** tag (e.g. `account: linear`) so any skill whose slot declares it binds to **one shared per-user vault entry** (`account:<service>`) instead of a per-skill `skill:<id>:<slot>` entry — entered once, reused by every skill that names the same service. Backward-compatible: a slot with **no** `account` keeps today's per-skill behavior. The bundled card checks the vault first and skips re-entry ("use your existing Linear key"); revoking the shared entry pulls the credential out from under every referencing skill.

**Architecture:** The "vault" is **not a new store** — it is the existing user-scoped credential store addressed by a new opaque ref shape `account:<service>` (invariant #4: one source of truth). The `account` tag rides as an optional field on the existing `CapabilitySlot`, parsed in `@ax/skills-parser`, surfaced through `skills:get`/`skills:resolve`, and consumed at exactly two points that already exist: (a) the orchestrator's `applyCapabilityGrant` (TASK-36), which now mints `account:<service>` as the slot's binding ref when the slot declares `account`; and (b) the broker's `request_capability` card builder (TASK-35), which reads the tag, does a metadata-only vault lookup (`credentials:list`, user scope), and tags each card slot with `account` + `haveExisting`. The bundled card (`PermissionCard`) renders "use your existing key" for vaulted slots and posts new keys to a new `account` **destination kind** on the existing destination-credential route. The binding ref is a pure function of the manifest, computed identically on the card-POST side and the orchestrator-bind side, so the two never disagree.

**Tech Stack:** TypeScript, pnpm workspace, zod, vitest, React + shadcn (channel-web), testcontainers + Postgres (credentials integration).

**Design refs (LOCKED — do not relitigate):** Part II **P2** (service-keyed vault), **P7.2** (manifest `account` tag + vault + card lookup), Appendix **decision #13**. Flow §6A is the happy path the card implements.

---

## Scope guardrails & as-built reconciliation (verified against `main`, deps merged)

This card's dep **TASK-35** (bundled card) is **Done**, and so are **TASK-33** (per-user attach), **TASK-36** (apply-grant + resume), **TASK-37/39/40/41**. Verified the current shape of every contract this plan extends. Findings that **correct stale design/comment anchors**:

- **The card already attaches + resumes.** The design's "Depends on: TASK-35 (the card's vault lookup)" and the `HALF-WIRED (TASK-35)` comment in `request-capability.ts` (lines ~107–110) say the card "does NOT yet attach the skill." **Stale.** TASK-36 landed: `PermissionCard.connect()` POSTs `/api/chat/permission-decision` → `agent:apply-capability-grant` → `skills:attach-for-user` → retire warm session → resume. The binding ref is minted in `chat-orchestrator/src/orchestrator.ts` `applyCapabilityGrant` (lines ~1914–1917), **not** in the card. That is the single point where the `account`-vs-`skill` ref decision belongs.
- **There is no separate "vault" component.** `account:<service>` is just a user-scoped row in the existing credential store. `REF_RE` in `@ax/credentials` (`/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,191}$/`) already accepts `account:linear`. No new table, no new store, no migration.
- **`refForDestination` is duplicated in THREE places** (invariant I2 — no cross-plugin runtime import), drift-pinned by `KNOWN_DESTINATION_FIXTURES` in `@ax/credentials/src/refs-fixtures.ts`: the canonical `@ax/credentials/src/refs.ts`, the inlined copy in `@ax/credentials-admin-routes/src/destination-routes.ts`, and the client mirror in `@ax/channel-web/src/lib/credentials.ts`. A new destination kind must land in **all three + the fixture + the route's `DestinationSchema`** in one task or a drift test fails.
- **Open-mode authored skills can never declare `account`.** `install_authored_skill` takes slot **names only** (`slots: string[]`); `agents:install-authored-skill` builds the manifest from the model's **requested** caps (the authored file's own caps are stripped at write time — `agents/src/plugin.ts` ~394). So authored skills always bind `skill:<id>:<slot>`, the authored card is unchanged, and the card-POST↔bind invariant holds on both paths. **This closes the open-mode prompt-injection vector for `account` by construction** — only admin-reviewed catalog manifests can carry the tag.
- **The SSE skill card forwards the payload verbatim** (`channel-web/src/server/sse.ts` ~378 `safeWrite({ reqId, permissionRequest: payload })`), so new optional slot fields ride through with no `sse.ts` logic change — only the type re-declarations and their tests.

**Boundary review (no NEW service hook; one changed payload + one new destination kind):**
- *Changed payload:* `skills:get` / `skills:resolve` credential slots gain optional `account?: string`. **Storage-agnostic** — `account` is a user-facing service slug (`linear`), not backend vocab; no `sha`/`pod`/`bucket`/`socket`. **Alternate impl:** a future `@ax/skills-fs` returns the identical shape. **Subscriber risk:** consumers treat `account` as an opaque service slug used to choose a credential ref (the orchestrator + broker are the intended consumers); it is never parsed for backend meaning.
- *New destination kind* `{ kind: 'account'; service }` → ref `account:<service>`. Destination-first route (client describes WHERE, server computes the ref via `refForDestination`) — same pattern as the existing five kinds. **IPC/wire schema** (`DestinationSchema`) lives in `@ax/credentials-admin-routes` (the route owner), not a central file.
- *New call:* the broker now calls **`credentials:list`** (existing hook, metadata-only, no secret) for the vault lookup — declared as an `optionalCall` and `hasService`-gated (degrades to "always prompt").

**Security-checklist: PRE-PR GATE (required).** The card body does not name it, but this work touches **credential handling + untrusted manifest content flowing into a credential ref** — invariant #5 fires it independently. Threat model pre-stated below (Task 9). Do not open the PR until the structured note is in the description.

**Half-wired window (state in the PR):**
- **OPEN:** the `account`-destination **DELETE** (revoke) and the **"used by"** hint have **no production UI caller** — that UI is **TASK-42** (user Settings surface — Connections + Keys). They are exercised by route + integration tests here. Window **CLOSES in TASK-42**.
- **Fully wired now (NOT half-wired):** the vault **write + lookup + bind + resolve** path is end-to-end live (card → user-scoped store → `applyCapabilityGrant` binding → proxy creds map → `credentials:get`) and covered by the canary (Task 9). No shipped catalog skill declares `account` yet — that is *data*, admitted by an admin (§6D); the code path is live the moment one does.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/skills-parser/src/capabilities.ts` | public `CapabilitySlot` shape | **add** optional `account?: string` |
| `packages/skills-parser/src/manifest.ts` | manifest parse/validate | **add** `ACCOUNT_RE` + `invalid-account` code; parse `account` in `parseCredentialList` |
| `packages/skills/src/types.ts` | `skills:*` return zod schemas | **add** `account` to `CapabilitySlotSchema` (so get/resolve don't strip it) |
| `packages/credentials/src/refs.ts` | canonical `Destination` + `refForDestination` | **add** `account` kind |
| `packages/credentials/src/refs-fixtures.ts` | drift fixtures (all 3 copies) | **add** `account` fixture |
| `packages/credentials-admin-routes/src/destination-routes.ts` | inlined `refForDestination` + `DestinationSchema` | **add** `account` kind |
| `packages/channel-web/src/lib/credentials.ts` | client `refForDestination` mirror | **add** `account` case |
| `packages/chat-orchestrator/src/orchestrator.ts` | `applyCapabilityGrant` binding builder + `ResolvedSkillForOrch` | **thread** `account`; mint `account:<svc>` ref |
| `packages/skill-broker/src/tools/request-capability.ts` | card builder + vault lookup | **read** `account`; `credentials:list` lookup; add `account`/`haveExisting` to card |
| `packages/skill-broker/src/plugin.ts` | broker manifest | **add** `credentials:list` to `optionalCalls` |
| `packages/channel-web/src/server/types.ts` | `PermissionRequest` (server) | **add** `account?`/`haveExisting?` to skill-variant slots |
| `packages/channel-web/src/lib/permission-card-store.ts` | `PermissionRequest` (client mirror) | **add** `account?`/`haveExisting?` to skill-variant slots |
| `packages/channel-web/src/components/PermissionCard.tsx` | the bundled card UI | **render** "use existing key"; route POST by destination kind |
| `packages/credentials/src/__tests__/vault.test.ts` | **new** — shared-ref reuse + revoke property | **create** |

---

## Shared rule: the `account` service grammar (referenced by Tasks 1, 4, 6, and the route in Task 3)

A valid **`account` service** is a lowercase service slug:

```
ACCOUNT_RE = /^[a-z][a-z0-9-]{0,63}$/
```

- lowercase only (so `Linear` and `linear` can't fork into two vault entries),
- no `:` (the credential-ref separator — also independently re-asserted by `refForDestination`'s `assertNoColon`),
- 1–64 chars, starts with a letter.

The resulting ref is `account:<service>` (e.g. `account:linear`), always stored at **user scope** (the vault is user-scoped + shared — design P1). This grammar is re-validated **independently** at three trust boundaries (no shared import — invariant I2): the manifest parser (`@ax/skills-parser`, Task 1), the destination route schema (`@ax/credentials-admin-routes`, Task 3), and `refForDestination`'s colon guard (`@ax/credentials` + its two copies, Task 3).

---

### Task 1: Parse the manifest `account` tag

**Files:**
- Modify: `packages/skills-parser/src/capabilities.ts`
- Modify: `packages/skills-parser/src/manifest.ts`
- Test: `packages/skills-parser/src/__tests__/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `manifest.test.ts` (mirrors the existing `parseSkillManifest` + `r.ok`/`r.value` pattern):

```typescript
it('parses an optional account tag on a credential slot', () => {
  const r = parseSkillManifest(
    [
      'name: linear',
      'description: Linear issues',
      'capabilities:',
      '  credentials:',
      '    - slot: LINEAR_TOKEN',
      '      kind: api-key',
      '      account: linear',
    ].join('\n'),
  );
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.capabilities.credentials).toEqual([
    { slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear' },
  ]);
});

it('omits account when absent (back-compat: today’s shape unchanged)', () => {
  const r = parseSkillManifest(
    'name: x\ndescription: x\ncapabilities:\n  credentials:\n    - slot: API_KEY\n      kind: api-key',
  );
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.capabilities.credentials[0]).toEqual({ slot: 'API_KEY', kind: 'api-key' });
  expect('account' in r.value.capabilities.credentials[0]!).toBe(false);
});

it.each([['Linear'], ['lin:ear'], ['linear_app'], ['-linear'], ['']])(
  'rejects an invalid account value %j with invalid-account',
  (bad) => {
    const r = parseSkillManifest(
      `name: x\ndescription: x\ncapabilities:\n  credentials:\n    - slot: API_KEY\n      kind: api-key\n      account: ${JSON.stringify(bad)}`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-account');
  },
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills-parser test -- src/__tests__/manifest.test.ts`
Expected: FAIL — `account` is dropped (not on the parsed slot) and `invalid-account` is not a known code.

- [ ] **Step 3: Add `account` to the slot type**

In `packages/skills-parser/src/capabilities.ts`:

```typescript
export interface CapabilitySlot {
  slot: string;
  kind: 'api-key';
  description?: string;
  /**
   * Optional service identifier (JIT P2/P7.2, decision #13). When set, the
   * slot binds to the user's SHARED service-keyed vault entry (`account:<service>`)
   * instead of a per-skill ref. Lowercase slug; absent = today's per-skill behavior.
   */
  account?: string;
}
```

- [ ] **Step 4: Add the code + grammar + parse it**

In `packages/skills-parser/src/manifest.ts`, add `'invalid-account'` to the `ManifestCode` union (next to `'invalid-slot' | 'duplicate-slot'`, ~lines 13–14), add the grammar near `SLOT_RE` (~line 72):

```typescript
// Account (service) slug: lowercase, starts with a letter, no ':' (ref separator).
const ACCOUNT_RE = /^[a-z][a-z0-9-]{0,63}$/;
```

Then inside `parseCredentialList`, after the `description` check and before the `out.push(...)` (~line 165), parse `account`:

```typescript
const rawAccount = cred['account'];
if (rawAccount !== undefined && (typeof rawAccount !== 'string' || !ACCOUNT_RE.test(rawAccount))) {
  return {
    ok: false,
    code: 'invalid-account',
    message: `"${contextLabel}" entry "account" on slot "${rawSlot}" must match /^[a-z][a-z0-9-]{0,63}$/, got: ${JSON.stringify(rawAccount)}`,
  };
}
```

and extend the pushed object:

```typescript
out.push({
  slot: rawSlot,
  kind: 'api-key',
  ...(rawDescription !== undefined ? { description: rawDescription } : {}),
  ...(rawAccount !== undefined ? { account: rawAccount } : {}),
});
```

(`buildSkillManifestYaml` in `build.ts` spreads `c.credentials` verbatim — line ~31 — so `account` round-trips on re-serialize with no further change.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/skills-parser test`
Expected: PASS (whole package green).

- [ ] **Step 6: Commit**

```bash
git add packages/skills-parser/src/capabilities.ts packages/skills-parser/src/manifest.ts packages/skills-parser/src/__tests__/manifest.test.ts
git commit -m "feat(skills-parser): optional account tag on credential slots"
```

---

### Task 2: Surface `account` through `skills:get` / `skills:resolve`

**Files:**
- Modify: `packages/skills/src/types.ts`
- Test: `packages/skills/src/__tests__/return-schemas.test.ts`

The hook bus strips keys not declared on a hook's `returns` schema (`hook-bus.ts`). `CapabilitySlotSchema` (`types.ts` ~line 209) currently lacks `account`, so even though the parser keeps it (Task 1), `skills:get`/`skills:resolve` would silently drop it. This task adds it to the schema so it survives the return-validation strip.

- [ ] **Step 1: Write the failing test**

Add to `return-schemas.test.ts` (mirror the existing per-schema round-trip guards in that file):

```typescript
import { SkillsGetOutputSchema } from '../types.js';

it('SkillsGetOutputSchema preserves the credential account tag', () => {
  const detail = {
    id: 'linear',
    description: 'd',
    version: 1,
    capabilities: {
      allowedHosts: ['api.linear.app'],
      credentials: [{ slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear' }],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
    },
    defaultAttached: false,
    updatedAt: new Date(0).toISOString(),
    scope: 'global',
    bodyMd: '# x',
    manifestYaml: 'name: linear',
    files: [],
  };
  const parsed = (SkillsGetOutputSchema as unknown as { parse: (v: unknown) => typeof detail }).parse(detail);
  expect(parsed.capabilities.credentials[0]!.account).toBe('linear');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/return-schemas.test.ts`
Expected: FAIL — `account` is stripped by the schema (`parsed.capabilities.credentials[0].account` is `undefined`).

- [ ] **Step 3: Add `account` to `CapabilitySlotSchema`**

In `packages/skills/src/types.ts` (~line 209):

```typescript
const CapabilitySlotSchema = z.object({
  slot: z.string(),
  kind: z.literal('api-key'),
  description: z.string().optional(),
  account: z.string().optional(), // JIT P2/P7.2 — service-keyed vault tag
});
```

(This one schema feeds `SkillDetailSchema`, `ResolvedSkillSchema`, and the MCP-server `credentials` array, so `skills:get`, `skills:resolve`, and `skills:list-defaults` all preserve `account` after this single change.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/return-schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/types.ts packages/skills/src/__tests__/return-schemas.test.ts
git commit -m "feat(skills): preserve credential account tag through get/resolve return schemas"
```

---

### Task 3: Add the `account` credential destination kind (all three ref copies + route)

**Files:**
- Modify: `packages/credentials/src/refs.ts`
- Modify: `packages/credentials/src/refs-fixtures.ts`
- Modify: `packages/credentials-admin-routes/src/destination-routes.ts`
- Modify: `packages/channel-web/src/lib/credentials.ts`
- Test: `packages/credentials/src/__tests__/refs.test.ts`
- Test: `packages/credentials-admin-routes/src/__tests__/destination-handlers.test.ts`

> All three `refForDestination` copies + the fixture + the route's `DestinationSchema` change together so the drift guards (`refs-drift.test.ts` in credentials-admin-routes; the channel-web ref test) stay green.

- [ ] **Step 1: Write the failing tests**

Add to `packages/credentials/src/__tests__/refs.test.ts`:

```typescript
it('mints account:<service> for an account destination', () => {
  expect(refForDestination({ kind: 'account', service: 'linear' })).toBe('account:linear');
});

it('rejects a service containing the ref separator', () => {
  expect(() => refForDestination({ kind: 'account', service: 'lin:ear' })).toThrow(/must not contain/);
});
```

Add to `packages/credentials-admin-routes/src/__tests__/destination-handlers.test.ts` (mirror the existing skill-slot create/delete cases in that file — same `createDestinationHandlers` + `RouteRequest` stub harness):

```typescript
it('POST /settings/destinations/account/credential stores under account:<service> at user scope', async () => {
  const { create } = makeHandlers(); // existing helper that wires deps.bus to a capturing credentials:set stub
  const res = makeRes();
  await create(
    makeReq({
      params: { destinationKind: 'account' },
      actorUserId: 'user-1',
      body: {
        destination: { kind: 'account', service: 'linear' },
        scope: 'user',
        ownerId: null,
        kind: 'api-key',
        payloadB64: Buffer.from('secret').toString('base64'),
      },
    }),
    res,
  );
  expect(res.statusCode).toBe(204);
  expect(captured.set).toMatchObject({ scope: 'user', ref: 'account:linear', kind: 'api-key' });
});

it('rejects an account destination whose kind mismatches the route param', async () => {
  const { create } = makeHandlers();
  const res = makeRes();
  await create(
    makeReq({
      params: { destinationKind: 'skill-slot' },
      body: { destination: { kind: 'account', service: 'linear' }, scope: 'user', ownerId: null, kind: 'api-key', payloadB64: 'eA==' },
    }),
    res,
  );
  expect(res.statusCode).toBe(400);
});
```

(If `makeHandlers`/`makeReq`/`captured` differ in the file, reuse whatever the existing skill-slot tests use — the assertion that matters is `ref === 'account:linear'` at `scope: 'user'`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @ax/credentials test -- src/__tests__/refs.test.ts` and `pnpm -F @ax/credentials-admin-routes test`
Expected: FAIL — `account` is not a known `Destination` kind / `DestinationSchema` rejects it.

- [ ] **Step 3: Add the kind to the canonical ref + fixture**

In `packages/credentials/src/refs.ts`, extend the union and the switch:

```typescript
export type Destination =
  | { kind: 'provider'; provider: string }
  | { kind: 'skill-slot'; skillId: string; slot: string }
  | { kind: 'mcp-env'; serverId: string; envName: string }
  | { kind: 'mcp-header'; serverId: string; headerName: string }
  | { kind: 'routine-hmac'; agentId: string; routinePath: string }
  | { kind: 'account'; service: string }; // JIT P2 — service-keyed user vault
```

and in `refForDestination`:

```typescript
    case 'account':
      assertNoColon('service', dest.service);
      return `account:${dest.service}`;
```

In `packages/credentials/src/refs-fixtures.ts`, append to `KNOWN_DESTINATION_FIXTURES`:

```typescript
  {
    destination: { kind: 'account', service: 'linear' },
    expectedRef: 'account:linear',
  },
```

- [ ] **Step 4: Add the kind to the inlined route copy + schema**

In `packages/credentials-admin-routes/src/destination-routes.ts`, mirror the same `case 'account'` in the file-local `refForDestination`, and add the discriminated-union variant to `DestinationSchema` (`.strict()`, with the service grammar re-validated independently — invariant I2):

```typescript
  z
    .object({
      kind: z.literal('account'),
      service: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]{0,63}$/, 'invalid account service'),
    })
    .strict(),
```

- [ ] **Step 5: Add the kind to the client mirror**

In `packages/channel-web/src/lib/credentials.ts`, add the case to the client `refForDestination` switch (the generic `setDestinationCredential`/`clearDestinationCredential` already key off `destination.kind`, so they need no change — only the switch must stay exhaustive):

```typescript
    case 'account':
      return `account:${dest.service}`;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm -F @ax/credentials test && pnpm -F @ax/credentials-admin-routes test && pnpm -F @ax/channel-web test -- src/lib`
Expected: PASS — canonical ref test, both drift guards, and the route create/mismatch tests all green.

- [ ] **Step 7: Commit**

```bash
git add packages/credentials/src/refs.ts packages/credentials/src/refs-fixtures.ts packages/credentials/src/__tests__/refs.test.ts packages/credentials-admin-routes/src/destination-routes.ts packages/credentials-admin-routes/src/__tests__/destination-handlers.test.ts packages/channel-web/src/lib/credentials.ts
git commit -m "feat(credentials): account:<service> destination kind across all ref copies + route schema"
```

---

### Task 4: Vault property — shared-ref reuse + revoke pulls from every skill

**Files:**
- Create: `packages/credentials/src/__tests__/vault.test.ts`

This is the explicit test for the design requirement *"Revoking a vault entry pulls the credential out from under every referencing skill."* It proves the property falls out of the shared `account:<service>` ref: two skills with distinct slots both bind to `account:linear`; one delete revokes both. No production code change — this is a guard that locks the property in.

- [ ] **Step 1: Write the failing test**

Create `packages/credentials/src/__tests__/vault.test.ts`, reusing the in-memory storage + credentials harness from `colon-refs.test.ts` (copy its `memStoragePlugin()` + `bootstrap` setup verbatim):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, makeAgentContext, bootstrap, PluginError } from '@ax/core';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';
// ...memStoragePlugin() copied from colon-refs.test.ts...

describe('service-keyed credential vault (account:<service>)', () => {
  let bus: HookBus;
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'user-1' });
  const enc = (s: string) => new TextEncoder().encode(s);

  beforeEach(async () => {
    bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
    });
  });

  it('one vaulted entry resolves for two skills that both bind account:linear', async () => {
    await bus.call('credentials:set', ctx, {
      scope: 'user', ownerId: 'user-1', ref: 'account:linear', kind: 'api-key', payload: enc('lin-key'),
    });
    // Skill A's slot binds account:linear; Skill B's different slot binds the same ref.
    const a = await bus.call('credentials:get', ctx, { ref: 'account:linear', userId: 'user-1' });
    const b = await bus.call('credentials:get', ctx, { ref: 'account:linear', userId: 'user-1' });
    expect(a).toBe('lin-key');
    expect(b).toBe('lin-key');
  });

  it('revoking the vault entry removes it from under every referencing skill', async () => {
    await bus.call('credentials:set', ctx, {
      scope: 'user', ownerId: 'user-1', ref: 'account:linear', kind: 'api-key', payload: enc('lin-key'),
    });
    await bus.call('credentials:delete', ctx, { scope: 'user', ownerId: 'user-1', ref: 'account:linear' });
    await expect(bus.call('credentials:get', ctx, { ref: 'account:linear', userId: 'user-1' })).rejects.toThrow(
      /credential-not-found|no credential/i,
    );
  });

  it('a different user does not see another user’s vault entry', async () => {
    await bus.call('credentials:set', ctx, {
      scope: 'user', ownerId: 'user-1', ref: 'account:linear', kind: 'api-key', payload: enc('lin-key'),
    });
    const other = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'user-2' });
    await expect(bus.call('credentials:get', other, { ref: 'account:linear', userId: 'user-2' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails (then passes)**

Run: `pnpm -F @ax/credentials test -- src/__tests__/vault.test.ts`
Expected: the first run after Task 3 should **PASS** (the property already holds via the shared ref). If the harness import shape differs, fix the harness only — the assertions are the contract. (If you prefer strict red-green, write the assertions first against a typo’d ref to see them fail, then correct.)

- [ ] **Step 3: Commit**

```bash
git add packages/credentials/src/__tests__/vault.test.ts
git commit -m "test(credentials): vault shared-ref reuse + revoke-pulls-from-all + user isolation"
```

---

### Task 5: Orchestrator mints the `account:<service>` binding ref

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`

`applyCapabilityGrant` (TASK-36, ~lines 1892–1938) builds `credentialBindings` slot→ref. Today every slot maps to `skill:<id>:<slot>`. This task makes it consult the resolved manifest's `account` tag: `account` present → `account:<service>`; absent → `skill:<id>:<slot>` (unchanged). The runtime resolution loop (~1271–1302) reads the *stored* ref unchanged — it never recomputes — so only the attach-time builder changes, and the ref the card POSTs to (Task 8) is the same pure function of the manifest.

- [ ] **Step 1: Write the failing test**

Add to `orchestrator.test.ts` (mirror the existing `applyCapabilityGrant` / `agent:apply-capability-grant` test that stubs `skills:resolve` + captures `skills:attach-for-user`):

```typescript
it('binds an account-tagged slot to account:<service> and a plain slot to skill:<id>:<slot>', async () => {
  const captured: { credentialBindings?: Record<string, string> } = {};
  // stub skills:resolve to return one account-tagged slot + one plain slot
  bus.registerService('skills:resolve', 'skills', async () => ({
    skills: [{
      id: 'linear',
      capabilities: {
        allowedHosts: ['api.linear.app'],
        credentials: [
          { slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear' },
          { slot: 'EXTRA', kind: 'api-key' },
        ],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      },
      bodyMd: '', manifestYaml: '', files: [],
    }],
  }));
  bus.registerService('skills:attach-for-user', 'skills', async (_c, input: any) => {
    captured.credentialBindings = input.credentialBindings;
    return { created: true };
  });

  await bus.call('agent:apply-capability-grant', grantCtx, {
    conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'linear',
  });

  expect(captured.credentialBindings).toEqual({
    LINEAR_TOKEN: 'account:linear',
    EXTRA: 'skill:linear:EXTRA',
  });
});
```

(Use whatever `bus`/`grantCtx`/session stubs the file's existing apply-capability-grant test already sets up; `session:is-alive` can return `{ alive: false }` so the retire branch no-ops.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/chat-orchestrator test -- src/__tests__/orchestrator.test.ts`
Expected: FAIL — both slots bind `skill:linear:<slot>`; `LINEAR_TOKEN` is not `account:linear`.

- [ ] **Step 3: Thread `account` into the resolved-skill type + binding builder**

In `orchestrator.ts`, extend the local `ResolvedSkillForOrch.capabilities.credentials` element (~line 227) to carry `account`:

```typescript
    credentials: Array<{ slot: string; kind: string; description?: string; account?: string }>;
```

(and the same on `McpServerSpecForOrch.credentials` ~line 221 for shape parity).

Then rewrite the `applyCapabilityGrant` slot resolution + binding loop (~lines 1899–1917):

```typescript
    let declaredSlots: Array<{ slot: string; account?: string }> = [];
    if (bus.hasService('skills:resolve')) {
      const r = await bus.call<SkillsResolveInput, SkillsResolveOutput>(
        'skills:resolve', ctx, { skillIds: [input.skillId], ownerUserId: input.userId },
      );
      declaredSlots =
        r.skills[0]?.capabilities.credentials.map((c) => ({
          slot: c.slot,
          ...(c.account !== undefined ? { account: c.account } : {}),
        })) ?? [];
    }

    // Per-slot ref: a slot tagged `account: <svc>` binds the SHARED user vault
    // entry `account:<svc>` (JIT P2/decision #13); an untagged slot keeps the
    // per-skill `skill:<id>:<slot>` ref. The card (request_capability + the
    // PermissionCard POST) derives the IDENTICAL ref from the same manifest, so
    // the stored key and this binding always address the same row. Local
    // re-derivation (no @ax/credentials import — I2), same posture as
    // credentials-admin-routes inlining refForDestination.
    const credentialBindings: Record<string, string> = {};
    for (const s of declaredSlots) {
      credentialBindings[s.slot] =
        s.account !== undefined ? `account:${s.account}` : `skill:${input.skillId}:${s.slot}`;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/chat-orchestrator test`
Expected: PASS (whole package green).

- [ ] **Step 5: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/__tests__/orchestrator.test.ts
git commit -m "feat(orchestrator): apply-capability-grant binds account-tagged slots to the shared vault ref"
```

---

### Task 6: Broker card vault lookup (`account` + `haveExisting`)

**Files:**
- Modify: `packages/skill-broker/src/tools/request-capability.ts`
- Modify: `packages/skill-broker/src/plugin.ts`
- Test: `packages/skill-broker/src/__tests__/plugin.test.ts`

`request_capability` reads the catalog skill (`skills:get`), now carrying `account` per slot (Task 2). For each slot, it does a **metadata-only** vault lookup (`credentials:list`, user scope) and tags the card slot with `account` + `haveExisting`. The secret never crosses; the broker only learns whether a `account:<service>` ref already exists for the user.

- [ ] **Step 1: Write the failing test**

Extend `busWithStubs()` in `plugin.test.ts` so `skills:get` for `linear` returns an account-tagged slot and a `credentials:list` stub is wired:

```typescript
  // in skills:get for 'linear', return the account tag:
  credentials: [{ slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear' }],
  // ...
  // add a configurable credentials:list stub:
  bus.registerService('credentials:list', 'creds', async (_c, input: unknown) => {
    void input;
    return { credentials: vaultRefs.map((ref) => ({ scope: 'user', ownerId: 'user-1', ref, kind: 'api-key', createdAt: new Date(0).toISOString() })) };
  });
```

(where `vaultRefs: string[]` is a closure the test flips). Then:

```typescript
it('card marks haveExisting:true + account when the user already has the vaulted key', async () => {
  const { bus, setVault } = busWithStubs();
  setVault(['account:linear']);
  await createSkillBrokerPlugin().init({ bus, config: {} as never });
  const cards: any[] = [];
  bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => { cards.push(p); return undefined; });
  await bus.call('tool:execute:request_capability', convCtx, { name: 'request_capability', input: { skillId: 'linear' } });
  expect(cards[0].slots).toEqual([{ slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear', haveExisting: true }]);
});

it('card marks haveExisting:false when the vault has no entry yet', async () => {
  const { bus, setVault } = busWithStubs();
  setVault([]); // empty vault
  await createSkillBrokerPlugin().init({ bus, config: {} as never });
  const cards: any[] = [];
  bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => { cards.push(p); return undefined; });
  await bus.call('tool:execute:request_capability', convCtx, { name: 'request_capability', input: { skillId: 'linear' } });
  expect(cards[0].slots[0]).toMatchObject({ slot: 'LINEAR_TOKEN', account: 'linear', haveExisting: false });
});
```

Update the **existing** exact-equality card test (~line 157) — make the stub `linear` skill's slot account-free (`{ slot: 'api_key', kind: 'api-key' }`) and assert the card slot is `{ slot: 'api_key', kind: 'api-key', haveExisting: false }` (no `account` key for an untagged slot).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skill-broker test`
Expected: FAIL — card slots carry neither `account` nor `haveExisting`.

- [ ] **Step 3: Implement the lookup + enriched card**

In `request-capability.ts`, extend the local `CatalogSkillDetail` credentials shape and the card `PermissionRequestEvent.slots`:

```typescript
interface CatalogSkillDetail {
  id: string;
  description: string;
  capabilities: {
    allowedHosts: string[];
    credentials: { slot: string; kind: 'api-key'; account?: string }[];
  };
}

interface PermissionRequestEvent {
  kind: 'skill';
  skillId: string;
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key'; account?: string; haveExisting?: boolean }[];
}

// Minimal local mirror (I2 — no @ax/credentials import). credentials:list
// returns metadata only — refs + kinds, NEVER a secret value.
interface CredentialsListOutput {
  credentials: Array<{ ref: string }>;
}
```

Then in the handler, after `detail` is fetched and before building the card, do the vault lookup (gated; degrade to "always prompt"):

```typescript
// Vault lookup (JIT P2): which account:<service> refs does this user already
// have? Metadata-only (credentials:list, user scope) — the secret never crosses
// this boundary; we only learn EXISTENCE so the card can offer "use your
// existing <service> key". Gated by hasService so credential-less presets
// degrade to always-prompt.
const vaulted = new Set<string>();
if (bus.hasService('credentials:list')) {
  try {
    const list = await bus.call<{ scope: 'user'; ownerId: string }, CredentialsListOutput>(
      'credentials:list', toolCtx, { scope: 'user', ownerId: toolCtx.userId },
    );
    for (const c of list.credentials) vaulted.add(c.ref);
  } catch {
    // Best-effort: a failed lookup just means the card prompts. Never block the card.
  }
}

const card: PermissionRequestEvent = {
  kind: 'skill',
  skillId,
  description: detail.description,
  hosts: detail.capabilities.allowedHosts,
  slots: detail.capabilities.credentials.map((c) => ({
    slot: c.slot,
    kind: 'api-key' as const,
    ...(c.account !== undefined ? { account: c.account } : {}),
    haveExisting: c.account !== undefined && vaulted.has(`account:${c.account}`),
  })),
};
await bus.fire('chat:permission-request', toolCtx, card);
```

In `packages/skill-broker/src/plugin.ts`, add the optional dependency to the manifest:

```typescript
      optionalCalls: [
        {
          hook: 'credentials:list',
          degradation:
            'the approval card cannot offer "use your existing key"; every credential slot is always prompted',
        },
        ...(allowUserInstalledSkills ? [/* existing agents:install-authored-skill entry */] : []),
      ],
```

(Keep the existing `agents:install-authored-skill` optionalCall; just prepend the `credentials:list` entry. A hook may appear in `calls` **or** `optionalCalls`, never both — `credentials:list` is in neither today, so this is clean.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skill-broker test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skill-broker/src/tools/request-capability.ts packages/skill-broker/src/plugin.ts packages/skill-broker/src/__tests__/plugin.test.ts
git commit -m "feat(skill-broker): card vault lookup — account + haveExisting per slot"
```

---

### Task 7: Thread `account`/`haveExisting` through the channel-web card payload

**Files:**
- Modify: `packages/channel-web/src/server/types.ts`
- Modify: `packages/channel-web/src/lib/permission-card-store.ts`
- Test: `packages/channel-web/src/__tests__/transport.test.ts`
- Test: `packages/channel-web/src/__tests__/server/sse.test.ts`

The SSE skill card forwards the payload verbatim (`sse.ts` ~378), so this is a type-and-test task: the server `PermissionRequest` and the client store mirror gain the optional fields, and the transport/SSE tests prove they survive the round-trip to the browser.

- [ ] **Step 1: Write the failing test**

In `transport.test.ts`, extend the existing `permissionRequest` skill frame (~line 187) to include the new fields and assert they decode onto the store request:

```typescript
// frame line gains an account-tagged, already-vaulted slot:
'data: {"reqId":"r1","permissionRequest":{"kind":"skill","skillId":"linear","description":"Read your Linear issues","hosts":["api.linear.app"],"slots":[{"slot":"LINEAR_TOKEN","kind":"api-key","account":"linear","haveExisting":true}]}}\n\n' +
// ...
expect(req.slots).toEqual([{ slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear', haveExisting: true }]);
```

In `sse.test.ts`, add to an existing skill-card forwarding case a slot carrying `account`/`haveExisting` and assert the written frame’s `permissionRequest.slots[0]` preserves both.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/transport.test.ts src/__tests__/server/sse.test.ts`
Expected: FAIL — the new slot fields are dropped by the typed decode (or the type doesn't compile).

- [ ] **Step 3: Add the optional fields to both `PermissionRequest` declarations**

In `packages/channel-web/src/server/types.ts`, the skill variant slots (~line 122):

```typescript
      slots: {
        slot: string;
        kind: 'api-key';
        /** JIT P2 — service slug; when set, the key binds the shared vault entry. */
        account?: string;
        /** JIT P2 — the user already has account:<service>; card shows "use existing". */
        haveExisting?: boolean;
      }[];
```

Mirror the identical change in `packages/channel-web/src/lib/permission-card-store.ts` (~line 29). Both are hand-kept in sync (I2 — no shared import), same posture as today.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/transport.test.ts src/__tests__/server/sse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/server/types.ts packages/channel-web/src/lib/permission-card-store.ts packages/channel-web/src/__tests__/transport.test.ts packages/channel-web/src/__tests__/server/sse.test.ts
git commit -m "feat(channel-web): carry account/haveExisting on the permission-request card payload"
```

---

### Task 8: `PermissionCard` — "use existing key" + destination-routed POST

**Files:**
- Modify: `packages/channel-web/src/components/PermissionCard.tsx`
- Test: `packages/channel-web/src/__tests__/permission-card.test.tsx`

> **Invoke the `shadcn` skill** before editing this component (invariant #6). Compose existing primitives (`Badge`, `Label`, `Input`, `Alert`) with semantic tokens — no new hand-rolled UI. No new primitive is required.

Render rules for each skill-card slot:
- `haveExisting === true` → a read-only row "Using your existing **{Service}** key" (a `Badge` + muted text), **no input**, counts as already-filled, **no POST** on Connect.
- `account` set, `haveExisting` falsy → an `Input`; on Connect, POST to the **`account`** destination (`{ kind: 'account', service: account }`).
- no `account` → an `Input`; on Connect, POST to the **`skill-slot`** destination (today's behavior).

- [ ] **Step 1: Write the failing test**

Add to `permission-card.test.tsx` (it already mocks `@/lib/credentials`'s `setDestinationCredential` and inspects POST URLs):

```typescript
it('skips the field and posts nothing for a slot already in the vault', async () => {
  permissionCardActions.show({
    kind: 'skill', skillId: 'linear', description: 'd', hosts: ['api.linear.app'],
    slots: [{ slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear', haveExisting: true }],
  });
  render(<PermissionCard />);
  // No password input for the vaulted slot; the "use existing" hint is shown.
  expect(screen.queryByLabelText('LINEAR_TOKEN')).toBeNull();
  expect(screen.getByText(/use your existing/i)).toBeInTheDocument();
  // Connect is enabled with no typing (slot counts as filled).
  await userEvent.click(screen.getByRole('button', { name: /connect/i }));
  // No credential POST happened for the vaulted slot.
  expect(setDestinationCredentialMock).not.toHaveBeenCalled();
});

it('posts an account-tagged slot to the account destination', async () => {
  permissionCardActions.show({
    kind: 'skill', skillId: 'linear', description: 'd', hosts: [],
    slots: [{ slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear', haveExisting: false }],
  });
  render(<PermissionCard />);
  await userEvent.type(screen.getByLabelText('LINEAR_TOKEN'), 'lin-secret');
  await userEvent.click(screen.getByRole('button', { name: /connect/i }));
  expect(setDestinationCredentialMock).toHaveBeenCalledWith(
    expect.objectContaining({ destination: { kind: 'account', service: 'linear' } }),
  );
});
```

(Keep the existing assertion that an account-free slot still POSTs to `/settings/destinations/skill-slot/credential`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card.test.tsx`
Expected: FAIL — the field always renders; POST always targets `skill-slot`.

- [ ] **Step 3: Implement the render + POST routing**

In `PermissionCard.tsx`, update `allSlotsFilled` so vaulted slots count as filled:

```typescript
  const allSlotsFilled =
    request === null ||
    request.kind !== 'skill' ||
    request.slots.every((s) => s.haveExisting === true || (values[s.slot] ?? '').trim().length > 0);
```

In `connect()`, route the POST by destination kind and skip vaulted slots:

```typescript
      for (const s of request.slots) {
        if (s.haveExisting === true) continue; // already in the vault — nothing to write
        const payload = (values[s.slot] ?? '').trim();
        if (payload.length === 0) continue;
        const destination =
          s.account !== undefined
            ? ({ kind: 'account', service: s.account } as const)
            : ({ kind: 'skill-slot', skillId: request.skillId, slot: s.slot } as const);
        await setDestinationCredential({
          destination,
          slot: { kind: 'api-key' },
          scope: { scope: 'user', ownerId: null },
          payload,
        });
      }
```

In the slot-render map, branch on `haveExisting`:

```tsx
        {request.slots.map((s) =>
          s.haveExisting === true ? (
            <div key={s.slot} className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="secondary">{s.account ?? s.slot}</Badge>
              <span>
                Using your existing{' '}
                {(s.account ?? s.slot).charAt(0).toUpperCase() + (s.account ?? s.slot).slice(1)} key
              </span>
            </div>
          ) : (
            <div key={s.slot} className="grid gap-1.5">
              <Label htmlFor={`perm-cred-${s.slot}`}>{s.slot}</Label>
              <Input
                id={`perm-cred-${s.slot}`}
                type="password"
                autoComplete="off"
                value={values[s.slot] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [s.slot]: e.target.value }))}
              />
            </div>
          ),
        )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/PermissionCard.tsx packages/channel-web/src/__tests__/permission-card.test.tsx
git commit -m "feat(channel-web): PermissionCard uses existing vaulted key + posts account destinations"
```

---

### Task 9: End-to-end canary + full verification + security-checklist

**Files:**
- Modify: an existing JIT/credentials e2e canary — `packages/credential-proxy/src/__tests__/reactive-wall.canary.test.ts` is the closest cross-plugin harness (bootstraps credentials + proxy + skills); add a focused vault case there, or co-locate a new `vault.canary.test.ts` if that file's harness can't be extended cleanly.

- [ ] **Step 1: Write the canary case (the design P8 assertion)**

Bootstrap credentials + storage + skills (+ the broker if the harness supports it). Assert the full **service-keyed reuse** path:

1. Upsert two GLOBAL catalog skills, each declaring a slot with `account: linear` (distinct slot names, distinct ids).
2. Store the user's key once at `account:linear` (user scope) via the destination route / `credentials:set`.
3. For **skill A**: `request_capability` fires a card whose slot has `haveExisting: true` (the key is already vaulted — *no re-prompt*).
4. `applyCapabilityGrant` for both skills binds the slot to `account:linear` (assert the captured `skills:attach-for-user` bindings).
5. Resolve the credential for both skills' bindings → both return the same key.
6. Delete `account:linear` → resolving either now fails (revoke-pulls-from-all).
7. **Back-compat guard:** a third skill with an account-free slot still binds `skill:<id>:<slot>` and prompts (no `haveExisting`).

- [ ] **Step 2: Run the canary**

Run: `pnpm -F @ax/credential-proxy test -- src/__tests__/reactive-wall.canary.test.ts` (or your new canary file)
Expected: PASS.

- [ ] **Step 3: Full build + test + lint (pre-PR gate)**

Run:
```bash
pnpm build
pnpm test
pnpm lint
```
Expected: all green. (Repo convention — `build` catches undeclared workspace deps vitest tolerates; the three `refForDestination` drift tests + the broker manifest `verifyCalls` are the cross-package guards.)

- [ ] **Step 4: Run the security-checklist skill (REQUIRED — pre-state below, then complete it)**

Invoke the `security-checklist` skill and answer all three threat models. Pre-stated analysis to confirm/refine:

- **Prompt injection / credential confusion (PRIMARY).** A catalog manifest declares `account: linear` so the card offers the user's existing Linear key — but the skill reaches `evil.com`. **Mitigations, in place:** (1) the card is the security boundary (decision #6) — it always renders the hosts the skill reaches, so the user sees `evil.com` before approving; (2) only **admin-reviewed catalog** manifests can carry `account` — open-mode authored skills can't (the tool takes slot names only, the manifest is built from requested caps), closing the model-injection path by construction; (3) admin review is the supply-chain gate for share-to-catalog submissions (§6D); (4) the `account` value is bounded by a strict lowercase grammar with **no `:`** so it can't inject a different ref shape. **Residual (accepted, design-locked):** the card does not require the skill's hosts to match what the vaulted key was originally approved for — a socially-engineered user could reuse a key for a mismatched host; the host display is the mitigation. Note a future hardening: warn on host-mismatch. Do **not** add a host-match gate here — decision #13 + P2 lock the "any skill with `account: X` binds" behavior.
- **Sandbox escape.** N/A — no sandbox boundary changes. The credential value still never enters the sandbox: the proxy resolves the opaque `account:<svc>` ref to an `ax-cred:` placeholder; the runner only ever sees the placeholder (I1 unchanged).
- **Supply chain.** No new dependencies. The only new external-influenced string is the manifest `account` value, validated independently at three boundaries (parser, route schema, `assertNoColon`) — invariant I2/I5.

Paste the structured note into the PR.

- [ ] **Step 5: Commit + open PR**

```bash
git add packages/credential-proxy/src/__tests__/   # or your canary path
git commit -m "test(jit): canary — service-keyed vault reuse, revoke-pulls-from-all, back-compat"
```

PR description must include:
- **Boundary review:** changed payload `account?: string` on credential slots (storage-agnostic; alternate impl `@ax/skills-fs`; subscribers treat it as an opaque service slug) + new `account` destination kind (destination-first route; schema in `@ax/credentials-admin-routes`) + new `credentials:list` optionalCall on the broker (metadata-only). No new service hook.
- **Half-wired window OPEN:** `account`-destination **DELETE** (revoke) + the **"used by"** hint have no production UI caller until **TASK-42** (Settings → Keys). Exercised by route + integration tests here. CLOSES in TASK-42. The write/lookup/bind/resolve path is fully wired now.
- **Stale-anchor note:** the design's "TASK-35 = the card's vault lookup" and the `HALF-WIRED (TASK-35)` comment in `request-capability.ts` are stale — TASK-36 already attaches/resumes; the binding ref is minted in `applyCapabilityGrant`, where this PR adds the `account` decision. (Optionally refresh that comment.)
- The security-checklist note.

---

## Self-Review

**Spec coverage** (design P2 / P7.2 / decision #13, and the TASK-43 card body):
- "credential slot gains optional `account` tag" → Task 1 (parser) + Task 2 (return schema). ✓
- "vault holds one entry per service per user; any skill with `account: linear` binds automatically" → Task 3 (the `account:<service>` user-scoped ref) + Task 5 (orchestrator mints that ref for tagged slots). ✓
- "backward-compatible: no `account` → today's `skill:<id>:<slot>`" → Task 5 else-branch + Task 1 back-compat test + Task 9 step 1.7. ✓
- "card checks the vault first → use your existing key (one tap, no re-entry)" → Task 6 (lookup → `haveExisting`) + Task 8 (render + skip field/POST). ✓
- "else prompt once and store under `account:<service>`" → Task 8 (account-destination POST) + Task 3 (route). ✓
- "revoking a vault entry pulls the credential out from under every referencing skill" → Task 4 (property test) + Task 9 step 1.6; revoke *capability* = the `account` DELETE in Task 3. The **"used by" hint** rendering is explicitly **TASK-42** (half-wired window). ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step shows the exact `pnpm -F` command + expected result. No TBD/TODO. ✓

**Type consistency:** the field is `account?: string` on a credential slot everywhere it appears — `CapabilitySlot` (skills-parser), `CapabilitySlotSchema` (skills), `CatalogSkillDetail` + card `PermissionRequestEvent.slots` (skill-broker), `PermissionRequest` slots (channel-web server + client store), and `ResolvedSkillForOrch.capabilities.credentials` (orchestrator). The card-only field `haveExisting?: boolean` appears in the broker card payload + both channel-web declarations + the `PermissionCard` render — never on a manifest/store type (it's a per-request lookup result, not persisted). The destination kind is `{ kind: 'account'; service: string }` → ref `account:<service>` identically in all three `refForDestination` copies + the fixture + `DestinationSchema`. The binding ref minted in `applyCapabilityGrant` (`account:${account}`) is byte-identical to what the card POSTs to (`{ kind: 'account', service: account }` → `account:${service}`), so stored key and binding always address the same row.

**Known residual / deliberate non-scope:**
- `account` on an **MCP-server** credential (`capabilities.mcpServers[].credentials`) parses under the same shared `parseCredentialList`, but only **top-level** `capabilities.credentials` slots drive the card + orchestrator binding this phase. MCP env/header credentials use the separate `mcp-env`/`mcp-header` destinations and are unchanged — an MCP-slot `account` is grammar-valid but inert (not a binding driver). Acceptable: it's a faithfully round-tripped data field, not unreachable infrastructure.
- The **"used by"** hint and the Keys-tab **revoke button** are **TASK-42** (Settings surface). This plan provides the underlying revoke *capability* (the `account` DELETE) and the shared-ref property (Task 4) they build on.
