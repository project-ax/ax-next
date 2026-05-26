# Routines — Design

**Status:** Proposal, ready for review
**Date:** 2026-05-14
**Author:** Vinay (with Claude)
**Related:** openclaw `HEARTBEAT.md` / heartbeat-runner, hermes-agent `cron` + `webhook subscribe`

---

## TL;DR

A new host-side plugin `@ax/routines` fires *routines* — markdown files in
`.ax/routines/<name>.md` that work like skills and identity: file is the
source of truth, the routines plugin maintains an indexed mirror in Postgres. Each
routine declares one trigger (`interval` / `cron` / `webhook`), a prompt
body, and a few options. When a routine fires, the routines plugin opens (or
finds) a conversation owned by the agent and publishes `chat:turn-start`
into the existing chat loop — the runner doesn't know the turn came from
the routines plugin. An optional `silenceToken` (e.g. `HEARTBEAT_OK`,
`[SILENT]`) suppresses the conversation when the agent has nothing to say.

The **heartbeat** is *not* a special concept. It's a regular routine with
`trigger: { kind: interval, every: 30m }` and a prompt body that says
"read `HEARTBEAT.md` if it exists". One mechanism; the heartbeat just
happens to be the most common shape.

Three triggers in v1: `interval`, `cron`, `webhook`. Webhooks mount under
`@ax/http-server` at `POST /webhooks/<token>/<slug>`, gated by an opaque
per-agent token (URL bearer) and optional HMAC. Webhook payloads are
substituted into the prompt via strict-whitelist `{{payload.x.y}}`
templating — no expression evaluation.

The tick loop runs on a host plugin, elected via Postgres advisory lock,
with `FOR UPDATE SKIP LOCKED` as the correctness backstop. Routine index
is kept in sync via the **existing** `workspace:applied` subscriber hook
(fired by `ipc-core/src/handlers/workspace-commit-notify.ts` after every
successful apply) — no new workspace hook is needed.

---

## Section 1 — Packaging

Two new packages. **No new workspace hook** — the existing
`workspace:applied` subscriber hook (fired by `@ax/ipc-core`'s
`workspace-commit-notify` handler) already gives us everything we need.

- **`@ax/routines`** (new, host-side)
  - Owns the tick loop (single-elected per cluster via PG advisory lock /
    `FOR UPDATE SKIP LOCKED`).
  - Owns the `routines_v1_definitions` and `routines_v1_fires` tables.
  - Subscribes to `workspace:applied` to sync routine files → DB rows.
  - Registers `routines:fire-now` (admin/manual trigger) and
    `routines:list` (read-only).
  - On fire: `agents:resolve` → find-or-create conversation → publish
    `chat:turn-start` → one-shot subscribe `chat:turn-end` to apply the
    silence-token logic before the conversation surfaces.
  - Trigger engines (`interval`, `cron`, `webhook`) are internal modules
    behind a single `nextRun(spec, from) → Date | null` interface.
  - Webhook trigger registers a route via `http:register-route` per
    routine.

- **`@ax/validator-routine`** (new, mirrors `@ax/validator-skill`)
  - Subscribes to `workspace:pre-apply`.
  - Parses YAML frontmatter on `.ax/routines/<name>.md`. Vetoes malformed
    frontmatter (missing/invalid trigger, bad cron, bad duration, missing
    prompt).
  - Same capability budget as `validator-skill`: no spawn, no network, no
    file I/O.

**Why this split:**

Validation is a *veto* on pre-apply; indexing must happen *after* the
commit settles. Different hooks (`workspace:pre-apply` vs
`workspace:applied`), different concerns → different plugins. One plugin
doing both would either re-validate twice or carry pre-apply state
through to commit.

**Using `workspace:applied` (existing hook, not new):**

The `workspace:applied` hook is already published by the
commit-notify path with payload `WorkspaceDelta` (see
`packages/core/src/workspace.ts`). It carries `before` / `after`
versions, optional `author`, and `changes: WorkspaceChange[]` with
**lazy** content fetchers (`contentBefore`/`contentAfter`). Lazy is
load-bearing for the routines plugin: we only need bytes for paths matching
`.ax/routines/<name>.md`, so we don't pay decode cost for unrelated
changes.

---

## Section 2 — Routine file format

Path: `.ax/routines/<name>.md`. The filename slug (`<name>`) is the stable
identity within the agent's workspace. Same shape rule as skills: flat
under `.ax/routines/`, no subdirectories.

