# DB-backed Routines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace file-authored routines with approved host tools and structured Settings edits over one durable DB definition, preserving all execution paths and defaults.

**Architecture:** Evolve the existing routine store and scheduler. A pure routines contract supplies validation; the routines plugin owns definitions, execution receipts, dispatch acceptance, and credential cleanup. Decisions owns approval state; tool-policy owns agent/person consent; webhook requests resolve tokens and definitions at request time.

**Tech Stack:** Node >=24, pnpm 10.33.2, TypeScript project references, Zod 3.25.76, Croner 8.1.2, Kysely/PostgreSQL, Vitest/Testcontainers, React and existing shadcn components. Reuse isomorphic-git 1.37.5 for offline workspace maintenance.

**Spec:** [Approved design](2026-10-09-db-backed-routines-design.md), approved by the user after commit `b10579304`. This implementation plan still requires review and execution-method selection.

## Global Constraints

- Work only in `/Users/vpulim/dev/ai/ax-next-db-routines`, branch `codex/db-backed-routines`, created from `origin/main` at `a730c4c6e`. Leave the shared main checkout untouched.
- “The DB is the only definition source.” No dual write, live markdown transport, export, or continuing file synchronization.
- “Do not import existing authored routines.” Delete legacy authored definitions/history/HMACs/current files; preserve defaults, overrides, default history, and existing default conversation identity.
- “Agent creates and edits require approval by default, including webhook routines and calls during a user turn.” Always Allow covers create/update for this agent and this real human only.
- “Updates are patches with revision checks. Omitted fields stay unchanged; `null` clears optional fields; `trigger` and `activeHours` replace complete objects.”
- “No process-local deduplication map.” No new authoritative per-host definition, routing, permission, cleanup, or request state.
- All six routine tools execute on the host and derive actor/agent from authenticated context. Do not flush or apply the workspace for routine CRUD.
- Preserve interval minimum 60 seconds, Croner/timezone validation, webhook events/HMAC, active hours, silence, conversation modes, Enabled, recent fires, Activity, claimDue, fire-now, and default seeds/overrides.
- Overall definition UTF-8 size limit 64 KiB; name 128 chars; description 2,048; cron expression 256; webhook path 128; events at most 32 with names 1–64; silence token/HMAC prefix/header 128; silenceMaxChars integer 0–65,536.
- Use real users for `agents:resolve`. No synthetic execution actors, cross-plugin runtime imports, cross-plugin FKs, or transaction handles passed to another plugin.
- Reuse semantic tokens and installed shadcn primitives. Consult the shadcn skill and Figma context before UI implementation; do not redesign unrelated shell/identity/goals surfaces.
- Require boundary reviews for every new/changed hook/tool and the final security-checklist note. Keep all new infrastructure registered, tested, and canary-reachable in this branch before merge.
- Every kubectl command includes `--context kind-ax-next-dev`. Never deploy to the default GKE context.
- Completion gates: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, `pnpm exec tsc --build`, `pnpm typecheck`, `pnpm lint`, and the kind walkthrough.
- Tasks below are reviewable local commits, not independently shippable slices. Do not merge/deploy intermediate half-wired states. Do not split the cutover into separate delivery plans.

## Review Focus

1. A completed credential removal retried after reconfiguration must not delete a newly saved secret; stale credential forms cannot write to a deleted routine (Tasks 4 and 9).
2. An Always Allow delivery retried after revocation must not re-enable consent, and Undo before release must grant nothing (Tasks 5 and 6).
3. An accepted fire finishing after agent deletion must not recreate purged history, receipts, or status (Tasks 3 and 8).
4. A valid proposal with a failed consent/freshness/ACL read must fail closed even when subscriber exceptions normally become pass-through (Tasks 2, 6, and 7).
5. An enabled/disabled authored routine named like a default must preserve the current default-shadowing behavior; disabling a custom heartbeat must not wake the default unexpectedly (Tasks 3 and 8).

---

## File map and fixed interfaces

New focused routines modules: `definition.ts` (validation/patch normalization), `services.ts` (hook registration and ACL), `tools.ts` (host descriptors/executors/preflight), `cleanup.ts` (durable credential cleanup/agent purge), and `dispatch.ts` (acceptance and completion). Keep engines/fire/tick specialized; do not replace them with a second scheduler.

Create `packages/routines-contract` with `src/{index,definition,services,tools}.ts`. It contains schemas/types/constants only, imports no plugin, and performs no I/O. Permit this pure library in the existing lint rule and add project references to each actual consumer. Do not make the browser import host crypto or core error classes.

The following signatures are the inter-task contract (all public schemas are strict):

```ts
// @ax/routines-contract
type RoutinePatch = Partial<RoutineDefinition>;
type RoutinePermissions = { edit: boolean; stop: boolean; fire: boolean; manageSecret: boolean };
type RoutineView = RoutineDefinition & {
  agentId: string; routineId: string; revision: string;
  origin: 'authored' | 'default'; defaultRoutineId: string | null;
  nextRunAt: string | null; lastRunAt: string | null;
  lastStatus: 'ok' | 'silenced' | 'error' | null;
  lastError: string | null; lastWarning: string | null;
  permissions: RoutinePermissions;
};
type RoutineCreateInput = { agentId: string; requestId: string; definition: RoutineDefinition };
type RoutineUpdateInput = { agentId: string; routineId: string; requestId: string; expectedRevision: string; patch: RoutinePatch };
type RoutineDeleteInput = { agentId: string; routineId: string; requestId: string; expectedRevision: string };
type RoutineFireNowInput = { agentId: string; routineId: string; expectedRevision: string; requestId: string };
type RoutineDeleteOutput = { deleted: true; cleanupPending: boolean };
type RoutineFireNowOutput = { status: 'ok' | 'error' };
type RoutineSecretInput = { agentId: string; routineId: string; expectedRevision: string } & (
  | { operation: 'set'; secret: Uint8Array }
  | { operation: 'delete' }
);

// routines internal: owner and destination never appear in RoutineView
type StoredRoutine = RoutineDefinition & {
  agentId: string; routineId: string; revision: string; ownerUserId: string;
  definitionId: string | null; definitionUpdatedAt: Date | null;
  nextRunAt: Date | null; lastRunAt: Date | null;
  lastStatus: 'ok' | 'silenced' | 'error' | null;
  lastError: string | null; lastWarning: string | null;
};
type RoutineKey = { agentId: string; routineId: string };
type AcceptedDispatch = {
  dispatchId: string; reqId: string; row: StoredRoutine;
  source: 'tick' | 'manual' | 'webhook'; acceptedAt: Date;
};
type DispatchOutcome = {
  status: 'ok' | 'silenced' | 'error'; conversationId: string | null;
  error: string | null; renderedPrompt: string | null; warning: string | null;
};

// tool-policy (schemas remain in this plugin)
type RoutineConsent = { enabled: boolean; revision: string };
type GrantRoutineConsentInput = { decisionId: string; expectedRevision: string };
type GrantRoutineConsentOutput = RoutineConsent & { delivered: true };

// decisions (schemas remain in this plugin)
type AuthorizeRoutineCallInput = { call: ToolCall };
type AuthorizeRoutineCallOutput = { authorizationId: string; requestId: string };
type SettleRoutineCallInput = {
  authorizationId: string; outcome: 'succeeded' | 'failed'; failureCode?: SafeToolCode;
};
```

`RoutineDefinition` and its field bounds are exactly the approved spec. The tool-policy grant hook derives agent/person from trusted decision replay context. Only decisions calls it. Every mutating tool/service includes a logical requestId, reused on retries; authorization returns that same requestId. This adds requestId to update/delete for durable response-loss recovery without changing patch/CAS semantics. Settings generates `crypto.randomUUID()` for logical mutations and retains it until a definite response. Secret set/delete shares one lifecycle hook; neither operation is an agent tool.

Two implementation refinements resolve existing infrastructure constraints without changing product behavior:

- `HookBus.subscribe` currently has insertion order only. Add optional `{ priority?: number }`, default 0, stable ascending order. Routine read-only preflight uses -100; decisions remains at normal priority after existing validators. The execution check remains mandatory if a subscriber fails or times out. Boundary review: alternate bus is an ordered external middleware pipeline; priority is domain ordering, not storage/transport data; no IPC field changes.
- Use a closed safe-error vocabulary whose messages are generated by core, never an arbitrary plugin-provided string. Existing IPC error envelopes already carry message/status; no new central routine IPC action or protocol union is needed. Both runners already propagate IPC failures; pin that behavior with tests and change adapters only if those tests expose a gap.

### Task 1: Structured contracts and field validation

**Files:** Create `packages/routines-contract/package.json`, `tsconfig.json`, `src/index.ts`, `src/definition.ts`, `src/services.ts`, `src/tools.ts`, `src/__tests__/definition.test.ts`; modify root `tsconfig.json`, `eslint.config.mjs`, `pnpm-lock.yaml`, and consumer manifests/references when those tasks start using the contract.

**Interfaces:** Produce `RoutineDefinitionSchema`, `RoutinePatchSchema`, `RoutineViewSchema`, service input/return schemas, six tool input schemas/JSON schemas, `durationToSeconds`, `validateWebhookPath`, `applyRoutinePatch`, and `routineToolKind(name): 'read' | 'write' | null`. No bus/core/DB imports. New external manifest pins are Zod 3.25.76 and Croner 8.1.2.

