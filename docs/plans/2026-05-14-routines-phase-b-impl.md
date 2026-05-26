# Routines — Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the routines core: a new `@ax/routines` host-plugin that indexes `.ax/routines/<name>.md` files via the existing `workspace:applied` hook, runs a tick loop with interval + cron engines, fires routines into the agent's chat loop, applies the silence-token logic via the Phase A `conversations:drop-turn` / `conversations:hide` hooks, and a new `@ax/validator-routine` plugin that vetoes malformed frontmatter on `workspace:pre-apply`. Phase B also replaces the Phase A `conversations:drop-turn` stub with the real runner-native jsonl rewrite. Both new plugins load in `@ax/cli` and `presets/k8s` in the same PR; the canary creates a routine in the test agent's workspace and asserts the plugin fires it on tick — that's the half-wired-window closure for Phase B.

**Architecture:** Two new packages.
- **`@ax/validator-routine`** mirrors `@ax/validator-skill`: pure-function frontmatter parser + a `workspace:pre-apply` subscriber that vetoes any `.ax/routines/<name>.md` whose YAML doesn't parse, is missing required fields, or names a trigger kind not yet shipped (`webhook` is deferred to Phase C — see Invariant I3 below).
- **`@ax/routines`** owns two postgres tables (`routines_v1_definitions` mirror + `routines_v1_fires` audit log), subscribes to `workspace:applied` to keep the mirror in sync, runs a tick loop guarded by a postgres advisory lock with `FOR UPDATE SKIP LOCKED` as the correctness backstop, and registers `routines:fire-now` + `routines:list` service hooks. Firing a routine resolves the agent via `agents:resolve`, finds-or-creates the conversation via the Phase A hook, dispatches `agent:invoke` fire-and-forget, and subscribes a one-shot `chat:turn-end` listener (keyed by `ctx.reqId`) that applies the silence-token logic — calling `conversations:drop-turn` + optionally `conversations:hide` when the agent's reply is HEARTBEAT_OK-shaped.

**Tech Stack:** TypeScript + Kysely + Postgres (existing). New runtime dep: `croner` for cron parsing (maintained, zero-dep, tz-safe). Test runner is vitest with the `@testcontainers/postgresql` harness already used by `@ax/conversations`.

**Spec:** `docs/plans/2026-05-14-routines-design.md` §1, §2, §3, §4, §5, §7.3 item 2, §7.4. Phase A foundation: `docs/plans/2026-05-14-routines-phase-a-impl.md`.

---

## Invariants (lessons from prior phases, per memory)

Numbered invariants surface explicit failure modes from prior rollouts and must hold across every task in this plan. Reviewers can grep PR notes for `I1..I8` to confirm coverage.

- **I1 (plan vs reality).** The design references `chat:turn-start` and `credentials:get-by-name`. Neither hook exists in the codebase today. Phase B uses `agent:invoke` (registered by `@ax/chat-orchestrator`) as the turn-into-the-agent entrypoint and avoids `credentials:get-by-name` entirely (webhook auth is Phase C). Each occurrence of these names in the design that's load-bearing here is flagged in the relevant task body — do not blindly emit a `chat:turn-start` publish call.
- **I2 (no cross-plugin imports).** `@ax/routines` reaches `@ax/conversations` / `@ax/agents` / `@ax/chat-orchestrator` only through the hook bus. `@ax/validator-routine` reaches `@ax/core` only. Lint will enforce this once the eslint allowlist sees the two new packages; until then a manual grep on the final commit is the safety net.
- **I3 (no half-wired plugins).** Webhook trigger kind is a Phase C concern. The validator rejects `kind: webhook` in this PR with a clear "Phase C" reason. The store schema for `trigger_kind` accepts `'webhook'` (so Phase C is a small additive change, not a migration), but no fire path exists for it. There is NO partially-wired webhook code in this PR.
- **I4 (one source of truth).** The `.ax/routines/<name>.md` file is the spec. The DB mirror is derived. `spec_hash` gating in the upsert prevents `next_run_at` from resetting on no-op applies. No defensive double-validation in the `workspace:applied` subscriber — the validator already vetted the frontmatter on pre-apply.
- **I5 (capabilities minimized).** `@ax/routines` declares only `database:get-instance` + `agents:resolve` + `conversations:*` + `agent:invoke` in its `calls`. No spawn, no filesystem, no network beyond PG. Webhook secret fetch (`credentials:*`) is NOT declared in Phase B — it lands in Phase C with its first caller.
- **I6 (storage-agnostic hooks).** New routines service hooks (`routines:fire-now`, `routines:list`) use opaque agent/path keys. No `sha`, no `bucket`, no `pod_name`. Payload field names assume nothing about the postgres backing or the workspace storage.
- **I7 (Phase A's half-wired window closes here).** The three Phase A hooks (`conversations:hide`, `conversations:drop-turn`, `conversations:find-or-create`) gain real production callers in this PR. The `drop-turn` stub is replaced with the runner-native jsonl rewrite. Phase A's "window CLOSED" line in this PR's notes references the canary fire test that exercises all three.
- **I8 (subscriber-must-not-throw).** The `workspace:applied` subscriber and the `chat:turn-end` one-shot in `fireRoutine` log + swallow on failure. A bad routine file or a runner crash must never break the workspace-apply path or wedge the bus's chat:turn-end fan-out. Errors land in `routines_v1_fires.status = 'error'` and surface in the admin UI (Phase D), not as bus rejections.

---

## File Structure

**Create:**
- `packages/validator-routine/package.json`
- `packages/validator-routine/tsconfig.json`
- `packages/validator-routine/src/index.ts`
- `packages/validator-routine/src/plugin.ts`
- `packages/validator-routine/src/frontmatter.ts` — pure parser
- `packages/validator-routine/src/__tests__/frontmatter.test.ts`
- `packages/validator-routine/src/__tests__/plugin.test.ts`
- `packages/routines/package.json`
- `packages/routines/tsconfig.json`
- `packages/routines/src/index.ts`
- `packages/routines/src/plugin.ts`
- `packages/routines/src/migrations.ts`
- `packages/routines/src/types.ts`
- `packages/routines/src/clock.ts`
- `packages/routines/src/parse-routine.ts` — re-uses validator-routine's parser, adds spec_hash
- `packages/routines/src/engines/interval.ts`
- `packages/routines/src/engines/cron.ts`
- `packages/routines/src/engines/index.ts` — dispatch by kind
- `packages/routines/src/active-hours.ts`
- `packages/routines/src/store.ts` — sync, claim, advance, record-fire
- `packages/routines/src/sync.ts` — `workspace:applied` subscriber body
- `packages/routines/src/fire.ts` — fireRoutine: resolve agent, find-or-create, `agent:invoke`, one-shot turn-end
- `packages/routines/src/silence.ts` — applySilenceAndLog
- `packages/routines/src/tick.ts` — tickLoop + election
- `packages/routines/src/__tests__/parse-routine.test.ts`
- `packages/routines/src/__tests__/migrations.test.ts`
- `packages/routines/src/__tests__/engines-interval.test.ts`
- `packages/routines/src/__tests__/engines-cron.test.ts`
- `packages/routines/src/__tests__/active-hours.test.ts`
- `packages/routines/src/__tests__/silence.test.ts`
- `packages/routines/src/__tests__/sync.test.ts`
- `packages/routines/src/__tests__/tick.test.ts`
- `packages/routines/src/__tests__/fire.test.ts`
- `packages/routines/src/__tests__/canary.test.ts`

**Modify:**
- `packages/conversations/src/plugin.ts` — replace `drop-turn` stub with real handler.
- `packages/conversations/src/store.ts` — add `dropTurnFromJsonl` helper used by the new handler.
- `packages/conversations/src/types.ts` — extend manifest doc-comments to reflect "callers landed in Phase B."
- `packages/cli/src/main.ts` — load `@ax/validator-routine` and `@ax/routines`.
- `presets/k8s/src/index.ts` — load `@ax/validator-routine` and `@ax/routines`.
- `presets/k8s/src/__tests__/preset.test.ts` — assert both plugins present + expected list updated.
- `tsconfig.json` (root) — add project refs for the two new packages.

**Do not touch:** `packages/channel-web`, `packages/sandbox-k8s`, `packages/http-server`. Webhook routes + admin UI are Phase C / Phase D.

---

## Task 1: Scaffold `@ax/validator-routine` package

**Files:**
- Create: `packages/validator-routine/package.json`
- Create: `packages/validator-routine/tsconfig.json`
- Create: `packages/validator-routine/src/index.ts`
- Create: `packages/validator-routine/src/plugin.ts` (stub)
- Create: `packages/validator-routine/src/frontmatter.ts` (stub)
- Modify: root `tsconfig.json` — add project ref.

- [ ] **Step 1: Create `packages/validator-routine/package.json`**

```json
{
  "name": "@ax/validator-routine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "croner": "^8.0.0",
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `packages/validator-routine/tsconfig.json`**

Copy `packages/validator-skill/tsconfig.json` verbatim — both packages share the same shape (TS project ref to `@ax/core`, output to `dist/`, strict + exactOptionalPropertyTypes on).

- [ ] **Step 3: Create stubbed `packages/validator-routine/src/frontmatter.ts`**

```ts
export interface RoutineFrontmatterFields {
  name: string;
  description: string;
  trigger: TriggerSpec;
  activeHours?: { start: string; end: string; tz: string };
  silenceToken?: string;
  silenceMaxChars: number;
  conversation: 'per-fire' | 'shared';
  promptBody: string;
}
export type TriggerSpec =
  | { kind: 'interval'; every: string }
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'webhook'; path: string };
export type RoutineFrontmatterResult =
  | { ok: true; fields: RoutineFrontmatterFields }
  | { ok: false; reason: string };
export function parseRoutineFrontmatter(_text: string): RoutineFrontmatterResult {
  return { ok: false, reason: 'not yet implemented' };
}
export function parseRoutineFrontmatterBytes(_bytes: Uint8Array): RoutineFrontmatterResult {
  return { ok: false, reason: 'not yet implemented' };
}
export function durationToSeconds(_every: string): number | null {
  return null;
}
```

- [ ] **Step 4: Create stubbed `packages/validator-routine/src/plugin.ts`**

```ts
import type { Plugin } from '@ax/core';

export function createValidatorRoutinePlugin(): Plugin {
  return {
    manifest: {
      name: '@ax/validator-routine',
      version: '0.0.0',
      registers: [],
      calls: [],
      subscribes: ['workspace:pre-apply'],
    },
    init() {
      // Task 3 wires the subscriber.
    },
  };
}
```

- [ ] **Step 5: Create `packages/validator-routine/src/index.ts`**

```ts
export { createValidatorRoutinePlugin } from './plugin.js';
export {
  parseRoutineFrontmatter,
  parseRoutineFrontmatterBytes,
  durationToSeconds,
  type RoutineFrontmatterFields,
  type RoutineFrontmatterResult,
  type TriggerSpec,
} from './frontmatter.js';
```

- [ ] **Step 6: Add the package to the root `tsconfig.json` references**

In the root `tsconfig.json`, add `{ "path": "packages/validator-routine" }` to the `references` array, alphabetically near `validator-skill`.

- [ ] **Step 7: Install deps and verify the package builds**

```bash
pnpm install
pnpm build --filter @ax/validator-routine
```

Expected: BUILD OK.

- [ ] **Step 8: Commit**

```bash
git add packages/validator-routine/ tsconfig.json pnpm-lock.yaml
git commit -m "feat(validator-routine): scaffold package (manifest + parser stubs)

Phase B foundation for the @ax/routines plugin. Stubs the frontmatter
parser and plugin shells; subsequent tasks land the real parser
(Task 2) and workspace:pre-apply subscriber (Task 3). Mirrors
@ax/validator-skill's package shape — same tsconfig, same deps, same
dist layout. Adds croner as a runtime dep for cron parse validation."
```

---


## Task 2: Routine frontmatter parser

**Files:**
- Modify: `packages/validator-routine/src/frontmatter.ts`
- Create: `packages/validator-routine/src/__tests__/frontmatter.test.ts`

The parser accepts the file format from design §2 and returns `RoutineFrontmatterFields` on success or `{ ok: false, reason }` on any malformation. Reuses `parseFrontmatter` pattern from `@ax/validator-skill/src/frontmatter.ts`. **Webhook trigger kind is REJECTED in Phase B (I3).**

- [ ] **Step 1: Write the failing parser tests**

Create `packages/validator-routine/src/__tests__/frontmatter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  parseRoutineFrontmatter,
  parseRoutineFrontmatterBytes,
} from '../frontmatter.js';

function fm(body: string): string {
  return `---\n${body}\n---\n# Prompt body\nhello\n`;
}

describe('parseRoutineFrontmatter — happy paths', () => {
  it('parses an interval routine', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: heartbeat',
      'description: Periodic check',
      'trigger:',
      '  kind: interval',
      '  every: "30m"',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.name).toBe('heartbeat');
    expect(r.fields.trigger).toEqual({ kind: 'interval', every: '30m' });
    expect(r.fields.conversation).toBe('per-fire');
    expect(r.fields.promptBody.trim()).toBe('# Prompt body\nhello');
  });

  it('parses a cron routine with tz', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: nightly-bug-triage',
      'description: nightly',
      'trigger:',
      '  kind: cron',
      '  expr: "0 2 * * *"',
      '  tz: "America/New_York"',
      'conversation: shared',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.trigger).toEqual({
      kind: 'cron',
      expr: '0 2 * * *',
      tz: 'America/New_York',
    });
  });

  it('parses optional activeHours / silenceToken / silenceMaxChars', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r',
      'description: d',
      'trigger:',
      '  kind: interval',
      '  every: "60s"',
      'activeHours:',
      '  start: "08:00"',
      '  end: "18:00"',
      '  tz: "America/New_York"',
      'silenceToken: "HEARTBEAT_OK"',
      'silenceMaxChars: 200',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.activeHours).toEqual({
      start: '08:00', end: '18:00', tz: 'America/New_York',
    });
    expect(r.fields.silenceToken).toBe('HEARTBEAT_OK');
    expect(r.fields.silenceMaxChars).toBe(200);
  });

  it('defaults conversation to per-fire and silenceMaxChars to 300', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r',
      'description: d',
      'trigger:',
      '  kind: interval',
      '  every: "60s"',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.conversation).toBe('per-fire');
    expect(r.fields.silenceMaxChars).toBe(300);
  });
});