```markdown
---
name: nightly-bug-triage           # human label; required; matches filename slug
description: One-line purpose      # required; surfaced in admin UI
trigger:                           # required; exactly one kind
  kind: interval                   # interval | cron | webhook
  every: "30m"                     # interval only — duration string

  # cron alternative:
  # kind: cron
  # expr: "0 2 * * *"
  # tz: "America/New_York"         # required for cron; no implicit timezone

  # webhook alternative:
  # kind: webhook
  # path: "/r/github-prs"          # mounted under the agent's webhook prefix
  # events: ["pull_request"]       # optional GitHub-event filter (X-GitHub-Event)
  # hmac:
  #   secretRef: gh-webhook-secret # @ax/credentials credential name
  #   header: "X-Hub-Signature-256"
  #   algorithm: "sha256"          # default sha256; sha1 supported for legacy
  #   prefix: "sha256="            # optional; stripped before compare

activeHours:                       # optional; applies to interval+cron only
  start: "08:00"
  end:   "24:00"
  tz:    "America/New_York"

silenceToken: "HEARTBEAT_OK"       # optional; if reply opens/closes with this
                                   # AND the remainder is ≤ silenceMaxChars,
                                   # suppress the conversation
silenceMaxChars: 300               # optional; default 300

conversation: per-fire             # "per-fire" | "shared"
                                   # per-fire = new conversation each tick
                                   # shared   = always append to one rolling
                                   #            conversation per routine
---

# Prompt body (markdown, sent verbatim as the user message)

Read HEARTBEAT.md if it exists. Follow it strictly. Do not infer or repeat
old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.

For webhook routines, you can interpolate payload fields with
{{payload.path.to.field}}:

> PR #{{payload.pull_request.number}}: "{{payload.pull_request.title}}"
> by @{{payload.pull_request.user.login}}.
```

**Conventions:**

- **Frontmatter is the spec.** Everything the routines plugin needs to schedule,
  fire, and route the routine lives in frontmatter. The body is the prompt.
- **Webhook templating uses `{{payload.x}}`** (Mustache-strict) with a
  tight whitelist: dotted-path lookups only — no expressions, no function
  calls. Missing field → empty string, logged. Whole-payload escape
  hatch: `{{payload}}` inlines the full JSON.
- **Active hours don't apply to webhooks.** A webhook *is* the trigger;
  the user already chose when to fire it by sending the event.
- **Identity is `(workspaceRef, path)`.** Renaming a routine file =
  delete-then-create from the routines plugin's point of view (state resets).
  If the user wants edit-without-reset, they edit frontmatter, not the
  filename.
- **No `agent:` field.** A routine lives in *one* agent's workspace and
  runs as that agent. Cross-agent dispatch is deferred.
- **No `skills:` field.** v2 skills are agent-attached (via the agent's
  `allowedTools`), not per-routine. Pinning this at "agent owns skills"
  keeps invariant #4 (one source of truth) intact.
- **No `model:` field at v1.** The agent's configured model wins.
  Trivially additive later.

**Heartbeat as a regular routine:**

The heartbeat is `.ax/routines/heartbeat.md` with
`trigger: { kind: interval, every: 30m }` and a prompt that references
`HEARTBEAT.md`. No special-case code path. When a workspace has no
heartbeat file, the routines plugin has no rows for that routine and does
nothing. We ship a default `heartbeat.md` in the agent-bootstrap
workspace template (Section 7).

---

## Section 3 — Indexing: `workspace:applied` + DB mirror

### 3.1 Hook surface (existing — `workspace:applied`)

Already defined in `packages/core/src/workspace.ts` and fired by
`packages/ipc-core/src/handlers/workspace-commit-notify.ts:280`. The
routines plugin **subscribes**; it does not register or modify the hook.

```ts
// Defined in @ax/core (existing).
interface WorkspaceDelta {
  before: WorkspaceVersion | null;     // version before this apply
  after:  WorkspaceVersion;            // version after this apply
  reason?: string;
  author?: { agentId?: string; userId?: string; sessionId?: string };
  changes: WorkspaceChange[];          // .ax/-filtered (same as pre-apply)
}

interface WorkspaceChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  contentBefore?: () => Promise<Bytes>;  // lazy
  contentAfter?:  () => Promise<Bytes>;  // lazy
}
```

**Key differences from the pre-apply shape:**

- `kind` is three-valued (`'added'` / `'modified'` / `'deleted'`), not
  two-valued (`'put'` / `'delete'`). The routines subscriber treats
  `'added'` and `'modified'` identically (both trigger an upsert);
  `'deleted'` triggers a delete.
- Content is lazy via `change.contentAfter?.()`. Call it only after the
  path regex matches `.ax/routines/<name>.md`.
- `workspaceRef` is *not* on the payload. The commit-notify handler
  doesn't carry it on `workspace:applied` today. We need it for the
  upsert. Two options:
  - **(Chosen)** Resolve it from `delta.author.agentId` via
    `agents:resolve` and read `agent.workspaceRef`. Cheap, single
    lookup per applied event. The hook stays storage-agnostic; the
    routines plugin handles the lookup.
  - (Alt) Add `workspaceRef` to `WorkspaceDelta`. Cross-cutting change
    touching workspace-commit-notify; defer unless other subscribers
    need it.

