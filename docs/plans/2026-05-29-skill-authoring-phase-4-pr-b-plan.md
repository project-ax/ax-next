# Skill authoring Phase 4 PR-B — hybrid approval timing: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the unapproved `proposalDelta` of a self-authored skill into live capabilities through a human approval at the wall, activating the grant per the re-spawn-vs-live asymmetry — closing the PR-A half-wired window.

**Architecture:** A pure per-bundle projection helper (`@ax/agents`) feeds both the real resolver and the CLI stub. The orchestrator folds the *approved* authored caps into the proxy egress allowlist + credential map (PC-1), fires one upfront approval card per unapproved shown-delta (deduped per conversation), and exposes a NEW `agent:apply-authored-capability-grant` that writes approval rows and activates host-only grants live (`proxy:add-host`) or credential grants via re-spawn (`session:terminate`). `@ax/skills` gains `-set`/`-revoke` write services over the existing PR-A store. channel-web routes authored decisions to the new path (server re-derives authored-ness; never trusts the client). MCP approval is deferred (fail-closed). A real-executor k8s canary proves an approved authored host is reachable through the proxy while an unapproved one is blocked.

**Tech Stack:** TypeScript, pnpm workspaces, Kysely + Postgres (testcontainers), Vitest, the `@ax` hook-bus plugin kernel, `@ax/skills-parser`, `@ax/test-harness` (`createTestHarness`, `createTestProxyPlugin`).

**Design docs:** `docs/plans/2026-05-29-skill-authoring-phase-4-pr-b-addendum.md` (the seven decisions D-B1..D-B7) + `docs/plans/2026-05-29-skill-authoring-phase-4-lazy-approval-design.md` (D1-D4, the asymmetry table).

---

## Verified ground truth (confirmed against `main` @ `82db5aac`; locate by symbol — lines drift)