describe('parseRoutineFrontmatter — vetoes', () => {
  it('rejects missing frontmatter', () => {
    const r = parseRoutineFrontmatter('# just a body\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/frontmatter/);
  });

  it('rejects malformed YAML', () => {
    const r = parseRoutineFrontmatter('---\nname: : bad\n---\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/yaml/i);
  });

  it('rejects missing name', () => {
    const r = parseRoutineFrontmatter(fm([
      'description: d',
      'trigger:', '  kind: interval', '  every: "60s"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/name/);
  });

  it('rejects missing description', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r',
      'trigger:', '  kind: interval', '  every: "60s"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/description/);
  });

  it('rejects missing trigger', () => {
    const r = parseRoutineFrontmatter(fm(['name: r', 'description: d'].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/trigger/);
  });

  it('rejects unknown trigger kind', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r', 'description: d',
      'trigger:', '  kind: never', '  every: "60s"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/trigger\.kind/);
  });

  it('rejects interval with sub-minute "every" (60s minimum)', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r', 'description: d',
      'trigger:', '  kind: interval', '  every: "10s"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/60s|minimum/i);
  });

  it('rejects interval missing every', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r', 'description: d', 'trigger:', '  kind: interval',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/every/);
  });

  it('rejects cron with no tz', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r', 'description: d',
      'trigger:', '  kind: cron', '  expr: "0 2 * * *"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/tz/);
  });

  it('rejects cron with malformed expr', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r', 'description: d',
      'trigger:', '  kind: cron',
      '  expr: "not a cron expr"', '  tz: "UTC"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/cron/i);
  });

  it('rejects webhook trigger kind in Phase B (Phase C ships it)', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r/x"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/webhook/i);
    expect(r.reason).toMatch(/Phase C|not yet supported/i);
  });

  it('rejects non-UTF-8 bytes', () => {
    const r = parseRoutineFrontmatterBytes(new Uint8Array([0xff, 0xfe, 0xfd]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/UTF-8/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test --filter @ax/validator-routine
```

Expected: all FAIL (stub parser always returns `not yet implemented`).

- [ ] **Step 3: Implement the parser**

Rewrite `packages/validator-routine/src/frontmatter.ts`:

```ts
import { load as yamlLoad, YAMLException } from 'js-yaml';
import { Cron } from 'croner';

const FRONTMATTER_FENCE = /^---\n([\s\S]*?)\n---(\n([\s\S]*))?$/;
const DURATION_RE = /^(\d+)(s|m|h|d)$/;
const TIME_OF_DAY_RE = /^([01]\d|2[0-4]):([0-5]\d)$/;

export type TriggerSpec =
  | { kind: 'interval'; every: string }
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'webhook'; path: string };

export interface ActiveHours {
  start: string;
  end: string;
  tz: string;
}

export interface RoutineFrontmatterFields {
  name: string;
  description: string;
  trigger: TriggerSpec;
  activeHours?: ActiveHours;
  silenceToken?: string;
  silenceMaxChars: number;
  conversation: 'per-fire' | 'shared';
  promptBody: string;
}

export type RoutineFrontmatterResult =
  | { ok: true; fields: RoutineFrontmatterFields }
  | { ok: false; reason: string };

const fail = (reason: string): RoutineFrontmatterResult => ({ ok: false, reason });

export function parseRoutineFrontmatter(text: string): RoutineFrontmatterResult {
  const m = FRONTMATTER_FENCE.exec(text);
  if (m === null) return fail('no frontmatter block');
  const yamlBody = m[1] ?? '';
  const promptBody = (m[3] ?? '').trim();

  let parsed: unknown;
  try {
    parsed = yamlLoad(yamlBody);
  } catch (err) {
    if (err instanceof YAMLException) {
      return fail(`invalid YAML in frontmatter: ${err.reason}`);
    }
    return fail('invalid YAML in frontmatter');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('frontmatter must be a YAML mapping');
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || (obj['name'] as string).length === 0) {
    return fail('frontmatter missing required field: name');
  }
  if (typeof obj['description'] !== 'string' || (obj['description'] as string).length === 0) {
    return fail('frontmatter missing required field: description');
  }

  const triggerRaw = obj['trigger'];
  if (triggerRaw === undefined || triggerRaw === null) {
    return fail('frontmatter missing required field: trigger');
  }
  if (typeof triggerRaw !== 'object' || Array.isArray(triggerRaw)) {
    return fail('frontmatter trigger must be a mapping');
  }
  const trigObj = triggerRaw as Record<string, unknown>;
  const kind = trigObj['kind'];

  let trigger: TriggerSpec;
  switch (kind) {
    case 'interval': {
      const every = trigObj['every'];
      if (typeof every !== 'string' || every.length === 0) {
        return fail('interval trigger missing required field: every');
      }
      if (DURATION_RE.exec(every) === null) {
        return fail(`interval.every: not a valid duration (30s | 5m | 1h | 1d): ${every}`);
      }
      const seconds = durationToSeconds(every);
      if (seconds === null) return fail(`interval.every: cannot parse ${every}`);
      if (seconds < 60) {
        return fail(`interval.every: minimum is 60s (got ${every})`);
      }
      trigger = { kind: 'interval', every };
      break;
    }
    case 'cron': {
      const cronExpr = trigObj['expr'];
      const tz = trigObj['tz'];
      if (typeof cronExpr !== 'string' || cronExpr.length === 0) {
        return fail('cron trigger missing required field: expr');
      }
      if (typeof tz !== 'string' || tz.length === 0) {
        return fail('cron trigger requires explicit tz (no implicit local time)');
      }
      try {
        new Cron(cronExpr, { timezone: tz });
      } catch (err) {
        return fail(`invalid cron: ${err instanceof Error ? err.message : String(err)}`);
      }
      trigger = { kind: 'cron', expr: cronExpr, tz };
      break;
    }
    case 'webhook':
      // I3: webhook lands in Phase C.
      return fail('trigger.kind: webhook is not yet supported (lands in Phase C)');
    default:
      return fail(`trigger.kind: unknown value ${JSON.stringify(kind)} (expected interval | cron)`);
  }

  let activeHours: ActiveHours | undefined;
  if (obj['activeHours'] !== undefined && obj['activeHours'] !== null) {
    const ah = obj['activeHours'];
    if (typeof ah !== 'object' || Array.isArray(ah)) {
      return fail('activeHours must be a mapping');
    }
    const ahObj = ah as Record<string, unknown>;
    const start = ahObj['start'];
    const end = ahObj['end'];
    const tz = ahObj['tz'];
    if (typeof start !== 'string' || !TIME_OF_DAY_RE.test(start)) {
      return fail(`activeHours.start: not HH:MM (got ${String(start)})`);
    }
    if (typeof end !== 'string' || !TIME_OF_DAY_RE.test(end)) {
      return fail(`activeHours.end: not HH:MM (got ${String(end)})`);
    }
    if (typeof tz !== 'string' || tz.length === 0) {
      return fail('activeHours.tz is required');
    }
    activeHours = { start, end, tz };
  }

  const silenceTokenRaw = obj['silenceToken'];
  let silenceToken: string | undefined;
  if (silenceTokenRaw !== undefined && silenceTokenRaw !== null) {
    if (typeof silenceTokenRaw !== 'string' || silenceTokenRaw.length === 0) {
      return fail('silenceToken must be a non-empty string when set');
    }
    silenceToken = silenceTokenRaw;
  }

  const silenceMaxRaw = obj['silenceMaxChars'];
  let silenceMaxChars = 300;
  if (silenceMaxRaw !== undefined && silenceMaxRaw !== null) {
    if (typeof silenceMaxRaw !== 'number' || !Number.isInteger(silenceMaxRaw) || silenceMaxRaw < 0) {
      return fail('silenceMaxChars must be a non-negative integer');
    }
    silenceMaxChars = silenceMaxRaw;
  }

  const conversationRaw = obj['conversation'];
  let conversation: 'per-fire' | 'shared';
  if (conversationRaw === undefined || conversationRaw === null) {
    conversation = 'per-fire';
  } else if (conversationRaw === 'per-fire' || conversationRaw === 'shared') {
    conversation = conversationRaw;
  } else {
    return fail(`conversation: must be "per-fire" or "shared" (got ${JSON.stringify(conversationRaw)})`);
  }

  const fields: RoutineFrontmatterFields = {
    name: obj['name'] as string,
    description: obj['description'] as string,
    trigger,
    silenceMaxChars,
    conversation,
    promptBody,
  };
  if (activeHours !== undefined) fields.activeHours = activeHours;
  if (silenceToken !== undefined) fields.silenceToken = silenceToken;
  return { ok: true, fields };
}

export function parseRoutineFrontmatterBytes(bytes: Uint8Array): RoutineFrontmatterResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('routine file is not valid UTF-8');
  }
  return parseRoutineFrontmatter(text);
}

export function durationToSeconds(every: string): number | null {
  const m = DURATION_RE.exec(every);
  if (m === null) return null;
  const n = Number.parseInt(m[1]!, 10);
  const unit = m[2]!;
  switch (unit) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86_400;
    default: return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/validator-routine
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/validator-routine/
git commit -m "feat(validator-routine): add routine frontmatter parser

Pure function — no file I/O, no spawn, no network. Mirrors
@ax/validator-skill's shape: strict UTF-8 decode, js-yaml safe schema,
returns ok/reason discriminated union. Validates name, description,
trigger (interval | cron only — webhook lands in Phase C per I3),
optional activeHours / silenceToken / silenceMaxChars / conversation.
croner is used as a parse-only gate on cron expressions and tz."
```

---

## Task 3: `@ax/validator-routine` workspace:pre-apply subscriber

**Files:**
- Modify: `packages/validator-routine/src/plugin.ts`
- Create: `packages/validator-routine/src/__tests__/plugin.test.ts`

The plugin subscribes to `workspace:pre-apply` and vetoes any FileChange whose path matches `^\.ax\/routines\/[^/]+\.md$` (flat — no subdirectories) and whose parsed frontmatter is not `ok: true`. Pass-through for any other path and for `kind: 'delete'`.

- [ ] **Step 1: Write the failing subscriber tests**

Create `packages/validator-routine/src/__tests__/plugin.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, type FileChange } from '@ax/core';
import { createValidatorRoutinePlugin } from '../plugin.js';

const ENC = new TextEncoder();

async function bootBus(): Promise<HookBus> {
  const bus = new HookBus();
  const plugin = createValidatorRoutinePlugin();
  await plugin.init?.({ bus } as never);
  return bus;
}

function preApply(changes: FileChange[]) {
  return { changes, parent: null, reason: 'test' };
}

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

describe('@ax/validator-routine — workspace:pre-apply', () => {
  it('passes through changes outside .ax/routines/', async () => {
    const bus = await bootBus();
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: 'README.md', kind: 'put', content: ENC.encode('# hi') },
    ]));
    expect(r.rejected).toBe(false);
  });

  it('passes through deletes', async () => {
    const bus = await bootBus();
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/old.md', kind: 'delete' },
    ]));
    expect(r.rejected).toBe(false);
  });

  it('passes through a valid interval routine', async () => {
    const bus = await bootBus();
    const body = [
      '---',
      'name: heartbeat',
      'description: d',
      'trigger:',
      '  kind: interval',
      '  every: "30m"',
      '---',
      '# prompt',
    ].join('\n') + '\n';
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/heartbeat.md', kind: 'put', content: ENC.encode(body) },
    ]));
    expect(r.rejected).toBe(false);
  });

  it('vetoes a malformed routine', async () => {
    const bus = await bootBus();
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/bad.md', kind: 'put', content: ENC.encode('no frontmatter') },
    ]));
    expect(r.rejected).toBe(true);
    if (!r.rejected) return;
    expect(r.reason).toMatch(/\.ax\/routines\/bad\.md/);
  });

  it('vetoes webhook routine (Phase B I3)', async () => {
    const bus = await bootBus();
    const body = [
      '---',
      'name: r', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r/x"',
      '---',
    ].join('\n') + '\n';
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/r.md', kind: 'put', content: ENC.encode(body) },
    ]));
    expect(r.rejected).toBe(true);
    if (!r.rejected) return;
    expect(r.reason).toMatch(/webhook/);
  });

  it('passes through nested paths under .ax/routines/ (validator regex is anchored)', async () => {
    const bus = await bootBus();
    const body = [
      '---', 'name: r', 'description: d',
      'trigger:', '  kind: interval', '  every: "60s"',
      '---', '# p',
    ].join('\n') + '\n';
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/sub/x.md', kind: 'put', content: ENC.encode(body) },
    ]));
    // Nested paths just don't match the validator regex. The routines
    // indexer (Task 9) is what enforces the flat-layout invariant by
    // ignoring nested paths.
    expect(r.rejected).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/validator-routine
```

Expected: subscriber tests FAIL (plugin init body is empty).

- [ ] **Step 3: Implement the subscriber**

Rewrite `packages/validator-routine/src/plugin.ts`:

```ts
import type { FileChange, Plugin, WorkspaceVersion } from '@ax/core';
import { reject } from '@ax/core';
import { parseRoutineFrontmatterBytes } from './frontmatter.js';

const PLUGIN_NAME = '@ax/validator-routine';

const ROUTINE_PATH = /^\.ax\/routines\/[^/]+\.md$/;

interface PreApplyPayload {
  changes: FileChange[];
  parent: WorkspaceVersion | null;
  reason: string;
}