- [ ] Write `definition.test.ts` with an explicit definition fixture and field-preservation/patch assertions:

```ts
const base = {
  name: 'Morning brief', description: 'Catch up', promptBody: 'first\nsecond\n', enabled: true,
  trigger: { kind: 'interval' as const, every: '1h' }, activeHours: null,
  silenceToken: null, silenceMaxChars: 300, conversation: 'per-fire' as const,
};
it('replaces nested objects and preserves omitted fields and prompt bytes', () => {
  const changed = applyRoutinePatch(base, {
    trigger: { kind: 'cron', expr: '0 8 * * 1-5', tz: 'America/New_York' },
    activeHours: { start: '22:00', end: '24:00', tz: 'UTC' },
  });
  expect(changed.promptBody).toBe('first\nsecond\n');
  expect(changed.trigger).toEqual({ kind: 'cron', expr: '0 8 * * 1-5', tz: 'America/New_York' });
  expect(applyRoutinePatch(changed, { activeHours: null }).activeHours).toBeNull();
});
it.each(['/../a', '/a//b', '/a/', '/%61', '/webhooks/a', '/a?token=x'])('rejects %s', path => {
  expect(RoutineDefinitionSchema.safeParse({ ...base, trigger: { kind: 'webhook', path } }).success).toBe(false);
});
```

- [ ] Run `pnpm --filter @ax/routines-contract test`; expect missing package/export failure before implementation.
- [ ] Implement strict Zod objects and semantic validation. Use discriminated trigger union; make the patch schema an explicit strict object of optional editable fields so create defaults cannot accidentally fill a patch. Use this merge/duration core:

```ts
export function durationToSeconds(value: string): number | null {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (match === null) return null;
  const factors = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = Number(match[1]) * factors[match[2] as keyof typeof factors];
  return Number.isSafeInteger(seconds) && seconds >= 60 &&
    seconds * 1000 <= 8_640_000_000_000_000 - Date.now() ? seconds : null;
}
export function applyRoutinePatch(current: RoutineDefinition, patch: RoutinePatch): RoutineDefinition {
  const checked = RoutinePatchSchema.parse(patch);
  return RoutineDefinitionSchema.parse({ ...current, ...checked });
}
```

Use `new Cron(expr, { timezone: tz })` without a callback in a try/catch, matching the existing cron engine's syntax-only use. Validate timezone with `Intl.DateTimeFormat`. Use ASCII path checks plus segment validation, not URL decoding. Validate total UTF-8 length with TextEncoder, not string.length. Reject webhook activeHours. Service adapters map schema issue paths to the closed safe field vocabulary; unknown keys produce the constant field `input`.

- [ ] Add table-driven tests for all three triggers, valid overnight hours, timezone/DST, each numeric/text limit, empty patches, null clearing, HMAC defaults/options, malformed headers, invalid JSON-like inputs, overflow, and every field round-trip. Test browser-safe imports. Pin logical request IDs/revision/ID to bounded opaque strings without parsing their encoding.
- [ ] Install only after execution approval, using the existing lockfile; inspect resolved dependency manifests for install scripts/new transitives and record the result. Run the contract tests and project build; commit `feat: define structured routine contracts`.

### Task 2: Safe host failures, ordered preflight, and retired-path hard veto

**Files:** Create `packages/core/src/safe-tool-error.ts`, `retired-routine-path.ts`, corresponding tests; modify `packages/core/src/{index,hook-bus,workspace-apply-facade}.ts`, `packages/ipc-core/src/handlers/{tool-execute-host,workspace-commit-notify}.ts`, their existing tests, `packages/agent-claude-sdk-runner/src/__tests__/host-mcp-server.test.ts`, and `packages/agent-aisdk-runner/src/__tests__/host-tools.test.ts`.

**Interfaces:** Produce `SafeToolError extends PluginError`, `SafeToolCode`, `SafeToolField`, `safeToolMessage(code, field)`, `assertNoRetiredRoutinePuts(changes: readonly FileChange[]): void`; extend subscribe's optional priority argument, with unchanged three-argument behavior. Both exported error fields and messages are closed vocabulary, never caller text.

- [ ] Add failing core/IPC tests: returned safe error reaches wire; an ordinary PluginError with a fake safe-looking code/message remains redacted; malicious unknown field names do not enter the message; subscriber order is stable and default registration order unchanged. Add runner tests expecting Claude `isError: true` and AI SDK executor rejection/failure callback for an actionable IPC error.

```ts
async function dispatchHostToolThatThrows(error: Error) {
  const bus = new HookBus();
  bus.registerService('tool:execute:example', '@ax/test-host-tool', async () => { throw error; });
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
  return toolExecuteHostHandler({ call: { id: 'call1', name: 'example', input: {} } }, ctx, bus);
}
it('keeps unknown host errors generic', async () => {
  const result = await dispatchHostToolThatThrows(new PluginError({
    code: 'invalid-payload', plugin: '@ax/third-party', message: 'private bearer secret',
  }));
  expect(JSON.stringify(result)).not.toContain('private bearer secret');
});
```

- [ ] Run `pnpm --filter @ax/core test` and `pnpm --filter @ax/ipc-core test`, confirming the new cases fail.
- [ ] Implement SafeToolError with the following closed messages. Fields are `input`, editable field paths, `routineId`, `expectedRevision`, `requestId`; runtime-check the enum before generating text. IPC uses 400 for validation, 404 for inaccessible/missing, 409 for conflicts/disabled/cleanup, 403 for denied authority; infrastructure remains generic 5xx. Check subtype before ordinary PluginError redaction. Replay already sees a thrown PluginError, so it cannot record successful execution.

```ts
const TOOL_MESSAGES = {
  validation: 'Routine input is invalid. Check the indicated field.',
  'revision-conflict': 'The routine changed. Read it with routine_get and submit a fresh edit.',
  'webhook-path-conflict': 'Another routine on this agent already uses that webhook path.',
  'request-conflict': 'This request ID was used for different input. Use a new request ID.',
  'approval-required': 'This operation requires human approval.',
  'not-found': 'The routine is unavailable.',
  forbidden: 'This operation is not allowed for this person and agent.',
  disabled: 'Enable the routine before firing it.',
  'cleanup-pending': 'Credential removal is pending. Retry after it completes.',
  unavailable: 'Routine management is temporarily unavailable.',
} as const;
const TOOL_FIELDS = ['input','name','description','promptBody','enabled','trigger',
  'trigger.every','trigger.expr','trigger.tz','trigger.path','trigger.events',
  'trigger.hmac','trigger.hmac.header','trigger.hmac.algorithm','trigger.hmac.prefix',
  'activeHours','activeHours.start','activeHours.end','activeHours.tz',
  'silenceToken','silenceMaxChars','conversation','routineId','expectedRevision','requestId'] as const;
export type SafeToolCode = keyof typeof TOOL_MESSAGES;
export type SafeToolField = typeof TOOL_FIELDS[number];
export function safeToolMessage(code: SafeToolCode, field: SafeToolField): string {
  const checkedCode = Object.hasOwn(TOOL_MESSAGES, code) ? code : 'unavailable';
  const checkedField = (TOOL_FIELDS as readonly string[]).includes(field) ? field : 'input';
  return `${TOOL_MESSAGES[checkedCode]} Field: ${checkedField}`;
}
export class SafeToolError extends PluginError {
  readonly toolCode: SafeToolCode;
  readonly field: SafeToolField;
  constructor(code: SafeToolCode, field: SafeToolField) {
    const checkedCode = Object.hasOwn(TOOL_MESSAGES, code) ? code : 'unavailable';
    const checkedField = (TOOL_FIELDS as readonly string[]).includes(field) ? field : 'input';
    super({code:'invalid-payload',plugin:'@ax/core',message:safeToolMessage(checkedCode,checkedField)});
    this.toolCode = checkedCode;
    this.field = checkedField;
  }
}
```

IPC must recompute `safeToolMessage(error.toolCode,error.field)` and use that closed code for status mapping; it must never forward error.message merely because instanceof matches. A third-party plugin can mutate an Error after construction. Add a regression that changes a SafeToolError's message to a fake secret and confirms the wire and routine approval receipt still use the fixed template. For field-specific validation, the model uses the schema/tool descriptions; do not attach arbitrary Zod/parser/SQL messages. Infra exceptions must not be converted to SafeToolError merely because they happened during validation.
- [ ] Add stable subscriber priority sorting at registration, retaining order among equal priorities. Extend RegisteredSubscriber with `priority:number`. Do not reorder unrelated validators or add per-agent state. Run the existing subscriber failure/timeout tests too. The registration body is:

```ts
subscribe<P>(hookName: string, plugin: string, handler: SubscriberHandler<P>,
  options: { priority?: number } = {}): void {
  const priority = options.priority ?? 0;
  if (!Number.isSafeInteger(priority)) throw new Error('subscriber priority must be a safe integer');
  const list = this.subscribers.get(hookName) ?? [];
  list.push({ plugin, handler: handler as SubscriberHandler, priority });
  list.sort((left, right) => left.priority - right.priority);
  this.subscribers.set(hookName, list);
}
```
- [ ] Implement the retired-prefix veto and invoke it before any bus/persistence call in public apply and after bundle diff extraction but before pre-apply/apply-bundle in runner commit. Canonicalize separators using the workspace path discipline; reject any put into `.ax/routines/`, allow deletes. Existing authenticated backend-internal apply stays a host capability, not a new IPC bypass.

