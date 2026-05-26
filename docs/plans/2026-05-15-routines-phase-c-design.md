# Routines — Phase C Design (Webhook Trigger)

**Status:** Proposal, ready for review
**Date:** 2026-05-15
**Author:** Vinay (with Claude)
**Related:** `docs/plans/2026-05-14-routines-design.md` §6 + §7, `docs/plans/2026-05-14-routines-phase-b-impl.md` (Phase B, merged PR #71), `docs/plans/2026-05-15-routines-phase-b-followups.md` (PRs #73 / #75 / #76 merged)

---

## TL;DR

Phase C delivers the third trigger kind that Phase B's validator explicitly
deferred (`@ax/validator-routine/src/frontmatter.ts:110-112`). It does so
without introducing any new package — only two files of additive change to
`@ax/agents` (new column + two hooks), a relaxed validator, and a new
webhook route surface inside `@ax/routines`. The route is mounted on
`workspace:applied` via the existing `http:register-route` hook, takes a
URL bearer token + optional HMAC, parses the body, runs a strict-whitelist
template, and dispatches the existing `fireRoutine` with
`source: 'webhook'` and a new optional `payload` argument.

Phase B already shipped `trigger_kind = 'webhook'` in the
`routines_v1_definitions` CHECK constraint and `FireSource = 'tick' |
'webhook' | 'manual'` in the type union (per I3: "small additive change,
not a migration"). Phase C is the producer + consumer + canary that closes
that half-wired window.

---

## Section 1 — Decisions resolved during brainstorming

Each decision below resolved a known plan-vs-reality gap (in the style
of Phase B's I1). The K-invariants in §8 carry these forward.

### 1.1 Webhook secrets resolve via existing `credentials:get`

The design doc (`2026-05-14-routines-design.md` §6.5) references a
`credentials:get-by-name` hook. That hook does not exist —
`@ax/credentials` registers `credentials:get({ ref, userId })`, which
walks user → agent → global scope precedence.

**Phase C reuses the existing hook.** `secretRef` from routine
frontmatter maps directly to the `ref` argument; we pass
`row.author_user_id` (already captured on the `routines_v1_definitions`
row for the `agents:resolve` ACL pass) as `userId`. The author is the
right principal — they already ACL'd into the routine file, they ACL
into the secret behind it. Operators can store webhook secrets at
`global` scope when no per-user notion applies; the precedence walk
finds them through the author's `userId` lookup. **K2.**

### 1.2 Webhook token lives on the agent row, generated lazily

One opaque 32-byte URL-safe token per agent (not per-routine). Stored
in a new nullable `webhook_token` column on `agents_v1_agents`.
Generated lazily by `@ax/routines` the first time it indexes a webhook
routine for an agent whose `webhook_token IS NULL`; rotatable via a new
hook. Per-routine tokens were rejected — rotation UX becomes
N-times-worse and webhook senders that fan multiple events into the
same agent would need N URLs to update. **K7 / K8.**

### 1.3 Route lifecycle uses `http:register-route`'s returned closure

The design doc references `http:unregister-route`. **That hook does not
exist** — `http:register-route` already returns `{ unregister(): void }`
as a closure, as used by `@ax/agents` admin routes
(`packages/agents/src/plugin.ts:65`) and `@ax/credentials-admin`. Phase
C holds those closures in an in-memory `Map<key, () => void>` inside
`@ax/routines`, calls them on routine delete / update, drains them all
on plugin `shutdown()`. **K1.**

### 1.4 Multi-replica posture: single-replica only, documented

Today's k8s preset is single-replica
(`presets/k8s/src/index.ts:51,650-723` — multiple plugins declare
"single-replica only — multi-replica fan-out is a future slice").
`workspace:applied` fires through the in-process `HookBus` — there is
no LISTEN/NOTIFY or pg pub/sub fanout.

The in-memory closure registry pattern therefore matches the rest of
the host: routes are local to the replica that received the apply.
Multi-replica fan-out is deferred until the broader preset lifts out of
single-replica (would require `workspace:applied` to broadcast or each
replica to run a reconcile loop against `routines_v1_definitions`). The
limitation is documented in the plugin manifest comment, the preset
load-site comment, and the PR notes — mirroring existing declarations.
**K3.**

### 1.5 Canary stays in-process; full HTTP belongs in MANUAL-ACCEPTANCE

Phase B canary stubs `agents:resolve` / `conversations:*` / `agent:invoke`
via `@ax/test-harness` and never spins up an HTTP socket. Phase C
mirrors that: stub `http:register-route` to capture
`(method, path, handler)`, then invoke the handler directly with a
synthetic `HttpRequest` / `HttpResponse`. The real-port round-trip
lands in `deploy/MANUAL-ACCEPTANCE.md` under the Phase D acceptance
walk (already planned per design §7.5). **K5.**

### 1.6 Payload templating: strict whitelist verbatim from §5.3

`{{payload.dotted.path}}` plus a `{{payload}}` (no path) whole-payload
escape hatch. No expressions, no helpers, no nested braces, no
`mustache.js`. The substitution output goes verbatim into the model
prompt — anything beyond string substitution would be a
prompt-injection amplifier. **K9.** `security-checklist` skill is
invoked before the body-parse / HMAC / template modules merge.

---

## Section 2 — Packaging (no new packages)

**Modify:**

- `packages/validator-routine/src/frontmatter.ts` — accept `kind:
  webhook` (replacing the "Phase C" reject at line 110-112), validate
  `path`, optional `events[]`, optional `hmac.{secretRef, header,
  algorithm, prefix}`.
- `packages/validator-routine/src/__tests__/frontmatter.test.ts` —
  positive + negative cases for the new validation paths.
- `packages/agents/src/migrations.ts` — additive `ALTER TABLE` adding
  `webhook_token TEXT UNIQUE` + partial index.
- `packages/agents/src/store.ts` — getters/setters for the new column.
- `packages/agents/src/plugin.ts` — register `agents:resolve-by-
  webhook-token` and `agents:rotate-webhook-token`. Manifest gains both
  in `registers`.
- `packages/agents/src/types.ts` — new input/output interfaces.
- `packages/agents/src/__tests__/` — unit tests for both new hooks
  (lazy generation, rotation, ACL on rotation, unknown-token lookup
  returns `null`).
- `packages/routines/src/plugin.ts` — manifest additions to `calls`;
  webhook route mount/unmount inside the existing `workspace:applied`
  subscriber; new `chat:turn-end` path unchanged.
- `packages/routines/src/sync.ts` — extend the per-change loop to
  register/replace/remove webhook routes.
- `packages/routines/src/webhook-handler.ts` — **new** module: route
  handler chain (token lookup → row lookup → HMAC → body parse →
  event filter → fireRoutine).
- `packages/routines/src/template.ts` — **new** module: strict-whitelist
  payload substitution.
- `packages/routines/src/fire.ts` — extend the `createFireRoutine`
  closure to accept optional `payload`; render template only when
  `source === 'webhook'`.
- `packages/routines/src/types.ts` — `FireSource` already includes
  `'webhook'` (Phase B); add `WebhookHmacSpec` and `WebhookTriggerSpec`
  shapes mirroring `validator-routine`.
- `packages/routines/src/__tests__/canary.test.ts` — five new test
  cases (see §7).
- `packages/routines/src/__tests__/template.test.ts` — **new** unit
  tests.
- `packages/routines/src/__tests__/webhook-handler.test.ts` — **new**
  unit tests covering all the chain branches.

**Do not touch:** `packages/channel-web` (admin UI is Phase D),
`packages/sandbox-k8s`, `packages/http-server` (no hook changes — we
use the existing register-route).

---

## Section 3 — Frontmatter format (new fields)

```yaml
---
name: github-pr-triage
description: Triage incoming GitHub PR webhooks
trigger:
  kind: webhook
  path: "/r/github-prs"            # required; appended after /webhooks/<token>
                                   # validator regex: ^/[A-Za-z0-9._\-/]+$, ≤128
                                   # NOTE: validator slugifies path → routine slug
                                   # for URL composition (see §4.1 path mapping)
  events: ["pull_request"]         # optional; matched against X-GitHub-Event
  hmac:                            # optional
    secretRef: gh-webhook-secret   # ref into @ax/credentials
    header: "X-Hub-Signature-256"  # case-insensitive
    algorithm: "sha256"            # sha256 (default) | sha1
    prefix: "sha256="              # optional; stripped before compare
conversation: per-fire
---
PR #{{payload.pull_request.number}} "{{payload.pull_request.title}}"
opened by @{{payload.pull_request.user.login}}.
```

**Validation rules (`@ax/validator-routine`):**

| Field | Required | Constraint |
|---|---|---|
| `trigger.path` | yes | `^/[A-Za-z0-9._\-/]+$`; 1-128 chars; not starting with `/webhooks/`; no `..`; no double-`/` |
| `trigger.events` | no | array of `[A-Za-z0-9_-]{1,64}`; 0-32 items |
| `trigger.hmac` | no | object; if present, `secretRef` + `header` required |
| `trigger.hmac.secretRef` | when `hmac` present | non-empty string |
| `trigger.hmac.header` | when `hmac` present | non-empty string |
| `trigger.hmac.algorithm` | no (default `sha256`) | `'sha256'` \| `'sha1'` |
| `trigger.hmac.prefix` | no | string |

`activeHours` rejected when `kind: webhook` (already implied by design
§2 — a webhook IS the trigger; the user picked when it fires by
sending the event). Phase B accepted `activeHours` unconditionally;
Phase C tightens this for webhook routines only.

**Note on URL path composition:** `trigger.path` in the frontmatter is
the *publish-side* identifier the operator names in their routine
file. The actual mounted URL is
`POST /webhooks/<agent.webhook_token>/<routine-slug>`, where
`<routine-slug>` is the filename without `.ax/routines/` prefix and
`.md` suffix (matches design §6.1). `trigger.path` is recorded on the
row for the admin UI's display affordance; the route mount uses the
canonical slug. Operators get one URL per routine; the frontmatter
`path` is for human labelling. This avoids slug/path collisions and
keeps URL composition entirely deterministic from `(token, filename)`.

---

## Section 4 — Webhook route lifecycle

### 4.1 Closure registry

```ts
// In @ax/routines/src/plugin.ts init() scope
const webhookRoutes = new Map<string, () => void>();
// key = `${agentId}::${path}`
// value = the `unregister` closure returned by http:register-route
```

### 4.2 `workspace:applied` subscriber, extended

The existing subscriber in `packages/routines/src/sync.ts` is augmented
with webhook handling. Pseudocode (real code threads `bus` + `store` +
`webhookRoutes` through `handleWorkspaceApplied`):

```
on workspace:applied(delta):
  for change in delta.changes matching /^\.ax\/routines\/[^/]+\.md$/:
    key = `${delta.author.agentId}::${change.path}`

    if change.kind === 'deleted':
      # 1. Unmount any webhook route bound to this routine
      webhookRoutes.get(key)?.()
      webhookRoutes.delete(key)
      # 2. Existing delete path runs (Phase B behaviour unchanged)
      DELETE FROM routines_v1_definitions WHERE agent_id=? AND path=?
      continue

    spec = parseRoutineFrontmatter(bytes)
    # Phase B existing UPSERT happens here

    if spec.trigger.kind !== 'webhook':
      # Drop any stale closure from a prior webhook → cron/interval
      # transition. K6: spec_hash already gates the upsert, but the
      # route-table side-effect needs explicit cleanup.
      webhookRoutes.get(key)?.()
      webhookRoutes.delete(key)
      continue

    # --- Webhook path ---
    # 3. Ensure agent has a token (lazy)
    agent = await bus.call('agents:resolve', ctx,
                           { agentId, userId: authorUserId })
    token = agent.webhookToken ??
            (await bus.call('agents:rotate-webhook-token',
                            ctx, { actor: { userId: authorUserId },
                                   agentId })).token

    # 4. Replace any prior closure for this key. Re-applies on no-op
    #    are filtered by spec_hash gate in the store layer — we only
    #    reach here when spec_hash actually changed. Re-registering
    #    the same path twice would throw `duplicate-route`, so the
    #    unregister-first ordering is load-bearing.
    webhookRoutes.get(key)?.()

    slug = change.path.replace(/^\.ax\/routines\//, '').replace(/\.md$/, '')
    out = await bus.call('http:register-route', ctx, {
      method: 'POST',
      path: `/webhooks/${token}/${slug}`,
      handler: makeWebhookHandler({ bus, store, agentId, routinePath: change.path }),
    })
    webhookRoutes.set(key, out.unregister)
```

**Failure handling (K10):** every step inside the `if kind === 'webhook'`
block is wrapped in try/catch at the route-binding level (not at the
hook fan-out level — `workspace:applied` is a subscriber hook, and we
inherit `bus.fire`'s subscriber-must-not-throw discipline). A failure
to fetch a token, register the route, or resolve the agent logs +
records `last_status='error'` on the routine row and continues with
the next change. The workspace apply itself is not affected.

### 4.3 Plugin shutdown

```ts
async shutdown() {
  for (const unregister of webhookRoutes.values()) {
    try { unregister(); } catch { /* idempotent per http-server contract */ }
  }
  webhookRoutes.clear();
  // ...existing Phase B shutdown
}
```

### 4.4 Re-apply / re-register semantics

The Phase B `spec_hash` gate in `store.upsert` prevents `next_run_at`
from resetting on no-op applies. The webhook subscriber respects the
same signal: we only re-register routes when `spec_hash` actually
changes. Implementation: the store returns whether the row was
inserted, updated-with-hash-change, or unchanged; the subscriber
acts on the first two and short-circuits on the third. This avoids
unregister→register churn on every workspace re-sync. **K6.**

---

## Section 5 — Route handler chain

`makeWebhookHandler({ bus, store, agentId, routinePath }) →
(req: HttpRequest, res: HttpResponse) => Promise<void>`:

```
1. Token + slug come from req.params (http-server populates params from
   :name segments). For Phase C the registered path is literal
   /webhooks/<resolved-token>/<resolved-slug>, NOT a parametric pattern
   — each routine gets its own concrete route. The token comparison is
   implicit (router only matched because the URL matched the bound
   token). No oracle: an unknown token / slug → http-server returns 404
   before our handler runs, same as any unmounted path.

2. row = await store.findOne({ agentId, path: routinePath })
   if row === null OR row.triggerKind !== 'webhook':
     return res.status(404).end()          # shouldn't happen (race
                                            # between unregister and
                                            # in-flight request)

3. if row.trigger.hmac:
     try:
       secret = await bus.call('credentials:get', ctx,
                               { ref: row.trigger.hmac.secretRef,
                                 userId: row.authorUserId })
     catch:
       return res.status(401).end()        # missing credential → 401
                                            # (no info leak about whether
                                            # ref exists)
     header = req.headers[hmac.header.toLowerCase()]
     if typeof header !== 'string': return res.status(401).end()
     bare = hmac.prefix ? header.replace(prefix, '') : header
     computed = createHmac(algorithm, secret).update(req.body).digest('hex')
     if !timingSafeEqual(bare.toLowerCase(), computed.toLowerCase()):
       return res.status(401).end()

4. ct = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
   switch ct:
     case 'application/json':
       try: payload = JSON.parse(req.body.toString('utf8'))
       catch: return res.status(400).end()
     case 'application/x-www-form-urlencoded':
       payload = Object.fromEntries(new URLSearchParams(req.body.toString('utf8')))
     default:
       return res.status(415).end()
   (req.body 1 MiB cap is enforced by http-server BEFORE handler runs;
   over-cap returns 413 there.)

5. if row.trigger.events?.length > 0:
     ghEvent = req.headers['x-github-event']
     if typeof ghEvent === 'string' AND !row.trigger.events.includes(ghEvent):
       return res.status(204).end()         # filtered; ACK'd

6. # Fire-and-forget — matches the tick path and design §6.4
   void fireRoutine(row, 'webhook', payload).catch(err => {
     process.stderr.write(`[ax/routines] webhook fire failed: ${err}\n`)
     # The fire row gets status='error' through the same chat:turn-end
     # / agent:invoke failure handling already in fire.ts.
   })

7. res.status(202).end()
```

**HMAC compare uses `crypto.timingSafeEqual`** with equal-length
buffers (compare the hex strings byte-for-byte after lowercasing).
**K11.**

**No oracle leakage:** unknown token, unknown slug, kind mismatch, and
HMAC mismatch all return early without distinguishing branches in
timing or response body. Bad token → http-server 404 (route not
mounted). Bad slug → router 404 (route not mounted). Bad HMAC → 401
(empty body). Bad body → 400 / 415 / 413 (after HMAC passes, so an
attacker can't probe Content-Type without a valid signature).

---

## Section 6 — `fireRoutine` extension + payload templating

### 6.1 `fireRoutine` signature

```ts
// packages/routines/src/fire.ts
export function createFireRoutine(deps: FireDeps) {
  return async (
    row: RoutineRow,
    source: FireSource,
    payload?: unknown,        // NEW (Phase C). Required when source==='webhook'.
  ): Promise<FireResult> => { ... };
}
```

The change is purely additive — Phase B callers (tick loop,
`routines:fire-now`) keep passing two args, and `payload` defaults to
`undefined`. The render step is:

```ts
const prompt = source === 'webhook' && payload !== undefined
  ? renderTemplate(row.promptBody, { payload })
  : row.promptBody;

// existing agent:invoke call now uses `prompt`
await bus.call('agent:invoke', fireCtx, {
  message: { role: 'user', content: prompt },
});
```

### 6.2 `renderTemplate` (the only sink for webhook payload bytes)

```ts
// packages/routines/src/template.ts
const WHOLE_RE = /\{\{\s*payload\s*\}\}/g;
const PATH_RE = /\{\{\s*payload((?:\.[a-zA-Z0-9_-]+)+)\s*\}\}/g;

export function renderTemplate(body: string, ctx: { payload: unknown }): string {
  return body
    .replace(WHOLE_RE, () => JSON.stringify(ctx.payload))
    .replace(PATH_RE, (_m, raw: string) => walkOrEmpty(ctx.payload, raw));
}

function walkOrEmpty(root: unknown, raw: string): string {
  const segments = raw.slice(1).split('.');
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === null || cur === undefined) return '';
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  return JSON.stringify(cur);
}
```

**Trust boundary contract (K9):** the bytes from `req.body` flow
`JSON.parse` (network → JS value) → `renderTemplate` (JS value →
string) → `agent:invoke({ message: { content: string } })` (string →
model prompt). They never reach a dynamic-JS-evaluation sink. The
forbidden set is the standard one (review will reject any introduction
of these): the `Function` constructor, the `vm` module, the global
`eval` function, child-process spawn, SQL string concatenation, or
HTML response interpolation. The model itself MAY emit tool calls or
further prompts based on the substituted string — that's the normal
model trust boundary that every chat message crosses, not a Phase
C-specific escalation.

`security-checklist` skill is invoked on the body-parse, HMAC, and
template modules before merge.

---

## Section 7 — Canary (closes the half-wired window in this PR)

`packages/routines/src/__tests__/canary.test.ts` gains a new
`describe('Phase C webhook canary', ...)` block. The harness mirrors
Phase B style: stub the bus services, capture the registered handler,
invoke it with a synthetic request.

```ts
const stubs = {
  'agents:resolve': /* returns agent with webhookToken=null then 't1' */,
  'agents:rotate-webhook-token': async (_ctx, { agentId }) => {
    agentTokens.set(agentId, 't1');
    return { token: 't1' };
  },
  'agents:resolve-by-webhook-token': async (_ctx, { token }) =>
    token === 't1' ? { agent: { id: 'agt_a' } } : null,
  'credentials:get': async (_ctx, { ref }) => {
    if (ref === 'gh-secret') return 'shhh';
    throw new PluginError({ code: 'not-found', plugin: 'test', message: 'no' });
  },
  'http:register-route': async (_ctx, input) => {
    captured.routes.push({ method: input.method, path: input.path });
    captured.handlers.set(input.path, input.handler);
    return { unregister: () => { captured.unregisters.push(input.path); } };
  },
  'agent:invoke': async (ctx, { message }) => {
    captured.invokes.push({ content: message.content, reqId: ctx.reqId });
    // immediately fire chat:turn-end (matches Phase B canary pattern)
    await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, turnId: 't1',
      contentBlocks: [{ type: 'text', text: 'ack' }] });
    return { kind: 'complete', messages: [] };
  },
};
```

**Cases (all five required for K5 window closure):**

1. **route mounts on indexing** — fire `workspace:applied` with a
   `kind: webhook` routine; assert `captured.routes` has exactly one
   `POST /webhooks/t1/<slug>` and `captured.handlers.size === 1`.
2. **lazy token generation is idempotent** — fire `workspace:applied`
   twice (adding two webhook routines for the same agent); assert
   `agents:rotate-webhook-token` was called exactly once.
3. **HMAC mismatch → 401** — fetch the captured handler, invoke with
   `{ headers: { 'x-hub-signature-256': 'sha256=deadbeef' }, body: ... }`;
   assert `res.status` was set to 401 and `agent:invoke` was NOT called.
4. **valid POST → templated agent:invoke** — invoke handler with a
   valid HMAC over `{ "pull_request": { "title": "fix bug" } }`;
   assert `agent:invoke` content is the prompt body with
   `{{payload.pull_request.title}}` substituted to `fix bug`. Also
   asserts `res.status(202)` was the response.
5. **routine deleted → route unmounts** — fire a `kind: 'deleted'`
   change; assert the prior `unregister` closure was called and
   `captured.unregisters` contains the path.

Full HTTP round-trip is the MANUAL-ACCEPTANCE walk (§9), not the
canary.

---

## Section 8 — K-Invariants (carry-forward from I1–I8 / J1–J5)

Numbered K-invariants surface explicit failure modes from prior phases
and must hold across every task in this plan. Reviewers can grep PR
notes for `K1..K11` to confirm coverage. **Phase B's I1–I8 and the
follow-ups' J1–J5 are not repealed**; K-invariants are additive
discipline for the Phase C surface.

- **K1 (plan vs reality #1 — `http:unregister-route` doesn't exist).**
  The design references `http:unregister-route` in §6 and §6.5.
  `@ax/http-server` does not register such a hook; `http:register-route`
  returns `{ unregister(): void }` as a closure. Phase C holds those
  closures in an in-memory `Map<key, () => void>` and calls them on
  delete / replace / shutdown. The capability budget does NOT list
  `http:unregister-route`.

- **K2 (plan vs reality #2 — `credentials:get-by-name` doesn't exist).**
  The design references `credentials:get-by-name`.
  `@ax/credentials` registers `credentials:get({ ref, userId })` only.
  Phase C reuses it, passing `row.authorUserId` as `userId`. The
  capability budget lists `credentials:get`, not the alias.

- **K3 (single-replica posture, explicit).** Webhook routes are in
  memory and local to the replica that received the `workspace:applied`
  event. Multi-replica fan-out is a future slice (would require
  `workspace:applied` broadcast via pg LISTEN/NOTIFY or a per-replica
  reconciler). Documented in the plugin manifest comment block, the
  preset load-site comment, and PR notes — matching the existing
  "single-replica only" declarations in `presets/k8s/src/index.ts`.

- **K4 (no cross-plugin imports).** `@ax/routines` reaches `@ax/agents`,
  `@ax/credentials`, and `@ax/http-server` only through the hook bus.
  `@ax/validator-routine` reaches `@ax/core` only. Lint already
  enforces this (allowlist updated by Phase B); a manual grep on the
  final commit is the belt-and-braces.

- **K5 (no half-wired plugins — window closure).** The producer
  (webhook routes mounted via `http:register-route`), the consumer
  (`fireRoutine` accepts `payload` and renders the template), and the
  canary that exercises both ship in the same PR. PR notes include the
  explicit "Phase C window CLOSED" line referencing the five canary
  cases in §7.

- **K6 (one source of truth — spec_hash gates re-binding).** The
  routine file is the spec; `(agentId, path)` identity is unchanged
  from Phase B; `spec_hash` already gates `next_run_at` resets, and
  Phase C extends it to gate webhook route re-registration. We only
  unregister + re-register when the spec actually changed.

- **K7 (capabilities explicit and minimized).** Additions:
  - `@ax/routines.calls`: `http:register-route`, `credentials:get`,
    `agents:resolve-by-webhook-token`, `agents:rotate-webhook-token`.
  - `@ax/agents.registers`: `agents:resolve-by-webhook-token`,
    `agents:rotate-webhook-token`.

  No spawn, no FS, no new network surface beyond what
  `@ax/http-server` already owns. No `http:unregister-route`. No
  `credentials:get-by-name`.

- **K8 (storage-agnostic hook payloads).** The two new `@ax/agents`
  hooks take opaque `agentId` / `token` strings only. No `sha`, no
  `bucket`, no `pod_name`, no DB row shapes. Output is `{ agent }` /
  `{ token }`.

- **K9 (untrusted-content trust boundary).** Webhook payload bytes
  flow: `req.body` → `JSON.parse` → `renderTemplate` (string
  substitution only) → `agent:invoke({ message: { content: string } })`.
  No dynamic-code evaluation (the standard forbidden set is the
  `Function` constructor, the `vm` module, the global `eval`, and
  child-process spawn — review will reject introductions). No SQL
  template, no HTML response interpolation.
  **`security-checklist` skill is invoked on the body-parse, HMAC, and
  template modules before merge.**

- **K10 (subscriber-must-not-throw — webhook re-bind failures).** Any
  failure inside the webhook-binding branch of the `workspace:applied`
  subscriber (token resolve, route register, agent resolve) is logged
  and recorded as `last_status='error'` on the routine row. The
  workspace apply itself is not affected; other routines in the same
  delta continue to process.

- **K11 (constant-time HMAC).** HMAC comparison uses
  `crypto.timingSafeEqual` over equal-length lowercase hex buffers.
  Direct `===` on the strings is rejected at review.

---

## Section 9 — MANUAL-ACCEPTANCE delta

`deploy/MANUAL-ACCEPTANCE.md` gains one new section (the "Receive a
webhook" entry per design §7.5):

1. Create `.ax/routines/notify.md` by chatting with the agent —
   `kind: webhook`, `path: /test`, no HMAC.
2. Open the Settings → Routines tab (Phase D placeholder; for Phase C
   the URL surfaces via `routines:list` admin output or a manual
   `SELECT webhook_token FROM agents_v1_agents`).
3. `curl -X POST -H 'Content-Type: application/json' -d '{"foo":"bar"}'
   http://localhost:8080/webhooks/<token>/notify`
4. Confirm: a new per-fire conversation appears in the sidebar; the
   first user turn contains the prompt body with `{{payload.foo}}`
   substituted to `bar`.
5. (HMAC variant — gated on Phase C MANUAL also covering the
   `credentials:set` step:) repeat with `hmac.secretRef` set; confirm
   that a missing / wrong signature returns 401 and no conversation
   appears.

---

## Section 10 — Capability budget audit

| Plugin | `registers` adds | `calls` adds | `subscribes` adds |
|---|---|---|---|
| `@ax/agents` | `agents:resolve-by-webhook-token`, `agents:rotate-webhook-token` | — | — |
| `@ax/validator-routine` | — | — | — (still `workspace:pre-apply`) |
| `@ax/routines` | — | `http:register-route`, `credentials:get`, `agents:resolve-by-webhook-token`, `agents:rotate-webhook-token` | — (still `workspace:applied`, `chat:turn-end`) |

Removed (vs design §6.5): `http:unregister-route` (K1) and
`credentials:get-by-name` (K2). Neither hook exists.

---

## Section 11 — Test plan

**Unit tests:**

- `validator-routine/__tests__/frontmatter.test.ts`:
  - Accepts a minimal webhook routine.
  - Rejects `trigger.path` missing / wrong shape / starts with
    `/webhooks/` / contains `..` / over 128 chars.
  - Rejects `trigger.events` items longer than 64 chars or with
    illegal characters; rejects more than 32 items.
  - Accepts `trigger.hmac` with all four fields; rejects missing
    `secretRef` / missing `header` / unknown algorithm.
  - Rejects `activeHours` when `kind: webhook`.
- `routines/__tests__/template.test.ts`:
  - `{{payload.a.b}}` walked correctly.
  - Missing field → empty string.
  - Non-object intermediate → empty string.
  - Number / boolean → `String(v)`.
  - Object / array → `JSON.stringify(v)`.
  - `{{payload}}` (no path) → whole JSON.
  - Unmatched braces left literal.
  - Confirm no path supports `..` or array indexing or function-call
    syntax (negative cases).
- `routines/__tests__/webhook-handler.test.ts`:
  - 202 flow with valid HMAC.
  - 401 on HMAC mismatch.
  - 401 on missing HMAC header when `hmac` configured.
  - 400 on malformed JSON.
  - 415 on unsupported Content-Type.
  - 204 on event filter mismatch (with `X-GitHub-Event`).
  - 404 when `routinePath` no longer in the store (race).
- `agents/__tests__/` new tests for `agents:resolve-by-webhook-token`
  (hit / miss / null on empty token) and `agents:rotate-webhook-token`
  (ACL gate, idempotent on no-op? — confirm: rotation always issues a
  new token; the "lazy first-use" idempotency lives in the routines
  caller, not in the hook).

**Integration tests (existing testcontainers harness):**

- `canary.test.ts` Phase C describe block, five cases per §7.
- Phase B canary cases remain green (no regression on tick / silence /
  shared-conversation paths).

**Migration test:**

- `agents/__tests__/migrations.test.ts` extended to assert the new
  column is added and indexed; existing rows continue to read with
  `webhook_token === null`.

---

## Section 12 — Deliberately deferred (YAGNI)

- **Admin UI for webhook URLs / token rotation.** Phase D ships the
  Routines settings tab per design §7.2. Phase C tests use direct DB
  reads or `routines:list` output for URL discovery.
- **Per-route rate limiting.** http-server's global rate-limit applies.
  Per-route lands when someone hits abuse, not now (design §6.7).
- **`X-GitHub-Delivery` replay dedup.** HMAC over the body is enough
  for v1; add the delivery-id cache when a duplicate report comes in.
- **IP allowlisting.** Infrastructure concern. URL token is the auth.
- **Multi-replica fan-out.** Documented as K3. Lands when the rest of
  the host lifts out of single-replica.
- **Synchronous webhook reply.** 202-and-go matches the design and
  every webhook producer's timeout posture.
- **Multiple webhook routes per routine.** One routine → one URL.
  Operators can declare N routine files if they want N URLs.
- **Webhook templating beyond `{{payload.x}}`.** No headers, no host,
  no request metadata. Add when a user asks; today's surface is the
  prompt-injection-amplifier-minimal version.

---

## Appendix A — Invariant audit (Phase C surface only)

| Invariant | Status | Notes |
|---|---|---|
| #1 Transport/storage-agnostic hooks | OK | New `agents:*` hooks use opaque `agentId` / `token`. No DB-isms. (K8.) |
| #2 No cross-plugin imports | OK | `@ax/routines` reaches `@ax/agents` / `@ax/credentials` / `@ax/http-server` through the bus. (K4.) |
| #3 No half-wired plugins | OK | Producer + consumer + canary same PR. PR notes name the "window CLOSED" line. (K5.) |
| #4 One source of truth | OK | Routine file is the spec. Lazy token generation has a single writer (`agents:rotate-webhook-token`). Spec_hash gates route re-binding. (K6.) |
| #5 Capabilities explicit and minimized | OK | Two `@ax/agents.registers` + four `@ax/routines.calls` additions, enumerated in §10. (K7.) |
| #6 One UI design language | OK / N/A | No UI in Phase C. Phase D admin tab will use shadcn primitives per Phase D plan. |

## Appendix B — Open questions (none load-bearing for spec)

- Should `agents:rotate-webhook-token` return the *old* token alongside
  the new one so callers can detect a no-op rotation? Today the
  contract says "always issue fresh" — even if the agent had a token,
  this generates a new one. Lazy-on-first-use is the caller's concern.
- Webhook URL display in the admin UI (Phase D): show the full URL
  with a Copy button, or hide the token behind a "reveal" affordance?
  Design §7.2 says "full URL with Copy" — confirm during Phase D.
- For non-GitHub webhook senders without `X-GitHub-Event`, the
  `events` filter should be ignored (today's design already
  short-circuits on `events.length === 0`; we should also short-circuit
  when the header is absent, even if `events.length > 0`, to avoid
  silently dropping non-GitHub traffic). The handler chain (§5 step 5)
  is written that way — flagged here for future reviewers.