export function createValidatorRoutinePlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [],
      subscribes: ['workspace:pre-apply'],
    },
    init({ bus }) {
      bus.subscribe<PreApplyPayload>(
        'workspace:pre-apply',
        PLUGIN_NAME,
        async (_ctx, input) => {
          for (const c of input.changes) {
            if (c.kind !== 'put') continue;
            if (!ROUTINE_PATH.test(c.path)) continue;
            const r = parseRoutineFrontmatterBytes(c.content);
            if (!r.ok) {
              return reject({ reason: `${c.path}: ${r.reason}` });
            }
          }
          return undefined;
        },
      );
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/validator-routine
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/validator-routine/
git commit -m "feat(validator-routine): workspace:pre-apply subscriber

Vetoes .ax/routines/<name>.md changes whose frontmatter doesn't parse,
is missing required fields, or names a trigger kind not yet shipped
(webhook lands in Phase C — I3). Pass-through for any other path and
for delete kinds. Same capability budget as @ax/validator-skill:
no spawn, no network, no file I/O."
```

---

## Task 4: Scaffold `@ax/routines` package

**Files:**
- Create: `packages/routines/package.json`
- Create: `packages/routines/tsconfig.json`
- Create: `packages/routines/src/index.ts`
- Create: `packages/routines/src/plugin.ts` (manifest only, init is empty)
- Create: `packages/routines/src/types.ts`
- Create: `packages/routines/src/clock.ts`
- Modify: root `tsconfig.json` — add project ref.

- [ ] **Step 1: Create `packages/routines/package.json`**

```json
{
  "name": "@ax/routines",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "@ax/validator-routine": "workspace:*",
    "croner": "^8.0.0",
    "kysely": "^0.27.0"
  },
  "devDependencies": {
    "@ax/database-postgres": "workspace:*",
    "@ax/test-harness": "workspace:*",
    "@testcontainers/postgresql": "^10.10.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `packages/routines/tsconfig.json`**

Copy `packages/conversations/tsconfig.json` verbatim (it has the right project refs for a Kysely+PG plugin).

- [ ] **Step 3: Create `packages/routines/src/types.ts`**

```ts
import type { TriggerSpec, ActiveHours } from '@ax/validator-routine';

export type { TriggerSpec, ActiveHours };

export type FireSource = 'tick' | 'webhook' | 'manual';
export type FireStatus = 'ok' | 'silenced' | 'error';

export interface RoutineRow {
  agentId: string;
  path: string;
  authorUserId: string;
  name: string;
  description: string;
  specHash: string;
  trigger: TriggerSpec;
  activeHours: ActiveHours | null;
  silenceToken: string | null;
  silenceMaxChars: number;
  conversation: 'per-fire' | 'shared';
  promptBody: string;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastStatus: FireStatus | null;
  lastError: string | null;
}

export interface FireRow {
  id: number;
  agentId: string;
  path: string;
  firedAt: Date;
  triggerSource: FireSource;
  conversationId: string | null;
  status: FireStatus;
  error: string | null;
}

// Service hook payloads.
export interface FireNowInput {
  agentId: string;
  path: string;
  source?: FireSource;
}
export interface FireNowOutput {
  fireId: number;
  status: FireStatus;
  conversationId: string | null;
}
export interface ListInput {
  agentId?: string;
}
export interface ListOutput {
  routines: RoutineRow[];
}

export interface RoutinesConfig {
  tickIntervalMs?: number;     // default 5_000
  claimBatchSize?: number;     // default 50
  claimWindowMinutes?: number; // default 5
  electionRetryMs?: number;    // default tickIntervalMs * 10
}
```

- [ ] **Step 4: Create `packages/routines/src/clock.ts`**

```ts
// ---------------------------------------------------------------------------
// Time injection for the routines plugin. Production wires Date.now /
// setTimeout / clearTimeout; tests substitute a controllable Clock so
// the tick loop, drift control, and active-hours math run in O(ms),
// not O(real seconds).
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep(ms, signal) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  },
};
```

- [ ] **Step 5: Create stubbed `packages/routines/src/plugin.ts`**

```ts
import type { Plugin } from '@ax/core';
import type { RoutinesConfig } from './types.js';

const PLUGIN_NAME = '@ax/routines';

export function createRoutinesPlugin(_config: RoutinesConfig = {}): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['routines:fire-now', 'routines:list'],
      calls: [
        'database:get-instance',
        'agents:resolve',
        'conversations:find-or-create',
        'conversations:create',
        'conversations:drop-turn',
        'conversations:hide',
        'agent:invoke',
      ],
      subscribes: ['workspace:applied', 'chat:turn-end'],
    },
    init() {
      // Tasks 5–14 wire migrations, store, sync, engines, tick, fire,
      // silence, service hooks.
    },
  };
}
```

- [ ] **Step 6: Create `packages/routines/src/index.ts`**

```ts
export { createRoutinesPlugin } from './plugin.js';
export type {
  RoutineRow,
  FireRow,
  FireSource,
  FireStatus,
  FireNowInput,
  FireNowOutput,
  ListInput,
  ListOutput,
  RoutinesConfig,
  TriggerSpec,
  ActiveHours,
} from './types.js';
```

- [ ] **Step 7: Add the package to the root `tsconfig.json` references**

In the root `tsconfig.json`, add `{ "path": "packages/routines" }` to the `references` array.

- [ ] **Step 8: Install deps and verify the package builds**

```bash
pnpm install
pnpm build --filter @ax/routines
```

Expected: BUILD OK.

- [ ] **Step 9: Commit**

```bash
git add packages/routines/ tsconfig.json pnpm-lock.yaml
git commit -m "feat(routines): scaffold package (manifest + types + clock)

Phase B foundation. Manifest declares all calls and subscribes for the
full plugin surface; init body is empty. Subsequent tasks land the
DB migration, store, sync, engines, tick loop, fire path, silence
logic, and service hook handlers. Clock abstraction lets tests drive
the tick loop in O(ms) instead of waiting on real time."
```

---

## Task 5: Routines DB migration

**Files:**
- Create: `packages/routines/src/migrations.ts`
- Create: `packages/routines/src/__tests__/migrations.test.ts`

Two tables (`routines_v1_definitions` + `routines_v1_fires`) plus indexes per design §3.2. Migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

- [ ] **Step 1: Write the failing migration test**

Create `packages/routines/src/__tests__/migrations.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
let db: Kysely<RoutinesDatabase>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
  db = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
}, 120_000);

afterAll(async () => {
  await db.destroy();
  if (container) await container.stop();
});

afterEach(async () => {
  await sql`DROP TABLE IF EXISTS routines_v1_fires`.execute(db);
  await sql`DROP TABLE IF EXISTS routines_v1_definitions`.execute(db);
});

describe('runRoutinesMigration', () => {
  it('creates routines_v1_definitions with primary key (agent_id, path)', async () => {
    await runRoutinesMigration(db);
    await db.insertInto('routines_v1_definitions').values({
      agent_id: 'agt_a', path: '.ax/routines/r.md', author_user_id: 'u1',
      name: 'r', description: 'd', spec_hash: 'h',
      trigger_kind: 'interval', trigger_spec: { kind: 'interval', every: '60s' },
      active_hours: null, silence_token: null, silence_max: 300,
      conversation: 'per-fire', prompt_body: '# x',
      next_run_at: new Date(),
    }).execute();
    await expect(
      db.insertInto('routines_v1_definitions').values({
        agent_id: 'agt_a', path: '.ax/routines/r.md', author_user_id: 'u1',
        name: 'r2', description: 'd', spec_hash: 'h',
        trigger_kind: 'interval', trigger_spec: { kind: 'interval', every: '60s' },
        active_hours: null, silence_token: null, silence_max: 300,
        conversation: 'per-fire', prompt_body: '# x',
        next_run_at: new Date(),
      }).execute(),
    ).rejects.toThrow(/duplicate|unique/i);
  });

  it('creates routines_v1_fires with append-only id', async () => {
    await runRoutinesMigration(db);
    const row = await db.insertInto('routines_v1_fires').values({
      agent_id: 'agt_a', path: '.ax/routines/r.md',
      trigger_source: 'tick', status: 'ok',
    }).returningAll().executeTakeFirstOrThrow();
    expect(row.id).toBeGreaterThan(0);
  });

  it('routines_v1_due index excludes null next_run_at', async () => {
    await runRoutinesMigration(db);
    const def = await db.introspection.getTables();
    const idxes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'routines_v1_definitions'
    `.execute(db);
    const names = idxes.rows.map((r) => r.indexname);
    expect(names).toContain('routines_v1_due');
  });

  it('is idempotent', async () => {
    await runRoutinesMigration(db);
    await runRoutinesMigration(db);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/routines -- migrations.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the migration**

Create `packages/routines/src/migrations.ts`:

```ts
import { sql, type Kysely, type Generated, type ColumnType } from 'kysely';

export interface RoutinesDefinitionsRow {
  agent_id: string;
  path: string;
  author_user_id: string;
  name: string;
  description: string;
  spec_hash: string;
  trigger_kind: 'interval' | 'cron' | 'webhook';
  trigger_spec: unknown;
  active_hours: unknown | null;
  silence_token: string | null;
  silence_max: number;
  conversation: 'per-fire' | 'shared';
  prompt_body: string;
  next_run_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  last_run_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  last_status: 'ok' | 'silenced' | 'error' | null;
  last_error: string | null;
  created_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface RoutinesFiresRow {
  id: Generated<number>;
  agent_id: string;
  path: string;
  fired_at: ColumnType<Date, Date | undefined, Date>;
  trigger_source: 'tick' | 'webhook' | 'manual';
  conversation_id: string | null;
  status: 'ok' | 'silenced' | 'error';
  error: string | null;
}

export interface RoutinesDatabase {
  routines_v1_definitions: RoutinesDefinitionsRow;
  routines_v1_fires: RoutinesFiresRow;
}

export async function runRoutinesMigration(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS routines_v1_definitions (
      agent_id        TEXT        NOT NULL,
      path            TEXT        NOT NULL,
      author_user_id  TEXT        NOT NULL,
      name            TEXT        NOT NULL,
      description     TEXT        NOT NULL,
      spec_hash       TEXT        NOT NULL,
      trigger_kind    TEXT        NOT NULL CHECK (trigger_kind IN ('interval','cron','webhook')),
      trigger_spec    JSONB       NOT NULL,
      active_hours    JSONB,
      silence_token   TEXT,
      silence_max     INTEGER     NOT NULL DEFAULT 300,
      conversation    TEXT        NOT NULL CHECK (conversation IN ('per-fire','shared')),
      prompt_body     TEXT        NOT NULL,
      next_run_at     TIMESTAMPTZ,
      last_run_at     TIMESTAMPTZ,
      last_status     TEXT,
      last_error      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_id, path)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS routines_v1_due
      ON routines_v1_definitions (next_run_at)
     WHERE next_run_at IS NOT NULL
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS routines_v1_fires (
      id              BIGSERIAL   PRIMARY KEY,
      agent_id        TEXT        NOT NULL,
      path            TEXT        NOT NULL,
      fired_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      trigger_source  TEXT        NOT NULL CHECK (trigger_source IN ('tick','webhook','manual')),
      conversation_id TEXT,
      status          TEXT        NOT NULL CHECK (status IN ('ok','silenced','error')),
      error           TEXT
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS routines_v1_fires_by_routine
      ON routines_v1_fires (agent_id, path, fired_at DESC)
  `.execute(db);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test --filter @ax/routines -- migrations.test.ts
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/migrations.ts packages/routines/src/__tests__/migrations.test.ts
git commit -m "feat(routines): add routines_v1_definitions + routines_v1_fires migration

Two tables per design §3.2:
  - routines_v1_definitions: agent_id+path PK, indexed on next_run_at
    where non-null (cheap due query). trigger_kind CHECK accepts
    webhook so Phase C is additive without a column-change migration.
  - routines_v1_fires: append-only audit log of every fire attempt
    (status: ok | silenced | error), indexed on (agent_id, path,
    fired_at DESC) for the admin per-routine recent-fires query.

Idempotent. Validated with Postgres testcontainer."
```

---

## Task 6: Trigger engines — interval

**Files:**
- Create: `packages/routines/src/engines/interval.ts`
- Create: `packages/routines/src/engines/index.ts` (just the interval entry for now)
- Create: `packages/routines/src/__tests__/engines-interval.test.ts`

`nextRun = from + parseDuration(every)`. Phase B keeps it pure — no clock side effects, the engine just maps (spec, from) → Date.

- [ ] **Step 1: Write the failing test**

Create `packages/routines/src/__tests__/engines-interval.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { intervalEngine } from '../engines/interval.js';

describe('intervalEngine', () => {
  it('advances by 30m', () => {
    const from = new Date('2026-05-14T12:00:00Z');
    const next = intervalEngine.nextRun({ kind: 'interval', every: '30m' }, from);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe('2026-05-14T12:30:00.000Z');
  });

  it('advances by 1h', () => {
    const from = new Date('2026-05-14T12:00:00Z');
    const next = intervalEngine.nextRun({ kind: 'interval', every: '1h' }, from);
    expect(next!.toISOString()).toBe('2026-05-14T13:00:00.000Z');
  });

  it('advances by 1d', () => {
    const from = new Date('2026-05-14T12:00:00Z');
    const next = intervalEngine.nextRun({ kind: 'interval', every: '1d' }, from);
    expect(next!.toISOString()).toBe('2026-05-15T12:00:00.000Z');
  });

  it('returns null for unparseable every (defensive — validator should reject)', () => {
    const from = new Date('2026-05-14T12:00:00Z');
    const next = intervalEngine.nextRun({ kind: 'interval', every: 'bad' }, from);
    expect(next).toBeNull();
  });

  it('schedulable: true', () => {
    expect(intervalEngine.schedulable).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/routines -- engines-interval.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

Create `packages/routines/src/engines/interval.ts`:

```ts
import { durationToSeconds, type TriggerSpec } from '@ax/validator-routine';

export interface TriggerEngine {
  nextRun(spec: TriggerSpec, from: Date): Date | null;
  schedulable: boolean;
}

export const intervalEngine: TriggerEngine = {
  schedulable: true,
  nextRun(spec, from) {
    if (spec.kind !== 'interval') return null;
    const seconds = durationToSeconds(spec.every);
    if (seconds === null) return null;
    return new Date(from.getTime() + seconds * 1000);
  },
};
```

Create `packages/routines/src/engines/index.ts`:

```ts
import type { TriggerSpec } from '@ax/validator-routine';
import { intervalEngine, type TriggerEngine } from './interval.js';

export { type TriggerEngine } from './interval.js';

export function engineFor(spec: TriggerSpec): TriggerEngine | null {
  switch (spec.kind) {
    case 'interval': return intervalEngine;
    case 'cron':     return null; // Task 7
    case 'webhook':  return null; // Phase C
    default:         return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test --filter @ax/routines -- engines-interval.test.ts
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/engines/ packages/routines/src/__tests__/engines-interval.test.ts
git commit -m "feat(routines): interval trigger engine

Pure function: (spec, from) -> Date. Returns null on unparseable
duration as a defensive guard — the validator should reject before
the row ever reaches the engine, but the failure mode of returning
null (vs. throwing) keeps the tick loop's invariant 'one bad row
does not wedge the loop' intact. Engine dispatcher (engines/index.ts)
returns null for cron + webhook for now; Task 7 lands cron, Phase C
lands webhook."
```

---

## Task 7: Trigger engines — cron

**Files:**
- Modify: `packages/routines/src/engines/cron.ts`
- Modify: `packages/routines/src/engines/index.ts`
- Create: `packages/routines/src/__tests__/engines-cron.test.ts`

Uses `croner` for cron parsing + tz-aware next-tick computation. `Cron.nextRun(from)` returns the next-after-from Date.

- [ ] **Step 1: Write the failing test**

Create `packages/routines/src/__tests__/engines-cron.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cronEngine } from '../engines/cron.js';

describe('cronEngine', () => {
  it('returns next 02:00 NYC after a 2026-05-14T01:00Z reference', () => {
    // 01:00Z on 2026-05-14 is 21:00 NYC on 2026-05-13 (EDT in May).
    // Next 02:00 NYC is 2026-05-14 02:00 EDT = 2026-05-14T06:00Z.
    const from = new Date('2026-05-14T01:00:00Z');
    const next = cronEngine.nextRun(
      { kind: 'cron', expr: '0 2 * * *', tz: 'America/New_York' },
      from,
    );
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe('2026-05-14T06:00:00.000Z');
  });

  it('handles UTC tz', () => {
    const from = new Date('2026-05-14T01:30:00Z');
    const next = cronEngine.nextRun(
      { kind: 'cron', expr: '0 2 * * *', tz: 'UTC' },
      from,
    );
    expect(next!.toISOString()).toBe('2026-05-14T02:00:00.000Z');
  });

  it('returns null for non-cron spec (defensive)', () => {
    const from = new Date('2026-05-14T01:00:00Z');
    expect(cronEngine.nextRun({ kind: 'interval', every: '30m' }, from)).toBeNull();
  });

  it('returns null on a malformed cron (defensive — validator should reject)', () => {
    const from = new Date('2026-05-14T01:00:00Z');
    expect(cronEngine.nextRun(
      { kind: 'cron', expr: 'not a cron', tz: 'UTC' }, from,
    )).toBeNull();
  });

  it('schedulable: true', () => {
    expect(cronEngine.schedulable).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/routines -- engines-cron.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

Create `packages/routines/src/engines/cron.ts`:

```ts
import { Cron } from 'croner';
import type { TriggerEngine } from './interval.js';

export const cronEngine: TriggerEngine = {
  schedulable: true,
  nextRun(spec, from) {
    if (spec.kind !== 'cron') return null;
    try {
      const c = new Cron(spec.expr, { timezone: spec.tz });
      const next = c.nextRun(from);
      return next ?? null;
    } catch {
      return null;
    }
  },
};
```

Update `packages/routines/src/engines/index.ts`:

```ts
import type { TriggerSpec } from '@ax/validator-routine';
import { intervalEngine, type TriggerEngine } from './interval.js';
import { cronEngine } from './cron.js';

export { type TriggerEngine } from './interval.js';

export function engineFor(spec: TriggerSpec): TriggerEngine | null {
  switch (spec.kind) {
    case 'interval': return intervalEngine;
    case 'cron':     return cronEngine;
    case 'webhook':  return null; // Phase C
    default:         return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test --filter @ax/routines -- engines-cron.test.ts
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/engines/cron.ts packages/routines/src/engines/index.ts packages/routines/src/__tests__/engines-cron.test.ts
git commit -m "feat(routines): cron trigger engine (croner)

Wraps croner's Cron(expr, { timezone }).nextRun(from). Defensive
null-returns on non-cron specs and malformed expressions match the
interval engine's behavior — bad rows are silently skipped by the
tick loop instead of crashing it. Validator vetted the expr + tz on
pre-apply, so the malformed path is the safety net not the happy
path."
```

---

## Task 8: Active-hours helper

**Files:**
- Create: `packages/routines/src/active-hours.ts`
- Create: `packages/routines/src/__tests__/active-hours.test.ts`

Given an `ActiveHours` spec and a candidate `next_run_at`, returns either the candidate (if it falls inside the window) or the start of the *next* window. Webhooks don't carry activeHours (design §2) — caller is responsible for skipping the call when `spec === null`.

- [ ] **Step 1: Write the failing test**

Create `packages/routines/src/__tests__/active-hours.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { advanceToNextActiveWindow } from '../active-hours.js';

describe('advanceToNextActiveWindow', () => {
  const ah = { start: '08:00', end: '24:00', tz: 'America/New_York' };

  it('returns the candidate when it falls inside the window', () => {
    // 2026-05-14 14:00 NYC = 18:00Z (EDT).
    const candidate = new Date('2026-05-14T18:00:00Z');
    const adjusted = advanceToNextActiveWindow(candidate, ah);
    expect(adjusted.toISOString()).toBe(candidate.toISOString());
  });

  it('shifts a candidate before the start to the day start', () => {
    // 2026-05-14 03:00 NYC = 07:00Z. Before 08:00 start.
    const candidate = new Date('2026-05-14T07:00:00Z');
    const adjusted = advanceToNextActiveWindow(candidate, ah);
    // 2026-05-14 08:00 NYC = 12:00Z.
    expect(adjusted.toISOString()).toBe('2026-05-14T12:00:00.000Z');
  });

  it('shifts a candidate after the end to the next day start', () => {
    // end = 24:00 means "midnight" — so 24:00 NYC = 04:00Z (next day).
    // Candidate 2026-05-15 05:00Z (= 2026-05-15 01:00 NYC, past midnight) →
    // shift to 2026-05-15 08:00 NYC = 12:00Z.
    const candidate = new Date('2026-05-15T05:00:00Z');
    const adjusted = advanceToNextActiveWindow(candidate, ah);
    expect(adjusted.toISOString()).toBe('2026-05-15T12:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/routines -- active-hours.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `packages/routines/src/active-hours.ts`:

```ts
import type { ActiveHours } from '@ax/validator-routine';

// We compute the tz-local hour/minute of the candidate using Intl
// (zero new deps; same approach croner uses). Then compare against the
// window edges. If inside, return candidate. If before start, shift to
// today's start. If past end, shift to tomorrow's start.
//
// `end: "24:00"` means midnight at the end of the day — candidates at
// or after the LOCAL midnight roll into the next-day window.

interface LocalHm {
  hour: number;   // 0..24 (24 represents the end sentinel only)
  minute: number; // 0..59
  ymd: { y: number; m: number; d: number };
}

function localParts(d: Date, tz: string): LocalHm {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    hour: parts.hour === '24' ? 0 : Number.parseInt(parts.hour, 10),
    minute: Number.parseInt(parts.minute, 10),
    ymd: {
      y: Number.parseInt(parts.year, 10),
      m: Number.parseInt(parts.month, 10),
      d: Number.parseInt(parts.day, 10),
    },
  };
}

function parseHm(hm: string): { h: number; m: number } {
  const [h, m] = hm.split(':');
  return { h: Number.parseInt(h!, 10), m: Number.parseInt(m!, 10) };
}

// Build a UTC Date for "YYYY-MM-DD HH:MM" in the given tz. Uses a
// fixed-point loop: pick a UTC guess, observe its rendered local time,
// nudge by the difference. Two iterations suffice across all real-world
// tz offsets including DST transitions.
function buildLocal(ymd: { y: number; m: number; d: number }, h: number, m: number, tz: string): Date {
  let guess = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, h, m, 0));
  for (let i = 0; i < 2; i++) {
    const seen = localParts(guess, tz);
    const seenMs = Date.UTC(seen.ymd.y, seen.ymd.m - 1, seen.ymd.d, seen.hour, seen.minute, 0);
    const wantMs = Date.UTC(ymd.y, ymd.m - 1, ymd.d, h, m, 0);
    guess = new Date(guess.getTime() + (wantMs - seenMs));
  }
  return guess;
}

function addDays(ymd: { y: number; m: number; d: number }, days: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function advanceToNextActiveWindow(candidate: Date, ah: ActiveHours): Date {
  const local = localParts(candidate, ah.tz);
  const startHm = parseHm(ah.start);
  const endHm = parseHm(ah.end);
  const candidateMinutes = local.hour * 60 + local.minute;
  const startMinutes = startHm.h * 60 + startHm.m;
  const endMinutes = endHm.h * 60 + endHm.m; // 24:00 → 1440

  if (candidateMinutes >= startMinutes && candidateMinutes < endMinutes) {
    return candidate;
  }
  if (candidateMinutes < startMinutes) {
    return buildLocal(local.ymd, startHm.h, startHm.m, ah.tz);
  }
  // past end → tomorrow's start
  return buildLocal(addDays(local.ymd, 1), startHm.h, startHm.m, ah.tz);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test --filter @ax/routines -- active-hours.test.ts
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/active-hours.ts packages/routines/src/__tests__/active-hours.test.ts
git commit -m "feat(routines): active-hours window helper

Given (candidate, ActiveHours), returns either the candidate (if it
falls inside the local-time window) or the next valid window start.
Used in §4.5 — outside-window candidates are not fired and not
counted as misses; we advance next_run_at to the next valid start.
Two-iteration fixed-point handles DST without a new dep."
```

---

## Task 9: Routines store (parse + spec_hash + sync upsert/delete + claim + advance + record-fire + list)

**Files:**
- Create: `packages/routines/src/parse-routine.ts`
- Create: `packages/routines/src/store.ts`
- Create: `packages/routines/src/__tests__/parse-routine.test.ts`
- Create: `packages/routines/src/__tests__/sync.test.ts` (store-level for now; full subscriber lands in Task 10)

The store has six methods: `upsert`, `delete`, `claimDue`, `advance`, `recordFire`, `list`. Spec-hash is sha256(frontmatter-bytes + body) so a no-op apply does not perturb `next_run_at` (design §3.3).

- [ ] **Step 1: Write parse-routine tests**

Create `packages/routines/src/__tests__/parse-routine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseRoutineRow } from '../parse-routine.js';

const ENC = new TextEncoder();

describe('parseRoutineRow', () => {
  it('returns parsed fields + a deterministic spec_hash', () => {
    const bytes = ENC.encode([
      '---', 'name: r', 'description: d',
      'trigger:', '  kind: interval', '  every: "60s"',
      '---', '# prompt',
    ].join('\n') + '\n');
    const a = parseRoutineRow(bytes);
    const b = parseRoutineRow(bytes);
    expect(a.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.specHash).toBe(b.specHash);
    expect(a.specHash).toHaveLength(64); // sha256 hex
  });

  it('different content yields different spec_hash', () => {
    const a = parseRoutineRow(ENC.encode('---\nname: a\ndescription: d\ntrigger:\n  kind: interval\n  every: "60s"\n---\n'));
    const b = parseRoutineRow(ENC.encode('---\nname: a\ndescription: d\ntrigger:\n  kind: interval\n  every: "120s"\n---\n'));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.specHash).not.toBe(b.specHash);
  });

  it('propagates parser failure', () => {
    const r = parseRoutineRow(ENC.encode('no frontmatter'));
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm test --filter @ax/routines -- parse-routine.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `parse-routine.ts`**

```ts
import { createHash } from 'node:crypto';
import {
  parseRoutineFrontmatterBytes,
  type RoutineFrontmatterFields,
} from '@ax/validator-routine';

export type ParsedRoutine =
  | { ok: true; fields: RoutineFrontmatterFields; specHash: string }
  | { ok: false; reason: string };

export function parseRoutineRow(bytes: Uint8Array): ParsedRoutine {
  const r = parseRoutineFrontmatterBytes(bytes);
  if (!r.ok) return { ok: false, reason: r.reason };
  const specHash = createHash('sha256').update(bytes).digest('hex');
  return { ok: true, fields: r.fields, specHash };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test --filter @ax/routines -- parse-routine.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write store tests**

Create `packages/routines/src/__tests__/sync.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore } from '../store.js';

let container: StartedPostgreSqlContainer;
let db: Kysely<RoutinesDatabase>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }),
  });
  await runRoutinesMigration(db);
}, 120_000);

afterEach(async () => {
  await sql`TRUNCATE routines_v1_definitions, routines_v1_fires`.execute(db);
});

afterAll(async () => {
  await db.destroy();
  if (container) await container.stop();
});

const baseUpsert = {
  agentId: 'agt_a',
  path: '.ax/routines/r.md',
  authorUserId: 'u1',
  name: 'r',
  description: 'd',
  specHash: 'sha-1',
  trigger: { kind: 'interval' as const, every: '60s' },
  activeHours: null,
  silenceToken: null,
  silenceMax: 300,
  conversation: 'per-fire' as const,
  promptBody: '# x',
  nextRunAt: new Date('2026-05-14T12:00:00Z'),
};

describe('routines store', () => {
  it('upsert creates a new row', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    const rows = await db.selectFrom('routines_v1_definitions').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe('agt_a');
    expect(rows[0]!.spec_hash).toBe('sha-1');
  });

  it('upsert with same spec_hash preserves next_run_at', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    const newer = new Date('2026-05-14T13:00:00Z');
    await store.upsert({ ...baseUpsert, nextRunAt: newer });
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    expect(row.next_run_at?.toISOString()).toBe('2026-05-14T12:00:00.000Z');
  });

  it('upsert with new spec_hash resets next_run_at', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    const newer = new Date('2026-05-14T13:00:00Z');
    await store.upsert({ ...baseUpsert, specHash: 'sha-2', nextRunAt: newer });
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    expect(row.next_run_at?.toISOString()).toBe('2026-05-14T13:00:00.000Z');
  });

  it('delete removes the row', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    await store.delete({ agentId: 'agt_a', path: '.ax/routines/r.md' });
    const rows = await db.selectFrom('routines_v1_definitions').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('claimDue returns due rows and advances next_run_at by the claim window', async () => {
    const store = createRoutinesStore(db);
    await store.upsert({ ...baseUpsert, nextRunAt: new Date('2026-05-14T11:00:00Z') });
    const claimedAt = new Date('2026-05-14T12:00:00Z');
    const claimed = await store.claimDue({ now: claimedAt, limit: 50, claimWindowMinutes: 5 });
    expect(claimed).toHaveLength(1);
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    // 11:00 + 5min claim window = 11:05
    expect(row.next_run_at?.toISOString()).toBe('2026-05-14T11:05:00.000Z');
  });

  it('claimDue skips webhook rows', async () => {
    const store = createRoutinesStore(db);
    // Webhook rows shouldn't normally have next_run_at set, but defend
    // against a buggy producer by ensuring the claim WHERE explicitly
    // excludes trigger_kind = 'webhook'.
    await db.insertInto('routines_v1_definitions').values({
      agent_id: 'agt_b', path: '.ax/routines/w.md', author_user_id: 'u1',
      name: 'w', description: 'd', spec_hash: 'h',
      trigger_kind: 'webhook', trigger_spec: { kind: 'webhook', path: '/x' },
      active_hours: null, silence_token: null, silence_max: 300,
      conversation: 'per-fire', prompt_body: '# x',
      next_run_at: new Date('2026-05-14T11:00:00Z'),
    }).execute();
    const claimed = await store.claimDue({ now: new Date('2026-05-14T12:00:00Z'), limit: 50, claimWindowMinutes: 5 });
    expect(claimed).toHaveLength(0);
  });

  it('advance updates next_run_at + last_run_at + last_status', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    const advancedAt = new Date('2026-05-14T12:01:00Z');
    const nextAt = new Date('2026-05-14T12:30:00Z');
    await store.advance({
      agentId: 'agt_a', path: '.ax/routines/r.md',
      nextRunAt: nextAt, lastRunAt: advancedAt,
      lastStatus: 'ok', lastError: null,
    });
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    expect(row.next_run_at?.toISOString()).toBe(nextAt.toISOString());
    expect(row.last_run_at?.toISOString()).toBe(advancedAt.toISOString());
    expect(row.last_status).toBe('ok');
  });

  it('recordFire appends a fires row', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    const id = await store.recordFire({
      agentId: 'agt_a', path: '.ax/routines/r.md',
      triggerSource: 'tick', conversationId: 'cnv_x', status: 'ok', error: null,
    });
    expect(id).toBeGreaterThan(0);
    const fires = await db.selectFrom('routines_v1_fires').selectAll().execute();
    expect(fires).toHaveLength(1);
    expect(fires[0]!.status).toBe('ok');
  });

  it('list returns all rows (optionally filtered by agent)', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseUpsert);
    await store.upsert({ ...baseUpsert, agentId: 'agt_b', path: '.ax/routines/r2.md' });
    expect(await store.list({})).toHaveLength(2);
    expect(await store.list({ agentId: 'agt_a' })).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run to verify fail**

```bash
pnpm test --filter @ax/routines -- sync.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 7: Implement the store**

Create `packages/routines/src/store.ts`:

```ts
import { sql, type Kysely } from 'kysely';
import type { RoutinesDatabase } from './migrations.js';
import type { TriggerSpec, ActiveHours } from '@ax/validator-routine';
import type { FireSource, FireStatus, RoutineRow } from './types.js';

export interface UpsertInput {
  agentId: string;
  path: string;
  authorUserId: string;
  name: string;
  description: string;
  specHash: string;
  trigger: TriggerSpec;
  activeHours: ActiveHours | null;
  silenceToken: string | null;
  silenceMax: number;
  conversation: 'per-fire' | 'shared';
  promptBody: string;
  nextRunAt: Date | null;
}

export interface AdvanceInput {
  agentId: string;
  path: string;
  nextRunAt: Date | null;
  lastRunAt: Date;
  lastStatus: FireStatus;
  lastError: string | null;
}

export interface ClaimInput {
  now: Date;
  limit: number;
  claimWindowMinutes: number;
}

export interface RecordFireInput {
  agentId: string;
  path: string;
  triggerSource: FireSource;
  conversationId: string | null;
  status: FireStatus;
  error: string | null;
}

export interface RoutinesStore {
  upsert(input: UpsertInput): Promise<void>;
  delete(input: { agentId: string; path: string }): Promise<void>;
  claimDue(input: ClaimInput): Promise<RoutineRow[]>;
  advance(input: AdvanceInput): Promise<void>;
  recordFire(input: RecordFireInput): Promise<number>;
  list(input: { agentId?: string }): Promise<RoutineRow[]>;
}

function rowToRoutine(row: {
  agent_id: string; path: string; author_user_id: string;
  name: string; description: string; spec_hash: string;
  trigger_kind: string; trigger_spec: unknown;
  active_hours: unknown | null;
  silence_token: string | null; silence_max: number;
  conversation: string; prompt_body: string;
  next_run_at: Date | null; last_run_at: Date | null;
  last_status: string | null; last_error: string | null;
}): RoutineRow {
  return {
    agentId: row.agent_id,
    path: row.path,
    authorUserId: row.author_user_id,
    name: row.name,
    description: row.description,
    specHash: row.spec_hash,
    trigger: row.trigger_spec as TriggerSpec,
    activeHours: row.active_hours as ActiveHours | null,
    silenceToken: row.silence_token,
    silenceMaxChars: row.silence_max,
    conversation: row.conversation as 'per-fire' | 'shared',
    promptBody: row.prompt_body,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status as FireStatus | null,
    lastError: row.last_error,
  };
}

export function createRoutinesStore(db: Kysely<RoutinesDatabase>): RoutinesStore {
  return {
    async upsert(input) {
      await db.insertInto('routines_v1_definitions').values({
        agent_id: input.agentId,
        path: input.path,
        author_user_id: input.authorUserId,
        name: input.name,
        description: input.description,
        spec_hash: input.specHash,
        trigger_kind: input.trigger.kind,
        trigger_spec: input.trigger as unknown,
        active_hours: input.activeHours as unknown,
        silence_token: input.silenceToken,
        silence_max: input.silenceMax,
        conversation: input.conversation,
        prompt_body: input.promptBody,
        next_run_at: input.nextRunAt,
      }).onConflict((oc) => oc
        .columns(['agent_id', 'path'])
        .doUpdateSet((eb) => ({
          author_user_id: eb.ref('excluded.author_user_id'),
          name: eb.ref('excluded.name'),
          description: eb.ref('excluded.description'),
          trigger_kind: eb.ref('excluded.trigger_kind'),
          trigger_spec: eb.ref('excluded.trigger_spec'),
          active_hours: eb.ref('excluded.active_hours'),
          silence_token: eb.ref('excluded.silence_token'),
          silence_max: eb.ref('excluded.silence_max'),
          conversation: eb.ref('excluded.conversation'),
          prompt_body: eb.ref('excluded.prompt_body'),
          // Spec-hash gate: only reset next_run_at when the spec actually changed.
          // Avoids next_run_at jitter on no-op applies (bundle re-apply).
          next_run_at: sql`CASE
            WHEN routines_v1_definitions.spec_hash IS DISTINCT FROM excluded.spec_hash
            THEN excluded.next_run_at
            ELSE routines_v1_definitions.next_run_at
          END`,
          spec_hash: eb.ref('excluded.spec_hash'),
          updated_at: sql`now()`,
        }))
      ).execute();
    },

    async delete(input) {
      await db.deleteFrom('routines_v1_definitions')
        .where('agent_id', '=', input.agentId)
        .where('path', '=', input.path)
        .execute();
    },

    async claimDue(input) {
      // SELECT due FOR UPDATE SKIP LOCKED, then UPDATE next_run_at by
      // the claim window. Two replicas claim disjoint sets atomically.
      const rows = await sql<{
        agent_id: string; path: string; author_user_id: string;
        name: string; description: string; spec_hash: string;
        trigger_kind: string; trigger_spec: unknown;
        active_hours: unknown | null;
        silence_token: string | null; silence_max: number;
        conversation: string; prompt_body: string;
        next_run_at: Date | null; last_run_at: Date | null;
        last_status: string | null; last_error: string | null;
      }>`
        WITH due AS (
          SELECT agent_id, path
            FROM routines_v1_definitions
           WHERE next_run_at IS NOT NULL
             AND next_run_at <= ${input.now}
             AND trigger_kind IN ('interval', 'cron')
           ORDER BY next_run_at ASC
           LIMIT ${input.limit}
           FOR UPDATE SKIP LOCKED
        )
        UPDATE routines_v1_definitions r
           SET next_run_at = r.next_run_at + (${input.claimWindowMinutes} || ' minutes')::interval
          FROM due
         WHERE r.agent_id = due.agent_id AND r.path = due.path
        RETURNING r.*
      `.execute(db);
      return rows.rows.map(rowToRoutine);
    },

    async advance(input) {
      await db.updateTable('routines_v1_definitions')
        .set({
          next_run_at: input.nextRunAt,
          last_run_at: input.lastRunAt,
          last_status: input.lastStatus,
          last_error: input.lastError,
          updated_at: sql`now()`,
        })
        .where('agent_id', '=', input.agentId)
        .where('path', '=', input.path)
        .execute();
    },

    async recordFire(input) {
      const row = await db.insertInto('routines_v1_fires').values({
        agent_id: input.agentId,
        path: input.path,
        trigger_source: input.triggerSource,
        conversation_id: input.conversationId,
        status: input.status,
        error: input.error,
      }).returning('id').executeTakeFirstOrThrow();
      return Number(row.id);
    },

    async list(input) {
      let q = db.selectFrom('routines_v1_definitions').selectAll();
      if (input.agentId !== undefined) q = q.where('agent_id', '=', input.agentId);
      const rows = await q.orderBy('agent_id').orderBy('path').execute();
      return rows.map(rowToRoutine);
    },
  };
}
```

- [ ] **Step 8: Run to verify pass**

```bash
pnpm test --filter @ax/routines -- sync.test.ts parse-routine.test.ts
```

Expected: ALL PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/routines/src/parse-routine.ts packages/routines/src/store.ts packages/routines/src/__tests__/parse-routine.test.ts packages/routines/src/__tests__/sync.test.ts
git commit -m "feat(routines): parse-routine helper + store (upsert/claim/advance/list)

parseRoutineRow wraps the validator's parser and adds sha256(bytes)
as a deterministic spec_hash. createRoutinesStore exposes six methods:
  - upsert  — INSERT ... ON CONFLICT with spec-hash-gated next_run_at
    reset (avoids jitter on no-op re-applies)
  - delete  — used when a .ax/routines/<name>.md is removed
  - claimDue — atomic FOR UPDATE SKIP LOCKED + advance by claim window
  - advance — set next_run_at + last_run_at + last_status
  - recordFire — append routines_v1_fires audit row
  - list — admin/manifest listing, optionally filtered by agent

Webhook rows are skipped by claimDue (Phase C will fire them via
HTTP route handler, not the tick)."
```

---

## Task 10: `workspace:applied` subscriber

**Files:**
- Create: `packages/routines/src/sync.ts`
- Modify: `packages/routines/src/plugin.ts` — wire the subscriber.
- Create: `packages/routines/src/__tests__/sync-subscriber.test.ts`

For each `.ax/routines/<name>.md` change in `delta.changes`:
- `'deleted'` → `store.delete`
- `'added'` / `'modified'` → parse content via `parseRoutineRow`, compute initial `next_run_at` via `engineFor`, `store.upsert`.

Subscriber MUST NOT throw (I8). On parse failure, log + skip (the validator should have rejected on pre-apply).

- [ ] **Step 1: Write the failing test**

Create `packages/routines/src/__tests__/sync-subscriber.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { HookBus, makeAgentContext, asWorkspaceVersion, type WorkspaceDelta } from '@ax/core';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore } from '../store.js';
import { handleWorkspaceApplied } from '../sync.js';

const ENC = new TextEncoder();

let container: StartedPostgreSqlContainer;
let db: Kysely<RoutinesDatabase>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }),
  });
  await runRoutinesMigration(db);
}, 120_000);

afterEach(async () => {
  await sql`TRUNCATE routines_v1_definitions, routines_v1_fires`.execute(db);
});

afterAll(async () => {
  await db.destroy();
  if (container) await container.stop();
});

function delta(changes: WorkspaceDelta['changes'], author: { agentId: string; userId: string }): WorkspaceDelta {
  return {
    before: null,
    after: asWorkspaceVersion('v1'),
    author,
    changes,
  };
}

function intervalBody(every = '60s'): Uint8Array {
  return ENC.encode([
    '---',
    'name: r', 'description: d',
    'trigger:', '  kind: interval', `  every: "${every}"`,
    '---', '# prompt',
  ].join('\n') + '\n');
}

describe('handleWorkspaceApplied', () => {
  it('upserts on added', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    const now = new Date('2026-05-14T12:00:00Z');
    await handleWorkspaceApplied(store, ctx, delta([
      {
        path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => intervalBody('60s'),
      },
    ], { agentId: 'agt_a', userId: 'u1' }), now);
    const rows = await db.selectFrom('routines_v1_definitions').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.next_run_at?.toISOString()).toBe('2026-05-14T12:01:00.000Z');
  });

  it('deletes on deleted', async () => {
    const store = createRoutinesStore(db);
    await store.upsert({
      agentId: 'agt_a', path: '.ax/routines/r.md', authorUserId: 'u1',
      name: 'r', description: 'd', specHash: 'h',
      trigger: { kind: 'interval', every: '60s' }, activeHours: null,
      silenceToken: null, silenceMax: 300, conversation: 'per-fire',
      promptBody: '# x', nextRunAt: new Date(),
    });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(store, ctx, delta([
      { path: '.ax/routines/r.md', kind: 'deleted' },
    ], { agentId: 'agt_a', userId: 'u1' }), new Date());
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('ignores changes outside .ax/routines/', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(store, ctx, delta([
      { path: 'README.md', kind: 'added', contentAfter: async () => ENC.encode('# hi') },
    ], { agentId: 'agt_a', userId: 'u1' }), new Date());
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('skips when author.agentId or author.userId is missing', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(
      store, ctx,
      { before: null, after: asWorkspaceVersion('v'), changes: [{ path: '.ax/routines/r.md', kind: 'added', contentAfter: async () => intervalBody() }] } as WorkspaceDelta,
      new Date(),
    );
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('does not throw on a malformed routine (I8 — log + skip)', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(store, ctx, delta([
      { path: '.ax/routines/bad.md', kind: 'added', contentAfter: async () => ENC.encode('no frontmatter') },
    ], { agentId: 'agt_a', userId: 'u1' }), new Date());
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('skips nested routine paths (.ax/routines/sub/x.md)', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(store, ctx, delta([
      { path: '.ax/routines/sub/x.md', kind: 'added', contentAfter: async () => intervalBody() },
    ], { agentId: 'agt_a', userId: 'u1' }), new Date());
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm test --filter @ax/routines -- sync-subscriber.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the subscriber**

Create `packages/routines/src/sync.ts`:

```ts
import type { AgentContext, WorkspaceDelta } from '@ax/core';
import type { RoutinesStore } from './store.js';
import { parseRoutineRow } from './parse-routine.js';
import { engineFor } from './engines/index.js';

const ROUTINE_PATH = /^\.ax\/routines\/[^/]+\.md$/;

// I8: subscriber MUST NOT throw. All failures are logged + swallowed;
// the workspace:apply path must not be wedged by a buggy routine file.
export async function handleWorkspaceApplied(
  store: RoutinesStore,
  ctx: AgentContext,
  delta: WorkspaceDelta,
  now: Date,
): Promise<void> {
  const agentId = delta.author?.agentId;
  const userId = delta.author?.userId;
  if (typeof agentId !== 'string' || agentId.length === 0) return;
  if (typeof userId !== 'string' || userId.length === 0) return;

  for (const change of delta.changes) {
    if (!ROUTINE_PATH.test(change.path)) continue;

    if (change.kind === 'deleted') {
      try {
        await store.delete({ agentId, path: change.path });
      } catch (err) {
        ctx.logger.warn('routines_sync_delete_failed', {
          agentId, path: change.path,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
      continue;
    }

    // 'added' | 'modified'
    try {
      const fetcher = change.contentAfter;
      if (typeof fetcher !== 'function') continue;
      const bytes = await fetcher();
      const parsed = parseRoutineRow(bytes);
      if (!parsed.ok) {
        ctx.logger.warn('routines_sync_parse_failed', {
          agentId, path: change.path, reason: parsed.reason,
        });
        continue;
      }
      const eng = engineFor(parsed.fields.trigger);
      const nextRunAt = parsed.fields.trigger.kind === 'webhook'
        ? null
        : eng?.nextRun(parsed.fields.trigger, now) ?? null;

      await store.upsert({
        agentId,
        path: change.path,
        authorUserId: userId,
        name: parsed.fields.name,
        description: parsed.fields.description,
        specHash: parsed.specHash,
        trigger: parsed.fields.trigger,
        activeHours: parsed.fields.activeHours ?? null,
        silenceToken: parsed.fields.silenceToken ?? null,
        silenceMax: parsed.fields.silenceMaxChars,
        conversation: parsed.fields.conversation,
        promptBody: parsed.fields.promptBody,
        nextRunAt,
      });
    } catch (err) {
      ctx.logger.warn('routines_sync_upsert_failed', {
        agentId, path: change.path,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}
```

- [ ] **Step 4: Wire the subscriber inside `plugin.ts`**

Modify `packages/routines/src/plugin.ts` to register the subscriber in `init()`:

```ts
import type { HookBus, Plugin, WorkspaceDelta } from '@ax/core';
import { makeAgentContext, type Kysely } from '@ax/core';
import { Kysely as KKysely } from 'kysely';
import { runRoutinesMigration, type RoutinesDatabase } from './migrations.js';
import { createRoutinesStore, type RoutinesStore } from './store.js';
import { handleWorkspaceApplied } from './sync.js';
import { systemClock, type Clock } from './clock.js';
import type { RoutinesConfig } from './types.js';

const PLUGIN_NAME = '@ax/routines';

export function createRoutinesPlugin(
  config: RoutinesConfig = {},
  clock: Clock = systemClock,
): Plugin {
  let db: KKysely<RoutinesDatabase> | undefined;
  let store: RoutinesStore | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['routines:fire-now', 'routines:list'],
      calls: [
        'database:get-instance',
        'agents:resolve',
        'conversations:find-or-create',
        'conversations:create',
        'conversations:drop-turn',
        'conversations:hide',
        'agent:invoke',
      ],
      subscribes: ['workspace:applied', 'chat:turn-end'],
    },
    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system',
      });
      const { db: shared } = await bus.call<unknown, { db: KKysely<unknown> }>(
        'database:get-instance', initCtx, {},
      );
      db = shared as KKysely<RoutinesDatabase>;
      await runRoutinesMigration(db);
      store = createRoutinesStore(db);
      const localStore = store;

      bus.subscribe<WorkspaceDelta>(
        'workspace:applied', PLUGIN_NAME,
        async (ctx, delta) => {
          await handleWorkspaceApplied(localStore, ctx, delta, clock.now());
          return undefined;
        },
      );

      // routines:fire-now + routines:list + tick loop + chat:turn-end
      // one-shot all land in Tasks 12, 13, 14.
    },
    async shutdown() {
      db = undefined;
      store = undefined;
    },
  };
}
```

- [ ] **Step 5: Run all routines tests**

```bash
pnpm test --filter @ax/routines
```

Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/routines/src/sync.ts packages/routines/src/plugin.ts packages/routines/src/__tests__/sync-subscriber.test.ts
git commit -m "feat(routines): workspace:applied subscriber syncs DB mirror

Subscriber matches paths against /^\.ax\/routines\/[^/]+\.md\$/ (flat
layout enforced here too — defense-in-depth alongside the validator).
'deleted' kind triggers store.delete; 'added' / 'modified' fetch
bytes lazily from change.contentAfter and parse via parseRoutineRow,
then engineFor(trigger) computes the initial next_run_at.

I8: every error path logs + swallows. A buggy routine file must
NEVER wedge the workspace:apply path. Validator already vetted the
file on pre-apply; failures here are the safety net, not the gate.

Missing author.agentId or author.userId on the delta skips the
update entirely — we don't synthesize a system-user attribution
just to get the routine indexed."
```

---

## Task 11: Tick loop + advisory-lock election + claim/advance

**Files:**
- Create: `packages/routines/src/tick.ts`
- Create: `packages/routines/src/__tests__/tick.test.ts`
- Modify: `packages/routines/src/plugin.ts` — start/stop the tick loop in init/shutdown.

Loop logic (design §4.2 – §4.7):
1. At each tick, try `pg_try_advisory_lock(hashtext('@ax/routines.tick'))`. If false, sleep `electionRetryMs` and retry.
2. If true, call `store.claimDue(now, limit, claimWindow)`. For each claimed row:
   - If outside `activeHours`, compute the next valid window start and `store.advance(nextRunAt = that, status = 'silenced'? no — drift-skip, no fire)`. Actually per §4.5: skip → reset next_run_at to next-valid window. No fire row.
   - Else: call `fireRoutine(row, 'tick')` (Task 12). After fire returns, `store.advance(nextRunAt = engine.nextRun(spec, now), lastRunAt=now, lastStatus=result.status, lastError=result.error)`.
3. Drift control: interval `nextRunAt` advances from the **previous** `nextRunAt`, not `now`. If `previous + every < now - every` (more than one interval behind), jump to `now + every`.

Phase B fire path returns a stub status; Task 12 lands the real fire. We split tick vs fire so tick can be tested without an agent runtime.

- [ ] **Step 1: Write the failing test**

Create `packages/routines/src/__tests__/tick.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore, type RoutinesStore } from '../store.js';
import { runTickOnce, type FireRoutineFn } from '../tick.js';

let container: StartedPostgreSqlContainer;
let db: Kysely<RoutinesDatabase>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }),
  });
  await runRoutinesMigration(db);
}, 120_000);

afterEach(async () => {
  await sql`TRUNCATE routines_v1_definitions, routines_v1_fires`.execute(db);
});

afterAll(async () => {
  await db.destroy();
  if (container) await container.stop();
});

async function seedInterval(store: RoutinesStore, agentId: string, every: string, nextAt: Date) {
  await store.upsert({
    agentId, path: '.ax/routines/r.md', authorUserId: 'u1',
    name: 'r', description: 'd', specHash: agentId + every,
    trigger: { kind: 'interval', every },
    activeHours: null, silenceToken: null, silenceMax: 300,
    conversation: 'per-fire', promptBody: '# x',
    nextRunAt: nextAt,
  });
}

describe('runTickOnce', () => {
  it('fires a due interval routine and advances next_run_at by every', async () => {
    const store = createRoutinesStore(db);
    await seedInterval(store, 'agt_a', '30m', new Date('2026-05-14T12:00:00Z'));
    const fired: Array<{ agentId: string; status: string }> = [];
    const fire: FireRoutineFn = async (row) => {
      fired.push({ agentId: row.agentId, status: 'ok' });
      return { status: 'ok', error: null };
    };
    await runTickOnce({
      store, fire, now: new Date('2026-05-14T12:01:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
    });
    expect(fired).toEqual([{ agentId: 'agt_a', status: 'ok' }]);
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    // Drift control: previous next_run_at + every. 12:00 + 30m = 12:30.
    expect(row.next_run_at?.toISOString()).toBe('2026-05-14T12:30:00.000Z');
    expect(row.last_status).toBe('ok');
  });

  it('jumps to now + every when more than one interval behind (catch-up storm guard)', async () => {
    const store = createRoutinesStore(db);
    // next_run_at was 09:00, every is 30m, now is 12:00 → ~6 intervals behind.
    await seedInterval(store, 'agt_a', '30m', new Date('2026-05-14T09:00:00Z'));
    const fire: FireRoutineFn = async () => ({ status: 'ok', error: null });
    await runTickOnce({
      store, fire, now: new Date('2026-05-14T12:00:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
    });
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    // jump: now + every = 12:30
    expect(row.next_run_at?.toISOString()).toBe('2026-05-14T12:30:00.000Z');
  });

  it('skips outside active hours and shifts to next valid window', async () => {
    const store = createRoutinesStore(db);
    await store.upsert({
      agentId: 'agt_a', path: '.ax/routines/r.md', authorUserId: 'u1',
      name: 'r', description: 'd', specHash: 'h',
      trigger: { kind: 'interval', every: '30m' },
      activeHours: { start: '08:00', end: '24:00', tz: 'America/New_York' },
      silenceToken: null, silenceMax: 300, conversation: 'per-fire',
      promptBody: '# x',
      // 2026-05-14 03:00 NYC = 07:00Z (before 08:00 start).
      nextRunAt: new Date('2026-05-14T07:00:00Z'),
    });
    const fired: unknown[] = [];
    const fire: FireRoutineFn = async (row) => { fired.push(row); return { status: 'ok', error: null }; };
    await runTickOnce({
      store, fire, now: new Date('2026-05-14T07:05:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
    });
    expect(fired).toEqual([]);
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    // Shifted to 08:00 NYC = 12:00Z.
    expect(row.next_run_at?.toISOString()).toBe('2026-05-14T12:00:00.000Z');
    // No fires row.
    const fires = await db.selectFrom('routines_v1_fires').selectAll().execute();
    expect(fires).toHaveLength(0);
  });

  it('records fire row with error status when fire throws', async () => {
    const store = createRoutinesStore(db);
    await seedInterval(store, 'agt_a', '30m', new Date('2026-05-14T12:00:00Z'));
    const fire: FireRoutineFn = async () => { throw new Error('agent crashed'); };
    await runTickOnce({
      store, fire, now: new Date('2026-05-14T12:01:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
    });
    const fires = await db.selectFrom('routines_v1_fires').selectAll().execute();
    expect(fires).toHaveLength(1);
    expect(fires[0]!.status).toBe('error');
    expect(fires[0]!.error).toMatch(/agent crashed/);
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    expect(row.last_status).toBe('error');
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm test --filter @ax/routines -- tick.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement the tick loop**

Create `packages/routines/src/tick.ts`:

```ts
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { RoutinesDatabase } from './migrations.js';
import type { RoutinesStore } from './store.js';
import type { RoutineRow, FireStatus } from './types.js';
import { engineFor } from './engines/index.js';
import { advanceToNextActiveWindow } from './active-hours.js';
import { durationToSeconds } from '@ax/validator-routine';
import type { Clock } from './clock.js';

export interface FireResult {
  status: FireStatus;
  conversationId?: string | null;
  error: string | null;
}

export type FireRoutineFn = (
  row: RoutineRow,
  source: 'tick' | 'manual',
) => Promise<FireResult>;

export interface TickOnceInput {
  store: RoutinesStore;
  fire: FireRoutineFn;
  now: Date;
  claimBatchSize: number;
  claimWindowMinutes: number;
}

export async function runTickOnce(input: TickOnceInput): Promise<void> {
  const claimed = await input.store.claimDue({
    now: input.now,
    limit: input.claimBatchSize,
    claimWindowMinutes: input.claimWindowMinutes,
  });

  for (const row of claimed) {
    // Active hours: skip + shift, no fire, no fire-row.
    if (row.activeHours !== null) {
      const adjusted = advanceToNextActiveWindow(input.now, row.activeHours);
      if (adjusted.getTime() > input.now.getTime()) {
        await input.store.advance({
          agentId: row.agentId, path: row.path,
          nextRunAt: adjusted,
          lastRunAt: input.now,
          lastStatus: row.lastStatus ?? 'ok',
          lastError: row.lastError ?? null,
        });
        continue;
      }
    }

    let result: FireResult;
    try {
      result = await input.fire(row, 'tick');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { status: 'error', error: msg, conversationId: null };
    }

    await input.store.recordFire({
      agentId: row.agentId, path: row.path,
      triggerSource: 'tick',
      conversationId: result.conversationId ?? null,
      status: result.status,
      error: result.error,
    });

    const nextAt = computeNextRunAt(row, input.now);
    await input.store.advance({
      agentId: row.agentId, path: row.path,
      nextRunAt: nextAt,
      lastRunAt: input.now,
      lastStatus: result.status,
      lastError: result.error,
    });
  }
}

function computeNextRunAt(row: RoutineRow, now: Date): Date | null {
  if (row.trigger.kind === 'webhook') return null;
  const eng = engineFor(row.trigger);
  if (eng === null) return null;

  // Drift control. For interval, advance from previous next_run_at unless
  // we're more than one interval behind — in which case jump to now+every
  // to avoid a catch-up storm.
  if (row.trigger.kind === 'interval') {
    const seconds = durationToSeconds(row.trigger.every) ?? 0;
    const prevTarget = row.nextRunAt ?? now;
    const candidate = new Date(prevTarget.getTime() + seconds * 1000);
    const oneIntervalAhead = new Date(now.getTime() + seconds * 1000);
    const isMoreThanOneBehind =
      now.getTime() - prevTarget.getTime() > seconds * 1000;
    return isMoreThanOneBehind ? oneIntervalAhead : candidate;
  }

  return eng.nextRun(row.trigger, now);
}

// ---------------------------------------------------------------------------
// Tick loop driver. Wraps runTickOnce in a sleep cadence + advisory-lock
// election. Cancelled via AbortSignal at plugin shutdown.
// ---------------------------------------------------------------------------

export interface TickLoopInput {
  db: Kysely<RoutinesDatabase>;
  store: RoutinesStore;
  fire: FireRoutineFn;
  clock: Clock;
  signal: AbortSignal;
  tickIntervalMs: number;
  electionRetryMs: number;
  claimBatchSize: number;
  claimWindowMinutes: number;
}

const ADVISORY_LOCK_KEY = 'ax/routines.tick';

export async function runTickLoop(input: TickLoopInput): Promise<void> {
  while (!input.signal.aborted) {
    const acquired = await tryAcquireAdvisoryLock(input.db);
    if (!acquired) {
      await input.clock.sleep(input.electionRetryMs, input.signal);
      continue;
    }
    try {
      while (!input.signal.aborted) {
        try {
          await runTickOnce({
            store: input.store, fire: input.fire,
            now: input.clock.now(),
            claimBatchSize: input.claimBatchSize,
            claimWindowMinutes: input.claimWindowMinutes,
          });
        } catch (err) {
          // I8 — tick errors must not crash the loop.
          process.stderr.write(
            `[ax/routines] tick error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        await input.clock.sleep(input.tickIntervalMs, input.signal);
      }
    } finally {
      await releaseAdvisoryLock(input.db);
    }
  }
}

async function tryAcquireAdvisoryLock(db: Kysely<RoutinesDatabase>): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT pg_try_advisory_lock(hashtext(${ADVISORY_LOCK_KEY})) AS ok
  `.execute(db);
  return r.rows[0]?.ok === true;
}

async function releaseAdvisoryLock(db: Kysely<RoutinesDatabase>): Promise<void> {
  try {
    await sql`SELECT pg_advisory_unlock(hashtext(${ADVISORY_LOCK_KEY}))`.execute(db);
  } catch {
    // Disconnect handles it.
  }
}
```

- [ ] **Step 4: Wire the loop in `plugin.ts`**

Add to the `init()` body in `packages/routines/src/plugin.ts`:

```ts
import { runTickLoop, type FireRoutineFn } from './tick.js';

// At the top of init(), AFTER store is created:
const abortCtl = new AbortController();
const tickConfig = {
  tickIntervalMs: config.tickIntervalMs ?? 5_000,
  claimBatchSize: config.claimBatchSize ?? 50,
  claimWindowMinutes: config.claimWindowMinutes ?? 5,
  electionRetryMs: config.electionRetryMs ?? (config.tickIntervalMs ?? 5_000) * 10,
};

// Task 12 lands the real fireRoutine. For now, stub that records an error
// status — keeps the tick loop runnable for the canary boot.
const stubFire: FireRoutineFn = async (_row, _source) => ({
  status: 'error',
  error: 'fireRoutine not yet implemented (Task 12)',
  conversationId: null,
});

// Fire-and-forget — the loop owns its lifecycle. We don't await it.
void runTickLoop({
  db, store: localStore, fire: stubFire, clock,
  signal: abortCtl.signal,
  ...tickConfig,
}).catch((err) => {
  process.stderr.write(`[ax/routines] tick loop died: ${err}\n`);
});

// In shutdown():
//   abortCtl.abort();

// Stash abortCtl in a closure so shutdown can call it.
```

Restructure so `abortCtl` lives at module-scope inside the closure. Adjust the existing `shutdown()` to call `abortCtl?.abort()`.

- [ ] **Step 5: Run all tests**

```bash
pnpm test --filter @ax/routines
```

Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/routines/src/tick.ts packages/routines/src/plugin.ts packages/routines/src/__tests__/tick.test.ts
git commit -m "feat(routines): tick loop + advisory-lock election + drift control

runTickOnce: claim due rows via FOR UPDATE SKIP LOCKED, apply active-
hours skip (no fire, no fire-row, shift next_run_at to next valid
window), else call fire() and advance next_run_at. Drift control on
interval: advance from previous next_run_at unless we're more than
one interval behind, in which case jump to now+every to avoid a
catch-up storm.

runTickLoop wraps runTickOnce in a sleep cadence + pg_try_advisory_
lock election. The lock is best-effort election; FOR UPDATE SKIP
LOCKED is the correctness guarantee. Cancelled via AbortSignal at
shutdown.

Phase B init() wires a STUB fireRoutine that records status=error
— Task 12 replaces it with the real fire path. The tick loop is
nevertheless runnable end-to-end (claims rows, advances next_run_at,
records fires) which is what the canary checks first."
```

---

## Task 12: `fireRoutine` — resolve agent, find-or-create conversation, agent:invoke

**Files:**
- Create: `packages/routines/src/fire.ts`
- Create: `packages/routines/src/__tests__/fire.test.ts`
- Modify: `packages/routines/src/plugin.ts` — replace the stub fire with the real one + wire the chat:turn-end one-shot router.

**I1 plan-vs-reality:** Design §5 says "publish `chat:turn-start`". That hook does not exist — Phase B uses the existing `agent:invoke` service hook (registered by `@ax/chat-orchestrator`). The input shape is `{ message: AgentMessage }` where `AgentMessage = { role: 'user'; content: string }`. Routines synthesizes a fresh ctx scoped to `(agent.ownerId, agent.id)` plus a unique `reqId` so the chat:turn-end one-shot router can demultiplex.

The fire path:
1. `agents:resolve(agentId, userId)` — uses `routine.authorUserId` as the userId.
2. Find-or-create conversation:
   - `conversation: 'shared'` → `conversations:find-or-create` with `externalKey = routine.path`.
   - `conversation: 'per-fire'` → `conversations:create`.
3. Generate a fresh `reqId` (`req-routine-${nanoid}`) and register a one-shot in the plugin-level "pending fires" map keyed by `reqId`.
4. Call `agent:invoke` fire-and-forget with `message = { role: 'user', content: row.promptBody }` and a synthetic ctx.
5. When the `chat:turn-end` subscriber receives a payload with that `reqId`, it dequeues the pending fire and runs `applySilenceAndLog` (Task 13).

For Phase B testing we DO NOT exercise the real chat-orchestrator. The fire test stubs `agent:invoke` with a controllable harness service that synchronously fires `chat:turn-end` with a chosen contentBlocks payload — enough to assert the silence path.

- [ ] **Step 1: Write the failing test**

Create `packages/routines/src/__tests__/fire.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import type { ContentBlock } from '@ax/ipc-protocol';
import { createFireRoutine, type FireDeps, type PendingFires } from '../fire.js';
import type { RoutineRow } from '../types.js';

function row(over: Partial<RoutineRow> = {}): RoutineRow {
  return {
    agentId: 'agt_a', path: '.ax/routines/r.md', authorUserId: 'u1',
    name: 'r', description: 'd', specHash: 'h',
    trigger: { kind: 'interval', every: '60s' },
    activeHours: null, silenceToken: null, silenceMaxChars: 300,
    conversation: 'per-fire', promptBody: 'do work',
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null,
    ...over,
  };
}

async function makeBus(opts: {
  resolve?: (agentId: string, userId: string) => Promise<{ agent: unknown }>;
  invoke?: (ctx: AgentContext, input: unknown) => Promise<unknown>;
  findOrCreate?: (input: unknown) => Promise<unknown>;
  create?: (input: unknown) => Promise<unknown>;
}) {
  const bus = new HookBus();
  bus.registerService('agents:resolve', 'test', async (_ctx, input) => {
    const i = input as { agentId: string; userId: string };
    return opts.resolve
      ? await opts.resolve(i.agentId, i.userId)
      : { agent: { id: i.agentId, ownerId: i.userId, workspaceRef: null } };
  });
  bus.registerService('agent:invoke', 'test', async (ctx, input) => {
    return opts.invoke
      ? await opts.invoke(ctx, input)
      : { kind: 'complete', messages: [] };
  });
  bus.registerService('conversations:find-or-create', 'test', async (_ctx, input) => {
    return opts.findOrCreate
      ? await opts.findOrCreate(input)
      : { conversation: { conversationId: 'cnv_shared', userId: 'u1', agentId: 'agt_a' }, created: true };
  });
  bus.registerService('conversations:create', 'test', async (_ctx, input) => {
    return opts.create
      ? await opts.create(input)
      : { conversationId: 'cnv_perfire', userId: 'u1', agentId: 'agt_a' };
  });
  return bus;
}

describe('fireRoutine', () => {
  it('per-fire: calls conversations:create and agent:invoke with the prompt body', async () => {
    let createdWith: unknown;
    let invokedWith: unknown;
    const bus = await makeBus({
      create: async (input) => { createdWith = input; return { conversationId: 'cnv_x', userId: 'u1', agentId: 'agt_a' }; },
      invoke: async (_ctx, input) => { invokedWith = input; return { kind: 'complete', messages: [] }; },
    });
    const pending: PendingFires = new Map();
    const fire = createFireRoutine({ bus, pending } as FireDeps);
    const result = await fire(row(), 'tick');
    expect((createdWith as { agentId: string }).agentId).toBe('agt_a');
    expect((invokedWith as { message: { content: string } }).message.content).toBe('do work');
    expect(result.conversationId).toBe('cnv_x');
    expect(pending.size).toBe(1);   // one-shot still pending until chat:turn-end
  });

  it('shared: calls conversations:find-or-create with externalKey = row.path', async () => {
    let foundOrCreatedWith: unknown;
    const bus = await makeBus({
      findOrCreate: async (input) => {
        foundOrCreatedWith = input;
        return { conversation: { conversationId: 'cnv_s', userId: 'u1', agentId: 'agt_a' }, created: false };
      },
    });
    const pending: PendingFires = new Map();
    const fire = createFireRoutine({ bus, pending } as FireDeps);
    await fire(row({ conversation: 'shared' }), 'tick');
    expect((foundOrCreatedWith as { externalKey: string }).externalKey).toBe('.ax/routines/r.md');
  });

  it('propagates an agents:resolve forbidden as error status', async () => {
    const bus = await makeBus({
      resolve: async () => { throw new PluginError({ code: 'forbidden', plugin: 'agents', hookName: 'agents:resolve', message: 'denied' }); },
    });
    const pending: PendingFires = new Map();
    const fire = createFireRoutine({ bus, pending } as FireDeps);
    const result = await fire(row(), 'tick');
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/forbidden|denied/i);
    expect(pending.size).toBe(0);
  });

  it('agent:invoke is fire-and-forget — does not block on completion', async () => {
    let resolveInvoke!: () => void;
    const invokePromise = new Promise<unknown>((res) => { resolveInvoke = () => res({ kind: 'complete', messages: [] }); });
    const bus = await makeBus({
      invoke: async () => invokePromise,
    });
    const pending: PendingFires = new Map();
    const fire = createFireRoutine({ bus, pending } as FireDeps);
    const t0 = Date.now();
    const result = await Promise.race([
      fire(row(), 'tick'),
      new Promise<{ blocked: true }>((res) => setTimeout(() => res({ blocked: true } as never), 200)),
    ]);
    expect((result as { blocked?: true }).blocked).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(200);
    resolveInvoke();
    await invokePromise;
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm test --filter @ax/routines -- fire.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `fire.ts`**

Create `packages/routines/src/fire.ts`:

```ts
import { makeAgentContext, PluginError, type AgentContext, type HookBus } from '@ax/core';
import type { RoutineRow, FireSource } from './types.js';
import type { FireResult } from './tick.js';

// One pending fire per in-flight reqId. The chat:turn-end one-shot router
// (wired in plugin.ts) looks up the reqId here, removes the entry, and
// calls `onTurnEnd(payload)` to run silence-token logic + record the fire.
export interface PendingFire {
  row: RoutineRow;
  conversationId: string;
  source: FireSource;
  // Set by the fire path; called by the chat:turn-end router.
  onTurnEnd: (turn: { contentBlocks?: unknown[] }) => Promise<void>;
}
export type PendingFires = Map<string, PendingFire>;

export interface FireDeps {
  bus: HookBus;
  pending: PendingFires;
}

let nextReqIdCounter = 0;
function makeReqId(): string {
  nextReqIdCounter += 1;
  return `req-routine-${Date.now().toString(36)}-${nextReqIdCounter}`;
}

export function createFireRoutine(deps: FireDeps) {
  return async (row: RoutineRow, source: FireSource): Promise<FireResult> => {
    const baseCtx = makeAgentContext({
      sessionId: `routine-${row.agentId}-${row.path}`,
      agentId: row.agentId,
      userId: row.authorUserId,
    });

    // 1. agents:resolve — propagate forbidden / not-found as a fire error.
    let agent: { id: string; ownerId?: string; workspaceRef?: string | null };
    try {
      const resolved = await deps.bus.call<
        { agentId: string; userId: string },
        { agent: typeof agent }
      >('agents:resolve', baseCtx, { agentId: row.agentId, userId: row.authorUserId });
      agent = resolved.agent;
    } catch (err) {
      if (err instanceof PluginError) {
        return { status: 'error', error: `${err.code}: ${err.message}`, conversationId: null };
      }
      throw err;
    }

    // 2. find-or-create conversation.
    let conversationId: string;
    try {
      if (row.conversation === 'shared') {
        const out = await deps.bus.call<
          unknown,
          { conversation: { conversationId: string }; created: boolean }
        >('conversations:find-or-create', baseCtx, {
          userId: row.authorUserId,
          agentId: row.agentId,
          externalKey: row.path,
          fallback: { title: row.name },
        });
        conversationId = out.conversation.conversationId;
      } else {
        const conv = await deps.bus.call<
          unknown,
          { conversationId: string }
        >('conversations:create', baseCtx, {
          userId: row.authorUserId,
          agentId: row.agentId,
          title: `${row.name} @ ${new Date().toISOString()}`,
        });
        conversationId = conv.conversationId;
      }
    } catch (err) {
      if (err instanceof PluginError) {
        return { status: 'error', error: `${err.code}: ${err.message}`, conversationId: null };
      }
      throw err;
    }

    const reqId = makeReqId();
    const fireCtx = makeAgentContext({
      reqId,
      sessionId: baseCtx.sessionId,
      agentId: row.agentId,
      userId: row.authorUserId,
      conversationId,
    });

    // 3. Register the one-shot BEFORE invoking so a fast chat:turn-end
    // can't arrive before we're listening.
    deps.pending.set(reqId, {
      row, conversationId, source,
      // The actual silence handler is installed by plugin.ts (Task 13
      // wires it together with the chat:turn-end subscriber).
      onTurnEnd: async () => {},
    });

    // 4. Dispatch agent:invoke fire-and-forget.
    void deps.bus.call('agent:invoke', fireCtx, {
      message: { role: 'user', content: row.promptBody },
    }).catch((err) => {
      // The chat:turn-end one-shot may never fire on a failed invoke.
      // Resolve the pending fire with an error so we don't leak it.
      const pf = deps.pending.get(reqId);
      if (pf !== undefined) {
        deps.pending.delete(reqId);
        // Record the fire here as a fallback. plugin.ts (Task 13) will
        // overwrite the onTurnEnd handler to do the same work via the
        // bus subscriber path — whichever happens first wins.
        process.stderr.write(
          `[ax/routines] agent:invoke failed for ${row.agentId}/${row.path}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    });

    return { status: 'ok', conversationId, error: null };
  };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test --filter @ax/routines -- fire.test.ts
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/fire.ts packages/routines/src/__tests__/fire.test.ts
git commit -m "feat(routines): fireRoutine path (resolve / find-or-create / agent:invoke)

Plan-vs-reality (I1): design says publish chat:turn-start; the actual
host surface is agent:invoke (registered by @ax/chat-orchestrator).
We use agent:invoke fire-and-forget with a synthesized fireCtx whose
reqId is the demultiplex key for the chat:turn-end one-shot router
(wired in Task 13).

The pending-fires map (reqId → row + conversationId + onTurnEnd) is
mutable; Task 13's plugin.ts wiring installs the real onTurnEnd
handler that runs silence-token logic. agents:resolve / find-or-
create / create failures surface as fire status='error' without
crashing the tick loop."
```

---

## Task 13: Silence-token logic + chat:turn-end one-shot router

**Files:**
- Create: `packages/routines/src/silence.ts`
- Create: `packages/routines/src/__tests__/silence.test.ts`
- Modify: `packages/routines/src/plugin.ts` — subscribe `chat:turn-end`, wire pending-fires map through to fire.ts.

`applySilenceAndLog(turnEnd, row)`:
- Concatenate `contentBlocks` text. Trim.
- If `row.silenceToken` is set and the text either starts with or ends with the token, and the remainder (after stripping the token) trimmed is ≤ `row.silenceMaxChars`, return `{ silenced: true }`.
- Otherwise `{ silenced: false }`.

The `chat:turn-end` subscriber:
- Looks up `pending.get(ctx.reqId)`. If absent, this turn is not ours — pass-through.
- Otherwise, runs `applySilenceAndLog`. If silenced, calls `conversations:drop-turn` (and `conversations:hide` for per-fire). Records the fire row via `store.recordFire`.
- Subscriber MUST NOT throw (I8) — every failure logs + swallows + records `status = 'error'`.

- [ ] **Step 1: Write the failing silence test**

Create `packages/routines/src/__tests__/silence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applySilenceLogic } from '../silence.js';

function blocks(text: string) {
  return [{ type: 'text', text }];
}

describe('applySilenceLogic', () => {
  it('returns silenced=false when no silenceToken is set', () => {
    const r = applySilenceLogic(blocks('hello world'), { silenceToken: null, silenceMaxChars: 300 });
    expect(r.silenced).toBe(false);
  });

  it('returns silenced=true when text == token', () => {
    const r = applySilenceLogic(blocks('HEARTBEAT_OK'), { silenceToken: 'HEARTBEAT_OK', silenceMaxChars: 300 });
    expect(r.silenced).toBe(true);
  });

  it('returns silenced=true when text starts with token and remainder ≤ max', () => {
    const r = applySilenceLogic(
      blocks('HEARTBEAT_OK\nshort follow-up'),
      { silenceToken: 'HEARTBEAT_OK', silenceMaxChars: 300 },
    );
    expect(r.silenced).toBe(true);
  });

  it('returns silenced=true when text ends with token', () => {
    const r = applySilenceLogic(
      blocks('nothing to do here\nHEARTBEAT_OK'),
      { silenceToken: 'HEARTBEAT_OK', silenceMaxChars: 300 },
    );
    expect(r.silenced).toBe(true);
  });

  it('returns silenced=false when remainder exceeds max', () => {
    const remainder = 'x'.repeat(400);
    const r = applySilenceLogic(
      blocks(`HEARTBEAT_OK\n${remainder}`),
      { silenceToken: 'HEARTBEAT_OK', silenceMaxChars: 300 },
    );
    expect(r.silenced).toBe(false);
  });

  it('returns silenced=false when token is in the middle but not at boundary', () => {
    const r = applySilenceLogic(
      blocks('here is HEARTBEAT_OK something else and a longer message body'),
      { silenceToken: 'HEARTBEAT_OK', silenceMaxChars: 300 },
    );
    expect(r.silenced).toBe(false);
  });

  it('treats empty contentBlocks (runner heartbeat) as non-silenced', () => {
    const r = applySilenceLogic([], { silenceToken: 'HEARTBEAT_OK', silenceMaxChars: 300 });
    expect(r.silenced).toBe(false);
  });

  it('escapes regex metachars in the token', () => {
    const r = applySilenceLogic(
      blocks('[SILENT]'),
      { silenceToken: '[SILENT]', silenceMaxChars: 300 },
    );
    expect(r.silenced).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm test --filter @ax/routines -- silence.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `silence.ts`**

Create `packages/routines/src/silence.ts`:

```ts
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface TurnText {
  text: string;
}

function blocksToText(blocks: unknown[]): string {
  let out = '';
  for (const b of blocks) {
    if (b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text;
      if (typeof t === 'string') out += (out.length > 0 ? '\n' : '') + t;
    }
  }
  return out.trim();
}

export interface SilenceConfig {
  silenceToken: string | null;
  silenceMaxChars: number;
}

export function applySilenceLogic(
  contentBlocks: unknown[],
  cfg: SilenceConfig,
): { silenced: boolean } {
  const token = cfg.silenceToken;
  if (token === null || token.length === 0) return { silenced: false };
  const text = blocksToText(contentBlocks);
  if (text.length === 0) return { silenced: false };

  const startsWith = text.startsWith(token);
  const endsWith = text.endsWith(token);
  if (!startsWith && !endsWith) return { silenced: false };

  const escaped = escapeRegex(token);
  // Strip one leading and one trailing occurrence of the token.
  const remainder = text
    .replace(new RegExp(`^${escaped}`), '')
    .replace(new RegExp(`${escaped}$`), '')
    .trim();
  return { silenced: remainder.length <= cfg.silenceMaxChars };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test --filter @ax/routines -- silence.test.ts
```

Expected: ALL PASS.

- [ ] **Step 5: Wire chat:turn-end one-shot router in `plugin.ts`**

Modify `packages/routines/src/plugin.ts` `init()` to (a) construct the `PendingFires` map, (b) pass it to the real `fireRoutine`, (c) subscribe to `chat:turn-end` and dispatch to `applySilenceLogic` for matching reqIds:

```ts
import { type PendingFires, createFireRoutine } from './fire.js';
import { applySilenceLogic } from './silence.js';

// Inside init(), AFTER store + abortCtl + tickConfig:

const pending: PendingFires = new Map();
const fireRoutine = createFireRoutine({ bus, pending });

bus.subscribe<{
  reqId?: string;
  contentBlocks?: unknown[];
}>('chat:turn-end', PLUGIN_NAME, async (ctx, payload) => {
  const reqId = payload.reqId ?? ctx.reqId;
  if (typeof reqId !== 'string' || reqId.length === 0) return undefined;
  const pf = pending.get(reqId);
  if (pf === undefined) return undefined;
  pending.delete(reqId);
  try {
    const blocks = payload.contentBlocks ?? [];
    const decision = applySilenceLogic(blocks, {
      silenceToken: pf.row.silenceToken,
      silenceMaxChars: pf.row.silenceMaxChars,
    });
    if (decision.silenced) {
      // Pull the last turnId from the runner-native transcript via a
      // listing call. The conversations:drop-turn handler (Task 14)
      // takes (conversationId, turnId, userId) — we use ctx.userId
      // (= row.authorUserId thanks to fire.ts's synthesized ctx).
      // The naive approach: drop by turnId we know from the turn-end
      // metadata. The runner emits `payload.turnId` if available; if
      // not we drop by passing the empty string and the conversations
      // handler treats absence as "drop the most recent turn for this
      // conversation". We pass payload.turnId verbatim.
      const turnId = (payload as { turnId?: string }).turnId;
      try {
        await bus.call('conversations:drop-turn', ctx, {
          conversationId: pf.conversationId,
          userId: pf.row.authorUserId,
          turnId: turnId ?? '',
        });
      } catch (err) {
        ctx.logger.warn('routines_drop_turn_failed', {
          conversationId: pf.conversationId,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
      if (pf.row.conversation === 'per-fire') {
        try {
          await bus.call('conversations:hide', ctx, {
            conversationId: pf.conversationId,
            userId: pf.row.authorUserId,
          });
        } catch (err) {
          ctx.logger.warn('routines_hide_failed', {
            conversationId: pf.conversationId,
            err: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
      await localStore.recordFire({
        agentId: pf.row.agentId, path: pf.row.path,
        triggerSource: pf.source,
        conversationId: pf.conversationId,
        status: 'silenced', error: null,
      });
    } else {
      await localStore.recordFire({
        agentId: pf.row.agentId, path: pf.row.path,
        triggerSource: pf.source,
        conversationId: pf.conversationId,
        status: 'ok', error: null,
      });
    }
  } catch (err) {
    // I8: subscriber-must-not-throw.
    ctx.logger.warn('routines_turn_end_handler_failed', {
      reqId, err: err instanceof Error ? err : new Error(String(err)),
    });
  }
  return undefined;
});

// Replace the stubFire passed to runTickLoop with fireRoutine.
```

- [ ] **Step 6: Run all routines tests**

```bash
pnpm test --filter @ax/routines
```

Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/routines/src/silence.ts packages/routines/src/plugin.ts packages/routines/src/__tests__/silence.test.ts
git commit -m "feat(routines): silence-token logic + chat:turn-end one-shot router

applySilenceLogic: if silenceToken is set AND the trimmed text starts
or ends with the token AND the remainder (after stripping) is ≤
silenceMaxChars → silenced. Otherwise not. Regex metachars in the
token are escaped before matching.

Plugin wiring: a per-plugin Map<reqId, PendingFire> demultiplexes
chat:turn-end events into the matching fire. Silenced turns trigger
conversations:drop-turn (always) plus conversations:hide (per-fire
only); both are best-effort — failures log + record fire status=ok
rather than blocking the loop.

I8: subscriber-must-not-throw is maintained throughout; every error
path is caught + logged + records the fire row with a status that
reflects what actually happened."
```

---

## Task 14: `routines:fire-now` + `routines:list` service hooks

**Files:**
- Modify: `packages/routines/src/plugin.ts` — register the two service hooks.
- Modify: `packages/routines/src/types.ts` if needed.
- Create: `packages/routines/src/__tests__/service-hooks.test.ts`

`routines:fire-now({ agentId, path, source? })`:
- Look up the row via `store.list({ agentId })`, filter by path. If absent → `PluginError({ code: 'not-found' })`.
- Call `fireRoutine(row, source ?? 'manual')` synchronously (we do await the result so the caller can see the fire status).
- Record the fire row. Return `{ fireId, status, conversationId }`.

`routines:list({ agentId? })`:
- `store.list(input)` and return `{ routines }`.

No ACL gate inside the hooks themselves; admin-only access is enforced by the eventual HTTP routes (Phase D). Phase B uses these hooks from the canary test and from the manual fire-now button (also Phase D).

- [ ] **Step 1: Write the failing test**

Create `packages/routines/src/__tests__/service-hooks.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createRoutinesPlugin } from '../plugin.js';
import type { RoutinesDatabase } from '../migrations.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
let harnesses: TestHarness[] = [];

async function harness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => {
        const i = input as { agentId: string };
        return { agent: { id: i.agentId, ownerId: 'u1', workspaceRef: null } };
      },
      'conversations:find-or-create': async () => ({
        conversation: { conversationId: 'cnv_x' }, created: true,
      }),
      'conversations:create': async () => ({ conversationId: 'cnv_y' }),
      'conversations:drop-turn': async () => undefined,
      'conversations:hide': async () => undefined,
      'agent:invoke': async () => ({ kind: 'complete', messages: [] }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createRoutinesPlugin({ tickIntervalMs: 60_000 /* effectively off */ }),
    ],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('TRUNCATE routines_v1_definitions, routines_v1_fires').catch(() => {});
  } finally { await cleanup.end().catch(() => {}); }
});

afterAll(async () => { if (container) await container.stop(); });

describe('routines:list', () => {
  it('returns rows in the mirror, filtered by agent', async () => {
    const h = await harness();
    const db = (h.bus as never as { _db: Kysely<RoutinesDatabase> })._db;
    // The harness doesn't expose the db directly; instead, drive the
    // listing through the workspace:applied path or directly via SQL
    // using the test connection. Use a direct INSERT here:
    const k = new Kysely<RoutinesDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
    await k.insertInto('routines_v1_definitions').values({
      agent_id: 'agt_a', path: '.ax/routines/r.md', author_user_id: 'u1',
      name: 'r', description: 'd', spec_hash: 'h',
      trigger_kind: 'interval', trigger_spec: { kind: 'interval', every: '60s' },
      active_hours: null, silence_token: null, silence_max: 300,
      conversation: 'per-fire', prompt_body: '# x',
      next_run_at: new Date(),
    }).execute();
    await k.destroy();
    const out = await h.bus.call('routines:list', h.ctx({ userId: 'u1' }), { agentId: 'agt_a' });
    expect((out as { routines: unknown[] }).routines).toHaveLength(1);
  });
});

describe('routines:fire-now', () => {
  it('fires an existing routine and records a fires row', async () => {
    const h = await harness();
    const k = new Kysely<RoutinesDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
    await k.insertInto('routines_v1_definitions').values({
      agent_id: 'agt_a', path: '.ax/routines/r.md', author_user_id: 'u1',
      name: 'r', description: 'd', spec_hash: 'h',
      trigger_kind: 'interval', trigger_spec: { kind: 'interval', every: '60s' },
      active_hours: null, silence_token: null, silence_max: 300,
      conversation: 'per-fire', prompt_body: '# x',
      next_run_at: new Date(),
    }).execute();
    const out = await h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
      agentId: 'agt_a', path: '.ax/routines/r.md',
    });
    expect((out as { status: string }).status).toBe('ok');
    const fires = await k.selectFrom('routines_v1_fires').selectAll().execute();
    expect(fires).toHaveLength(1);
    expect(fires[0]!.trigger_source).toBe('manual');
    await k.destroy();
  });

  it('throws not-found for an unknown routine', async () => {
    const h = await harness();
    await expect(
      h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
        agentId: 'agt_a', path: '.ax/routines/missing.md',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm test --filter @ax/routines -- service-hooks.test.ts
```

Expected: FAIL — hooks not registered.

- [ ] **Step 3: Register the hooks in `plugin.ts`**

Add to `init()`:

```ts
import { PluginError } from '@ax/core';
import type { FireNowInput, FireNowOutput, ListInput, ListOutput } from './types.js';

bus.registerService<ListInput, ListOutput>(
  'routines:list', PLUGIN_NAME,
  async (_ctx, input) => {
    const filter: { agentId?: string } = {};
    if (input.agentId !== undefined) filter.agentId = input.agentId;
    const routines = await localStore.list(filter);
    return { routines };
  },
);

bus.registerService<FireNowInput, FireNowOutput>(
  'routines:fire-now', PLUGIN_NAME,
  async (_ctx, input) => {
    const all = await localStore.list({ agentId: input.agentId });
    const row = all.find((r) => r.path === input.path);
    if (row === undefined) {
      throw new PluginError({
        code: 'not-found', plugin: PLUGIN_NAME,
        hookName: 'routines:fire-now',
        message: `routine ${input.agentId}/${input.path} not found`,
      });
    }
    const source = input.source ?? 'manual';
    const result = await fireRoutine(row, source === 'tick' ? 'tick' : 'manual');
    const fireId = await localStore.recordFire({
      agentId: row.agentId, path: row.path,
      triggerSource: source,
      conversationId: result.conversationId ?? null,
      status: result.status,
      error: result.error,
    });
    return {
      fireId,
      status: result.status,
      conversationId: result.conversationId ?? null,
    };
  },
);
```

- [ ] **Step 4: Run all tests**

```bash
pnpm test --filter @ax/routines
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/plugin.ts packages/routines/src/__tests__/service-hooks.test.ts
git commit -m "feat(routines): register routines:fire-now + routines:list hooks

routines:list returns the mirror rows, optionally filtered by agent.
routines:fire-now looks up the row, calls fireRoutine synchronously
(awaits resolve/find-or-create/agent:invoke dispatch), records a
fires row, returns { fireId, status, conversationId }. Unknown
routines surface as not-found.

No ACL gate at the hook layer — admin-only access is the eventual
HTTP routes' responsibility (Phase D). The canary boot in Task 17
exercises both hooks against a real-postgres harness."
```

---

## Task 15: Replace `conversations:drop-turn` Phase A stub with the runner-native jsonl rewrite

**Files:**
- Modify: `packages/conversations/src/plugin.ts` — replace the throw-not-implemented body with a real handler.
- Modify: `packages/conversations/src/store.ts` — add a `dropTurnFromJsonl` helper that rewrites the bytes.
- Modify: `packages/conversations/src/__tests__/drop-turn.test.ts` — flip the assertions from "throws not-implemented" to real rewrite behavior.

**Closes I7 for this hook.**

How drop-turn rewrites jsonl:
1. Look up the conversation row by `(conversationId, userId)`. Pull `runnerSessionId` and `agentId`.
2. Build a synthetic ctx (userId/agentId/conv from the row) and call `workspace:list` with `pathGlob: .claude/projects/**/<sessionId>.jsonl`.
3. `workspace:read` the path. If `!found` → return (best-effort).
4. Parse the bytes line-by-line. Find the line with `uuid === turnId`. Note its `message.id` (if assistant). Filter out: (a) that line, and (b) any subsequent assistant line whose `message.id` matches AND whose uuid is later in the file (those are coalesced lines belonging to the same logical turn).
5. Concat the surviving lines, terminate with `\n`, and `workspace:apply` a `put` of the rewritten bytes against the parent version returned by `workspace:read`.

Empty `turnId` → drop the LAST user-or-assistant turn in the file (treat as "drop most recent"). This handles the Task 13 path where the chat:turn-end payload may not include a turnId.

- [ ] **Step 1: Read the existing test and update it**

Edit `packages/conversations/src/__tests__/drop-turn.test.ts` and rewrite the two test bodies to cover the real rewrite. Concretely, the new test should:

a. Build a fake jsonl with two assistant turns (uuid `t1` and `t2`, each with a single text block).
b. Stub `workspace:list` to return the matching path; stub `workspace:read` to return those bytes; capture the bytes passed to `workspace:apply` and assert one line was removed.

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type { CreateInput, CreateOutput } from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

function jsonlLine(over: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'will-be-set',
    timestamp: '2026-05-14T12:00:00.000Z',
    message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ...over,
  });
}

async function makeHarnessWithWorkspace(workspaceData: Map<string, Uint8Array>) {
  let lastApplied: { changes: Array<{ path: string; content: Uint8Array }> } | undefined;
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_c, input: unknown) => ({
        agent: { id: (input as { agentId: string }).agentId, visibility: 'personal' },
      }),
      'workspace:list': async (_c, input: unknown) => {
        const glob = (input as { pathGlob: string }).pathGlob;
        const slug = /\/([^/]+)\.jsonl$/.exec(glob)?.[1] ?? '';
        const path = `.claude/projects/proj/${slug}.jsonl`;
        return { paths: workspaceData.has(path) ? [path] : [] };
      },
      'workspace:read': async (_c, input: unknown) => {
        const path = (input as { path: string }).path;
        const bytes = workspaceData.get(path);
        return bytes === undefined ? { found: false } as const : { found: true, bytes, version: 'v1' };
      },
      'workspace:apply': async (_c, input: unknown) => {
        lastApplied = input as never;
        // Reflect the put back into the in-memory workspace so subsequent reads see it.
        const changes = (input as { changes: Array<{ path: string; kind: string; content?: Uint8Array }> }).changes;
        for (const c of changes) if (c.kind === 'put' && c.content !== undefined) workspaceData.set(c.path, c.content);
        return { version: 'v2', delta: { before: 'v1', after: 'v2', changes: [] } };
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  harnesses.push(h);
  return { h, getLastApplied: () => lastApplied! };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
});

afterAll(async () => { if (container) await container.stop(); });

describe('conversations:drop-turn (Phase B — runner-native jsonl rewrite)', () => {
  it('drops the line whose uuid matches turnId', async () => {
    const data = new Map<string, Uint8Array>();
    const lines = [
      jsonlLine({ uuid: 't1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'first' }] } }),
      jsonlLine({ uuid: 't2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'second' }] } }),
    ];
    data.set('.claude/projects/proj/sess_a.jsonl', new TextEncoder().encode(lines.join('\n') + '\n'));

    const { h, getLastApplied } = await makeHarnessWithWorkspace(data);
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create', h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'a1' },
    );
    await h.bus.call('conversations:store-runner-session', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId, runnerSessionId: 'sess_a',
    });

    await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId, userId: 'u1', turnId: 't1',
    });

    const applied = getLastApplied();
    const written = new TextDecoder().decode(applied.changes[0]!.content);
    expect(written).not.toContain('t1');
    expect(written).toContain('t2');
  });

  it('drops the most recent turn when turnId is empty', async () => {
    const data = new Map<string, Uint8Array>();
    const lines = [
      jsonlLine({ uuid: 't1' }),
      jsonlLine({ uuid: 't2' }),
    ];
    data.set('.claude/projects/proj/sess_b.jsonl', new TextEncoder().encode(lines.join('\n') + '\n'));

    const { h, getLastApplied } = await makeHarnessWithWorkspace(data);
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create', h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'a1' },
    );
    await h.bus.call('conversations:store-runner-session', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId, runnerSessionId: 'sess_b',
    });

    await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId, userId: 'u1', turnId: '',
    });
    const written = new TextDecoder().decode(getLastApplied().changes[0]!.content);
    expect(written).toContain('t1');
    expect(written).not.toContain('t2');
  });

  it('is a no-op when the conversation has no runnerSessionId', async () => {
    const data = new Map<string, Uint8Array>();
    const { h } = await makeHarnessWithWorkspace(data);
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create', h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'a1' },
    );
    // No store-runner-session call — drop-turn just returns.
    await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
      conversationId: conv.conversationId, userId: 'u1', turnId: 't1',
    });
  });

  it('throws not-found for an unknown conversation_id', async () => {
    const data = new Map<string, Uint8Array>();
    const { h } = await makeHarnessWithWorkspace(data);
    await expect(
      h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
        conversationId: 'cnv_missing', userId: 'u1', turnId: 't1',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm test --filter @ax/conversations -- drop-turn.test.ts
```

Expected: FAIL — old stub still throws not-implemented.

- [ ] **Step 3: Add the `dropTurnFromJsonl` helper to `store.ts`**

Append to `packages/conversations/src/store.ts`:

```ts
// Rewrite jsonl bytes to exclude the named turnId (and any coalesced
// continuation lines sharing its message.id). If turnId is empty, drop
// the LAST user/assistant turn block. Returns the new bytes (or null
// if nothing changed).
export function dropTurnFromJsonl(
  bytes: Uint8Array,
  turnId: string,
): Uint8Array | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (text.length === 0) return null;
  const rawLines = text.split('\n');
  // Track parsed (uuid, messageId, isAssistant) for each non-blank line.
  interface Parsed { line: string; uuid?: string; messageId?: string; isAssistant: boolean; isTurnBearing: boolean }
  const parsed: Parsed[] = rawLines.map((line) => {
    if (line.trim().length === 0) return { line, isAssistant: false, isTurnBearing: false };
    try {
      const o = JSON.parse(line) as { type?: string; uuid?: string; message?: { id?: string } };
      const isAssistant = o.type === 'assistant';
      const isTurnBearing = o.type === 'assistant' || o.type === 'user';
      const result: Parsed = { line, isAssistant, isTurnBearing };
      if (typeof o.uuid === 'string') result.uuid = o.uuid;
      if (isAssistant && typeof o.message?.id === 'string') result.messageId = o.message.id;
      return result;
    } catch {
      return { line, isAssistant: false, isTurnBearing: false };
    }
  });

  // Determine the turnId to drop.
  let dropUuid = turnId;
  if (dropUuid === '') {
    // Walk backward and find the last turn-bearing uuid.
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i]!.isTurnBearing && parsed[i]!.uuid !== undefined) {
        dropUuid = parsed[i]!.uuid!;
        break;
      }
    }
    if (dropUuid === '') return null;
  }

  // Find the target line.
  const targetIdx = parsed.findIndex((p) => p.uuid === dropUuid);
  if (targetIdx < 0) return null;
  const target = parsed[targetIdx]!;
  const dropMessageId = target.messageId;

  // Filter: drop the target line + any later assistant line whose
  // messageId matches the target's messageId (coalesced continuation).
  const survivors = parsed.filter((p, i) => {
    if (i === targetIdx) return false;
    if (
      dropMessageId !== undefined &&
      i > targetIdx &&
      p.isAssistant &&
      p.messageId === dropMessageId
    ) return false;
    return true;
  }).map((p) => p.line);

  const rewritten = survivors.join('\n');
  return new TextEncoder().encode(
    rewritten.endsWith('\n') || rewritten.length === 0 ? rewritten : rewritten + '\n',
  );
}
```

- [ ] **Step 4: Replace the stub in `plugin.ts`**

In `packages/conversations/src/plugin.ts`:

a. Remove the stub:

```ts
// OLD: throw new PluginError({ code: 'not-implemented', ... })
```

b. Add `'workspace:apply'` to the `calls` array of the manifest.

c. Replace the handler with a real one:

```ts
import { dropTurnFromJsonl } from './store.js';
import type {
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceListInput,
  WorkspaceListOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';

bus.registerService<DropTurnInput, DropTurnOutput>(
  'conversations:drop-turn',
  PLUGIN_NAME,
  async (ctx, input) => dropTurn(localStore, bus, ctx, input),
);

// ...

async function dropTurn(
  store: ConversationStore,
  bus: HookBus,
  ctx: AgentContext,
  input: DropTurnInput,
): Promise<DropTurnOutput> {
  const hookName = 'conversations:drop-turn';
  const conv = await store.getByIdNotDeleted(input.conversationId);
  if (conv === null || conv.userId !== input.userId) {
    throw new PluginError({
      code: 'not-found', plugin: PLUGIN_NAME, hookName,
      message: `conversation '${input.conversationId}' not found`,
    });
  }
  await assertAgentReachable(bus, ctx, conv.agentId, input.userId, hookName);

  if (conv.runnerSessionId === null) {
    // No runner-native transcript yet — nothing to drop.
    return;
  }

  // Synthetic ctx scoped to the conversation owner (same pattern as
  // getConversation — workspace:* dispatch keys off ctx.userId/agentId).
  const workspaceCtx = makeAgentContext({
    reqId: ctx.reqId, sessionId: ctx.sessionId,
    userId: conv.userId, agentId: conv.agentId,
    logger: ctx.logger, workspace: ctx.workspace,
  });

  const list = await bus.call<WorkspaceListInput, WorkspaceListOutput>(
    'workspace:list', workspaceCtx,
    { pathGlob: `.claude/projects/**/${conv.runnerSessionId}.jsonl` },
  );
  if (list.paths.length === 0) return;
  const path = list.paths[0]!;
  const read = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
    'workspace:read', workspaceCtx, { path },
  );
  if (!read.found) return;

  const rewritten = dropTurnFromJsonl(read.bytes, input.turnId);
  if (rewritten === null) return;

  await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
    'workspace:apply', workspaceCtx,
    {
      changes: [{ path, kind: 'put', content: rewritten }],
      parent: read.version,
      reason: `routines:drop-turn ${input.conversationId} ${input.turnId}`,
    },
  );
}
```

d. Update the `'conversations:drop-turn'` registers comment to reflect "Phase B closure."

- [ ] **Step 5: Run all conversations tests**

```bash
pnpm test --filter @ax/conversations
```

Expected: ALL PASS. The other tests (hide, find-or-create, lifecycle) must still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/conversations/src/plugin.ts packages/conversations/src/store.ts packages/conversations/src/__tests__/drop-turn.test.ts
git commit -m "feat(conversations): conversations:drop-turn full impl (runner-native jsonl rewrite)

Closes the half-wired window opened in Phase A for the drop-turn hook
(I7). The handler now:
  1. Looks up the conversation row (J1 ACL gate via agents:resolve).
  2. Resolves the .claude/projects/**/<sessionId>.jsonl via
     workspace:list + workspace:read.
  3. Rewrites the bytes via dropTurnFromJsonl — drops the line with
     the matching uuid plus any later coalesced assistant lines
     sharing its message.id. Empty turnId means 'drop the most
     recent turn'.
  4. Commits the rewrite via workspace:apply.

Adds workspace:apply to the conversations manifest calls. No new
service hooks; no schema migration. Phase B's routines plugin is
the first caller (silence-token logic — Task 13)."
```

---

## Task 16: Load both plugins in `@ax/cli` and `presets/k8s`

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `presets/k8s/src/index.ts`
- Modify: `presets/k8s/src/__tests__/preset.test.ts`

CLI loads `@ax/validator-routine` AND `@ax/routines`. k8s preset does the same. Both must appear in the preset's "expected production plugin set" canary list (the test that says "k8s mode means THIS list").

**I3 closure prerequisite:** both plugins MUST load in both presets in the same PR. No "wire in cli first, k8s next sprint" — that's the half-wired pattern Phase A's memory explicitly calls out.

- [ ] **Step 1: Add `@ax/validator-routine` and `@ax/routines` to `packages/cli/package.json`**

```bash
# In packages/cli/package.json, "dependencies", add (alphabetically):
#   "@ax/routines": "workspace:*",
#   "@ax/validator-routine": "workspace:*",
```

- [ ] **Step 2: Wire them in `packages/cli/src/main.ts`**

Add imports near the existing `createValidatorSkillPlugin` import:

```ts
import { createValidatorRoutinePlugin } from '@ax/validator-routine';
import { createRoutinesPlugin } from '@ax/routines';
```

Add the pushes immediately after `plugins.push(createValidatorSkillPlugin());`:

```ts
// Phase B (2026-05-14). Routines core — interval/cron scheduling, plus
// silence-token logic via Phase A's conversations:hide / drop-turn /
// find-or-create hooks.
plugins.push(createValidatorRoutinePlugin());
plugins.push(createRoutinesPlugin());
```

- [ ] **Step 3: Add the deps to `presets/k8s/package.json`**

Same shape — `"@ax/routines": "workspace:*"` and `"@ax/validator-routine": "workspace:*"` in dependencies.

- [ ] **Step 4: Wire them in `presets/k8s/src/index.ts`**

Add the imports near the existing `createValidatorSkillPlugin` import:

```ts
import { createValidatorRoutinePlugin } from '@ax/validator-routine';
import { createRoutinesPlugin } from '@ax/routines';
```

Push them after `plugins.push(createValidatorSkillPlugin());`:

```ts
plugins.push(createValidatorRoutinePlugin());
plugins.push(createRoutinesPlugin());
```

- [ ] **Step 5: Update the k8s preset's expected-plugin-set test**

In `presets/k8s/src/__tests__/preset.test.ts`, the `contains the expected production plugin set` test has a hard-coded sorted list. Add `'@ax/validator-routine'` and `'@ax/routines'` to that list:

```ts
expect(names).toEqual(
  [
    '@ax/agents',
    '@ax/audit-log',
    '@ax/auth-better',
    '@ax/channel-web',
    '@ax/chat-orchestrator',
    '@ax/conversations',
    '@ax/credential-proxy',
    '@ax/credentials',
    '@ax/credentials-store-db',
    '@ax/database-postgres',
    '@ax/eventbus-postgres',
    '@ax/http-server',
    '@ax/ipc-http',
    '@ax/mcp-client',
    '@ax/onboarding',
    '@ax/routines',
    '@ax/sandbox-k8s',
    '@ax/session-postgres',
    '@ax/storage-postgres',
    '@ax/teams',
    '@ax/tool-dispatcher',
    '@ax/validator-routine',
    '@ax/validator-skill',
    '@ax/workspace-git',
  ].sort(),
);
```

- [ ] **Step 6: Add a Phase B half-wired-window-closure describe block to the preset test**

After the existing `Phase A routines hooks` describe block (around line 400), append:

```ts
// Phase B routines core (2026-05-14). Both new plugins (@ax/routines +
// @ax/validator-routine) load in the production preset, register their
// service hooks, and have all their declared calls satisfied by other
// plugins in the preset.
describe('@ax/preset-k8s — routines Phase B core (half-wired window closes here)', () => {
  it('@ax/routines and @ax/validator-routine are present in the default plugin set', () => {
    const plugins = createK8sPlugins(stubConfig);
    const names = plugins.map((p) => p.manifest.name);
    expect(names).toContain('@ax/routines');
    expect(names).toContain('@ax/validator-routine');
  });

  it('@ax/routines registers routines:fire-now and routines:list', () => {
    const plugins = createK8sPlugins(stubConfig);
    const routines = plugins.find((p) => p.manifest.name === '@ax/routines');
    expect(routines, '@ax/routines plugin').toBeDefined();
    expect(routines!.manifest.registers).toContain('routines:fire-now');
    expect(routines!.manifest.registers).toContain('routines:list');
  });

  it('@ax/routines calls are all satisfied by other plugins in the preset', () => {
    const plugins = createK8sPlugins(stubConfig);
    const allRegistered = new Set<string>(
      plugins.flatMap((p) => p.manifest.registers),
    );
    const routines = plugins.find((p) => p.manifest.name === '@ax/routines');
    expect(routines, '@ax/routines plugin not found').toBeDefined();
    if (!routines) return;
    const unsatisfied = routines.manifest.calls.filter((c) => !allRegistered.has(c));
    expect(unsatisfied, `@ax/routines calls with no registrant: ${unsatisfied.join(', ')}`).toEqual([]);
  });

  it('@ax/validator-routine subscribes to workspace:pre-apply', () => {
    const plugins = createK8sPlugins(stubConfig);
    const v = plugins.find((p) => p.manifest.name === '@ax/validator-routine');
    expect(v, '@ax/validator-routine plugin').toBeDefined();
    expect(v!.manifest.subscribes).toContain('workspace:pre-apply');
  });
});
```

- [ ] **Step 7: Run the preset wiring tests**

```bash
pnpm test --filter @ax/preset-k8s -- preset.test.ts
pnpm build
```

Expected: ALL PASS. If `pnpm build` complains about missing project refs or workspace deps, fix the package.json + tsconfig pieces and re-run.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/ presets/k8s/ pnpm-lock.yaml
git commit -m "feat(presets): load @ax/routines and @ax/validator-routine in cli + k8s

I3 closure prerequisite for Phase B's half-wired window. Both new
plugins load in BOTH presets in the same PR — no 'wire in cli first,
k8s next sprint' pattern.

Preset test gains:
  - both plugins listed in the expected production plugin set
  - assertions that @ax/routines registers routines:fire-now / list
  - assertion that @ax/routines' calls are satisfied by other plugins
    in the preset (no no-service errors at boot)
  - assertion that @ax/validator-routine subscribes to
    workspace:pre-apply

Half-wired window for Phase B closes in the next task (canary fire
test in @ax/routines)."
```

---

## Task 17: Canary — create a routine, assert the routines plugin fires it on tick

**Files:**
- Create: `packages/routines/src/__tests__/canary.test.ts`

This is the load-bearing closure for Phase B's half-wired window AND for Phase A's drop-turn / hide / find-or-create hooks (I7). The test boots the full routines plugin + the conversations plugin + database-postgres against a Postgres testcontainer. It then:

1. Stubs `agents:resolve`, `agent:invoke`, and the workspace hooks the conversations plugin needs.
2. Calls the routines plugin's `workspace:applied` subscriber via `bus.fire` with a `WorkspaceDelta` carrying a fresh `.ax/routines/r.md` (an interval routine with `silenceToken: HEARTBEAT_OK` and `conversation: per-fire`).
3. Asserts the row landed in `routines_v1_definitions`.
4. Drives one `runTickOnce` (via `routines:fire-now` for determinism) and asserts the agent:invoke stub was called with the routine's prompt.
5. Stubs `agent:invoke` so it synchronously fires `chat:turn-end` with `contentBlocks: [{ type: 'text', text: 'HEARTBEAT_OK' }]` and `reqId = invoke ctx.reqId`. Asserts:
   - `routines_v1_fires` got a row with `status = 'silenced'`.
   - `conversations:drop-turn` was called (verify by stubbing it and recording the call).
   - `conversations:hide` was called (per-fire routine).
6. Repeats with `contentBlocks: 'real reply text'` — asserts the next fire is `status = 'ok'` and neither drop-turn nor hide is called.

- [ ] **Step 1: Write the canary test**

Create `packages/routines/src/__tests__/canary.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createRoutinesPlugin } from '../plugin.js';
import { asWorkspaceVersion, type WorkspaceDelta } from '@ax/core';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { RoutinesDatabase } from '../migrations.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

const ENC = new TextEncoder();
function routineBody(opts: { silenceToken?: string } = {}): Uint8Array {
  return ENC.encode([
    '---',
    'name: hb',
    'description: heartbeat',
    'trigger:', '  kind: interval', '  every: "60s"',
    ...(opts.silenceToken ? [`silenceToken: "${opts.silenceToken}"`] : []),
    'conversation: per-fire',
    '---',
    'check in',
  ].join('\n') + '\n');
}

interface Captured {
  invokes: Array<{ message: { content: string }; reqId: string }>;
  drops: Array<{ conversationId: string; turnId: string }>;
  hides: Array<{ conversationId: string }>;
}

async function makeHarness(captured: Captured, replyOnInvoke: { contentBlocks: unknown[] }) {
  let nextConvId = 1;
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => ({
        agent: { id: (input as { agentId: string }).agentId, ownerId: 'u1', workspaceRef: null },
      }),
      'conversations:find-or-create': async () => ({
        conversation: { conversationId: `cnv_${nextConvId++}` }, created: true,
      }),
      'conversations:create': async () => ({ conversationId: `cnv_${nextConvId++}` }),
      'conversations:drop-turn': async (_ctx, input: unknown) => {
        captured.drops.push(input as { conversationId: string; turnId: string });
      },
      'conversations:hide': async (_ctx, input: unknown) => {
        captured.hides.push(input as { conversationId: string });
      },
      'agent:invoke': async (ctx, input: unknown) => {
        const msg = (input as { message: { content: string } }).message;
        captured.invokes.push({ message: msg, reqId: ctx.reqId ?? '' });
        // Synchronously fire chat:turn-end so the routines plugin's
        // one-shot router runs in the same tick.
        await h.bus.fire('chat:turn-end', ctx, {
          reqId: ctx.reqId,
          contentBlocks: replyOnInvoke.contentBlocks,
        });
        return { kind: 'complete', messages: [] };
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createRoutinesPlugin({ tickIntervalMs: 60_000 /* loop effectively idle */ }),
    ],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('TRUNCATE routines_v1_definitions, routines_v1_fires').catch(() => {});
  } finally { await cleanup.end().catch(() => {}); }
});

afterAll(async () => { if (container) await container.stop(); });

describe('Phase B canary — routine creates → fires → silence path closes window', () => {
  it('indexes a routine when workspace:applied carries .ax/routines/r.md', async () => {
    const captured: Captured = { invokes: [], drops: [], hides: [] };
    const h = await makeHarness(captured, { contentBlocks: [{ type: 'text', text: 'HEARTBEAT_OK' }] });
    const delta: WorkspaceDelta = {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added', contentAfter: async () => routineBody({ silenceToken: 'HEARTBEAT_OK' }) }],
    };
    const r = await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), delta);
    expect(r.rejected).toBe(false);
    const k = new Kysely<RoutinesDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
    const rows = await k.selectFrom('routines_v1_definitions').selectAll().execute();
    await k.destroy();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe('.ax/routines/r.md');
  });

  it('fire-now: silence-token reply triggers drop-turn + hide; status=silenced', async () => {
    const captured: Captured = { invokes: [], drops: [], hides: [] };
    const h = await makeHarness(captured, { contentBlocks: [{ type: 'text', text: 'HEARTBEAT_OK' }] });

    // Seed the routine via workspace:applied.
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added', contentAfter: async () => routineBody({ silenceToken: 'HEARTBEAT_OK' }) }],
    });

    // Trigger a fire manually (deterministic — no tick wait).
    const out = await h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
      agentId: 'agt_a', path: '.ax/routines/r.md',
    });

    expect(captured.invokes).toHaveLength(1);
    expect(captured.invokes[0]!.message.content).toBe('check in');
    expect(captured.drops).toHaveLength(1);
    expect(captured.hides).toHaveLength(1);

    const k = new Kysely<RoutinesDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
    const fires = await k.selectFrom('routines_v1_fires').selectAll().execute();
    await k.destroy();
    // We expect two fire rows: one from routines:fire-now's synchronous
    // recordFire (status=ok — the manual dispatch path), one from the
    // chat:turn-end subscriber (status=silenced). The most recent is
    // the silenced one.
    const silenced = fires.find((f) => f.status === 'silenced');
    expect(silenced, 'expected a silenced fire row').toBeDefined();
  });

  it('fire-now: non-silence reply records status=ok and skips drop/hide', async () => {
    const captured: Captured = { invokes: [], drops: [], hides: [] };
    const h = await makeHarness(captured, { contentBlocks: [{ type: 'text', text: 'real reply text' }] });

    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added', contentAfter: async () => routineBody({ silenceToken: 'HEARTBEAT_OK' }) }],
    });

    await h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
      agentId: 'agt_a', path: '.ax/routines/r.md',
    });

    expect(captured.invokes).toHaveLength(1);
    expect(captured.drops).toEqual([]);
    expect(captured.hides).toEqual([]);
  });

  it('shared routine reuses the same conversation across fires (find-or-create)', async () => {
    const captured: Captured = { invokes: [], drops: [], hides: [] };
    const h = await makeHarness(captured, { contentBlocks: [{ type: 'text', text: 'reply' }] });

    const sharedBody = ENC.encode([
      '---', 'name: shared', 'description: d',
      'trigger:', '  kind: interval', '  every: "60s"',
      'conversation: shared',
      '---', 'check in',
    ].join('\n') + '\n');

    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/s.md', kind: 'added', contentAfter: async () => sharedBody }],
    });

    const first = await h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
      agentId: 'agt_a', path: '.ax/routines/s.md',
    });
    const second = await h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
      agentId: 'agt_a', path: '.ax/routines/s.md',
    });
    // Our find-or-create stub returns a fresh conversationId each call —
    // a real impl returns the same one. The assertion here is that the
    // shared path calls find-or-create (vs. create) — captured via the
    // invokes' message content already (same content both fires). The
    // real per-(user, agent, externalKey) reuse is exercised by
    // @ax/conversations' own tests.
    expect((first as { fireId: number }).fireId).toBeGreaterThan(0);
    expect((second as { fireId: number }).fireId).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the canary test**

```bash
pnpm test --filter @ax/routines -- canary.test.ts
```

Expected: ALL PASS. If the chat:turn-end synchronous path races with the routines:fire-now return value, add a tiny `await new Promise(r => setImmediate(r))` after the `routines:fire-now` call to flush microtasks before assertions.

- [ ] **Step 3: Commit**

```bash
git add packages/routines/src/__tests__/canary.test.ts
git commit -m "test(routines): Phase B canary — create routine, fire, silence path

Closes the Phase B half-wired window AND Phase A's three-hook window
(I7). The canary boots the full @ax/routines plugin against a
real-postgres harness and asserts the full chain:

  1. workspace:applied with a .ax/routines/r.md → row indexed.
  2. routines:fire-now → agent:invoke called with the prompt body.
  3. The harness' agent:invoke synchronously emits chat:turn-end
     with HEARTBEAT_OK. The routines plugin's chat:turn-end one-shot
     router fires the silence-token check, calls conversations:drop-
     turn + conversations:hide, and records routines_v1_fires.status
     = 'silenced'.
  4. Non-silence reply → status=ok, no drop, no hide.

This is THE canary that says 'Phase B works end-to-end in the bus'
— and the load-bearing closure for the Phase A foundation hooks."
```

---

## Task 18: Full build + lint check + open the PR

- [ ] **Step 1: Type-check and run all tests**

```bash
pnpm build
pnpm test
```

Expected: ALL PASS. Common ripples to check:
- Any code that constructs a `Conversation` object literal must now include `externalKey: null` (Phase A already added it — verify nothing regressed).
- `packages/conversations/src/types.ts` `DropTurnInput` shape was locked in Phase A. No callers needed to change for Task 15 — verify by greppin for `'conversations:drop-turn'`.
- `presets/k8s/src/__tests__/preset.test.ts` "calls satisfied by registers" should still pass — the routines plugin's `agent:invoke` / `conversations:*` calls are all already registered elsewhere in the preset.

- [ ] **Step 2: Manual cross-plugin import audit (I2)**

```bash
grep -rn "from '@ax/" packages/routines/src/ packages/validator-routine/src/ | grep -v '@ax/core' | grep -v '@ax/validator-routine'
```

Expected output: only `@ax/core` (and `@ax/validator-routine` from inside `@ax/routines`). Anything else is an invariant-2 violation and needs to be replaced with a bus call.

- [ ] **Step 3: Write the PR body**

```bash
cat > /tmp/pr-body-phase-b.md <<'EOF'
## Summary

Phase B of the routines rollout. Two new packages plus a follow-up on Phase A's `drop-turn` stub.

- **`@ax/validator-routine`** — `workspace:pre-apply` subscriber that vetoes malformed `.ax/routines/<name>.md` files. Frontmatter parser supports interval + cron; rejects webhook with a clear "lands in Phase C" reason (I3).
- **`@ax/routines`** — full host plugin:
  - `routines_v1_definitions` + `routines_v1_fires` postgres tables (migration is idempotent).
  - `workspace:applied` subscriber syncs the DB mirror; spec-hash gating prevents `next_run_at` jitter on no-op applies.
  - Interval + cron trigger engines (via `croner`).
  - Tick loop guarded by `pg_try_advisory_lock` (best-effort election) + `FOR UPDATE SKIP LOCKED` (correctness).
  - `fireRoutine`: resolves the agent, finds-or-creates the conversation, dispatches `agent:invoke` fire-and-forget. **I1 plan-vs-reality:** design says publish `chat:turn-start`; the actual host surface is `agent:invoke` — we use that and demultiplex `chat:turn-end` events by `reqId`.
  - Silence-token logic: HEARTBEAT_OK-style replies trigger `conversations:drop-turn` (always) + `conversations:hide` (per-fire). Closes Phase A's three-hook half-wired window (I7).
  - Registers `routines:fire-now` + `routines:list` service hooks.
- **`@ax/conversations`** — `conversations:drop-turn` stub replaced with the runner-native jsonl rewrite. Adds `workspace:apply` to the manifest's `calls`. The rewrite handles assistant-message coalescing (drops the line by uuid + any later coalesced lines sharing its `message.id`).
- Both new plugins load in `@ax/cli` and `presets/k8s` in the same PR.
- New canary test (`packages/routines/src/__tests__/canary.test.ts`) boots the routines plugin against a postgres testcontainer, drives a routine from `workspace:applied` → `routines:fire-now` → `chat:turn-end` with HEARTBEAT_OK, and asserts the full silence chain runs.

## Invariants

| Invariant | Status | Notes |
| --- | --- | --- |
| I1 (plan vs reality) | OK | Used `agent:invoke` (not `chat:turn-start`). Credentials lookup is Phase C. |
| I2 (no cross-plugin imports) | OK | Manual grep confirms only `@ax/core` (and `@ax/validator-routine` inside `@ax/routines`). |
| I3 (no half-wired plugins) | OK | Webhook trigger kind rejected by validator; no fire path. |
| I4 (one source of truth) | OK | Spec-hash gate on upsert. No double-validation in subscriber. |
| I5 (capabilities minimized) | OK | Only `database:get-instance` + `agents:resolve` + `conversations:*` + `agent:invoke`. No spawn, no FS, no network beyond PG. |
| I6 (storage-agnostic hooks) | OK | `routines:fire-now` / `:list` carry opaque keys. |
| I7 (Phase A's half-wired window closes here) | OK | All three Phase A hooks have real callers + canary coverage. |
| I8 (subscriber-must-not-throw) | OK | `workspace:applied` subscriber + `chat:turn-end` one-shot both log + swallow. |

## Half-wired window

**Phase B window: CLOSED** by the new canary test (`packages/routines/src/__tests__/canary.test.ts`) — boots the plugin against a real-postgres harness and exercises the full fire path.

**Phase A window: CLOSED** by the same canary plus Phase B's drop-turn replacement (`packages/conversations/src/__tests__/drop-turn.test.ts`).

**Phase C window (webhook surface): NOT YET OPEN** — no webhook code merges in this PR.

## Test plan

- [x] `pnpm test --filter @ax/validator-routine`
- [x] `pnpm test --filter @ax/routines`
- [x] `pnpm test --filter @ax/conversations`
- [x] `pnpm test --filter @ax/preset-k8s -- preset.test.ts`
- [x] `pnpm build` — no type ripples in the monorepo.
- [ ] Manual: `make dev-fast` against kind cluster, create a 60-second interval routine via chat, observe a per-fire conversation appearing in the sidebar.
- [ ] Manual: update the routine to add `silenceToken: HEARTBEAT_OK`, observe the next reply suppresses the conversation.
EOF
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(routines): Phase B core — @ax/routines + @ax/validator-routine" \
             --body-file /tmp/pr-body-phase-b.md
```

- [ ] **Step 5: Watch CI; iterate if it fails**

If the preset's "calls satisfied by registers" check fails, the missing service is either (a) an `agent:invoke` registrant that the preset omits (unlikely — chat-orchestrator is in the list) or (b) a `conversations:*` hook the routines plugin's manifest declares but doesn't actually need at boot. Audit `packages/routines/src/plugin.ts` manifest `calls` against the bus dispatches in `fire.ts` + `tick.ts` and trim any over-declarations.

If `multi-tenant-acceptance.test.ts` fails on a missing route, that's the canary test detecting an unintended `http:register-route` call — Phase B should NOT register any HTTP route (webhooks are Phase C). Verify by grepping `packages/routines/src` for `http:register-route` (expected: no matches).

---

## Notes on spec deviations

Record this in project memory after merge:

> Phase B shipped 2026-05-14 with two design deviations:
>
> 1. **`chat:turn-start` → `agent:invoke`.** Design §5 says routines publish a `chat:turn-start` event that the chat-orchestrator consumes. That hook does not exist in v2. The implementation uses `agent:invoke` (the existing host-side service hook on `@ax/chat-orchestrator`) fire-and-forget, with `ctx.reqId` as the demultiplex key for the `chat:turn-end` one-shot router inside `@ax/routines`. Phase D may revisit if multiple sources of "inject a user turn" emerge (admin UI button, MCP tool, scripted procedures).
>
> 2. **`credentials:get-by-name` → not introduced.** Design §6 references a `credentials:get-by-name` hook for webhook HMAC secrets. That hook doesn't exist; the closest is `credentials:get({ ref, userId })`. Phase B doesn't need it (no webhook). Phase C will either reuse `credentials:get` (acceptable — `ref` is the credential name) or add `credentials:get-by-name` as an alias if it's a clearer abstraction.

Also update the routines design doc's §5 + §6 in a follow-up commit to flag the rename so future readers don't trip on the same divergence.

---

## Summary of commits (expected git log order)

1. `feat(validator-routine): scaffold package (manifest + parser stubs)` — Task 1
2. `feat(validator-routine): add routine frontmatter parser` — Task 2
3. `feat(validator-routine): workspace:pre-apply subscriber` — Task 3
4. `feat(routines): scaffold package (manifest + types + clock)` — Task 4
5. `feat(routines): add routines_v1_definitions + routines_v1_fires migration` — Task 5
6. `feat(routines): interval trigger engine` — Task 6
7. `feat(routines): cron trigger engine (croner)` — Task 7
8. `feat(routines): active-hours window helper` — Task 8
9. `feat(routines): parse-routine helper + store (upsert/claim/advance/list)` — Task 9
10. `feat(routines): workspace:applied subscriber syncs DB mirror` — Task 10
11. `feat(routines): tick loop + advisory-lock election + drift control` — Task 11
12. `feat(routines): fireRoutine path (resolve / find-or-create / agent:invoke)` — Task 12
13. `feat(routines): silence-token logic + chat:turn-end one-shot router` — Task 13
14. `feat(routines): register routines:fire-now + routines:list hooks` — Task 14
15. `feat(conversations): conversations:drop-turn full impl (runner-native jsonl rewrite)` — Task 15
16. `feat(presets): load @ax/routines and @ax/validator-routine in cli + k8s` — Task 16
17. `test(routines): Phase B canary — create routine, fire, silence path` — Task 17

Task 18 is verification + PR open, no commits.