```ts
export function assertNoRetiredRoutinePuts(changes: readonly FileChange[]): void {
  if (changes.some(change => change.kind === 'put' && change.path.startsWith('.ax/routines/'))) {
    throw new PluginError({ code: 'rejected', plugin: '@ax/core',
      reasonCode: 'routine-files-retired',
      message: 'Routine files are no longer supported. Use the routine tools.' });
  }
}
```

Use the existing canonical path validator before this check; tests include alternate separators/dot segments so a malformed path cannot evade the veto. Return the same authored refusal through commit-notify's current rejection response rather than map it to an internal error. Test an earlier permissive subscriber and a throwing subscriber cannot cause persistence.

- [ ] Run core, IPC, and both runner targeted suites; commit `feat: enforce routine host failure and retired-path boundaries`.

### Task 3: One-time retirement migration and transactional routine store

**Files:** Modify `packages/routines/src/{migrations,store,types,reflection-prompt}.ts`; create `retirement-migration.ts`, `definition.ts`, `dispatch.ts`, `src/__tests__/{definition,retirement,dispatch}.test.ts`; modify existing migrations/store/default tests.

**Interfaces:** `runRoutinesMigration(db)` retains its name. Store produces `createAuthored`, `updateAuthored`, `deleteAuthored`, scoped `list/findOne/findWebhook`, `acceptDispatch`, `finishDispatch`, `withLockedWebhookSecret`, `pendingCleanup`, `completeCleanup`, `purgeAgent`, and `findOperationReceipt`. Operation receipt writes remain inside mutation transactions. Keep default materialization/refresh/reconcile methods with routineId/revision-aware rows. Below-bus helper signatures:

```ts
createAuthored(input: RoutineCreateInput & { ownerUserId: string; now: Date }): Promise<StoredRoutine>;
updateAuthored(input: RoutineUpdateInput & { now: Date; stopOnly: boolean }): Promise<StoredRoutine>;
deleteAuthored(input: RoutineDeleteInput & { now: Date }): Promise<RoutineDeleteOutput>;
findOne(key: RoutineKey): Promise<StoredRoutine | null>;
findWebhook(input: { agentId: string; path: string }): Promise<StoredRoutine | null>;
acceptDispatch(input: RoutineKey & {
  expectedRevision: string; source: 'tick' | 'manual' | 'webhook';
  requestId: string; now: Date;
}): Promise<AcceptedDispatch | null>;
finishDispatch(input: { dispatchId: string; outcome: DispatchOutcome }): Promise<boolean>;
purgeAgent(agentId: string): Promise<void>;
withLockedWebhookSecret(input: RoutineSecretInput, effect: () => Promise<void>): Promise<{saved:true}>;
pendingCleanup(input: {limit:number}): Promise<Array<{
  agentId:string; routineId:string; credentialRef:string; ownerUserId:string;
}>>;
completeCleanup(input: {agentId:string;credentialRef:string}): Promise<void>;
findOperationReceipt(input: {
  agentId:string; actorUserId:string; operation:string; requestId:string; inputHash:string;
}): Promise<unknown | null>;
```

Operation-receipt writes are private helpers inside each mutation transaction; do not expose a standalone settleOperationReceipt method that could separate the effect from its receipt. Parse receipt output with the operation's return schema before returning it. Before mutation, insert-or-lock the scoped request row; differing inputHash conflicts, a completed matching result returns directly, and new effect+result commit together.

- [ ] Seed an origin/main legacy schema in `retirement.test.ts`, insert interval/cron/webhook authored rows with all optional fields, HMAC refs, legacy orphan fires, customized defaults/overrides/history, and run the migration twice. Assert authored rows removed, exact refs queued, default IDs/history/conversation keys unchanged, source_md removed, and a new DB routine created between runs survives. Add fresh-schema and rollback-on-DDL-failure tests.
- [ ] Run the routines migration tests with an explicit DOCKER_HOST; confirm the new-schema assertions fail.
- [ ] Replace the repeat-all-DDL startup with schema detection and one transaction per versioned migration. If definitions has `path`, run retirement once: capture HMAC jobs before deletion using the deterministic legacy `routine:${agentId}:${path}:hmac` ref, never an arbitrary secretRef inside trigger JSON; preserve default rows by definition_id and default fire identity, delete authored/orphan file-path fires, rename identity columns, and mark completion. Fresh schema uses routine_id directly. Do not run old path/source_md seed SQL against a converted schema. Preserve old seed hash guards before removing source_md; skip updates to customized defaults. Test a forged legacy secretRef cannot cause another credential family to be deleted.

Canonical additions include:

```sql
ALTER TABLE routines_v1_definitions ADD COLUMN revision TEXT NOT NULL DEFAULT 'initial';
ALTER TABLE routines_v1_definitions ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE;
CREATE UNIQUE INDEX routines_v1_webhook_path_unique
  ON routines_v1_definitions (agent_id, (trigger_spec->>'path'))
  WHERE trigger_kind = 'webhook';
CREATE TABLE routines_v1_requests (
  agent_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
  operation TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
  result JSONB, routine_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, owner_user_id, operation, request_id)
);
CREATE TABLE routines_v1_credential_cleanup (
  agent_id TEXT NOT NULL, routine_id TEXT NOT NULL, credential_ref TEXT NOT NULL,
  owner_user_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, credential_ref)
);
CREATE TABLE routines_v1_dispatches (
  dispatch_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, routine_id TEXT NOT NULL,
  revision TEXT NOT NULL, req_id TEXT NOT NULL UNIQUE, accepted_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ, trigger_source TEXT NOT NULL
);
```

Guard every addition for migration reruns, initialize revision to a distinct host-generated value per definition, and add unique dispatch_id on fires to prevent double terminal recording. All FKs, if used, stay inside routines. Dispatch rows intentionally survive routine deletion but are purged with the agent.

- [ ] Implement mutation transactions with `SELECT ... FOR UPDATE`, revision comparison, merged validation, and only then write/receipt. IDs/revisions use `randomUUID().replaceAll('-', '')` with host prefixes. Convert only the known uniqueness constraint to webhook-path-conflict; unknown DB exceptions stay infrastructure errors. Compare only scheduling fields to decide whether to recompute nextRun. Preserve raw prompt newlines and owner. Delete writes an exact cleanup job atomically.

```ts
const current = await trx.selectFrom('routines_v1_definitions')
  .selectAll().where('agent_id', '=', input.agentId)
  .where('routine_id', '=', input.routineId).forUpdate().executeTakeFirst();
if (!current) throw new SafeToolError('not-found', 'routineId');
if (current.revision !== input.expectedRevision) {
  throw new SafeToolError('revision-conflict', 'expectedRevision');
}
const next = applyRoutinePatch(editableDefinition(rowToRoutine(current)), input.patch);
```

`applyRoutinePatch` receives only editable fields; rowToRoutine also carries private fields. Add this pure projection to definition.ts:

```ts
export function editableDefinition(row: RoutineDefinition): RoutineDefinition {
  return {name:row.name,description:row.description,promptBody:row.promptBody,enabled:row.enabled,
    trigger:row.trigger,activeHours:row.activeHours,silenceToken:row.silenceToken,
    silenceMaxChars:row.silenceMaxChars,conversation:row.conversation};
}
```

Gate stopOnly to exactly `{enabled:false}`. Keep default shadowing by authored name, including disabled definitions. Update internal advance operations to accept expectedRevision and no-op when stale.

- [ ] Add concurrent unique-path, CAS, idempotent create/request-conflict, commit-before-response retry, schedule-not-reset-on-prompt-edit, default shadowing, and wrong-agent tests. AcceptDispatch rechecks enabled/revision under the same row lock as mutations and commits a dispatch record before invoke. FinishDispatch locks the dispatch record, writes exactly one terminal fire if it still exists, and conditionally updates matching definition status. Missing dispatch after agent purge yields false without creating history. Test finish twice and finish after purge.
- [ ] Run routines store/migration/dispatch/default suites and commit `feat: store routine definitions with revisions and durable lifecycle records`.

### Task 4: Agent management ACL, routine services, and HMAC lifecycle

**Files:** Modify `packages/agents/src/{plugin,types}.ts`, its ACL/webhook tests; create routines `src/{services,cleanup}.ts`, `src/__tests__/{services,cleanup}.test.ts`, `src/__tests__/support/routine-harness.ts`; modify routines plugin/type return-schema tests.

**Interfaces:** Register every routines hook in the approved boundary table. Produce `registerRoutineServices({bus,store,now})`, `drainRoutineCleanup({bus,store,limit})`, `purgeRoutineAgent({bus,store,pending,agentId})`, and `agents:can-manage-routines({agentId}) -> {allowed:boolean}` using ctx.userId. `routines:set-webhook-secret` is a host/human hook, never a descriptor or IPC action.

- [ ] Create a test harness using the real database-postgres and agents plugins, a deterministic `teams:is-member` role fixture, actual routines plugin, and inert invoke/conversation/credential services. Reuse createTestHarness, startTestContainer, stopPostgresContainer. Helper interface:

```ts
type RoutineHarness = {
  bus: HookBus; owner: AgentContext; teamAdmin: AgentContext; teamMember: AgentContext;
  agentId: string; teamAgentId: string; credentialCalls: Array<{ operation: string; ref: string }>;
  failNextCredentialDelete(): void;
  drainCleanup(): Promise<void>;
  close(): Promise<void>;
};
async function createRoutineHarness(): Promise<RoutineHarness>;
```