### 3.2 DB schema (`@ax/routines`)

```sql
-- One row per .ax/routines/<name>.md per agent.
-- Identity: (agent_id, path). Renames = delete + create.
--
-- Note: keying on agent_id (not workspace_ref) because `workspace:applied`
-- carries `author.agentId` but no workspaceRef. The agent owns its
-- workspace 1:1 in v1; the path is workspace-relative and stable as long
-- as the agent's workspaceRef is stable (which it is — set at agent
-- create, immutable).
CREATE TABLE routines_v1_definitions (
  agent_id        TEXT     NOT NULL,
  path            TEXT     NOT NULL,        -- ".ax/routines/<name>.md"
  -- captured at index time from delta.author.userId — used at fire time
  -- to pass ACL on `agents:resolve(agentId, userId)`.
  author_user_id  TEXT     NOT NULL,
  name            TEXT     NOT NULL,
  description     TEXT     NOT NULL,
  spec_hash       TEXT     NOT NULL,        -- sha256 of frontmatter + body
  trigger_kind    TEXT     NOT NULL,        -- 'interval' | 'cron' | 'webhook'
  trigger_spec    JSONB    NOT NULL,
  active_hours    JSONB,
  silence_token   TEXT,
  silence_max     INTEGER  NOT NULL DEFAULT 300,
  conversation    TEXT     NOT NULL,        -- 'per-fire' | 'shared'
  prompt_body     TEXT     NOT NULL,
  next_run_at     TIMESTAMPTZ,              -- null for webhook routines
  last_run_at     TIMESTAMPTZ,
  last_status     TEXT,                     -- 'ok' | 'silenced' | 'error' | null
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, path)
);

CREATE INDEX routines_v1_due ON routines_v1_definitions (next_run_at)
  WHERE next_run_at IS NOT NULL;

-- Append-only fire log; powers the admin UI and audit.
CREATE TABLE routines_v1_fires (
  id              BIGSERIAL PRIMARY KEY,
  agent_id        TEXT     NOT NULL,
  path            TEXT     NOT NULL,
  fired_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  trigger_source  TEXT     NOT NULL,        -- 'tick' | 'webhook' | 'manual'
  conversation_id TEXT,                     -- null if silenced
  status          TEXT     NOT NULL,        -- 'ok' | 'silenced' | 'error'
  error           TEXT
);

CREATE INDEX routines_v1_fires_by_routine
  ON routines_v1_fires (agent_id, path, fired_at DESC);
```

Retention for `routines_v1_fires`: unbounded at v1. We add a TTL-based
cleanup job if the table grows pathologically; cheap and additive.

### 3.3 Sync logic (the `workspace:applied` subscriber)

```
on workspace:applied(delta):
  agentId = delta.author?.agentId
  userId  = delta.author?.userId
  if agentId is null OR userId is null:
    # Not a runner-driven apply (e.g., admin bulk import) — skip routine
    # indexing. The author block on workspace:apply is always populated
    # from ctx in the runner path; absence here means we don't have
    # enough context to associate the routine with an agent.
    return

  for change in delta.changes:
    if not change.path matches /^\.ax\/routines\/[^/]+\.md$/: continue

    if change.kind === 'deleted':
      DELETE FROM routines_v1_definitions
       WHERE agent_id = ? AND path = ?
      continue

    # 'added' or 'modified' — fetch bytes lazily and parse frontmatter
    # (validator already vetoed bad ones on pre-apply)
    contentBytes = await change.contentAfter?.()
    if contentBytes is null: continue   # defensive — lazy fetcher missing
    spec = parseRoutineFile(contentBytes)

    nextRunAt = trigger.kind === 'webhook' ? null
              : trigger.kind === 'interval' ? now + parseDuration(spec.every)
              : nextCronTick(spec.expr, spec.tz, now)

    UPSERT routines_v1_definitions (agent_id, path, author_user_id, ...) VALUES (...)
    ON CONFLICT (agent_id, path) DO UPDATE SET
      trigger_kind = excluded.trigger_kind,
      trigger_spec = excluded.trigger_spec,
      author_user_id = excluded.author_user_id,
      ...,
      -- only reset next_run_at on spec_hash change to avoid jitter on no-op apply
      next_run_at = CASE
        WHEN routines_v1_definitions.spec_hash IS DISTINCT FROM excluded.spec_hash
        THEN excluded.next_run_at
        ELSE routines_v1_definitions.next_run_at
      END,
      spec_hash = excluded.spec_hash,
      updated_at = now()
```

**Correctness notes:**