- **PC-1 gap is real and narrow.** `orchestrator.ts` folds *catalog attachment* hosts/creds into `baseAllowSet`/`baseCreds` in the `for (const attachment of attachments)` loop (~`:1407-1445`). Authored drafts are resolved into `authoredDraftSkills` (~`:1461-1475`) and unioned into `unionedSkills` for display (~`:1494-1520`) but their `capabilities.allowedHosts`/`credentials` are **never folded into the allowlist/creds** that `proxy:open-session` receives (~`:1597-1608`). The registry auto-allow loop (~`:1522-1538`) **already** iterates `unionedSkills` (which includes authored), so approved authored *package* registry hosts are already handled — PC-1 only needs authored `allowedHosts` + `credentials`.
- **Credential ref convention (must match on both sides).** The card writes keys via `setDestinationCredential` → server `refForDestination` → `skill:<skillId>:<slot>` (untagged) or `account:<service>` (account-tagged) (`packages/channel-web/src/lib/credentials.ts:138-153`, `packages/credentials/src/refs.ts`). The catalog grant derives the IDENTICAL ref (`orchestrator.ts` `applyCapabilityGrant`). The proxy resolves a ref via `credentials:get { ref, userId } -> string`. PC-1's authored fold MUST derive the same ref.
- **`chat:end` is per-TURN** (15 fire sites, one per outcome). Do NOT clear the upfront-card dedup there. `wallCardsByHost` is cleared per-session in `onSessionTerminate`; `respawnSessions` likewise. The new `upfrontCardsByConv` is conversation-scoped and persists across turns/re-spawns; it is cleared only by the authored grant on apply (so a post-approve spawn re-evaluates the smaller delta). In-memory, single-replica — same posture as the other orchestrator maps.
- **Orchestrator uses LOCAL mirror types** (invariant #2 — no `@ax/agents` import): `ResolvedSkillForOrch` (`orchestrator.ts:226-240`) and a local `interface AgentsResolveAuthoredSkillsOutput { skills: ResolvedSkillForOrch[] }` (~`:251-253`). To read `proposalDelta`/`description` we widen the local mirror, not import from `@ax/agents`.
- **Grant test pattern exists:** `packages/chat-orchestrator/src/__tests__/apply-capability-grant.test.ts` uses `createTestHarness({ services, plugins:[createChatOrchestratorPlugin(...)] })` with stub peer services + a `trace`. The orchestrator under test is REAL; peers are stubs (NOT a fire-spy — the store/projection are unit-tested elsewhere + the canary uses fully real executors). Mirror it for the authored grant.
- **Decision-route test pattern exists:** `packages/channel-web/src/__tests__/server/routes-chat.test.ts:1089` tests `postPermissionDecision` over a real http-server + a mock plugin registering `agent:apply-capability-grant` (~`:203-230`) + a `postDecision(port, body)` helper (~`:1067`).
- **TestProxy discards open-session input** (`packages/test-harness/src/test-proxy-plugin.ts`). Add an optional `onOpenSession` capture for the canary's reachability assertion.
- **Preset state:** k8s preset loads both `@ax/skills` and `@ax/chat-orchestrator` (`presets/k8s/src/index.ts`) — no preset wiring needed beyond the new services. CLI loads `@ax/chat-orchestrator` + `dev-agents-stub` (NO `@ax/skills`). `presets/k8s/src/__tests__/preset.test.ts` has the PR-A assertion (~`:228-237`) that `-set`/`-revoke` are NOT registered — flip it. `packages/skills/src/__tests__/return-schemas.test.ts` asserts every `skills:*` service declares `{returns}`.

---

## File Structure

**Create:**
- `packages/chat-orchestrator/src/authored-egress.ts` — pure `foldAuthoredSkillCaps()` (PC-1 fold). One responsibility: fold approved authored caps into a base allowlist/creds, detecting trusted-slot collisions.
- `packages/chat-orchestrator/src/__tests__/authored-egress.test.ts`
- `packages/chat-orchestrator/src/authored-card.ts` — pure `buildAuthoredCardPayload()` + `authoredCardDedupKey()` (upfront card shape + dedup key). One responsibility: turn a shown delta into a card payload + a stable dedup key.
- `packages/chat-orchestrator/src/__tests__/authored-card.test.ts`
- `packages/chat-orchestrator/src/__tests__/apply-authored-capability-grant.test.ts`

**Modify:**
- `packages/agents/src/authored-caps.ts` — add `projectAuthoredBundle()`.
- `packages/agents/src/__tests__/authored-caps.test.ts` — add helper tests.
- `packages/agents/src/types.ts` — add `description` to `AuthoredResolvedSkill` + schema.
- `packages/agents/src/plugin.ts` — rewire the resolver loop to call `projectAuthoredBundle` + include `description`.
- `packages/agents/src/__tests__/authored-skills.test.ts` — assert `description` in the projection.
- `packages/cli/src/dev-agents-stub.ts` — call `projectAuthoredBundle(manifestYaml, [])`.
- `packages/skills/src/types.ts` — `-set`/`-revoke` Input/Output + schemas.
- `packages/skills/src/index.ts` — export new types.
- `packages/skills/src/plugin.ts` — register `-set`/`-revoke` + manifest.
- `packages/skills/src/__tests__/return-schemas.test.ts` — add cases.
- `packages/chat-orchestrator/src/orchestrator.ts` — widen local mirror types; PC-1 fold; `upfrontCardsByConv` + at-spawn card fire; `applyAuthoredCapabilityGrant` + `activeAliveSession` helper.
- `packages/chat-orchestrator/src/plugin.ts` — register `agent:apply-authored-capability-grant` + manifest.
- `packages/channel-web/src/server/routes-chat.ts` — authored-first routing in `postPermissionDecision`.
- `packages/channel-web/src/__tests__/server/routes-chat.test.ts` — authored routing tests.
- `packages/test-harness/src/test-proxy-plugin.ts` — `onOpenSession` capture.
- `presets/k8s/src/__tests__/preset.test.ts` — flip the PR-A assertion; assert the new services.
- `presets/k8s/src/__tests__/acceptance.test.ts` — the PR-B canary.

**Boundary note (#4 + #2):** the bundle frontmatter is the proposal source; `skills_v1_approved_caps` is approval metadata; the projection is the view. All cross-plugin shapes (card payload, authored-grant I/O, the orchestrator's authored-skill mirror) are duplicated structurally — no cross-plugin type imports.

---

## Task 1: PC-2 — shared `projectAuthoredBundle` helper + `description` field + CLI stub sync

**Files:**
- Modify: `packages/agents/src/authored-caps.ts`
- Modify: `packages/agents/src/__tests__/authored-caps.test.ts`
- Modify: `packages/agents/src/types.ts`
- Modify: `packages/agents/src/plugin.ts`
- Modify: `packages/agents/src/__tests__/authored-skills.test.ts`
- Modify: `packages/cli/src/dev-agents-stub.ts`

- [ ] **Step 1: Write the failing helper test**

Append to `packages/agents/src/__tests__/authored-caps.test.ts` (the file already imports from `../authored-caps.js` and defines `proposal()`):

```ts
import { projectAuthoredBundle } from '../authored-caps.js';

describe('projectAuthoredBundle', () => {
  const MANIFEST =
    'name: linear\n' +
    'description: Query Linear issues\n' +
    'capabilities:\n' +
    '  allowedHosts:\n' +
    '    - api.linear.app\n' +
    '  credentials:\n' +
    '    - slot: LINEAR_API_KEY\n' +
    '      kind: api-key\n';

  it('returns null for an unparseable manifest', () => {
    expect(projectAuthoredBundle(': not yaml : [', [])).toBeNull();
  });

  it('with NO approvals: empty caps, full delta, caps-stripped manifest, description preserved', () => {
    const out = projectAuthoredBundle(MANIFEST, []);
    expect(out).not.toBeNull();
    expect(out!.description).toBe('Query Linear issues');
    expect(out!.capabilities.allowedHosts).toEqual([]);
    expect(out!.delta.allowedHosts).toEqual(['api.linear.app']);
    expect(out!.delta.credentials.map((c) => c.slot)).toEqual(['LINEAR_API_KEY']);
    expect(out!.manifestYaml).not.toContain('capabilities');
    expect(out!.manifestYaml).not.toContain('api.linear.app');
    expect(out!.manifestYaml).toContain('name: linear');
  });

  it('approving the host moves it into caps, leaves the slot in the delta', () => {
    const out = projectAuthoredBundle(MANIFEST, [{ kind: 'host', value: 'api.linear.app' }]);
    expect(out!.capabilities.allowedHosts).toEqual(['api.linear.app']);
    expect(out!.delta.allowedHosts).toEqual([]);
    expect(out!.delta.credentials.map((c) => c.slot)).toEqual(['LINEAR_API_KEY']);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm --filter @ax/agents exec vitest run src/__tests__/authored-caps.test.ts -t "projectAuthoredBundle"`
Expected: FAIL — `projectAuthoredBundle is not a function`.

- [ ] **Step 3: Implement `projectAuthoredBundle`**

In `packages/agents/src/authored-caps.ts`, extend the imports and append the function. The file currently imports only types from `@ax/skills-parser`; add the two value imports:

```ts
import { parseSkillManifest, buildSkillManifestYaml } from '@ax/skills-parser';
```

Append:

```ts
/**
 * Project ONE self-authored bundle: parse its frontmatter proposal, intersect
 * with the approved set, and rebuild a caps-stripped manifest. Pure (no I/O) —
 * the caller supplies `approved` (the real resolver fetches it from
 * skills:approved-caps-list; the CLI stub passes []). Returns null on an
 * unparseable manifest so the caller skips the draft (one bad draft must not
 * break discovery). The rebuilt manifest carries name+description+version only
 * (EMPTY capabilities) — frontmatter alone grants nothing.
 */
export function projectAuthoredBundle(
  manifestYaml: string,
  approved: ApprovedCapEntry[],
): {
  description: string;
  capabilities: SkillCapabilities;
  delta: SkillCapabilities;
  manifestYaml: string;
} | null {
  const parsed = parseSkillManifest(manifestYaml);
  if (!parsed.ok) return null;
  const { capabilities, delta } = intersectProposalWithApproved(
    parsed.value.capabilities,
    approved,
  );
  const stripped = buildSkillManifestYaml({
    id: parsed.value.id,
    description: parsed.value.description,
    version: parsed.value.version,
    capabilities: EMPTY_CAPABILITIES,
  });
  return { description: parsed.value.description, capabilities, delta, manifestYaml: stripped };
}
```

- [ ] **Step 4: Run the helper test — verify it passes**

Run: `pnpm --filter @ax/agents exec vitest run src/__tests__/authored-caps.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Add `description` to the output type + schema**

In `packages/agents/src/types.ts`, add `description: string;` to `AuthoredResolvedSkill` (after `id`):

```ts
export interface AuthoredResolvedSkill {
  id: string;
  description: string;
  capabilities: SkillCapabilities;
  proposalDelta: SkillCapabilities;
  bodyMd: string;
  manifestYaml: string;
  files: Array<{ path: string; contents: string }>;
}
```

And add `description: z.string(),` to the per-skill object in `AgentsResolveAuthoredSkillsOutputSchema` (after `id: z.string(),`):

```ts
      id: z.string(),
      description: z.string(),
      capabilities: SkillCapabilitiesSchema,
```

- [ ] **Step 6: Rewire the real resolver to use the helper + description**

In `packages/agents/src/plugin.ts`, replace the per-bundle body of `agents:resolve-authored-skills` (the parse → approved-fetch → intersect → buildManifest → push block) so the post-quarantine portion of the loop becomes:

```ts
            // Read what the human approved (soft dep). Absent store / error →
            // [] → the safe empty-caps default (the proxy blocks everything).
            let approved: ApprovedCapEntry[] = [];
            if (bus.hasService('skills:approved-caps-list')) {
              try {
                const r = await bus.call<
                  { ownerUserId: string; agentId: string; skillId: string },
                  { capabilities: ApprovedCapEntry[] }
                >('skills:approved-caps-list', _ctx, {
                  ownerUserId: input.ownerUserId,
                  agentId: input.agentId,
                  skillId: b.id,
                });
                approved = r.capabilities;
              } catch (err) {
                _ctx.logger.warn('resolve_authored_caps_list_failed', {
                  skillId: b.id,
                  error: err instanceof Error ? err.message : String(err),
                });
                approved = [];
              }
            }

            const proj = projectAuthoredBundle(b.manifestYaml, approved);
            if (proj === null) continue; // unparseable — skip (defensive)

            skills.push({
              id: b.id,
              description: proj.description,
              capabilities: proj.capabilities,
              proposalDelta: proj.delta,
              bodyMd: b.bodyMd,
              manifestYaml: proj.manifestYaml,
              files: b.files,
            });
```

Update the import group from `./authored-caps.js` to include `projectAuthoredBundle` (and drop now-unused `intersectProposalWithApproved`/`EMPTY_CAPABILITIES`/`buildSkillManifestYaml`/`parseSkillManifest` imports here **only if** they are no longer referenced elsewhere in the file — verify with a grep before removing):

```ts
import { projectAuthoredBundle, type ApprovedCapEntry } from './authored-caps.js';
```

- [ ] **Step 7: Add the `description` assertion to the projection test**

In `packages/agents/src/__tests__/authored-skills.test.ts`, in the existing Phase-4 projection test, after the `proposalDelta` assertions add:

```ts
    expect(linear!.description.length).toBeGreaterThan(0);
```

- [ ] **Step 8: Run the agents suite + build**

Run: `pnpm --filter @ax/agents exec vitest run src/__tests__/authored-caps.test.ts src/__tests__/authored-skills.test.ts`
Expected: PASS.
Run: `pnpm --filter @ax/agents build`
Expected: tsc PASS.

- [ ] **Step 9: Sync the CLI dev stub**

In `packages/cli/src/dev-agents-stub.ts`, replace the hand-rolled `.map()` projection in the `agents:resolve-authored-skills` handler with a call to the shared helper (approved=[] since the CLI has no `@ax/skills`). Add the import:

```ts
import { projectAuthoredBundle } from '@ax/agents';
```

(If `@ax/agents` is not already a dependency of `packages/cli/package.json`, add it: `"@ax/agents": "workspace:*"` — it is already a workspace package the CLI depends on transitively; verify the import resolves via `pnpm --filter @ax/ax build`.)

Replace the `const skills = bundles.map((b) => ({ ... }))` block with:

```ts
    const skills = [];
    for (const b of bundles) {
      const proj = projectAuthoredBundle(b.manifestYaml, []);
      if (proj === null) continue;
      skills.push({
        id: b.id,
        description: proj.description,
        capabilities: proj.capabilities,
        proposalDelta: proj.delta,
        bodyMd: b.bodyMd,
        manifestYaml: proj.manifestYaml,
        files: b.files,
      });
    }
```

- [ ] **Step 10: Verify `projectAuthoredBundle` is exported from `@ax/agents`**

Confirm `packages/agents/src/index.ts` re-exports it. Add if missing:

```ts
export { projectAuthoredBundle, intersectProposalWithApproved, EMPTY_CAPABILITIES } from './authored-caps.js';
export type { ApprovedCapEntry } from './authored-caps.js';
```

(Check the file first — `intersectProposalWithApproved`/`EMPTY_CAPABILITIES`/`ApprovedCapEntry` may already be exported from PR-A; only add `projectAuthoredBundle`.)

- [ ] **Step 11: Build the CLI**

Run: `pnpm --filter @ax/ax build` (the CLI package name — confirm via `grep '"name"' packages/cli/package.json`; use that filter).
Expected: tsc PASS (the stub now type-checks against the shared helper).

- [ ] **Step 12: Commit**

```bash
git add packages/agents/src/authored-caps.ts packages/agents/src/__tests__/authored-caps.test.ts \
        packages/agents/src/types.ts packages/agents/src/plugin.ts \
        packages/agents/src/__tests__/authored-skills.test.ts packages/agents/src/index.ts \
        packages/cli/src/dev-agents-stub.ts
git commit -m "feat(agents): shared projectAuthoredBundle helper + description field; sync CLI stub (Phase 4 PR-B PC-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: PC-1 — fold approved authored caps into the proxy egress allowlist + creds

**Files:**
- Create: `packages/chat-orchestrator/src/authored-egress.ts`
- Create: `packages/chat-orchestrator/src/__tests__/authored-egress.test.ts`
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`

- [ ] **Step 1: Write the failing fold test**

Create `packages/chat-orchestrator/src/__tests__/authored-egress.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { foldAuthoredSkillCaps } from '../authored-egress.js';

function emptyBase() {
  return {
    allow: new Set<string>(),
    creds: {} as Record<string, { ref: string; kind: string }>,
    owners: new Map<string, string>(),
  };
}

describe('foldAuthoredSkillCaps', () => {
  it('folds authored hosts into the allowlist', () => {
    const b = emptyBase();
    const c = foldAuthoredSkillCaps(
      [{ id: 'linear', capabilities: { allowedHosts: ['api.linear.app'], credentials: [] } }],
      b.allow, b.creds, b.owners,
    );
    expect(c).toBeNull();
    expect([...b.allow]).toEqual(['api.linear.app']);
  });

  it('binds an untagged slot to skill:<id>:<slot> and an account slot to account:<svc>', () => {
    const b = emptyBase();
    foldAuthoredSkillCaps(
      [{
        id: 'linear',
        capabilities: {
          allowedHosts: [],
          credentials: [
            { slot: 'LINEAR_API_KEY', kind: 'api-key' },
            { slot: 'SHARED', kind: 'api-key', account: 'linear' },
          ],
        },
      }],
      b.allow, b.creds, b.owners,
    );
    expect(b.creds).toEqual({
      LINEAR_API_KEY: { ref: 'skill:linear:LINEAR_API_KEY', kind: 'api-key' },
      SHARED: { ref: 'account:linear', kind: 'api-key' },
    });
    expect(b.owners.get('LINEAR_API_KEY')).toBe('linear');
  });

  it('returns a collision when a slot is already owned by a trusted source (no override)', () => {
    const b = emptyBase();
    b.creds['ANTHROPIC_API_KEY'] = { ref: 'provider:anthropic', kind: 'api-key' };
    b.owners.set('ANTHROPIC_API_KEY', '<agent.requiredCredentials>');
    const c = foldAuthoredSkillCaps(
      [{ id: 'evil', capabilities: { allowedHosts: [], credentials: [{ slot: 'ANTHROPIC_API_KEY', kind: 'api-key' }] } }],
      b.allow, b.creds, b.owners,
    );
    expect(c).toEqual({ slot: 'ANTHROPIC_API_KEY', existingOwner: '<agent.requiredCredentials>', skillId: 'evil' });
    // The trusted binding is untouched — no hijack.
    expect(b.creds['ANTHROPIC_API_KEY']).toEqual({ ref: 'provider:anthropic', kind: 'api-key' });
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/authored-egress.test.ts`
Expected: FAIL — `Cannot find module '../authored-egress.js'`.

- [ ] **Step 3: Implement the fold**

Create `packages/chat-orchestrator/src/authored-egress.ts`:

```ts
/**
 * PC-1 — fold an APPROVED self-authored skill's capabilities into the session's
 * base egress allowlist + credential map (Phase 4 PR-B). The projection
 * (agents:resolve-authored-skills) already filtered these to proposal ∩ approved,
 * so everything here is human-approved. Without this fold an approved authored
 * host projects into the skill's caps yet the proxy still blocks it
 * ("approved but unreachable").
 *
 * Credential refs are derived the SAME way the approval card wrote them and the
 * catalog grant binds them: an account-tagged slot → the shared `account:<svc>`
 * vault entry; an untagged slot → the per-skill `skill:<id>:<slot>` ref. So the
 * stored key and this binding always address the same row.
 *
 * SECURITY: an untrusted draft must never hijack a slot already owned by a
 * trusted source (an agent default or a catalog attachment). On the first such
 * collision we STOP and return it — the caller turns it into a fatal terminate
 * with a clear reason (mirrors the catalog attachment loop). We never override
 * the trusted binding.
 *
 * Mutates `baseAllowSet` / `baseCreds` / `slotOwners` in place (same objects the
 * catalog loop built). Registry hosts for approved packages need no handling
 * here — the orchestrator's registry auto-allow loop already iterates the
 * authored skills.
 */
export interface AuthoredCapsLike {
  id: string;
  capabilities: {
    allowedHosts: string[];
    credentials: Array<{ slot: string; kind: string; account?: string }>;
  };
}

export interface FoldCollision {
  slot: string;
  existingOwner: string;
  skillId: string;
}

export function foldAuthoredSkillCaps(
  authored: AuthoredCapsLike[],
  baseAllowSet: Set<string>,
  baseCreds: Record<string, { ref: string; kind: string }>,
  slotOwners: Map<string, string>,
): FoldCollision | null {
  for (const s of authored) {
    for (const host of s.capabilities.allowedHosts) baseAllowSet.add(host);
    for (const slotDef of s.capabilities.credentials) {
      if (slotOwners.has(slotDef.slot)) {
        return { slot: slotDef.slot, existingOwner: slotOwners.get(slotDef.slot)!, skillId: s.id };
      }
      const ref =
        slotDef.account !== undefined
          ? `account:${slotDef.account}`
          : `skill:${s.id}:${slotDef.slot}`;
      baseCreds[slotDef.slot] = { ref, kind: slotDef.kind };
      slotOwners.set(slotDef.slot, s.id);
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the fold test — verify it passes**

Run: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/authored-egress.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Widen the orchestrator's local authored-skill mirror type**

In `packages/chat-orchestrator/src/orchestrator.ts`, just after the `ResolvedSkillForOrch` interface (~`:240`), add:

```ts
/** Authored-draft projection mirror (structurally mirrors @ax/agents'
 * AuthoredResolvedSkill — NOT an import, per invariant #2). Adds the Phase-4
 * fields the orchestrator consumes: `proposalDelta` (the unapproved remainder,
 * drives the upfront card) and `description` (the card body). `capabilities` is
 * the APPROVED subset PC-1 folds into egress. */
export interface AuthoredResolvedSkillForOrch extends ResolvedSkillForOrch {
  proposalDelta: ResolvedSkillForOrch['capabilities'];
  description: string;
}
```

Change the local `AgentsResolveAuthoredSkillsOutput` mirror (~`:251`) to:

```ts
interface AgentsResolveAuthoredSkillsOutput {
  skills: AuthoredResolvedSkillForOrch[];
}
```

Change the `authoredDraftSkills` declaration (~`:1461`):

```ts
    let authoredDraftSkills: AuthoredResolvedSkillForOrch[] = [];
```

- [ ] **Step 6: Call the fold in the cold-start path**

In `packages/chat-orchestrator/src/orchestrator.ts`, add the import near the other local imports:

```ts
import { foldAuthoredSkillCaps } from './authored-egress.js';
```

Immediately AFTER the `authoredDraftSkills` resolve block (after the closing `}` of the `if (bus.hasService('agents:resolve-authored-skills'))` at ~`:1475`) and BEFORE the `defaultSkillsForUnion` block, insert:

```ts
    // PC-1 — fold APPROVED authored-draft caps into the egress allowlist +
    // credential map (Phase 4 PR-B). baseCreds is aliased by unionedCreds and
    // baseAllowSet is frozen into unionedAllowlist below, so mutating them here
    // reaches proxy:open-session. A slot colliding with a trusted owner is a
    // fatal terminate (an untrusted draft must not hijack a trusted credential).
    const authoredCollision = foldAuthoredSkillCaps(
      authoredDraftSkills,
      baseAllowSet,
      baseCreds,
      slotOwners,
    );
    if (authoredCollision !== null) {
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason: 'skill-slot-collision',
        error: new Error(
          `authored skill '${authoredCollision.skillId}' slot '${authoredCollision.slot}' collides with existing owner '${authoredCollision.existingOwner}'`,
        ),
      };
      await fireTurnError(ctx, ctx.reqId, outcome.reason);
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }
```

(`fireTurnError`, `AgentOutcome`, `baseAllowSet`, `baseCreds`, `slotOwners`, `unionedCreds` are all in scope at this point — confirm `slotOwners` and `baseCreds` are declared before `:1461`; they are, at ~`:1398-1405`.)

- [ ] **Step 7: Build + run the orchestrator suite**

Run: `pnpm --filter @ax/chat-orchestrator build`
Expected: tsc PASS.
Run: `pnpm --filter @ax/chat-orchestrator exec vitest run`
Expected: PASS (existing suites + the new fold test). The end-to-end reachability proof lands in the canary (Task 7).

- [ ] **Step 8: Commit**

```bash
git add packages/chat-orchestrator/src/authored-egress.ts \
        packages/chat-orchestrator/src/__tests__/authored-egress.test.ts \
        packages/chat-orchestrator/src/orchestrator.ts
git commit -m "feat(orchestrator): fold approved authored-skill caps into proxy egress (Phase 4 PR-B PC-1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: write services — `skills:approved-caps-set` + `skills:approved-caps-revoke`

**Files:**
- Modify: `packages/skills/src/types.ts`
- Modify: `packages/skills/src/index.ts`
- Modify: `packages/skills/src/plugin.ts`
- Modify: `packages/skills/src/__tests__/return-schemas.test.ts`
- Modify: `presets/k8s/src/__tests__/preset.test.ts`

- [ ] **Step 1: Add the service types + schemas**

In `packages/skills/src/types.ts`, after the `SkillsApprovedCapsListOutputSchema` block, add:

```ts
export interface SkillsApprovedCapsSetInput {
  ownerUserId: string;
  agentId: string;
  skillId: string;
  kind: 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';
  value: string;
  /** Optional audit/display detail (slot kind + account). The projection
   * matches on (kind, value) only; this is never read back by list(). */
  detail?: { kind?: 'api-key'; account?: string } | null;
}
export interface SkillsApprovedCapsSetOutput {
  created: boolean;
}
export interface SkillsApprovedCapsRevokeInput {
  ownerUserId: string;
  agentId: string;
  skillId: string;
  kind: 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';
  value: string;
}
export interface SkillsApprovedCapsRevokeOutput {
  cleared: boolean;
}

export const SkillsApprovedCapsSetOutputSchema = z.object({
  created: z.boolean(),
}) as unknown as ZodType<SkillsApprovedCapsSetOutput>;

export const SkillsApprovedCapsRevokeOutputSchema = z.object({
  cleared: z.boolean(),
}) as unknown as ZodType<SkillsApprovedCapsRevokeOutput>;
```

- [ ] **Step 2: Export the new types**

In `packages/skills/src/index.ts`, add to the `export type { ... } from './types.js'` block:

```ts
  SkillsApprovedCapsSetInput,
  SkillsApprovedCapsSetOutput,
  SkillsApprovedCapsRevokeInput,
  SkillsApprovedCapsRevokeOutput,
```

- [ ] **Step 3: Register the services + manifest entries**

In `packages/skills/src/plugin.ts`:

(a) Add the type imports to the existing `from './types.js'` group:

```ts
  SkillsApprovedCapsSetInput,
  SkillsApprovedCapsSetOutput,
  SkillsApprovedCapsSetOutputSchema,
  SkillsApprovedCapsRevokeInput,
  SkillsApprovedCapsRevokeOutput,
  SkillsApprovedCapsRevokeOutputSchema,
```

(b) Add to `manifest.registers` (after `'skills:approved-caps-list'`):

```ts
        'skills:approved-caps-set',
        'skills:approved-caps-revoke',
```

(c) Register the services (after the `skills:approved-caps-list` registration). The store `set`/`clear` already return `{created}` / `{cleared}`, so pass input straight through:

```ts
      bus.registerService<SkillsApprovedCapsSetInput, SkillsApprovedCapsSetOutput>(
        'skills:approved-caps-set',
        PLUGIN_NAME,
        async (_ctx, input) => approvedCapsStore.set(input),
        { returns: SkillsApprovedCapsSetOutputSchema },
      );
      bus.registerService<SkillsApprovedCapsRevokeInput, SkillsApprovedCapsRevokeOutput>(
        'skills:approved-caps-revoke',
        PLUGIN_NAME,
        async (_ctx, input) => approvedCapsStore.clear(input),
        { returns: SkillsApprovedCapsRevokeOutputSchema },
      );
```

(The store's `set` input type is structurally `{ownerUserId, agentId, skillId, kind, value, detail?}` and `clear` is `{...without detail}` — `SkillsApprovedCapsSetInput`/`RevokeInput` match. The store's `ApprovedCapKind` is the same union; if tsc complains about `detail?: {...}|null` vs the store's `detail?: unknown`, the object is assignable to `unknown` — no cast needed.)

- [ ] **Step 4: Add return-schema round-trip cases**

In `packages/skills/src/__tests__/return-schemas.test.ts`, mirror the `skills:approved-caps-list` cases:

```ts
  it('skills:approved-caps-set output round-trips', () => {
    const v: SkillsApprovedCapsSetOutput = { created: true };
    expect(SkillsApprovedCapsSetOutputSchema.parse(v)).toEqual(v);
  });
  it('skills:approved-caps-revoke output round-trips', () => {
    const v: SkillsApprovedCapsRevokeOutput = { cleared: false };
    expect(SkillsApprovedCapsRevokeOutputSchema.parse(v)).toEqual(v);
  });
```

(Add the type + schema imports at the top of the test file alongside the existing `SkillsApprovedCapsList*` imports.)

- [ ] **Step 5: Flip the preset reachability assertion**

In `presets/k8s/src/__tests__/preset.test.ts`, update the PR-A test (the `not.toContain` block):

```ts
  it('loads @ax/skills and registers the approved-caps read + write services (Phase 4 PR-B)', () => {
    const plugins = createK8sPlugins(stubConfig);
    const registers = plugins.flatMap((p) => p.manifest.registers);
    expect(registers).toContain('skills:approved-caps-list');
    expect(registers).toContain('skills:approved-caps-set');
    expect(registers).toContain('skills:approved-caps-revoke');
    expect(registers).toContain('agent:apply-authored-capability-grant');
  });
```

(The `agent:apply-authored-capability-grant` registrant is added in Task 4; if running tasks strictly in order, this line will fail until Task 4 — acceptable for the per-task TDD, or add it in Task 4's commit. Keep both expectations together for the window-CLOSED proof.)

- [ ] **Step 6: Build + test @ax/skills**

Run: `pnpm --filter @ax/skills build`
Expected: tsc PASS.
Run: `pnpm --filter @ax/skills exec vitest run src/__tests__/return-schemas.test.ts src/__tests__/plugin.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/skills/src/types.ts packages/skills/src/index.ts packages/skills/src/plugin.ts \
        packages/skills/src/__tests__/return-schemas.test.ts presets/k8s/src/__tests__/preset.test.ts
git commit -m "feat(skills): approved-caps set/revoke write services (Phase 4 PR-B)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: authored-grant path — `agent:apply-authored-capability-grant`

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`
- Modify: `packages/chat-orchestrator/src/plugin.ts`
- Create: `packages/chat-orchestrator/src/__tests__/apply-authored-capability-grant.test.ts`
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts` (stub registers — see Step 7)

- [ ] **Step 1: Write the failing grant test**

Create `packages/chat-orchestrator/src/__tests__/apply-authored-capability-grant.test.ts` (mirrors `apply-capability-grant.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { makeAgentContext, createLogger, type ServiceHandler } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

interface Trace {
  setRows: Array<{ skillId: string; kind: string; value: string }>;
  terminate: string[];
  addHost: Array<{ sessionId: string; host: string }>;
}

const EMPTY_CAPS = { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } };

function buildMocks(opts: {
  draft: { id: string; proposalDelta: typeof EMPTY_CAPS } | null;
  activeSessionId: string | null;
  liveSessions: Set<string>;
}): { trace: Trace; services: Record<string, ServiceHandler> } {
  const trace: Trace = { setRows: [], terminate: [], addHost: [] };
  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({
      agent: {
        id: 'agent-1', ownerId: 'user-1', ownerType: 'user', visibility: 'personal',
        displayName: 'A', systemPrompt: '', allowedTools: [], mcpConfigIds: [],
        model: 'claude-sonnet-4-7', workspaceRef: null,
      },
    }),
    'agents:resolve-authored-skills': async () => ({
      skills: opts.draft === null ? [] : [{
        id: opts.draft.id, description: 'd', capabilities: EMPTY_CAPS,
        proposalDelta: opts.draft.proposalDelta, bodyMd: '', manifestYaml: '', files: [],
      }],
    }),
    'skills:approved-caps-set': async (_c, input: unknown) => {
      const i = input as { skillId: string; kind: string; value: string };
      trace.setRows.push({ skillId: i.skillId, kind: i.kind, value: i.value });
      return { created: true };
    },
    'conversations:get': async (_c, input: unknown) => {
      const i = input as { conversationId: string; userId: string };
      return { conversation: { conversationId: i.conversationId, userId: i.userId, agentId: 'agent-1', activeSessionId: opts.activeSessionId, activeReqId: null } };
    },
    'session:is-alive': async (_c, input: unknown) => ({ alive: opts.liveSessions.has((input as { sessionId: string }).sessionId) }),
    'session:terminate': async (_c, input: unknown) => { trace.terminate.push((input as { sessionId: string }).sessionId); return {}; },
    'proxy:add-host': async (_c, input: unknown) => { const i = input as { sessionId: string; host: string }; trace.addHost.push(i); return { added: true, agentId: 'agent-1' }; },
    'session:queue-work': async () => ({ cursor: 0 }),
    'sandbox:open-session': async () => ({ runnerEndpoint: 'unix:///tmp/x.sock', handle: { kill: async () => undefined, exited: new Promise(() => undefined) } }),
  };
  return { trace, services };
}

function ctx() {
  return makeAgentContext({
    sessionId: 's', agentId: 'agent-1', userId: 'user-1', conversationId: 'cnv-1',
    logger: createLogger({ reqId: 'authgrant', writer: () => undefined }),
  });
}

async function harnessFor(mocks: ReturnType<typeof buildMocks>) {
  return createTestHarness({
    services: mocks.services,
    plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', oneShot: true })],
  });
}

describe('agent:apply-authored-capability-grant', () => {
  it('a host-only delta writes a host row + widens live, no re-spawn', async () => {
    const mocks = buildMocks({
      draft: { id: 'linear', proposalDelta: { ...EMPTY_CAPS, allowedHosts: ['api.linear.app'] } },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-capability-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'linear',
    });
    expect(out).toEqual({ applied: true, respawned: false });
    expect(mocks.trace.setRows).toEqual([{ skillId: 'linear', kind: 'host', value: 'api.linear.app' }]);
    expect(mocks.trace.addHost).toEqual([{ sessionId: 'sess-warm', host: 'api.linear.app' }]);
    expect(mocks.trace.terminate).toEqual([]);
  });

  it('a credential delta writes a slot row + re-spawns, no live add-host', async () => {
    const mocks = buildMocks({
      draft: { id: 'linear', proposalDelta: { ...EMPTY_CAPS, allowedHosts: ['api.linear.app'], credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }] } },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-capability-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'linear',
    });
    expect(out).toEqual({ applied: true, respawned: true });
    expect(mocks.trace.setRows).toEqual([
      { skillId: 'linear', kind: 'host', value: 'api.linear.app' },
      { skillId: 'linear', kind: 'slot', value: 'LINEAR_API_KEY' },
    ]);
    expect(mocks.trace.terminate).toEqual(['sess-warm']);
    expect(mocks.trace.addHost).toEqual([]);
  });

  it('a non-draft skillId returns not-authored and writes nothing', async () => {
    const mocks = buildMocks({ draft: null, activeSessionId: null, liveSessions: new Set() });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-capability-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'catalog-skill',
    });
    expect(out).toEqual({ applied: false, reason: 'not-authored' });
    expect(mocks.trace.setRows).toEqual([]);
    expect(mocks.trace.terminate).toEqual([]);
  });

  it('a package-only delta widens the registry host live, no re-spawn', async () => {
    const mocks = buildMocks({
      draft: { id: 'tool', proposalDelta: { ...EMPTY_CAPS, packages: { npm: ['left-pad'], pypi: [] } } },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-capability-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'tool',
    });
    expect(out).toEqual({ applied: true, respawned: false });
    expect(mocks.trace.setRows).toEqual([{ skillId: 'tool', kind: 'npm', value: 'left-pad' }]);
    expect(mocks.trace.addHost).toEqual([{ sessionId: 'sess-warm', host: 'registry.npmjs.org' }]);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/apply-authored-capability-grant.test.ts`
Expected: FAIL — no registrant for `agent:apply-authored-capability-grant`.

- [ ] **Step 3: Add the I/O types + `activeAliveSession` helper + the grant method**

In `packages/chat-orchestrator/src/orchestrator.ts`, add the exported I/O types near `ApplyCapabilityGrantInput` (search for it):

```ts
export interface ApplyAuthoredCapabilityGrantInput {
  conversationId: string;
  userId: string;
  agentId: string;
  skillId: string;
}
export type ApplyAuthoredCapabilityGrantOutput =
  | { applied: true; respawned: boolean }
  | { applied: false; reason: 'not-authored' };
```

Add a private helper (place it next to `applyCapabilityGrant`):

```ts
  // Resolve the conversation's ACTIVE + ALIVE session id (or null). Shared by
  // the catalog + authored grant paths (retire / live-widen). Best-effort: any
  // lookup failure → null (the next turn's route-vs-fresh self-corrects).
  async function activeAliveSession(
    ctx: AgentContext,
    conversationId: string,
    userId: string,
  ): Promise<string | null> {
    if (!bus.hasService('conversations:get') || !bus.hasService('session:is-alive')) return null;
    try {
      const conv = await bus.call<ConversationsGetInput, ConversationsGetOutput>(
        'conversations:get', ctx, { conversationId, userId },
      );
      const candidate = conv.conversation.activeSessionId;
      if (candidate === null || candidate.length === 0) return null;
      const alive = await bus.call<SessionIsAliveInput, SessionIsAliveOutput>(
        'session:is-alive', ctx, { sessionId: candidate },
      );
      return alive.alive ? candidate : null;
    } catch (err) {
      ctx.logger.warn('active_session_lookup_failed', {
        conversationId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return null;
    }
  }
```

Refactor `applyCapabilityGrant`'s retire block (step 4 there) to use the helper:

```ts
    const warm = await activeAliveSession(ctx, input.conversationId, input.userId);
    if (warm !== null) {
      try {
        await bus.call('session:terminate', ctx, { sessionId: warm });
      } catch (err) {
        ctx.logger.warn('apply_capability_grant_retire_failed', {
          conversationId: input.conversationId,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
```

Add the authored grant method:

```ts
  async function applyAuthoredCapabilityGrant(
    ctx: AgentContext,
    input: ApplyAuthoredCapabilityGrantInput,
  ): Promise<ApplyAuthoredCapabilityGrantOutput> {
    // 1. Re-resolve the agent's authored drafts — the HOST is the authority on
    //    which path runs (D-B7). A skillId that is not a draft is a catalog
    //    skill; signal not-authored so the route falls back to the catalog grant.
    let drafts: AuthoredResolvedSkillForOrch[] = [];
    if (bus.hasService('agents:resolve-authored-skills')) {
      const r = await bus.call<
        { ownerUserId: string; agentId: string },
        AgentsResolveAuthoredSkillsOutput
      >('agents:resolve-authored-skills', ctx, {
        ownerUserId: input.userId,
        agentId: input.agentId,
      });
      drafts = r.skills;
    }
    const draft = drafts.find((s) => s.id === input.skillId);
    if (draft === undefined) return { applied: false, reason: 'not-authored' };

    // 2. The SHOWN delta (hosts/slots/packages; mcp deferred — D-B2). Approve
    //    the whole shown delta (D-B3).
    const delta = draft.proposalDelta;
    const rows: Array<{
      kind: 'host' | 'slot' | 'npm' | 'pypi';
      value: string;
      detail?: { kind: 'api-key'; account?: string };
    }> = [
      ...delta.allowedHosts.map((h) => ({ kind: 'host' as const, value: h })),
      ...delta.credentials.map((c) => ({
        kind: 'slot' as const,
        value: c.slot,
        detail: { kind: 'api-key' as const, ...(c.account !== undefined ? { account: c.account } : {}) },
      })),
      ...delta.packages.npm.map((p) => ({ kind: 'npm' as const, value: p })),
      ...delta.packages.pypi.map((p) => ({ kind: 'pypi' as const, value: p })),
    ];

    // 3. Write the approval rows (host-side store, outside the agent's reach).
    if (bus.hasService('skills:approved-caps-set')) {
      for (const row of rows) {
        await bus.call('skills:approved-caps-set', ctx, {
          ownerUserId: input.userId,
          agentId: input.agentId,
          skillId: input.skillId,
          kind: row.kind,
          value: row.value,
          ...(row.detail !== undefined ? { detail: row.detail } : {}),
        });
      }
    }

    // 4. Drop the upfront-card dedup for this conversation so the next spawn
    //    re-evaluates the now-smaller delta (re-fires only if something remains).
    upfrontCardsByConv.delete(input.conversationId);

    // 5. Activate per the asymmetry (design table): ANY credential slot → env
    //    var frozen at spawn → re-spawn. Else host/package-only → live widen.
    const needsRespawn = delta.credentials.length > 0;
    if (needsRespawn) {
      const warm = await activeAliveSession(ctx, input.conversationId, input.userId);
      let respawned = false;
      if (warm !== null) {
        try {
          await bus.call('session:terminate', ctx, { sessionId: warm });
          respawned = true;
        } catch (err) {
          ctx.logger.warn('authored_grant_retire_failed', {
            conversationId: input.conversationId,
            err: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
      return { applied: true, respawned };
    }

    // Host/package-only → live widen on the conversation's warm session.
    const liveHosts = [...delta.allowedHosts];
    if (delta.packages.npm.length > 0) liveHosts.push('registry.npmjs.org');
    if (delta.packages.pypi.length > 0) liveHosts.push('pypi.org', 'files.pythonhosted.org');
    if (liveHosts.length > 0 && bus.hasService('proxy:add-host')) {
      const warm = await activeAliveSession(ctx, input.conversationId, input.userId);
      if (warm !== null) {
        for (const host of liveHosts) {
          try {
            await bus.call('proxy:add-host', ctx, { sessionId: warm, host });
          } catch (err) {
            ctx.logger.warn('authored_grant_add_host_failed', {
              host,
              err: err instanceof Error ? err : new Error(String(err)),
            });
          }
        }
      }
    }
    return { applied: true, respawned: false };
  }
```

Add `applyAuthoredCapabilityGrant` to the orchestrator's returned object (next to `applyCapabilityGrant` in the `return { ... }` near `:2198`).

(`ConversationsGetInput/Output`, `SessionIsAliveInput/Output`, `AgentContext`, `upfrontCardsByConv` must be in scope. `upfrontCardsByConv` is declared in Task 5 — if running Task 4 before Task 5, declare the Map now: `const upfrontCardsByConv = new Map<string, Set<string>>();` near `wallCardsByHost` ~`:631`, and Task 5 reuses it.)

- [ ] **Step 4: Register the service + manifest**

In `packages/chat-orchestrator/src/plugin.ts`:

(a) Add `'agent:apply-authored-capability-grant'` to `manifest.registers` (after `'agent:apply-capability-grant'`).

(b) Register it after the catalog grant registration:

```ts
    bus.registerService<ApplyAuthoredCapabilityGrantInput, ApplyAuthoredCapabilityGrantOutput>(
      'agent:apply-authored-capability-grant',
      PLUGIN_NAME,
      async (ctx, input) => orch.applyAuthoredCapabilityGrant(ctx, input),
    );
```

Import the I/O types from `../index.js`/`./orchestrator.js` alongside `ApplyCapabilityGrantInput`.

- [ ] **Step 5: Run the grant test — verify it passes**

Run: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/apply-authored-capability-grant.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the catalog grant test — verify no regression from the refactor**

Run: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/apply-capability-grant.test.ts`
Expected: PASS (the `activeAliveSession` refactor preserves behavior).

- [ ] **Step 7: Keep the channel-web acceptance stub bootstrap-able**

In `presets/k8s/src/__tests__/acceptance.test.ts`, the channel-web HTTP stub plugin registers `['agent:invoke', 'agent:apply-capability-grant', 'proxy:add-host']` (two sites, ~`:2743` and ~`:3190`). Add `'agent:apply-authored-capability-grant'` to both `registers` arrays and provide a no-op handler returning `{ applied: false, reason: 'not-authored' }` so the route falls back to the catalog stub:

```ts
          registers: ['agent:invoke', 'agent:apply-capability-grant', 'agent:apply-authored-capability-grant', 'proxy:add-host'],
```
```ts
      bus.registerService('agent:apply-authored-capability-grant', 'mock-orch-stub', async () => ({ applied: false, reason: 'not-authored' }));
```

(Match the surrounding stub registration style at each site.)

- [ ] **Step 8: Build the orchestrator**

Run: `pnpm --filter @ax/chat-orchestrator build`
Expected: tsc PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/plugin.ts \
        packages/chat-orchestrator/src/__tests__/apply-authored-capability-grant.test.ts \
        presets/k8s/src/__tests__/acceptance.test.ts
git commit -m "feat(orchestrator): agent:apply-authored-capability-grant (write rows + live/re-spawn) (Phase 4 PR-B)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: upfront approval card at-spawn (build payload + dedup + fire)

**Files:**
- Create: `packages/chat-orchestrator/src/authored-card.ts`
- Create: `packages/chat-orchestrator/src/__tests__/authored-card.test.ts`
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`

- [ ] **Step 1: Write the failing card-builder test**

Create `packages/chat-orchestrator/src/__tests__/authored-card.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildAuthoredCardPayload, authoredCardDedupKey } from '../authored-card.js';

const EMPTY = { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } };

describe('buildAuthoredCardPayload', () => {
  it('builds a skill card from a host+slot delta, authored:true', () => {
    const card = buildAuthoredCardPayload(
      { skillId: 'linear', description: 'Query Linear', delta: { ...EMPTY, allowedHosts: ['api.linear.app'], credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }] } },
      new Set(),
    );
    expect(card).toEqual({
      kind: 'skill', skillId: 'linear', description: 'Query Linear', authored: true,
      hosts: ['api.linear.app'],
      slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key', haveExisting: false }],
      packages: { npm: [], pypi: [] },
    });
  });

  it('marks an account-tagged slot haveExisting when its vault ref is present', () => {
    const card = buildAuthoredCardPayload(
      { skillId: 'linear', description: 'd', delta: { ...EMPTY, credentials: [{ slot: 'KEY', kind: 'api-key', account: 'linear' }] } },
      new Set(['account:linear']),
    );
    expect(card!.slots).toEqual([{ slot: 'KEY', kind: 'api-key', account: 'linear', haveExisting: true }]);
  });

  it('returns null for an empty shown delta', () => {
    expect(buildAuthoredCardPayload({ skillId: 'x', description: 'd', delta: { ...EMPTY } }, new Set())).toBeNull();
  });

  it('returns null for an mcp-only delta (mcp deferred — D-B2)', () => {
    const delta = { ...EMPTY, mcpServers: [{ name: 'm', transport: 'stdio' as const, allowedHosts: [], credentials: [] }] };
    expect(buildAuthoredCardPayload({ skillId: 'x', description: 'd', delta }, new Set())).toBeNull();
  });
});

describe('authoredCardDedupKey', () => {
  it('is stable regardless of array order', () => {
    const a = authoredCardDedupKey('s', { ...EMPTY, allowedHosts: ['b.com', 'a.com'] });
    const b = authoredCardDedupKey('s', { ...EMPTY, allowedHosts: ['a.com', 'b.com'] });
    expect(a).toBe(b);
  });
  it('changes when the shown delta grows', () => {
    const a = authoredCardDedupKey('s', { ...EMPTY, allowedHosts: ['a.com'] });
    const b = authoredCardDedupKey('s', { ...EMPTY, allowedHosts: ['a.com', 'c.com'] });
    expect(a).not.toBe(b);
  });
  it('ignores mcp-only changes (mcp not shown)', () => {
    const base = authoredCardDedupKey('s', { ...EMPTY, allowedHosts: ['a.com'] });
    const withMcp = authoredCardDedupKey('s', { ...EMPTY, allowedHosts: ['a.com'], mcpServers: [{ name: 'm', transport: 'stdio' as const, allowedHosts: [], credentials: [] }] });
    expect(base).toBe(withMcp);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/authored-card.test.ts`
Expected: FAIL — `Cannot find module '../authored-card.js'`.

- [ ] **Step 3: Implement the card builder + dedup key**

Create `packages/chat-orchestrator/src/authored-card.ts`:

```ts
/**
 * Upfront authored-skill approval card (Phase 4 PR-B, decisions D-B1/D-B2/D-B3).
 * Pure: turns a draft's UNAPPROVED shown delta (hosts/slots/packages; mcp
 * excluded — deferred) into the `kind:'skill'` card payload, and computes a
 * stable per-conversation dedup key over the shown delta.
 *
 * The card payload structurally mirrors channel-web's PermissionRequest `skill`
 * variant — NOT an import (invariant #2). `authored:true` drives the warning
 * banner; the SSE subscriber matches the frame by conversationId.
 */
export interface AuthoredDeltaLike {
  allowedHosts: string[];
  credentials: Array<{ slot: string; kind: string; account?: string }>;
  packages: { npm: string[]; pypi: string[] };
  mcpServers?: unknown[];
}

export interface AuthoredSkillCard {
  kind: 'skill';
  skillId: string;
  description: string;
  hosts: string[];
  slots: Array<{ slot: string; kind: 'api-key'; account?: string; haveExisting?: boolean }>;
  authored: true;
  packages: { npm: string[]; pypi: string[] };
}

/** Build the card, or null if the shown delta is empty (incl. mcp-only). */
export function buildAuthoredCardPayload(
  args: { skillId: string; description: string; delta: AuthoredDeltaLike },
  vaultedRefs: Set<string>,
): AuthoredSkillCard | null {
  const { skillId, description, delta } = args;
  const hosts = delta.allowedHosts;
  const slots = delta.credentials.map((c) => ({
    slot: c.slot,
    kind: 'api-key' as const,
    ...(c.account !== undefined ? { account: c.account } : {}),
    haveExisting: c.account !== undefined && vaultedRefs.has(`account:${c.account}`),
  }));
  const npm = delta.packages.npm;
  const pypi = delta.packages.pypi;
  if (hosts.length === 0 && slots.length === 0 && npm.length === 0 && pypi.length === 0) {
    return null; // nothing the card can show/approve (mcp-only or empty)
  }
  return { kind: 'skill', skillId, description, hosts, slots, authored: true, packages: { npm, pypi } };
}

/** Stable dedup key over the SHOWN delta (mcp excluded). */
export function authoredCardDedupKey(skillId: string, delta: AuthoredDeltaLike): string {
  const canon = JSON.stringify({
    h: [...delta.allowedHosts].sort(),
    s: [...delta.credentials.map((c) => c.slot)].sort(),
    n: [...delta.packages.npm].sort(),
    p: [...delta.packages.pypi].sort(),
  });
  return `${skillId}\u0000${canon}`;
}
```

- [ ] **Step 4: Run the card test — verify it passes**

Run: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/authored-card.test.ts`
Expected: PASS.

- [ ] **Step 5: Declare the dedup map (if not already from Task 4)**

In `packages/chat-orchestrator/src/orchestrator.ts`, near `const wallCardsByHost = ...` (~`:631`), add (skip if Task 4 already added it):

```ts
  // Phase 4 PR-B — upfront authored-skill approval cards already fired, keyed by
  // conversationId → set of shown-delta dedup keys. Conversation-scoped so it
  // SURVIVES a re-spawn within the conversation (do NOT clear on chat:end —
  // that's per-turn). Cleared by applyAuthoredCapabilityGrant on apply so a
  // post-approve spawn re-evaluates the smaller delta. In-memory, single-replica
  // (same posture as wallCardsByHost / respawnSessions).
  const upfrontCardsByConv = new Map<string, Set<string>>();
```

- [ ] **Step 6: Fire the upfront cards in the cold-start path**

In `packages/chat-orchestrator/src/orchestrator.ts`, add the import:

```ts
import { buildAuthoredCardPayload, authoredCardDedupKey } from './authored-card.js';
```

After the sandbox session is opened on the cold-start path (after the `proxy:open-session` + `sandbox:open-session` succeed, before the turn work is queued — locate by the `sandbox:open-session` call), insert the card-fire block. It only runs when there is at least one authored draft with an unapproved delta:

```ts
    // Phase 4 PR-B (D-B1/D-B3) — fire ONE upfront approval card per authored
    // draft with a non-empty SHOWN delta (hosts/slots/packages; mcp deferred),
    // deduped per (conversation, skillId, shown-delta). conversationId is the
    // SSE match key for skill cards, so guard on it.
    if (ctx.conversationId !== undefined && ctx.conversationId.length > 0) {
      const cardable = authoredDraftSkills.filter(
        (s) =>
          s.proposalDelta.allowedHosts.length > 0 ||
          s.proposalDelta.credentials.length > 0 ||
          s.proposalDelta.packages.npm.length > 0 ||
          s.proposalDelta.packages.pypi.length > 0,
      );
      if (cardable.length > 0) {
        // Vaulted refs → haveExisting on account-tagged slots (mirror request_capability).
        const vaultedRefs = new Set<string>();
        if (bus.hasService('credentials:list')) {
          try {
            const list = await bus.call<
              { scope: 'user'; ownerId: string },
              { credentials: Array<{ ref: string }> }
            >('credentials:list', ctx, { scope: 'user', ownerId: ctx.userId });
            for (const c of list.credentials) vaultedRefs.add(c.ref);
          } catch {
            /* a failed lookup just means the card prompts — never block it */
          }
        }
        const fired = upfrontCardsByConv.get(ctx.conversationId) ?? new Set<string>();
        for (const s of cardable) {
          const key = authoredCardDedupKey(s.id, s.proposalDelta);
          if (fired.has(key)) continue;
          const card = buildAuthoredCardPayload(
            { skillId: s.id, description: s.description, delta: s.proposalDelta },
            vaultedRefs,
          );
          if (card === null) continue;
          fired.add(key);
          await bus.fire('chat:permission-request', ctx, card);
        }
        if (fired.size > 0) upfrontCardsByConv.set(ctx.conversationId, fired);
      }
    }
```

- [ ] **Step 7: Build + run the orchestrator suite**

Run: `pnpm --filter @ax/chat-orchestrator build`
Expected: tsc PASS.
Run: `pnpm --filter @ax/chat-orchestrator exec vitest run`
Expected: PASS (the at-spawn fire is exercised end-to-end in the canary, Task 7).

- [ ] **Step 8: Commit**

```bash
git add packages/chat-orchestrator/src/authored-card.ts \
        packages/chat-orchestrator/src/__tests__/authored-card.test.ts \
        packages/chat-orchestrator/src/orchestrator.ts
git commit -m "feat(orchestrator): upfront authored-skill approval card at spawn (deduped) (Phase 4 PR-B)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: decision routing — authored-first in `postPermissionDecision` (channel-web)

**Files:**
- Modify: `packages/channel-web/src/server/routes-chat.ts`
- Modify: `packages/channel-web/src/__tests__/server/routes-chat.test.ts`

- [ ] **Step 1: Write the failing routing tests**

In `packages/channel-web/src/__tests__/server/routes-chat.test.ts`, extend the mock-grant plugin (the one registering `agent:apply-capability-grant`, ~`:203-230`) to ALSO register `agent:apply-authored-capability-grant`, and capture which path ran. Add a module-level trace and register the authored grant so that skillId `'authored-draft'` → `{applied:true}` and anything else → `{applied:false, reason:'not-authored'}`:

```ts
// inside the mock grant plugin's init, beside agent:apply-capability-grant:
      bus.registerService(
        'agent:apply-authored-capability-grant',
        'mock-grant',
        async (_c, input: unknown) => {
          const i = input as { skillId: string };
          grantTrace.authored.push(i.skillId);
          return i.skillId === 'authored-draft'
            ? { applied: true, respawned: false }
            : { applied: false, reason: 'not-authored' };
        },
      );
```

Add `'agent:apply-authored-capability-grant'` to that plugin's `manifest.registers`. Define `const grantTrace = { authored: [] as string[], catalog: [] as string[] };` at module scope and push the skillId in the EXISTING `agent:apply-capability-grant` handler too (`grantTrace.catalog.push(i.skillId)`).

Then add two cases in the `POST /api/chat/permission-decision` describe (mirror the existing happy-path test ~`:1090`, which seeds a conversation + posts `{conversationId, skillId}` via `postDecision`):

```ts
  it('routes an authored draft to agent:apply-authored-capability-grant', async () => {
    // ...seed conversation owned by the user (reuse the helper in the existing test)...
    const res = await postDecision(port, { conversationId, skillId: 'authored-draft' });
    expect(res.status).toBe(200);
    expect(grantTrace.authored).toContain('authored-draft');
    expect(grantTrace.catalog).not.toContain('authored-draft');
  });

  it('falls back to the catalog grant when the skill is not an authored draft', async () => {
    const res = await postDecision(port, { conversationId, skillId: 'catalog-skill' });
    expect(res.status).toBe(200);
    expect(grantTrace.authored).toContain('catalog-skill'); // tried authored first
    expect(grantTrace.catalog).toContain('catalog-skill');  // then fell back
  });
```

(Reset `grantTrace.authored.length = 0; grantTrace.catalog.length = 0;` in a `beforeEach`/at the top of each test as the surrounding suite does.)

- [ ] **Step 2: Run them — verify they fail**

Run: `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server/routes-chat.test.ts -t "permission-decision"`
Expected: FAIL — the route always calls the catalog grant; `grantTrace.authored` is empty.

- [ ] **Step 3: Add authored-first routing**

In `packages/channel-web/src/server/routes-chat.ts` `postPermissionDecision`, declare the local I/O types near the top of the file (invariant #2 — no orchestrator import):

```ts
interface ApplyAuthoredGrantInput {
  conversationId: string;
  userId: string;
  agentId: string;
  skillId: string;
}
type ApplyAuthoredGrantOutput =
  | { applied: true; respawned: boolean }
  | { applied: false; reason: 'not-authored' };
```

Replace the single `agent:apply-capability-grant` call (step 5 of the handler) with authored-first routing:

```ts
  try {
    // Authored-first (D-B7): the host-side grant is the authority on which path
    // runs — the route never trusts a client `authored` flag. An authored draft
    // applies here; a catalog skill returns not-authored and we fall through.
    if (bus.hasService('agent:apply-authored-capability-grant')) {
      const a = await bus.call<ApplyAuthoredGrantInput, ApplyAuthoredGrantOutput>(
        'agent:apply-authored-capability-grant',
        grantCtx,
        { conversationId: body.conversationId, userId, agentId, skillId: body.skillId },
      );
      if (a.applied) {
        res.status(200).json({ ok: true });
        return;
      }
    }
    const out = await bus.call<
      { conversationId: string; userId: string; agentId: string; skillId: string },
      { attached: boolean }
    >('agent:apply-capability-grant', grantCtx, {
      conversationId: body.conversationId,
      userId,
      agentId,
      skillId: body.skillId,
    });
    res.status(200).json({ ok: true, attached: out.attached });
  } catch (err) {
    grantCtx.logger.warn('permission_decision_grant_failed', {
      conversationId: body.conversationId,
      skillId: body.skillId,
      err: err instanceof Error ? err : new Error(String(err)),
    });
    res.status(500).json({ error: 'grant-failed' });
  }
```

- [ ] **Step 4: Run the routing tests — verify they pass**

Run: `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server/routes-chat.test.ts -t "permission-decision"`
Expected: PASS (existing happy path + the two new cases).

- [ ] **Step 5: Build channel-web**

Run: `pnpm --filter @ax/channel-web build`
Expected: tsc PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/server/routes-chat.ts \
        packages/channel-web/src/__tests__/server/routes-chat.test.ts
git commit -m "feat(channel-web): route authored-skill approvals to the authored grant (server-derived) (Phase 4 PR-B)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: canary — approved authored host reachable through the proxy (real executors) + MCP fail-closed

**Files:**
- Modify: `packages/test-harness/src/test-proxy-plugin.ts`
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts`

- [ ] **Step 1: Add an `onOpenSession` capture to the test proxy**

In `packages/test-harness/src/test-proxy-plugin.ts`, add the optional hook to `TestProxyPluginOpts` and call it in the `proxy:open-session` handler:

```ts
export interface TestProxyPluginOpts {
  script: StubRunnerScript;
  envExtra?: Record<string, string>;
  /** Test hook — receives the proxy:open-session input verbatim so a canary can
   * assert the orchestrator folded the right allowlist/credentials. */
  onOpenSession?: (input: {
    sessionId: string;
    userId: string;
    agentId: string;
    allowlist: string[];
    credentials: Record<string, { ref: string; kind: string }>;
  }) => void;
}
```

In the handler, capture before returning:

```ts
        async (_ctx: AgentContext, input: unknown) => {
          opts.onOpenSession?.(input as Parameters<NonNullable<TestProxyPluginOpts['onOpenSession']>>[0]);
          return {
            proxyEndpoint: 'tcp://127.0.0.1:1',
            caCertPem: DUMMY_CA_PEM,
            envMap: { AX_TEST_STUB_SCRIPT: encoded, ...(opts.envExtra ?? {}) },
          };
        },
```

Run: `pnpm --filter @ax/test-harness build && pnpm --filter @ax/test-harness exec vitest run`
Expected: tsc PASS; existing test-proxy test still PASS.

- [ ] **Step 2: Write the PR-B canary (reachability + MCP fail-closed)**

In `presets/k8s/src/__tests__/acceptance.test.ts`, add a new `it(...)` after the Phase-4 PR-A canary. It mirrors the PR-A canary's bootstrap (real `createSkillsPlugin` + `createAgentsPlugin` + workspace-git-server + `simulateRunnerTurn` + `workspaceCommitNotifyHandler`) AND drives a real `agent:invoke` cold start with a capturing test proxy. Key differences from PR-A: write approval rows via `skills:approved-caps-set`, then drive `agent:invoke` and assert the captured allowlist/credentials.

```ts
  it(
    'Phase 4 PR-B canary: an APPROVED authored host+credential is folded into the proxy allowlist+creds at spawn; an UNAPPROVED host is not; mcp stays fail-closed (real executors)',
    { timeout: 30_000 },
    async () => {
      const connectionString = await ensurePostgresStarted();
      const serverToken = randomBytes(32).toString('hex');
      const serverRepoRoot = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'ax-phase4-prb-canary-')),
      );
      let server: WorkspaceGitServer | null = null;
      let handle: Awaited<ReturnType<typeof bootstrap>> | null = null;
      const captured: Array<{ allowlist: string[]; credentials: Record<string, { ref: string; kind: string }> }> = [];
      try {
        server = await createWorkspaceGitServer({ repoRoot: serverRepoRoot, host: '127.0.0.1', port: 0, token: serverToken });
        const presetConfig: K8sPresetConfig = {
          database: { connectionString: 'postgres://stub:5432/stub' },
          eventbus: { connectionString: 'postgres://stub:5432/stub' },
          session: { connectionString: 'postgres://stub:5432/stub' },
          workspace: { backend: 'git-protocol', baseUrl: `http://127.0.0.1:${server.port}`, token: serverToken },
          sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
          ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
          chat: { runnerBinary: stubRunnerPath, chatTimeoutMs: 60_000 },
          http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
        };
        const presetPlugins = createK8sPlugins(presetConfig);
        const kept = presetPlugins.filter((p) => !PLUGINS_TO_DROP.has(p.manifest.name));
        const sqlitePath = path.join(tmp, 'phase4-prb-canary.sqlite');
        const replacements: Plugin[] = [
          createDatabasePostgresPlugin({ connectionString }),
          createSkillsPlugin(),
          createAgentsPlugin(),
          createHttpRegisterRouteStubPlugin(),
          createAuthRequireUserStubPlugin(),
          createStorageSqlitePlugin({ databasePath: sqlitePath }),
          createSessionInmemoryPlugin(),
          createSandboxSubprocessPlugin(),
          createIpcServerPlugin(),
          createTestProxyPlugin({
            script: { entries: [{ kind: 'finish', reason: 'end_turn' }] },
            onOpenSession: (input) => captured.push({ allowlist: input.allowlist, credentials: input.credentials }),
          }),
          createMcpClientPlugin(),
        ];
        const plugins: Plugin[] = [...kept, ...replacements];
        const bus = new HookBus();
        handle = await bootstrap({ bus, plugins, config: {} });

        const sessionId = 'phase4-prb';
        const userId = `phase4-user-${sessionId}`;
        const agentId = `phase4-agent-${sessionId}`;
        const ctx = makeAgentContext({ sessionId, agentId, userId, conversationId: 'cnv-prb', workspace: { rootPath: tmp } });
        const workspaceId = workspaceIdFor({ userId, agentId });
        const bareRepoPath = path.join(serverRepoRoot, `${workspaceId}.git`);

        // A draft proposing TWO hosts + a credential + an MCP server.
        const proposingSkillMd =
          '---\n' +
          'name: linear\n' +
          'description: Query Linear issues\n' +
          'capabilities:\n' +
          '  allowedHosts:\n' +
          '    - api.linear.app\n' +
          '    - unapproved.example.com\n' +
          '  credentials:\n' +
          '    - slot: LINEAR_API_KEY\n' +
          '      kind: api-key\n' +
          '  mcpServers:\n' +
          '    - name: linear-mcp\n' +
          '      transport: stdio\n' +
          '      command: npx\n' +
          '      args: ["-y", "linear-mcp"]\n' +
          '---\n' +
          '# Linear\nQuery issues.\n';

        const { bundleB64 } = await simulateRunnerTurn({
          baselineFiles: [],
          turnFiles: { '.ax/draft-skills/linear/SKILL.md': proposingSkillMd },
          parentDir: tmp,
        });
        const commit = await workspaceCommitNotifyHandler({ parentVersion: null, reason: 'turn', bundleBytes: bundleB64 }, ctx, bus);
        expect(commit.status).toBe(200);

        // Approve ONLY api.linear.app + LINEAR_API_KEY (NOT unapproved.example.com, NOT the mcp server).
        await bus.call('skills:approved-caps-set', ctx, { ownerUserId: userId, agentId, skillId: 'linear', kind: 'host', value: 'api.linear.app' });
        await bus.call('skills:approved-caps-set', ctx, { ownerUserId: userId, agentId, skillId: 'linear', kind: 'slot', value: 'LINEAR_API_KEY', detail: { kind: 'api-key' } });

        // Seed a credential value under the ref PC-1 derives (skill:<id>:<slot>).
        await bus.call('credentials:set', ctx, { scope: 'user', ownerId: userId, ref: 'skill:linear:LINEAR_API_KEY', kind: 'api-key', payload: 'tok-123' });

        // The projection now grants the approved subset.
        const projection = await bus.call<
          { ownerUserId: string; agentId: string },
          { skills: Array<{ id: string; capabilities: { allowedHosts: string[]; credentials: Array<{ slot: string }>; mcpServers: unknown[] }; proposalDelta: { allowedHosts: string[]; mcpServers: unknown[] } }> }
        >('agents:resolve-authored-skills', ctx, { ownerUserId: userId, agentId });
        const linear = projection.skills.find((s) => s.id === 'linear')!;
        expect(linear.capabilities.allowedHosts).toEqual(['api.linear.app']);
        expect(linear.capabilities.credentials.map((c) => c.slot)).toEqual(['LINEAR_API_KEY']);
        // MCP FAIL-CLOSED: never approved (the card/grant don't write mcp rows) → not projected.
        expect(linear.capabilities.mcpServers).toEqual([]);
        expect(linear.proposalDelta.mcpServers.length).toBe(1);
        expect(linear.proposalDelta.allowedHosts).toEqual(['unapproved.example.com']);

        // Drive a real cold-start turn → the capturing proxy records what the orchestrator folded.
        const outcome = await bus.call('agent:invoke', ctx, { message: 'hi', conversationId: 'cnv-prb' });
        expect(outcome).toBeDefined();
        expect(captured.length).toBeGreaterThan(0);
        const open = captured[captured.length - 1]!;
        // PC-1: approved host reachable; unapproved host NOT; credential ref folded.
        expect(open.allowlist).toContain('api.linear.app');
        expect(open.allowlist).not.toContain('unapproved.example.com');
        expect(open.credentials['LINEAR_API_KEY']).toEqual({ ref: 'skill:linear:LINEAR_API_KEY', kind: 'api-key' });
      } finally {
        if (handle !== null) await handle.shutdown();
        if (server !== null) await server.close();
        await fs.rm(serverRepoRoot, { recursive: true, force: true });
      }
    },
  );
```

(Adapt `agent:invoke`'s input shape + the agent-creation prerequisite to whatever the surrounding `agent:invoke` canaries at ~`:474`/`:674` use — those tests show the exact ctx + agent-seed + invoke payload this harness expects. Reuse their agent-creation helper so `agents:resolve` returns a real agent for `agentId`. `credentials:set` input shape: confirm against `@ax/credentials` `CredentialsSetInput` — adjust field names if needed.)

- [ ] **Step 3: Run the canary**

Run: `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/acceptance.test.ts -t "Phase 4 PR-B"`
Expected: PASS. (Confirm the package filter name via `grep '"name"' presets/k8s/package.json`.)

- [ ] **Step 4: Run the PR-A canary — no regression**

Run: `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/acceptance.test.ts -t "Phase 4 PR-A"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/test-harness/src/test-proxy-plugin.ts presets/k8s/src/__tests__/acceptance.test.ts
git commit -m "test(preset-k8s): Phase 4 PR-B canary — approved authored host reachable via proxy; mcp fail-closed (real executors)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: full verification + boundary/security notes + open PR-B

- [ ] **Step 1: Full build + scoped tests + lint**

Run:
```bash
pnpm build
pnpm --filter @ax/agents test
pnpm --filter @ax/skills test
pnpm --filter @ax/chat-orchestrator test
pnpm --filter @ax/channel-web test
pnpm --filter @ax/test-harness test
pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/preset.test.ts src/__tests__/acceptance.test.ts
pnpm exec eslint packages/agents/src packages/skills/src packages/chat-orchestrator/src packages/channel-web/src/server packages/cli/src/dev-agents-stub.ts packages/test-harness/src/test-proxy-plugin.ts presets/k8s/src/__tests__
```
Expected: build PASS; all suites PASS; lint clean. (Scope eslint to changed paths — repo-wide `pnpm lint` trips on stale `.worktrees/` copies.)

- [ ] **Step 2: ax-code-reviewer (whole-branch diff vs main)**

Dispatch the `ax-code-reviewer` subagent on `git diff main...HEAD`. Focus: the six invariants; the trust split (authored never routes through the catalog grant; server re-derives authored-ness); the PC-1 fold correctness (ref convention, collision = fatal); silent-failure hunting on the new soft-dep calls + the credentials:list card lookup; the half-wired window (every new service/path reachable + tested this PR). Address findings before opening.

- [ ] **Step 3: security-checklist skill**

Invoke `security-checklist` (touches the proxy egress boundary, plugin loading, untrusted-content handling, new services). Headline for the note: only the approved subset is reachable (PC-1 proves approved→reachable AND unapproved→blocked); approval is host-side, outside the agent's reach (#5, no self-grant); the trusted catalog path is untouched; an untrusted draft cannot hijack a trusted credential slot (collision = fatal terminate); MCP is fail-closed (never projected until a future card PR).

- [ ] **Step 4: Push + open PR-B against main**

PR body MUST include:
- **Half-wired window: CLOSED.** PR-A opened it (store + read projection). PR-B lands the write services (`-set`/`-revoke`), the authored-grant path, PC-1 egress wiring, the upfront card, and decision routing — all reachable + tested in the CLI + k8s presets this PR.
- **Boundary review** (from the design addendum): `skills:approved-caps-{set,revoke}` alternate impl = snapshot blob (rejected); `agent:apply-authored-capability-grant` alternate impl = extend catalog grant (rejected — collapses the trust split); fields are backend-neutral; not an IPC action.
- **Security note** from Step 3.
- **Deviations from the handoff prompt:** (1) MCP card deferred (D-B2) — prong-7c becomes a fail-closed canary assertion; (2) prong-4 reactive→credential enrichment dropped (D-B4) — the reactive host card collects no credential value; credentials flow through the upfront card. (3) PC-1 narrower than the prompt: registry hosts already folded by the existing `unionedSkills` loop.
- Confirm the PC-1 approved-but-reachable canary (Task 7) is green.

```bash
git push -u origin feat/skill-authoring-phase-4-pr-b-approval-timing
gh pr create --base main --title "Skill-authoring Phase 4 PR-B: hybrid approval timing (window CLOSED)" --body "<the body above>"
```

---

## Deferred to a fast-follow (PR-B.1): quarantine-clear affordance

Prong 6 (a channel-web UI to list `skills:quarantine-list` + clear `skills:quarantine-clear` a quarantined draft) is **orthogonal to the approval-timing window** — the Phase-2 quarantine services are already fully wired + tested; they only lack a channel-web UI. Deferring it keeps PR-B focused and reviewable, and leaves no half-wired window (the approval path is fully closed by Tasks 1–7). Recommend a small follow-up PR: two HTTP routes (GET list / POST clear over the existing services, mirroring `routes-allow-host.ts`) + a settings UI built with the `shadcn` skill. **Raise the include-now-vs-defer choice with the user at execution handoff** (the design addendum included it in PR-B as "most separable").

---

## Self-Review (against the design addendum)

**Spec coverage:** D-B1 (dedup) → Task 5 (`authoredCardDedupKey` + `upfrontCardsByConv`, not cleared on chat:end). D-B2 (mcp deferred/fail-closed) → Task 5 (card returns null on mcp-only) + Task 4 (grant writes no mcp row) + Task 7 (canary fail-closed assertion). D-B3 (approve whole shown delta) → Task 4. D-B4 (reactive no-change) → no code task (documented; Task 8 PR note). D-B5 (pure helper) → Task 1. D-B6 (description) → Task 1. D-B7 (server re-derives) → Task 4 (grant self-detects) + Task 6 (authored-first + fallback). PC-1 → Task 2 + Task 7. Write services → Task 3. Canary → Task 7. Boundary/security → Task 8.

**Placeholder scan:** none — every code step shows complete code. Task 7's `agent:invoke` payload + `credentials:set` shape are flagged to confirm against the surrounding canaries (the harness's own established shapes), not placeholders.

**Type consistency:** `ApprovedCapEntry` `{kind,value}` identical across `@ax/skills`/`@ax/agents`. `projectAuthoredBundle` returns `{description, capabilities, delta, manifestYaml}` — consumed identically in Task 1's real handler + CLI stub. `AuthoredResolvedSkillForOrch` (orchestrator local mirror) carries `proposalDelta` + `description`, consumed by Task 4 (grant) + Task 5 (card). The card payload shape (`AuthoredSkillCard`) matches channel-web's `PermissionRequest` skill variant (`kind`/`skillId`/`description`/`hosts`/`slots`/`authored`/`packages`). The credential ref `skill:<id>:<slot>` / `account:<svc>` is identical in Task 2 (fold), the card write, and the catalog grant. The authored-grant I/O (`{applied, respawned}` / `{applied:false, reason:'not-authored'}`) is identical in Task 4 (orchestrator), Task 6 (channel-web local mirror), and the Task 4 stub in acceptance.test.ts.

**Scope check:** PR-B is one coherent slice (the approval path + its egress wiring). Quarantine-clear is correctly deferred.