Seed agents through agents:create using the actual owner context; team fixture supplies real membership/admin checks. When testing service internals before tools arrive, direct human contexts are authorized, and no `agents:resolve` stub returns unconditional success.

- [ ] Add service tests for scoped list/get and all ACL rows in the spec. Team creator is pinned; another admin can delete/disable but cannot edit prompt/enable/fire. Personal ownership change reconciles revision and owner. Ordinary member cannot create. Agent lookup outages propagate; missing team provider denies. Run agents/routines tests and observe expected missing-hook failures.
- [ ] Implement can-manage-routines with existing personal-owner/team-admin helpers, without a payload isAdmin. Adjust ensure/rotate token permission to include team admins while preserving existing explicit admin authority at those token APIs. Every agent-scoped routine service calls agents:resolve using the real ctx actor before querying/returning data, then applies management/owner rules. On personal management reads/mutations, reconcile the resolved real owner's rows/revisions using the same store helper as tick, so a transferred agent need not wait for tick before getting its current owner/revision. Team creator identity stays pinned. Return projections with permissions, no raw owner/hash/ref/token. Default catalog services call `auth:get-user({userId:ctx.userId})` and require `user.isAdmin === true`; declare that dependency and seed its real-user-shaped response in the unit harness. Do not accept a model-provided admin flag or require a registration system actor to pass admin ACL.
- [ ] Wire delete/remove-HMAC to cleanup queue. Cleanup derives credential scope `'agent'`, ownerId agentId, exact ref from captured host data, calls credentials:delete, and removes a job only after confirmation. Retry limit is a bounded batch from DB; log only counts/IDs, never secret bytes. Agent purge removes all routine data and pending correlations but keeps undelivered cleanup jobs until deletion is confirmed. Use identical purge function for event and tick not-found fallback.
- [ ] Implement withLockedWebhookSecret: lock current definition, check expectedRevision/current webhook HMAC/owner management/zero pending cleanup, call bounded credentials:set or credentials:delete according to operation while holding the routines row lock, then return `{saved:true}`. Never pass trx to the credential plugin. Reject stale/removal-pending forms. Serialize cleanup reconfiguration using the same definition row and outstanding job test.

```ts
const webhookDefinition: RoutineDefinition = {
  name: 'Project update', description: '', promptBody: 'Summarize the update.', enabled: true,
  trigger: { kind: 'webhook', path: '/project-updated',
    hmac: { header: 'X-Hub-Signature-256', algorithm: 'sha256' } },
  activeHours: null, silenceToken: null, silenceMaxChars: 300, conversation: 'per-fire',
};
it('keeps removal retry from touching a reconfigured secret', async () => {
  const h = await createRoutineHarness();
  const created = await h.bus.call<RoutineCreateInput, RoutineView>('routines:create', h.owner, {
    agentId: h.agentId, requestId: 'create-hmac', definition: webhookDefinition,
  });
  h.failNextCredentialDelete();
  const removed = await h.bus.call<RoutineUpdateInput, RoutineView>('routines:update', h.owner, {
    agentId: h.agentId, routineId: created.routineId, expectedRevision: created.revision,
    requestId: 'remove-hmac', patch: { trigger: { kind: 'interval', every: '1h' } },
  });
  const readd: RoutineUpdateInput = {
    agentId: h.agentId, routineId: created.routineId, expectedRevision: removed.revision,
    requestId: 'readd-hmac', patch: { trigger: webhookDefinition.trigger },
  };
  await expect(h.bus.call('routines:update', h.owner, readd)).rejects.toMatchObject({
    toolCode: 'cleanup-pending',
  });
  await h.drainCleanup();
  const reconfigured = await h.bus.call<RoutineUpdateInput, RoutineView>('routines:update', h.owner, readd);
  await h.bus.call('routines:set-webhook-secret', h.owner, {
    agentId: h.agentId, routineId: created.routineId, expectedRevision: reconfigured.revision,
    operation: 'set', secret: new TextEncoder().encode('new-test-secret'),
  });
  const count = h.credentialCalls.length;
  await h.drainCleanup();
  expect(h.credentialCalls).toHaveLength(count);
  await h.close();
});
```

The harness credential service throws once when failNextCredentialDelete is armed; drainCleanup invokes the real cleanup function, never a simulated queue. Also test an in-flight credential:set blocks deletion until it completes, and a stale form after deletion fails before credentials:set. Secret hook has its own routine ACL; the human HTTP adapter retains the additional existing admin credential gate.

- [ ] Run agents/routines service+cleanup tests, then commit `feat: authorize routine management and durable credential cleanup`.

### Task 5: Durable agent/person consent and explicit policy rules

**Files:** Create `packages/tool-policy/src/routine-consent.ts`, `src/__tests__/routine-consent.test.ts`; modify `migrations.ts`, `types.ts`, `rules.ts`, `evaluate.ts`, `plugin.ts`, policy/agent-purge tests.

**Interfaces:** Register get/grant/revoke-routine-consent. Get/revoke require `{agentId}` and authenticated ctx.userId. Grant uses `{decisionId,expectedRevision}` under trusted stored-decision context. Return `{enabled,revision}`; no in-memory store fallback. Add `routineConsent?: 'create-update'` to reviewed PolicyRule only, and `routineConsentAllowed?: boolean` to EvaluateOptions.

- [ ] Add tests for holds before grant, grant for only agent+person, read/get failures, process restart, revocation, noneligible tools, and deny precedence. Test a grant delivered twice after revocation stays revoked.

```ts
it('consent cannot relax a deny', () => {
  const rule: PolicyRule = {
    id:'routines.create.blocked',match:{tool:'routine_create'},verdict:'deny',
    capability:'create routines',subject:'agent',providedBy:'host',routineConsent:'create-update',
  };
  expect(evaluate([rule], {name:'routine_create',input:{}}, {
    routineConsentAllowed:true,
  }).verdict).toBe('deny');
  expect(evaluate([{...rule,verdict:'hold'}], {name:'routine_create',input:{}}, {
    routineConsentAllowed:true,
  }).verdict).toBe('allow');
});
```
- [ ] Run tool-policy tests; expect missing services/consent option failures.
- [ ] Add `tool_policy_v1_routine_consent` keyed agent/person with enabled/revision and a same-plugin `tool_policy_v1_routine_consent_deliveries` ledger keyed decisionId. Grant transaction checks delivery first; a duplicate returns delivered with current consent state and never writes enabled=true again. New delivery requires the expected consent revision (absence is revision `'0'`), writes enabled=true/new revision, then records the delivery. Revoke writes enabled=false/new revision and preserves delivery ledger. Purge both on agents:deleted.

```ts
const existingDelivery = await trx.selectFrom('tool_policy_v1_routine_consent_deliveries')
  .selectAll().where('decision_id', '=', input.decisionId).executeTakeFirst();
if (existingDelivery) return { ...(await readConsent(trx, ctx.agentId, ctx.userId)), delivered: true };
// Lock/upsert the scoped consent row, compare expectedRevision, write new
// consent and delivery in this transaction. Do not regrant an old delivery.
```

Define `readConsent(db,agentId,userId): Promise<RoutineConsent>` locally; absence returns disabled/revision0. If revocation wins before first delivery, surface a consent revision conflict and settle that grant intent as failed; do not retry it forever or override the person's newer choice. A new approval can create a new intent.

- [ ] Add exact rules for list/get allow; create/update hold with the explicit consent exception; delete hold once; fire-now hold once with `irreversible:true`, effects `['spends','outward']` since its agent prompt can cause outward effects. Create/update/delete are reversible management changes; all are `providedBy:'host'` using the existing PolicyRule field. Keep static rule verdict hold even when runtime consent relaxes it. Only relax a matched opted-in hold, never deny or an unopted hold. DB absence/read failure leaves hold. Preserve capability/rule/effect disclosures so the rail describes granted create/update honestly.
- [ ] Run policy tests, capability lint, and agent-deletion tests; commit `feat: remember scoped routine consent in tool policy`.

### Task 6: Approval choices and host execution authority

**Files:** Create `packages/decisions/src/routine-authorization.ts`, `src/__tests__/routine-authorization.test.ts`; modify decisions `types.ts`, `migrations.ts`, `store.ts`, `pre-call.ts`, `plugin.ts`, `templates.ts`, `replay.ts`, `receipts.ts`, test fake-store and machine/delivery/replay/expiry/purge tests.

**Interfaces:** Extend decisions:approve with approvalScope. Register `decisions:authorize-routine-call` and `decisions:settle-routine-call`; produce authorization/request ID types above. Internal decision fields: `approvalScope`, `consentExpectedRevision`, `consentDeliveryState: 'none'|'pending'|'delivered'|'failed'`, `routineAuthorizationId`, `routineExecutionFingerprint`, and outcome. State stays in decisions DB.

- [ ] Test Allow once current call only, eligible Always Allow, altered input/agent/person, duplicate approvals, absent policy, consent outage, revision conflict, and no success receipt on safe failure. Test direct execution during undo grace fails and Undo grants nothing. Test restart after grant commit/lost delivery acknowledgement, revocation then duplicate delivery, and exact crash retry before/after routine effect.