- The validator runs first (on `workspace:pre-apply`) and vetoes
  anything that wouldn't parse. The applied subscriber treats
  frontmatter as well-formed. No defensive double-validation
  (invariant #4: one source of truth — the validator).
- No new `agents:*` hook is required for the indexing path —
  `delta.author.agentId` is the authoritative key. `delta.author.userId`
  is captured so the fire path can call `agents:resolve(agentId,
  userId)` and pass ACL without a synthetic system user.
- Spec-hash gating prevents `next_run_at` reset on no-op applies (e.g.,
  bundle re-apply re-puts the same file). Without this, a workspace
  re-sync silently pushes every interval routine's next-run forward.
- Webhook routines have `next_run_at = NULL` and don't appear in the
  due query. The webhook route handler is what fires them.

---

## Section 4 — Trigger engines + tick loop + multi-replica leasing

### 4.1 Trigger engine interface

```ts
interface TriggerEngine {
  // Compute the next fire time given a parsed trigger spec and "now".
  // Returns null for webhook (event-driven, no scheduled next-run).
  nextRun(spec: TriggerSpec, from: Date): Date | null;

  // Whether the engine participates in the tick scan.
  schedulable: boolean;
}
```

- **`interval`** — `nextRun = from + parseDuration(every)`. Accepts
  `30s`, `30m`, `1h`, `1d`. Validator enforces a minimum of `60s` to keep
  tick load sane.
- **`cron`** — uses a maintained cron lib (likely `croner` or
  `cron-parser`). `nextRun = nextOccurrence(expr, tz, from)`. Cron
  without an explicit `tz:` is rejected by the validator (no implicit
  local time — invariants #1/#4: no hidden state).
- **`webhook`** — `nextRun` always returns `null`. Fires happen via the
  HTTP route handler, not the tick.

### 4.2 Tick loop

```ts
// inside @ax/routines init()
async function tickLoop() {
  const interval = config.tickIntervalMs ?? 5_000;
  while (!shutdown) {
    await tickOnce().catch((err) => log.error('tick failed', err));
    await sleep(interval);
  }
}
```

Tick frequency: **5 seconds**. Bounded below by the minimum allowed
interval (60s) — never more than 12 ticks between fires. Sub-second cron
expressions are explicitly out of scope.

### 4.3 `tickOnce()` — claim, fire, advance

```sql
-- Atomic claim: pull up to N due routines, lock them so other replicas
-- can't double-fire. SKIP LOCKED lets the elected ticker (or racers, in
-- either election model) safely fan out.
WITH due AS (
  SELECT workspace_ref, path
    FROM routines_v1_definitions
   WHERE next_run_at <= now()
     AND trigger_kind IN ('interval', 'cron')
   ORDER BY next_run_at ASC
   LIMIT 50
   FOR UPDATE SKIP LOCKED
)
UPDATE routines_v1_definitions r
   SET next_run_at = r.next_run_at + INTERVAL '5 minutes' -- "claim window"
 WHERE (r.workspace_ref, r.path) IN (SELECT workspace_ref, path FROM due)
RETURNING r.*;
```

For each claimed row: check active hours (skip → reset `next_run_at` to
the next valid window), else fire (Section 5), then
`UPDATE next_run_at = engine.nextRun(spec, now)` and write a
`routines_v1_fires` row.

### 4.4 Multi-replica election

Two replicas both running `tickOnce()` is *safe* under
`FOR UPDATE SKIP LOCKED` — each claims a disjoint set, nothing
double-fires. But "single elected tick" is simpler operationally:

```sql
-- At loop start, try to acquire a session-scoped advisory lock.
SELECT pg_try_advisory_lock(hashtext('@ax/routines.tick'));
-- false → sleep `tickIntervalMs * 10`, retry. true → proceed.
-- Auto-releases on session disconnect.
```

The lock is best-effort election; the SKIP-LOCKED claim is the
correctness guarantee. Belt and braces — if election overlaps briefly
during failover, the claim still serializes.

### 4.5 Active-hours skip

A due routine outside its active hours is **not fired** and **not
counted as a miss**. We compute the next-valid time and update
`next_run_at` to it. For interval routines, this prevents a 30m
heartbeat with `activeHours: 08:00–24:00` from queuing 16 overnight
misses and bombing the agent at 08:00.

### 4.6 Drift control

Interval `next_run_at` advances from the **previous `next_run_at`**, not
from `now()`, so a 30m heartbeat stays at `:00`/`:30`. Exception: if
we're more than one interval behind (replica was down), jump to
`now() + every` to avoid catch-up storms.

### 4.7 Shutdown

`tickLoop` checks the kernel's shutdown signal between ticks. Mid-fire
shutdown: the `chat:turn-start` we just published is the runner's
problem; kernel shutdown drains it. Releasing the advisory lock on
shutdown lets another replica take over within `tickIntervalMs * 10`.

### 4.8 Capability budget

- Network: PG only (via `database:get-instance`).
- Spawn: none.
- Filesystem: none directly — the routine's prompt body comes from
  `routines_v1_definitions`, already validator-vetted.
- Untrusted content boundary: prompt body and webhook payload are
  model-trust-boundary content. They pass verbatim into the agent's
  session via `chat:turn-start`. The routines plugin does **not** evaluate
  them. Webhook templating is whitelist-only string substitution.

---

## Section 5 — Execution path (fire → agent run → conversation)

```
[tick or webhook handler]
        │
        ▼
  routines.fireRoutine(row, source, payload?)
        │
        │ 1. Resolve agent
        ▼
  agents:resolve({ agentId: row.agent_id, userId: agent.ownerId })
  // v1 supports `ownerType: 'user'` only. Team-owned agents have no
  // single recipient for a routine fire; the validator vetoes routine
  // files in team-visibility agent workspaces. See §7.6 (deferred).
        │
        │ 2. Decide conversation
        ▼
  if row.conversation === 'shared':
    conv = conversations:find-or-create({
             ownerId: agent.ownerId,
             agentId: agent.id,
             kind: 'routine',
             externalKey: row.path
           })
  else: // 'per-fire'
    conv = conversations:create({
             ownerId: agent.ownerId,
             agentId: agent.id,
             kind: 'routine',
             title: `${row.name} @ ${ISO timestamp}`
           })
        │
        │ 3. Render prompt
        ▼
  prompt = source === 'webhook'
         ? renderTemplate(row.prompt_body, { payload })
         : row.prompt_body
        │
        │ 4. Publish into the agent's loop
        ▼
  bus.publish('chat:turn-start', {
    conversationId: conv.id,
    agentId: agent.id,
    role: 'user',
    contentBlocks: [{ type: 'text', text: prompt }],
    metadata: {
      source: 'routine',
      routinePath: row.path,
      fireId: <fire-id>,
      silenceToken: row.silence_token,
      silenceMaxChars: row.silence_max
    }
  })
        │
        │ 5. Subscribe own one-shot on chat:turn-end
        ▼
  bus.subscribeOnce('chat:turn-end', { fireId }, applySilenceAndLog)
```

### 5.1 Silence-token logic

```ts
function applySilenceAndLog(turnEnd: TurnEndPayload) {
  // turnEnd.contentBlocks may be undefined for the runner's no-content
  // turn-end heartbeat (yes — naming collision with our concept, but
  // these are the runner's "I didn't say anything" signals, not ours).
  // For a routine-sourced turn, that's an error.
  const text = (turnEnd.contentBlocks ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const token = row.silence_token;
  const max = row.silence_max ?? 300;

  let silenced = false;
  if (token) {
    const startsWith = text.startsWith(token);
    const endsWith = text.endsWith(token);
    if (startsWith || endsWith) {
      const remainder = text
        .replace(new RegExp(`^${escape(token)}|${escape(token)}$`, 'g'), '')
        .trim();
      silenced = remainder.length <= max;
    }
  }

  if (silenced) {
    bus.publish('conversations:drop-turn', { conversationId, turnId });
    if (row.conversation === 'per-fire') {
      bus.publish('conversations:hide', { conversationId });
    }
    log.status = 'silenced';
  } else {
    log.status = 'ok';
    // turn lands in the conversation via the normal chat:turn-end
    // subscriber in @ax/conversations — last_activity_at bumps,
    // sidebar surfaces the conversation.
  }

  routines.recordFire({ fireId, status: log.status, conversationId, error: null });
}
```

### 5.2 Semantics

- **Silenced routines leave no UX trail by default.** Per-fire
  conversations get dropped+hidden; shared conversations simply don't
  receive a new turn. The `routines_v1_fires` row is still written
  (status=`silenced`) so the admin UI shows "fired but silent." Matches
  openclaw's "showOk: false by default."
- **Errors are visible.** If the agent run throws or times out,
  `status='error'`, and the conversation surfaces. The user finds out
  their nightly bug-triage routine is broken — silence is never a place
  to hide failures (no silent failures invariant).
- **Source attribution rides existing `chat:turn-start`.** No parallel
  hook. `metadata.source = 'routine'` lets `@ax/conversations` and any
  audit subscriber distinguish routine fires from user messages.
- **The runner sees an ordinary user turn.** No routines-aware code in
  the runner. This is what makes the unification (Section 1) work.

### 5.3 Webhook templating

```ts
// Whitelist substitution: {{payload.dotted.path}} only.
// No expressions, no helpers, no nested braces.
function renderTemplate(body: string, ctx: { payload: unknown }): string {
  return body.replace(
    /\{\{\s*payload((?:\.[a-zA-Z0-9_-]+)*)\s*\}\}/g,
    (_m, path) => {
      const segments = path.slice(1).split('.').filter(Boolean);
      let cur: unknown = ctx.payload;
      for (const seg of segments) {
        if (cur == null || typeof cur !== 'object') return '';
        cur = (cur as Record<string, unknown>)[seg];
      }
      if (cur == null) return '';
      if (typeof cur === 'string') return cur;
      if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
      return JSON.stringify(cur);
    }
  );
}
```

Strict by design — model output gets the substituted string verbatim, so
any expression evaluator here would be a prompt-injection amplifier.
Field path must match `[a-zA-Z0-9_-]+`; anything else is left literal
(logged once per fire). Whole-payload escape hatch: `{{payload}}` (no
path) inlines the full JSON.

### 5.4 New hooks on `@ax/conversations`

- `conversations:drop-turn({ conversationId, turnId })` — removes a
  just-recorded turn. New, because dropping is a routines-plugin concern that
  conversations serves, not the other way around.
- `conversations:hide({ conversationId })` — sets a `hidden = true`
  flag (excluded from sidebar list, still readable by id). Not
  speculative — has an actual caller (silenced per-fire conversations).
  Foreseeable reuse: titler runs, system events.

Both stay generic (no `routine` vocabulary in payloads).

---

## Section 6 — Webhook surface

### 6.1 Route shape

```
POST /webhooks/<webhook-token>/<routine-slug>
```

- **`<webhook-token>`** — opaque random 32-byte URL-safe token, stored
  on the agent row, generated on first use, rotatable. **Not** the
  agent_id (agent IDs are public-ish; leaking them would enable
  enumeration). The token gates inbound webhook auth even without HMAC.
- **`<routine-slug>`** — filename slug (`.ax/routines/<slug>.md`). With
  the token, uniquely names the routine without exposing `workspace_ref`.

### 6.2 Dynamic route binding

Each webhook routine, on `workspace:applied`, calls
`http:register-route(POST /webhooks/<token>/<slug>, handler)`. On delete,
the matching `http:unregister-route` runs. The routines plugin doesn't
centralize a "find the routine for this URL" router — `@ax/http-server`'s
route table already does that.

A new `agents:rotate-webhook-token` admin hook cycles the token and
forces re-registration of every webhook route for that agent.

### 6.3 Authentication

Two layers:

1. **Token in URL** — mandatory. The URL itself is the bearer
   credential. Attacker without it can't even hit the right route.
   Unmatched-route 404s are logged but don't differentiate "bad token"
   from "bad slug" (no oracle).
2. **HMAC signature** — optional, configured per-routine in frontmatter
   (see Section 2). On request: load the secret via
   `credentials:get-by-name`, compute HMAC over the **raw** body,
   compare in constant time. Mismatch → 401, no info leak.

For sources without HMAC (generic API triggers), the URL token is the
only auth. Documented behavior — treat the URL itself like a bearer
token (don't paste it into Slack).

### 6.4 Request handling

```
POST /webhooks/<token>/<slug>
        │
        │ 1. agents:resolve-by-webhook-token(token) → agent | 404
        ▼
        │ 2. find routines_v1_definitions row for
        │    (agent.workspaceRef, ".ax/routines/<slug>.md") → row | 404
        ▼
        │ 3. if row.trigger.hmac is set → verify HMAC; mismatch → 401
        ▼
        │ 4. Body parsing
        │    application/json            → JSON.parse, fail → 400
        │    application/x-www-form-urlencoded → URLSearchParams
        │    other Content-Type          → 415
        │    Size limit: 1 MiB. Larger   → 413
        ▼
        │ 5. Optional GitHub event filter
        │    if spec.events.length > 0 and X-GitHub-Event header is set,
        │    require it to be in spec.events; else 204
        ▼
        │ 6. routines.fireRoutine(row, source='webhook', payload=parsedBody)
        ▼
        │ 7. Respond 202 immediately (do NOT block on agent run)
```

**Why 202-and-go:** agent runs take seconds-to-minutes; webhook senders
(GitHub, monitoring tools, Slack) time out at 10s. We acknowledge
receipt fast and run the agent async. Fire results land in the
conversation; webhook callers don't see them. Synchronous reply is
deferred — explicit YAGNI for v1.

### 6.5 Capability budget

`@ax/routines` declares:

- `calls: ['http:register-route', 'http:unregister-route',
            'credentials:get-by-name',
            'agents:resolve-by-webhook-token',
            'agents:resolve',
            'conversations:find-or-create', 'conversations:create',
            'conversations:drop-turn', 'conversations:hide',
            'database:get-instance']`
- `subscribes: ['workspace:applied', 'chat:turn-end']`
- `registers: ['routines:fire-now', 'routines:list']`

`@ax/agents` adds: `agents:resolve-by-webhook-token`,
`agents:rotate-webhook-token`.

Network surface: PG only from the routines plugin itself; HTTP plugin owns
the inbound socket. Untrusted request body is parsed to JSON then
passed *only* to the templating function — no code execution path
touches it.

### 6.6 Boundary review

- `agents:resolve-by-webhook-token(token) → Agent | null` — opaque
  token, opaque agent. No leak.
- `agents:rotate-webhook-token({ actor, agentId }) → { token }` — write.
  Opaque.
- `conversations:drop-turn` and `conversations:hide` — already covered
  in §5.4.

### 6.7 Out of v1

- IP allowlisting (push to infra).
- Per-routine rate limiting (one route per routine; misuse hits global
  http rate-limit).
- Replay protection beyond HMAC (`X-GitHub-Delivery` dedup adds later
  if a duplicate report comes in).
- WebSocket / SSE inbound — HTTP POST only.

---

## Section 7 — Bootstrap, admin UI, testing, half-wired window

### 7.1 Heartbeat bootstrap (the default routine)

Three considered options; shipping the first:

- **(Chosen) Agent-template seed.** When `@ax/agents` creates an agent,
  it includes a starter workspace bundle (`workspace:apply-bundle` with
  a baseline tree). Add `.ax/routines/heartbeat.md` and
  `.ax/HEARTBEAT.md` (empty-with-comment) to that template. New agents
  pick up heartbeat automatically. Existing agents need a one-shot
  migration (admin button: "Add heartbeat routine"). Zero
  routines-plugin-specific bootstrap code; coupling lives in the template.
- **(Alt) System-default fallback in routines plugin.** The plugin synthesizes
  a virtual row per agent that has no `.ax/routines/heartbeat.md`,
  using config defaults. Doesn't break invariant #4 only if we mark the
  row `kind = 'synthesized'` and never write it through to a file.
  More magic.
- **(Alt) Onboarding wizard adds it.** First-use wizard offers
  "enable heartbeat" as a checkbox during agent creation. Couples
  `@ax/onboarding` to `@ax/routines`.

The starter `HEARTBEAT.md` ships with a single comment line:
*"Add a short checklist here — kept tiny."* — file exists but the agent
has nothing to do until the user fills it in.

### 7.2 Admin surface (`@ax/channel-web`)

New **Routines** tab under settings, scoped to the agent the user is
currently chatting with (admin UI gets cluster-wide list):

- **List view** — every routine for this agent: name, trigger summary
  (`every 30m` / `cron 0 2 * * *` /
  `webhook POST /webhooks/.../<slug>`), `last_fired_at`, `last_status`,
  `next_run_at`.
- **Per-routine drawer** — view the markdown file inline (read-only —
  editing happens via chat with the agent or `git push`), recent fires
  (from `routines_v1_fires`), per-fire conversation links.
- **Webhook URL display** — for `kind: webhook`, show the full URL with
  a Copy button. Agent-level rotate-token action lives next to it.
- **Manual fire button** — calls
  `routines:fire-now({ workspaceRef, path, source: 'manual' })`.

Built with shadcn primitives + semantic tokens per invariant #6:
`Table`, `Card`, `Badge`, `Button`, `Dialog`. No new design language.

### 7.3 Half-wired window discipline

Per project memory, every phase reaches the canary loop in the same PR:

1. **Phase A — Foundations.** New hooks on `@ax/conversations`:
   `conversations:drop-turn`, `conversations:hide`,
   `conversations:find-or-create`. Plus the `hidden` column migration on
   the conversations table. No new workspace or agents hooks needed
   (we use the existing `workspace:applied` + `delta.author.agentId`).
   Each new conversations hook is unit-tested and exercised in the
   canary boot so the surface is real, not theoretical.
2. **Phase B — Routines core.** `@ax/routines` plugin (manifest + DB
   migration + tick loop + interval/cron engines).
   `@ax/validator-routine` plugin. CLI preset + k8s preset both load
   both plugins. Canary creates a routine in the test agent's workspace
   and asserts the routines plugin fires it on tick.
3. **Phase C — Webhook surface.** HTTP route registration, HMAC,
   payload templating, `agents:resolve-by-webhook-token`,
   `agents:rotate-webhook-token`. Canary POSTs to a webhook routine and
   asserts the fire lands in a conversation.
4. **Phase D — UI + heartbeat bootstrap.** Routines tab in settings;
   agent-template seeds `.ax/routines/heartbeat.md`. Manual
   `MANUAL-ACCEPTANCE` walk.

Each phase closes its window before the next opens. PR notes for
phases A–C name the explicit "window CLOSED" line referencing the canary
test that exercises the new surface.

### 7.4 Testing strategy

- **Unit:** trigger engines (interval/cron/active-hours math),
  frontmatter parser + validator vetoes, silence-token logic
  (start/end/middle/oversized remainder), webhook template substitution
  (whitelist + missing-field handling), HMAC compare (constant-time).
- **Integration:** post-apply sync (put/modify/delete + spec_hash
  drift), tick claim under concurrency (two replicas,
  `FOR UPDATE SKIP LOCKED` proves disjoint claim), advisory-lock
  failover, active-hours skip semantics (no catch-up storm).
- **Canary (acceptance):** the standard ax-next canary chat path gains
  a routine. After workspace bootstrap, the canary asserts (a) interval
  routine fires within `tickInterval × 2`, (b) silence-token suppresses
  the conversation, (c) webhook POST fires the routine, (d) HMAC
  mismatch returns 401.
- **No mocks for tick math.** Time is injected (`Clock` abstraction) so
  tests run in real Postgres against synthetic timestamps (project
  memory: "no mock DB").

### 7.5 MANUAL-ACCEPTANCE deltas

Two new sections in `deploy/MANUAL-ACCEPTANCE.md`:

- **Schedule a routine** — create `.ax/routines/notify.md` by chatting
  with the agent ("create a routine that pings me every 5 minutes
  saying 'still here'"), confirm a per-fire conversation appears,
  confirm silence-token suppresses subsequent fires after the user
  updates the prompt to opt in.
- **Receive a webhook** — create a webhook routine, copy the URL from
  the settings tab, `curl -X POST` it, confirm the fire lands in a
  conversation.

### 7.6 Deliberately deferred (YAGNI per memory)

- Routine-scoped skills (`skills: [foo, bar]` in frontmatter) — agent
  already owns skills.
- Per-routine model override — agent already owns model.
- Script pre-processing (`--script` à la hermes) — adds an exec surface
  that fights invariant #5. Add only when a user actually asks.
- Cross-agent routines (one routine fires another agent) — adds an
  authz dimension. Workspace-bound is enough for MVP.
- **Team-owned-agent routines.** Validator vetoes routine files in
  team-visibility agent workspaces. Open question for follow-up: should
  a team routine fire once and land in the agent-creator's inbox, fan
  out per team member, or post to a team channel? Defer until a user
  asks.
- Synchronous webhook reply.
- Manual `routines:fire-now` exposed beyond admin (e.g., per-user
  "fire now" buttons). Admin-only at v1.

---

## Appendix A — Invariant audit

| Invariant                                  | Status | Notes                                                                                                                                                            |
| ------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 Transport/storage-agnostic hooks        | OK     | Uses existing `workspace:applied` (opaque `WorkspaceVersion`). `agents:resolve-by-webhook-token` and `agents:rotate-webhook-token` use opaque tokens. No `sha`, no `pod`. |
| #2 No cross-plugin imports                 | OK     | `@ax/routines` reaches `@ax/agents` / `@ax/credentials` / `@ax/conversations` / `@ax/http-server` only via the hook bus.                                        |
| #3 No half-wired plugins                   | OK     | Phases A–D each reach the canary loop in the same PR. Explicit "window CLOSED" line in PR notes (see §7.3).                                                      |
| #4 One source of truth                     | OK     | Routine file is the spec; DB row is derived. Spec-hash gate prevents no-op apply from desyncing schedule state.                                                  |
| #5 Capabilities explicit and minimized     | OK     | Capability budget enumerated in §4.8 and §6.5. No spawn, no FS, only PG + bus + HTTP (via plugin).                                                               |
| #6 One UI design language (shadcn primitives) | OK   | Admin tab uses `Table` / `Card` / `Badge` / `Button` / `Dialog`. No new design system.                                                                           |

## Appendix B — Hook surface summary

**New service hooks:**

- `@ax/agents`: `agents:resolve-by-webhook-token`,
  `agents:rotate-webhook-token`. *(Removed
  `agents:resolve-by-workspace`: not needed under the
  `workspace:applied`-based indexing — `delta.author.agentId` is the
  authoritative key.)*
- `@ax/routines`: `routines:fire-now`, `routines:list`.
- `@ax/conversations`: `conversations:drop-turn`,
  `conversations:hide`, `conversations:find-or-create`.

**Subscribed hooks (existing — no publisher changes):**

- `@ax/routines` subscribes to `workspace:applied` and `chat:turn-end`.
- `@ax/validator-routine` subscribes to `workspace:pre-apply`.

**Existing hook surface used (no payload changes):**

- `workspace:applied` (published by `@ax/ipc-core`'s
  `workspace-commit-notify` handler with payload `WorkspaceDelta`).
- `workspace:pre-apply`.
- `chat:turn-start` / `chat:turn-end`.
- `agents:resolve`, `agents:create` (admin path for webhook-token
  rotation).
- `http:register-route`, `http:unregister-route`.
- `credentials:get-by-name`.
- `database:get-instance`.

## Appendix C — Open questions (none load-bearing for spec)

- `routines_v1_fires` retention policy beyond unbounded — pick when
  table size becomes a concern, not before.
- Webhook routes might want a per-route allowlist of source IPs once a
  user asks for it; today's posture is "URL token is auth."
- Whether `agents:rotate-webhook-token` should invalidate in-flight
  requests (current draft: routes are torn down; in-flight requests
  complete against the prior handler). YAGNI for v1.