Use the existing `base()` Decision fixture in replay.test.ts for this concrete failure regression:

```ts
it('does not mark a stale routine edit as successfully replayed', async () => {
  const decision = base({call:{id:'call1',name:'routine_update',input:{
    requestId:'edit1',routineId:'rtn_a',expectedRevision:'old',patch:{name:'New name'},
  }}});
  const bus = new HookBus();
  bus.registerService('tool:execute:routine_update','@ax/test-routine',async () => {
    throw new SafeToolError('revision-conflict','expectedRevision');
  });
  const outcome = await replayOnApprove({bus,ctx:replayContext(decision),decision});
  expect(outcome.executed).toBe(false);
  expect(outcome.error).toContain('routine_get');
});
```
- [ ] Run decisions tests; confirm new cases fail.
- [ ] Add strict schema/eligibility checks at approval. Bind the real authenticated ctx user to input userId for externally initiated approval; replay already builds a context from stored owner. Preserve existing approve semantics for other tools. Persist scope/expected consent revision with the decision claim. Do not deliver consent during an undo grace window: deliver only when the existing execution/delivery release is due, before waking/replaying the tool. Undo clears unsent intent. On delivery outage leave execution pending and let existing sweep retry; on consent CAS conflict store failure and expose an actionable failed grant result.
- [ ] For routine tools, pre-call evaluates current deny policy before checking standing approval and does not consume the final authorization. It may let an eligible standing approval proceed to the host check only after its release time. AuthorizeRoutineCall re-evaluates policy, binds ctx actor/agent/fingerprint/expiry/release time, and either verifies live create/update consent or atomically claims the matching approved decision. It can return an already-claimed exact logical operation's authorization for safe retry; it cannot authorize changed input.

```ts
const kind = routineToolKind(call.name);
if (kind !== 'write') throw new SafeToolError('forbidden', 'input');
const answer = await bus.call('tool-policy:evaluate', ctx, {
  agentId: ctx.agentId, call: { name: call.name, input: call.input },
});
if (answer.verdict === 'deny') throw new SafeToolError('forbidden', 'input');
const fingerprint = callFingerprint(call);
// Claim exact standing/replay authority in DecisionStore, or issue scoped
// authority only when the opted-in create/update consent is currently live.
```

Define `routineToolKind` in Task 1 and import only that pure contract helper. Use current stored-decision/replay state for matching, not session-name parsing or IPC-supplied flags. Preserve dynamic tool-executor dispatch; decisions does not declare a back-edge to routines. Declare all policy consent calls; routines declares decisions authorization/settlement calls. The ordered preflight from Task 2 avoids invalid proposals being held first.

- [ ] SettleRoutineCall binds authorization to real context and stores succeeded/failed. A host replay settles before receipts; an attended successful tool can now produce a truthful receipt from its settled authority. Safe failure stores closed failureCode and recomputes its template from checked code/field rather than error.message. Unknown routine failures get generic text, never sanitized raw host/vault exception messages; preserve other tools' current receipt semantics. Recover stranded grant/authorization states without executing a different request. Exact mutation receipts recover commit-before-response loss; an unknown completed external fire is never blindly re-invoked.
- [ ] Run decisions approval/pre-call/replay/sweep suites and existing nonroutine regression suites; commit `feat: enforce routine approvals at host execution`.

### Task 7: Register host tools and shared prompt guidance

**Files:** Create `packages/routines/src/tools.ts`, `src/__tests__/tools.test.ts`; modify routines `plugin.ts`, `package.json`, `tsconfig.json`; modify `packages/agent-runner-core/src/{system-prompt,prompt-engine,run-runner}.ts` and prompt tests. Both runner packages consume agent-runner-core; keep their prompt behavior aligned.

**Interfaces:** Produce `registerRoutineTools({bus,store,now})`; register all six `tool:execute:routine_*` services and descriptors through tool:register. Register routine `tool:pre-call` preflight at priority -100. Add `routineNote(): string` and optional final `routineToolsAvailable = false` parameter to buildSystemPrompt; the runner derives availability from its filtered tool catalog. Keep descriptor JSON Schema in the contract's tools.ts, with executesIn/activity metadata in the host tools.ts. Export the pure editableDefinition projection for host/client patch computation.

- [ ] Add descriptor/executor tests using Task 4's real-ACL harness. Assert all six descriptors execute on host, strict schema, no flush flag, no model actor/agent/owner/admin/ref/source/payload fields. A forged direct call without pre-call/consent fails. An invalid interval or stale revision returns validation/conflict before decisions creates a card. DB create/read/update/delete invokes no workspace hook even when workspace:apply rejects storage-full.

Extend createRoutineHarness to load the real tool-policy and decisions plugins now that Tasks 5–6 are available, with a controlled attendance/clock fixture and no consent. The direct-endpoint regression is:

```ts
it('rejects direct host creation without approval', async () => {
  const h = await createRoutineHarness();
  const definition = RoutineDefinitionSchema.parse({
    name:'Daily check',promptBody:'Check outstanding work.',trigger:{kind:'interval',every:'1h'},
  });
  await expect(h.bus.call('tool:execute:routine_create',h.owner,{
    id:'call-direct',name:'routine_create',input:{requestId:'direct1',definition},
  })).rejects.toMatchObject({toolCode:'approval-required'});
  const after = await h.bus.call<{agentId:string},{routines:RoutineView[]}>(
    'routines:list',h.owner,{agentId:h.agentId});
  expect(after.routines.filter(r => r.origin === 'authored')).toHaveLength(0);
  await h.close();
});
```
- [ ] Run routines tools and runner-core prompt tests; expect missing tool/prompt failures.
- [ ] Register descriptors following registerMemoryRecall. For reads derive ctx.agentId and call scoped services. For writes parse strict input, perform read-only preflight, authorize the exact ToolCall, call the appropriate routine service, and settle authority. Host init uses system context only for tool:register, never for agent ACL. Implement the fail-closed preflight guard:

```ts
bus.subscribe<ToolCall>('tool:pre-call', PLUGIN_NAME, async (ctx, call) => {
  if (routineToolKind(call.name) === null) return;
  try {
    await preflightRoutineCall({ bus, store, ctx, call });
    return;
  } catch (error) {
    return reject({ source: PLUGIN_NAME, reason: error instanceof SafeToolError
      ? error.message : 'Routine validation is unavailable. Try again when it is available.' });
  }
}, { priority: -100 });
```

Define `preflightRoutineCall({bus,store,ctx,call}): Promise<void>` in tools.ts. It performs schemas and real ACL, uses receipt read to recognize an already completed matching logical operation, then gets current/merged definition for new effects. It does not mutate definitions or grant authority. A timeout may be swallowed by generic subscribers, but the executor repeats all gates and cannot execute on missing authorization. Executor failures use the closed SafeToolError factory, ordinary infrastructure errors stay redacted.

- [ ] Use a same-transaction operation receipt for every mutation, using the requestId in the authoritative type block. On tool failure settle failed unless the effect receipt proves it committed; then return its saved output and settle success. Do not turn a caught exception into `{error:...}` normal output. Default materializations get clear rejection for authored CRUD, and normal read/fire policy where supported.
- [ ] Add the approved fixed note:

```ts
export function routineNote(): string {
  return 'Use the routine tools to schedule unattended work with interval, cron, or webhook triggers. ' +
    'Use routine_list/routine_get to read current definitions and routine_get before editing. ' +
    'Creates and edits require approval unless the person enabled Always Allow for this agent. ' +
    'Report success only after the tool confirms it. Do not create routine files.';
}
```

Append only when filtered routine tools are available in normal mode. Preserve exclusive bootstrap composition and all identity files. Descriptions explain holds, revisions, null clearing, Enabled, logical retries, and delete/fire once-only approval; definitions/tokens/secrets are never prompt-injected.

- [ ] Test malformed inputs and validation DB outage, hold without definition creation, exact retry, and success evidence in both runner prompt paths. Run routines/runner-core suites and commit `feat: expose approved DB routine tools to agents`.

### Task 8: Reconcile scheduler, fire completion, and request-time webhook routing

**Files:** Modify routines `tick.ts`, `fire.ts`, `webhook-handler.ts`, `plugin.ts`, `store.ts`, `types.ts`, engines and active-hours imports; replace the old route-binding tests with `src/__tests__/webhook-router.test.ts`; update tick/fire/ownership/silence/skip-warning/default canaries.

**Interfaces:** Use Task 3 acceptDispatch/finishDispatch. Produce `createWebhookRouter({bus,store,fire,now}) -> HttpRouteHandler` and retain one unregister handle. `createFireRoutine` consumes accepted dispatch instead of a stale row, preserving PendingFires for existing turn correlation. `runTickOnce` retains its public signature with revision-aware claim rows.

- [ ] Add tick tests: prompt-only update preserves due target; stale claim cannot dispatch/advance after edit/delete; disabled authored/default overrides are unclaimed; enable schedules future occurrence; active-hour defer uses expectedRevision; both enabled and disabled authored heartbeat shadow the default. Add a deferred agent invoke then agent deletion then turn-end regression: history/dispatches/status stay purged. Run routines tick/fire tests and confirm failures.

In dispatch.test.ts use its migrated `db` fixture and the actual store:

```ts
it('does not recreate history after agent purge', async () => {
  const store = createRoutinesStore(db);
  const row = await store.createAuthored({agentId:'a',ownerUserId:'u',requestId:'create1',
    now:new Date('2026-10-09T12:00:00Z'),definition:RoutineDefinitionSchema.parse({
      name:'Check',promptBody:'Check progress.',trigger:{kind:'interval',every:'1m'},
    })});
  const accepted = await store.acceptDispatch({agentId:'a',routineId:row.routineId,
    expectedRevision:row.revision,source:'manual',requestId:'fire1',now:new Date()});
  if (accepted === null) throw new Error('test dispatch was unexpectedly rejected');
  await store.purgeAgent('a');
  expect(await store.finishDispatch({dispatchId:accepted.dispatchId,outcome:{
    status:'ok',conversationId:'c',error:null,renderedPrompt:'Check progress.',warning:null,
  }})).toBe(false);
  expect(await store.recentFiresForAgent({agentId:'a'})).toHaveLength(0);
});
```
- [ ] Replace every row.path with row.routineId, keeping default identity value and conversation externalKey unchanged. Replace unique req ID counter with host UUID-based dispatch reqId from the store. Before dispatch use agents:resolve as accepted row owner; exact not-found purges agent, forbidden records a failure and does not purge. Tick gets current owners/defaults and claims as before, then acceptance rechecks revision/enabled. For default rows, compute effective Enabled from the current catalog flag and agent override in the acceptance transaction; a materialized row's own flag must not bypass a disabled default. Preserve shadow-by-authored-name during automatic claims. Compute conditional advances from the original scheduled time without overwriting an edited schedule.
- [ ] Move terminal writes through finishDispatch. The one actor that removes a PendingFire writes its terminal result; DB unique dispatch and completion guard enforce no second row. Remove pending entries on agent purge. A deleted routine's accepted dispatch may finish/history persist; a deleted agent's dispatch may not. Store warnings/silence exactly once. On startup, abandoned accepted dispatches from a prior process are recorded as interrupted failures, not blindly re-invoked; this avoids duplicate unattended external effects and retains current single-host scope.
- [ ] Replace the webhookRoutes Map/startup scan/token-rotation rebind with one POST route. Lookup the token every request, validate the raw splat path, resolve DB definition, validate raw body/signature/events, then accept current revision and invoke. Schema/domain distinctions are explicit: token is routing authentication, owner agents:resolve is execution authorization. Do not expose a new token service to tools.

```ts
const resolved = await bus.call('agents:resolve-by-webhook-token', requestCtx, { token: req.params.token });
if (!resolved.agent) return res.status(404).json({ error: 'not-found' });
const path = '/' + (req.params['*'] ?? '');
if (!validateWebhookPath(path)) return res.status(404).json({ error: 'not-found' });
const row = await store.findWebhook({ agentId: resolved.agent.id, path });
if (!row || !row.enabled) return res.status(404).json({ error: 'not-found' });
```

Use the actual HttpRequest/HttpResponse duck types already declared in webhook-handler.ts; do not import runtime HTTP plugin code. requestCtx is the host request context for token resolution only; fire context is constructed later with the real stored owner. Preserve 1 MiB body cap, JSON/form parsing, raw HMAC compare, filtered204/accepted202 behavior, and no agent invocation for invalid signature/missing configured key. Derive secretRef on host; no cached route row.

- [ ] Test actual registered route dispatch with JSON, form, SHA256/SHA1/prefix, events absent/present, invalid body/token/path/HMAC, disable/delete, editing URL path, handler restart, owner/member removal, and rotation. Confirm no route re-registration on create/update/rotate/delete. Run the changed tick/fire/webhook/default tests explicitly with `pnpm --filter @ax/routines exec vitest run src/__tests__/tick.test.ts src/__tests__/fire.test.ts src/__tests__/webhook-router.test.ts src/__tests__/canary-defaults.test.ts` and commit `feat: fire current DB routines through tick and webhook routing`. Obsolete sync tests are removed in Task 11; do not claim the whole package is green until then.

### Task 9: Human REST adapters, structured defaults, and credential destinations

**Files:** Modify `packages/routines-admin-routes/src/{routes,shared,plugin}.ts` and routes tests; delete its `storage-full.ts` and test if unused. Modify `packages/credentials/src/{refs,refs-fixtures}.ts`, refs/colon tests; modify `packages/credentials-admin-routes/src/{destination-routes,plugin}.ts` and destination/ref-drift tests; modify channel-web `lib/{routines,default-routines,credentials}.ts`, client tests and `components/credentials/CredentialSlotRow.tsx`.

**Interfaces:** REST routes use these bodies (notation below describes the HTTP contract, not executable TypeScript):

```text
POST /settings/routines/:agentId
  { requestId, definition } -> { routine: RoutineView }
GET /settings/routines/:agentId/:routineId
  -> { routine: RoutineView }
PATCH /settings/routines/:agentId/:routineId
  { requestId, expectedRevision, patch } -> { routine: RoutineView }
DELETE /settings/routines/:agentId/:routineId
  { requestId, expectedRevision } -> RoutineDeleteOutput
POST /settings/routines/:agentId/:routineId/fire
  { requestId, expectedRevision } -> RoutineFireNowOutput
GET /settings/routines/:agentId/:routineId/fires?limit=20
  -> { fires: WireFire[] }
GET /settings/routines/:agentId/consent -> RoutineConsent
DELETE /settings/routines/:agentId/consent -> RoutineConsent
GET /settings/routines/:agentId/receiver -> { url: string }
```

Collection GET scopes one agent. Register static consent/receiver routes before item routes so they are not parsed as routine IDs. The receiver URL returns only the authenticated human's authorized agent receiver prefix; client combines canonical draft path. No save/path reservation occurs. Client exports `routineApi.{list,get,create,update,remove,fireNow,recentFires,getConsent,revokeConsent,getReceiver}` with typed errors `{code,field?,status}`. Public dates remain ISO strings; components convert to Date at formatting points.

- [ ] Add route tests asserting real actor context, strict unknown-field rejection, unauthorized404, conflict409, and no workspace call. Inject workspace storage-full refusal and complete create/patch/delete normally. Test old `{path,sourceMd}` no longer accepted. Add static route precedence and receiver token permission tests. Run routines-admin-routes tests to observe failures.

Add a strict body schema regression alongside the route tests:

```ts
it('accepts structured edits and rejects the old write format', () => {
  expect(RoutineUpdateInputSchema.safeParse({
    agentId:'a',routineId:'rtn_a',requestId:'edit1',expectedRevision:'rev1',patch:{name:'Renamed'},
  }).success).toBe(true);
  expect(RoutineUpdateInputSchema.safeParse({
    agentId:'a',path:'.ax/routines/a.md',sourceMd:'---\nname: a\n---\nRun',
  }).success).toBe(false);
});
```
- [ ] Replace workspace writes with service calls and strict schemas from the pure contract. Derive user context from auth with scoped agentId and retain admin-only defaults authorization. Structured default upsert accepts editable canonical interval-only fields and optional global enabled; preserve current default-name identity rule and omitted-enabled semantics. Remove sourceMd parsing/serialization from client and server.
- [ ] Change Destination routine-hmac to `{kind:'routine-hmac',agentId,routineId}` everywhere, with ref `routine:${agentId}:${routineId}:hmac` and colon rejection for new authored IDs. Legacy refs exist only in captured retirement cleanup jobs, not normal destination payloads. Default routines have no webhook secret destination. Keep mirrored helper implementations and fixtures exactly aligned; do not introduce cross-plugin runtime imports.
- [ ] Route routine-hmac POST to routines:set-webhook-secret after existing admin ACL. Accept expectedRevision in the credential adapter body for this kind only; enforce agent scope/ownerId derived from destination. For routine-hmac credential DELETE, use the same routine lifecycle lock/check with a delete operation so a stale form cannot race reconfiguration; add `operation:'set'|'delete'` to the human-only secret hook, with secret present only for set. Other credential families retain current routes. Secret payload remains bounded decoded bytes and never appears in returned text.
- [ ] Test ref drift, invalid colon IDs, arbitrary scope/owner/ref forgery, stale/deleted/cleanup-pending secret forms, and a concurrent set/remove-HMAC race using deferred credential calls. Friendly slot labels use routine name supplied by an authorized routine lookup, not basename stripping.
- [ ] Run routines-admin-routes, credentials, credentials-admin-routes and web client suites; commit `feat: route Settings routine and credential edits through services`.

### Task 10: Figma routine views, grant status, and approval buttons

**Files:** Modify web routine `RoutineEditor.tsx`, `RoutinesList.tsx`, `RoutinesTab.tsx`, `AgentSelfImprovementSection.tsx`, `FireNowControl.tsx`, `FireRowsTable.tsx`, `TriggerChip.tsx`; create `RoutineConsentSection.tsx` and its tests. Modify admin `DefaultRoutinesSection.tsx`, workspace `ApprovalCard.tsx`, `DecisionRow.tsx`, `AgentSettings.tsx`, `lib/{workspace-types,workspace-api,workspace-decisions}.ts`, `server/routes-workspace.ts`, and corresponding tests. Remove `routines-storage-full.test.tsx`; retain storage-full code for other surfaces only if used.

**Interfaces:** RoutineEditor receives `{mode:'create'|'edit',agentId,agentName,routine?:RoutineView,onSaved,onCancel}` and sends patch/CAS for edits. Defaults use an interval-only structured mode without authored ID/filename/raw markdown. RoutineConsentSection reads status and offers revoke only. Decision wire adds `approvalScopes: ('once'|'agent-routines')[]`; client approve action accepts optional scope, default once. Server computes scopes from stored tool eligibility and actor, never model text.

- [ ] Read shadcn skill, inspect installed component context, and request Figma get_design_context/screenshots for the precise referenced forms. Source fileKey `yDka46zOpwgipUxTBWiXuo`: list52:977, schedule86:4202, interval86:4310, webhook86:4413, edit86:4822, self-improvement59:1441, plus corresponding dark/URL-preview variants identified in the spec. Reuse matching existing static assets/icons; download any required assets locally, never retain temporary Figma URLs. Install a missing primitive only with the shadcn CLI `-c packages/channel-web`.
- [ ] Add UI tests for create/edit structured payloads, nullable clears, nested trigger replacement, disabled state, all optional fields, no filename/raw markdown controls, conflict preserving input, grant read failure, and Always Allow eligible-only behavior. Test keyboard focus and mobile scrollable dialog. Run targeted web tests to see failures.

In RoutineConsentSection.test.ts mock only the HTTP client; the component must represent a failed read honestly:

```tsx
vi.mock('@/lib/routines', () => ({routineApi:{getConsent:vi.fn(),revokeConsent:vi.fn()}}));
it('does not present a failed permission read as Ask or Always Allow', async () => {
  vi.mocked(routineApi.getConsent).mockRejectedValue(new Error('network unavailable'));
  render(<RoutineConsentSection agentId="a" agentName="Caveman" />);
  expect(await screen.findByText('Routine permissions are unavailable.')).toBeVisible();
  expect(screen.queryByRole('button',{name:'Revoke'})).not.toBeInTheDocument();
});
```

RoutineConsentSection takes `{agentId:string,agentName:string}`. Test successful disabled/enabled replies and revoke failure as separate states; the initial loading state uses the existing Skeleton/Spinner primitives, not a guessed permission value.
- [ ] Build the shared form from existing Field/FieldGroup, Input, Textarea, Switch, Tabs/ToggleGroup, Collapsible, Dialog, Alert, Button, Separator. The optional section exposes active hours/silence/HMAC. Webhook disables active-hours fields. Preserve prompt newlines. Build patches by comparing each top-level editable field to its loaded value; a changed trigger is a complete object. Generate one request ID per submitted logical operation and retain it across a transport retry.

```ts
const editableKeys = ['name', 'description', 'promptBody', 'enabled', 'trigger',
  'activeHours', 'silenceToken', 'silenceMaxChars', 'conversation'] as const;
const patch: RoutinePatch = {};
for (const key of editableKeys) {
  if (JSON.stringify(form[key]) !== JSON.stringify(loaded[key])) {
    Object.assign(patch, { [key]: form[key] });
  }
}
await routineApi.update(agentId, loaded.routineId, {
  requestId: operationRequestId, expectedRevision: loaded.revision, patch,
});
```

No autosave, implicit merge, or success before server confirmation. Submit empty patch is disabled. Refresh fresh get on reopen; conflict offers reload without discarding input silently. List uses stable IDs and permissions for edit/stop/fire controls; My routines shows authored rows, self-improvement retains reflection override, existing default controls remain reachable. Map Activity names by routineId with deleted fallback; remove references to file path/spec hash/sourceMd.
- [ ] Derive URL preview from authenticated receiver prefix + valid draft path. Mark create preview inactive until create and edit preview inactive until save; copy feedback is local and accessible. Render missing permission/fetch failure explicitly. No receiver token is passed into tool/prompt data. Keep secret writing in its existing credential UI with revision-aware adapter.
- [ ] Add Always Allow next to Allow only when server approvalScopes includes agent-routines. Both paths preserve pending/double-click guards and existing Undo. Copy states the agent name and create/edit scope. Approve route parses strict `{approvalScope?}`, sends a real actor context, and returns current decision/consent state. Revoke status refreshes both agent settings and capability disclosure; do not offer a general Settings toggle that bypasses the decision grant.
- [ ] Run web client/component/server suites, inspect desktop/mobile light/dark against Figma in the local browser, and commit `feat: implement structured routine Settings and scoped approvals`.

### Task 11: Offline file retirement and complete removal of the old design

**Files:** Create `packages/workspace-git-core/src/retire-routine-files.ts`, `src/__tests__/retire-routine-files.test.ts`, `packages/cli/src/retire-routine-files.ts`, its tests, and `docs/runbooks/db-backed-routines-cutover.md`. Remove routines `sync.ts`, `parse-routine.ts` and sync/parser tests; delete `packages/validator-routine`. Modify CLI/preset imports/manifests/tsconfig references/tests, root tsconfig/lint exceptions/lockfile, routine/web manifests, identity-template comments, conversations fixtures, runner/IPC file fixtures, and sandbox comments/tests referencing the removed package.

**Interfaces:** Offline helper `retireRoutineFiles({repoRoot,dryRun,now}): Promise<{repositories:number,removed:number,failures:Array<{repository:string;code:string}>}>` is a workspace backend implementation utility, not a plugin service. CLI command is `ax retire-routine-files --repo-root <absolute-root> [--apply]`; dry-run is the default. It operates only with the host stopped, as the runbook requires, and reports fixed error codes without file bodies or tokens.

- [ ] Write temp-bare-repository tests with `.ax/routines/interval.md`, cron/webhook files, an unsynced fourth file, unrelated `.ax/IDENTITY.md`, ordinary user files, and symlink/unexpected repository candidates. Dry-run leaves HEAD unchanged; apply removes only legacy *.md current-tree entries; second apply removes zero. Old commits remain readable. Simulate interruption/retry and full online quota without consulting the quota service.

Use `registerWorkspaceGitHooks` to seed a real bare repo through its backend-internal service, avoiding the intentionally enforced public veto:

```ts
it('removes legacy files once and preserves identities', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(),'routine-retirement-'));
  const bus = new HookBus();
  registerWorkspaceGitHooks(bus,{repoRoot});
  const ctx = makeAgentContext({sessionId:'maintenance-test',agentId:'a',userId:'u'});
  const content = new TextEncoder().encode('legacy test content');
  await bus.call('workspace:apply-internal',ctx,{parent:null,changes:[
    {kind:'put',path:'.ax/routines/a.md',content},
    {kind:'put',path:'.ax/IDENTITY.md',content},
  ]});
  const dry = await retireRoutineFiles({repoRoot,dryRun:true,now:new Date()});
  expect(dry.removed).toBe(1);
  const applied = await retireRoutineFiles({repoRoot,dryRun:false,now:new Date()});
  expect(applied.removed).toBe(1);
  const again = await retireRoutineFiles({repoRoot,dryRun:false,now:new Date()});
  expect(again.removed).toBe(0);
  expect(applied.failures).toEqual([]);
  const identity = await bus.call('workspace:read',ctx,{path:'.ax/IDENTITY.md'});
  expect(identity).not.toBeNull();
});
```

Use existing backend read-response assertions to check exact identity bytes, and remove the temp directory in afterEach. The internal hook is already host-only; no new online mutation capability is registered for maintenance.
- [ ] Run workspace-git-core/CLI retirement tests; expect missing helper/command failures.
- [ ] Implement using pinned isomorphic-git and Node fs under the explicitly resolved absolute repoRoot. Enumerate direct agent `.git` repositories only, reject symlinks/out-of-root paths, skip unknown repo layouts with a failure code rather than guess. Read HEAD and walk current tree; filter exact `.ax/routines/` direct-child `.md` entries. Write a new tree/commit with only those entries omitted and update the active workspace HEAD ref conditionally if unchanged. No shell expansion, model input, import/parser, prune, or git-history rewrite. Host-stopped requirement avoids racing writers; a changed ref fails safely rather than overwriting it. Include both local and git-server store roots in the operator runbook; do not create a new online bypass hook.

```ts
function isLegacyRoutineEntry(path: string): boolean {
  return /^\.ax\/routines\/[^/]+\.md$/.test(path);
}
const entriesToDelete = currentTreeEntries.filter(entry => isLegacyRoutineEntry(entry.path));
// Use isomorphic-git tree/commit/ref APIs with the same bare-repo settings
// and active branch selection as workspace-git-core; test the actual APIs.
```

Do not mutate current workspaces during plan writing. During acceptance, use only kind test workspace roots. Operator pre-start sequence: stop host, offline dry-run/apply and verify zero legacy entries, deploy new image, migration/cleanup completion checks, restart host; never run an old sync-capable host after migration. Authored-data deletion is intentionally irreversible except restoring an explicit pre-cutover backup; document that rollback requires restoring old schema/data together, not simply swapping an image.
- [ ] Remove obsolete package/code/imports and replace all runtime test producers with DB service/tool setup. Keep retired prefix only in migration, maintenance, veto tests and historical docs/memory. No automatic file export. Update presets to expect routines tools/static webhook registration, not validator-routine. Remove heartbeat markdown seed builder/sourceMd paths while preserving canonical defaults. Leave `.ax/skill-reflection/last-run.json`, identities, goals, and workspace storage intact.
- [ ] Run a reference audit:

```bash
rg -n '@ax/validator-routine|buildRoutineMd|parseRoutineMd|sourceMd|routinePath|webhookRoutes' packages presets eslint.config.mjs tsconfig.json
rg -n '\.ax/routines/' packages presets
```

Every match is either removed or explained as narrowly necessary legacy cleanup/veto test data; no runtime loader, serializer, sync callback, live destination routinePath, or route map may remain. Remove unused storage-full helper/constants only after checking imports; shared workspace quota UI remains.
- [ ] Run workspace-git-core/CLI/preset registration/reference-drift suites and commit `refactor: retire routine files and validator package`.

### Task 12: Reachability canaries, full gates, and kind acceptance

**Files:** Modify `packages/routines/src/__tests__/{canary,canary-defaults}.test.ts`, `presets/k8s/src/__tests__/{acceptance,preset}.test.ts`; create `docs/plans/2026-10-09-db-backed-routines-validation.md`; append a new task memory shard with actual implemented facts and test evidence. The existing design-decision shard must only be appended, never rewritten.

**Interfaces:** No new product surface. Canary loads actual registered tool/approval/routine/router services and real agents ACL. Use existing Testcontainers readiness wrapper and explicit daemon selection; no Docker context discovery in test execution.

- [ ] Add canary tests with a deterministic clock: call routine_create through tool:pre-call (hold), assert no definition, approve stored decision as real human, release existing grace window, execute/replay, advance interval clock, tick, emit correlated turn-end, and assert one fire. Edit through Settings service, get through routine_get, then signed webhook via actual static HTTP route and assert another recorded fire. Delete and assert no next webhook/tick/secret. Load default heartbeat/reflection and assert unchanged materialization/silence. Tests must spy that workspace:apply never ran.

Use Task 7's harness with its real decisions/policy plugins and unattended attendance fixture for an immediate reversible create approval:

```ts
it('creates through the registered tool after a real approval', async () => {
  const h = await createRoutineHarness();
  const call = {id:'canary-call',name:'routine_create',input:{requestId:'canary-create',
    definition:RoutineDefinitionSchema.parse({name:'Canary',promptBody:'Check progress.',
      trigger:{kind:'interval',every:'1m'}})}};
  const held = await h.bus.fire('tool:pre-call',h.owner,call);
  if (!isHold(held)) throw new Error('routine create did not hold');
  const approved = await h.bus.call<DecisionsApproveInput,DecisionsApproveOutput>(
    'decisions:approve',h.owner,{decisionId:held.hold.decisionId,userId:h.owner.userId,approvalScope:'once'});
  expect(approved.executed).toBe(true);
  const listed = await h.bus.call<{agentId:string},{routines:RoutineView[]}>(
    'routines:list',h.owner,{agentId:h.agentId});
  expect(listed.routines.filter(r => r.name === 'Canary')).toHaveLength(1);
  await h.close();
});
```

Extend that same canary's captured real invoke/turn-end/tick loop to assert the fire record, and its captured static HTTP router to test the signed webhook. Reuse the existing canary controlled Clock/invoke capture rather than add a public tick hook. Both are mandatory assertions, not separate future work.
- [ ] Cover each motivating bug class from the spec and the five Review Focus cases by pointing to concrete test names in the validation document. Verify the tool and route are loaded in both CLI and k8s preset; dependency graph has no cycle, all registers/calls/return schemas are consistent, and the removed package is absent. No canary that stubs agents:resolve to always pass counts as owner enforcement.
- [ ] Run targeted canaries first, fix actual failures, then execute all gates once the branch is coherent. Name the intended Docker endpoint explicitly (local unix socket or verified TLS endpoint) before container suites; verify it is reachable and do not edit daemon configuration. Commands:

```bash
pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
pnpm exec tsc --build
pnpm typecheck
pnpm lint
```

If recursive tests fail, still run eslint-rules and scripts separately so results for all three suites are known. Record assertion/teardown failures separately and fix rather than assume a stopped suite passed. Do not broaden/repeat passed tests without a new change or unresolved concern.
- [ ] Read the browser skill, build and deploy this branch to the explicitly authorized kind dev target using `make image KIND_CLUSTER=ax-next-dev` after tests. The Makefile pins kubectl to the kind context; manually issued commands must also do so. Preserve existing configured provider/auth settings. Inspect reachability with:

```bash
kubectl --context kind-ax-next-dev -n ax-next get pods
kubectl --context kind-ax-next-dev -n ax-next get svc
```

Use the browser's existing kind dev endpoint or a context-pinned port-forward to the service discovered above. Do not read tokens or credentials into tool output. Perform the host-stopped offline cleanup/migration sequence in the runbook for the kind store, then finish the walkthrough.
- [ ] In chat ask for a one-minute interval routine; see approval and no routine before approval; choose Allow; see it in Agent Settings; edit instructions there; ask agent routine_get and verify exact edit; wait for a real fire and inspect Activity/history; delete and verify no later dispatch. Create a signed webhook routine with a test-only HMAC via the human credential UI, POST signed payload locally without logging its key/token, and verify recorded fire. Choose Always Allow on another proposed create; future create/update for this agent skip hold; a second agent still holds; revoke and verify the next create holds. Confirm Enabled/URL preview/revision conflict behavior in the UI. Remove acceptance-created test routines/secrets/grants afterward.
- [ ] Review final diff against every boundary table row, run security-checklist with actual dependency/install-script results, and inspect lockfile/preset removal. Record all gate commands/results, Figma/browser checks, kind evidence, and material limits. Commit `test: verify DB routine cutover end to end`. Do not claim completion while any required suite/walk is incomplete.

## Final contract refinements and consistency checks

These are concrete implementation details to review with the plan:

1. Every mutation service accepts a logical requestId, including update/delete, so approval or HTTP response loss can recover the committed result. The authoritative types above already require requestId for these operations; tool schemas include it for every mutation. Keep patch/expectedRevision semantics exactly as approved. The stored request receipt and definition effect commit together. The service does not rerun an effect for a previously settled matching request.
2. The human-only secret hook is a discriminated union: `{operation:'set',secret:Uint8Array}` or `{operation:'delete'}`, both with agentId/routineId/expectedRevision. This routes existing credential DELETE through the same lifecycle fence as POST. It is not an agent tool and is not an authorization shortcut.
3. `decisions:settle-routine-call` complements authorize-routine-call so attended execution has a durable outcome and receipt. Only the exact claimed authorization and authenticated agent/person can settle it. Alternate implementation is a durable external authorization queue; fields contain no backend vocabulary; no sandbox IPC action exposes it.
4. Stable subscribe priority is a kernel registration option, not hook payload data. Existing default-order tests must stay green. Routine validation failure/timeout cannot become a host-side effect even if a subscriber chain continues.
5. Grant delivery is idempotent by decision ID and fenced by consent revision. Existing grace windows and Undo apply before delivery; completed old deliveries cannot reverse later revocation.

The authoritative type block includes these refinements. The original spec's table abbreviates update/delete and secret inputs; this plan supplies their complete retry/lifecycle fields. Plan review approves these implementation details together with the task sequence; it does not reopen DB-only definitions or the settled product choices.

## Boundary and security handoff

Copy the approved spec's boundary table into the implementation PR and update it for subscribe priority, decisions:settle-routine-call, requestId on update/delete, and the human secret-operation union. Every routines:* hook and all six tool execute surfaces require an alternate provider, opaque/domain fields, subscriber risk, and schema owner. Schemas live in their owning plugin/pure contract, not a new central IPC file.

Final security note must explicitly cover: execution-time authority and failed reads; real-owner ACL; request-time token/DB routing and raw-body HMAC; bounded secrets with no model exposure; serialized secret cleanup; fixed-scope offline deletion; no new process/env/network reach in tools; no per-host authoritative state; pinned dependencies and their reviewed install/transitive surface.

## Execution handoff

This plan is a single deliverable with twelve local task gates. Recommend **subagent-driven execution**, because interfaces span the kernel, decisions, policy, routine storage/scheduling, credentials, and UI, and a mistaken approval or cleanup boundary would create unattended work under the wrong authority. Each task gets an implementation and independent review before the next, then a whole-branch review. Native execution remains an option if the user prefers lower overhead.

Wait for the user's written-plan review and method selection. Approval of the design spec authorized writing this plan only.

## Plan self-review

Completed before handoff:

| Spec requirement | Owning tasks |
| --- | --- |
| Structured validation, identity, revision/CAS, atomic path uniqueness | 1, 3 |
| Expected tool failures and no false success receipts | 2, 6, 7 |
| Ownership/ACL, defaults and real actor contexts | 3, 4, 8, 9 |
| Allow / Always Allow / revoke / host bypass prevention | 5, 6, 7, 10 |
| Tick, fire-now, recent fires, silence, warnings, Activity | 3, 8, 10, 12 |
| Request-time webhook routing and HMAC lifecycle | 4, 8, 9, 12 |
| Authored deletion without import and no file-design leftovers | 2, 3, 11 |
| Prompt guidance and Figma Settings/forms | 7, 10 |
| Boundary/security review, regression canaries, three suites, typecheck/lint/kind | 12 and final handoff sections |

The five Review Focus failures have explicit owning tests. Checked names against current repo interfaces: auth:get-user uses isAdmin, PolicyRule uses providedBy, workspace-git-core uses refs/heads/main, and both runners already propagate IPC request failures. Request/secret types in the main contract include their complete retry/lifecycle fields. Safe failures are re-rendered from closed vocabulary at every outward boundary. No product dependencies, code, tests, workspaces, or deployments were changed while preparing this plan.
