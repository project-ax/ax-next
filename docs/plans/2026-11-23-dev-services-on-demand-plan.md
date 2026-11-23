# Dev Services on Demand, and Longer Turns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a coding agent start an admin-approved service stack (imported from a compose file) inside its own sandbox on demand, mid-turn, and let its turns run up to 2 hours without any clock cutting them off.

**Architecture:** Services stay native sidecars in the sandbox pod (TASK-150..160). A connector marks its services *on demand*; a host tool records a per-conversation service set and the orchestrator swaps the sandbox inside the same `agent:invoke`, waking the new runner with a host-authored note. Per-agent turn, idle and runner-size settings flow from the agent row through the orchestrator to `sandbox:open-session` and the runner's env.

**Tech Stack:** TypeScript, zod, vitest, kysely/Postgres, Kubernetes native sidecars (1.29+), Helm chart tests (`@ax/chart-tests`), React + shadcn (channel-web).

**Spec:** `docs/plans/2026-11-12-sandbox-service-reach-design.md` (approved 2026-11-23). Read it with this plan; section refs (§) point there.

## Global Constraints

- Code baseline: origin/main `f952512ad`.
- Always-on connectors behave as today; the default connector mode is always-on.
- Service sets: at most **16 services** per on-demand connector; always-on stays at **8**.
- At most **10** live sandboxes with services per agent (chart value).
- Agent `turnLimitMinutes`: default **10**, chart cap `chat.maxTurnMinutes` **120**; `idleMinutes`: default **5**, cap `chat.maxIdleMinutes` **60**. Clamped when used, never refused on read.
- Runner size default unchanged: **1 CPU / 1 GiB** limit, **100m / 256 MiB** request; per-agent values clamped by chart maximums. Coding agent recommendation: request **2 CPU / 6 GiB**, limit **4 CPU / 8 GiB**.
- `maxTurnMinutes` must sit at least **20 minutes** inside the pod ceiling (`activeDeadlineSeconds`, 6 h).
- GKE `ingress.backendConfig.timeoutSec` **7,500** in `gke-values.yaml`; template check fails when backend config is on and `timeoutSec` ≤ `maxTurnMinutes × 60`.
- Mid-turn `proxy:rotate-session` every **30 minutes**.
- `AX_INBOX_IDLE_MS` = `max(15 min, idleMinutes + 5 min)`.
- claude-sdk runner: `BASH_MAX_TIMEOUT_MS` = turn limit, `API_TIMEOUT_MS` = **30 min**. aisdk Bash max = turn limit; Bash default stays **2 min**.
- Slack `TURN_HARD_CAP_MS` = **30 min**; orchestrator `reapHoldMaxMs` = `max(30 min, agent turn limit)`.
- Writable-path `emptyDir` size limit default **2 GiB** (chart value); every imported service also gets `/tmp`.
- Sizes on the wire are numbers: CPU in millicores, memory in MiB. No Kubernetes quantity strings in hook or IPC payloads (invariant 1).
- No cross-plugin imports; new hooks get a boundary review in the PR body; a hook merges stacked and squashed with its first caller (invariant 3).
- Run `security-checklist` on PR steps 1, 2 (sandbox boundary) and 3 (IPC).
- UI: shadcn primitives + semantic tokens in `packages/channel-web` only.
- ax-next stays operator-neutral: test fixtures are synthetic compose files, never a company's real file.
- Test command form: `pnpm --filter @ax/<pkg> test -- <file>`; type check with `pnpm --filter @ax/<pkg> build`.

## Review Focus

1. **A compose file with a `depends_on` cycle, or a condition we don't know** (`service_started` aside), must be refused at import with the service names in the message, never imported half-ordered. → Task 1.4, `refuses a depends_on cycle naming both services`.
2. **A service in the set fails to start** (bad digest, crash on a read-only path): the restart must end the turn with the TASK-160 diagnosis and clear the conversation's set, so the next turn isn't stuck failing the same way. → Task 3.3, `a failed restart clears serviceSet and reports the service`.
3. **The on-demand connector is deleted, or switched to always-on, while a conversation has its set on**: the next turn must open without that set and clear it, not throw. → Task 3.3, `a vanished set is cleared at routing`.
4. **An admin lowers a chart cap below an agent's stored `turnLimitMinutes` / runner size**: the agent keeps loading and runs at the cap. → Task 2.3, `stored limits above the cap run clamped`.
5. **Two conversations restart at once while the agent is at 9 of 10**: only one may win. Pending restarts count toward the cap. → Task 3.3, `concurrent restarts at the cap admit one`.

---

## PR step 1 — Descriptor and importer

One PR. Boundary review: the descriptor fields ride `sandbox:open-session.services` (a changed hook payload). `security-checklist`: sandbox boundary (new container `command`, init containers, `hostAliases`).

### Task 1.1: Descriptor fields (canonical schema)

**Files:**
- Modify: `packages/skills-parser/src/service-descriptor.ts`
- Test: `packages/skills-parser/src/__tests__/service-descriptor.test.ts`

**Interfaces:**
- Produces (all optional, `.strict()` kept):
  ```ts
  command?: string[];            // ≤ 32 args, each ≤ 4,096 chars
  entrypoint?: string[];         // same caps
  job?: boolean;                 // run once to exit 0 (plain init container)
  publishedPorts?: Array<{ published: number; target: number }>; // ≤ PORTS_MAX
  resources?: { cpuMillis?: { request: number; limit: number }; memoryMiB?: { request: number; limit: number } };
  storageMiB?: number;           // size of each writable path; positive int
  export const SERVICES_MAX = 16;            // carrier cap
  export const ALWAYS_ON_SERVICES_MAX = 8;
  ```
- Array order is start order. No `dependsOn` field: the importer sorts.

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts command, entrypoint, job, publishedPorts, resources, storageMiB', () => {
  const d = ServiceDescriptorSchema.parse({ ...base, command: ['mongod', '--port', '27019'],
    entrypoint: ['docker-entrypoint.sh'], job: true, publishedPorts: [{ published: 47017, target: 27017 }],
    resources: { cpuMillis: { request: 250, limit: 1000 }, memoryMiB: { request: 512, limit: 1536 } }, storageMiB: 2048 });
  expect(d.publishedPorts).toEqual([{ published: 47017, target: 27017 }]);
});
it('rejects a request above its limit', () => {
  expect(() => ServiceDescriptorSchema.parse({ ...base, resources: { memoryMiB: { request: 2048, limit: 1024 } } })).toThrow();
});
it('rejects a published port outside 1..65535', () => { /* published: 0 → throws */ });
it('carrier cap is 16', () => {
  expect(ServicesArraySchema.safeParse(Array(16).fill(0).map((_, i) => ({ ...base, name: `s${i}` }))).success).toBe(true);
  expect(ServicesArraySchema.safeParse(Array(17).fill(0).map((_, i) => ({ ...base, name: `s${i}` }))).success).toBe(false);
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @ax/skills-parser test -- service-descriptor` → FAIL (unrecognized keys / cap 8).
- [ ] **Step 3: Implement** the fields above in `ServiceDescriptorSchema` with a `superRefine` for request ≤ limit.
- [ ] **Step 4: Run, expect PASS** — same command, then `pnpm --filter @ax/skills-parser build`.
- [ ] **Step 5: Commit** — `git commit -m "feat(skills-parser): service descriptor gains command, jobs, published ports, sizes"`

### Task 1.2: Mirror the fields, and the connector mode

**Files:**
- Modify: `packages/connectors/src/types.ts` (around `:222-240`, the `services` capability), `packages/sandbox-protocol/src/schemas.ts` (the wire copy, `:229`)
- Test: `packages/connectors/src/__tests__/capability-limits.test.ts`, `packages/sandbox-protocol/src/__tests__/schemas.test.ts`

**Interfaces:**
- Consumes: Task 1.1's field shapes.
- Produces: `Capabilities.servicesMode?: 'always' | 'on-demand'` (default `'always'`); the services cap becomes `ALWAYS_ON_SERVICES_MAX` (8) unless the mode is `'on-demand'` (16). The wire `OpenSessionInput.services` accepts up to 16.

- [ ] **Step 1: Failing tests**
  - `capability-limits.test.ts`: `'9 services refused when always-on, accepted on-demand'`; `'servicesMode defaults to always'`.
  - `schemas.test.ts`: `'open-session services carry the new descriptor fields and up to 16'`; `'wire copy keys equal the canonical schema keys'`, asserting `Object.keys(wireShape).sort()` equals the canonical keys, so the three copies can't drift.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @ax/connectors test -- capability-limits` and `pnpm --filter @ax/sandbox-protocol test -- schemas`.
- [ ] **Step 3: Implement** both copies. The connector cap is a `superRefine` keyed on `servicesMode`.
- [ ] **Step 4: Run, expect PASS**; `pnpm --filter @ax/connectors build && pnpm --filter @ax/sandbox-protocol build`.
- [ ] **Step 5: Commit** — `feat(connectors,sandbox-protocol): on-demand service mode and the new descriptor fields`

### Task 1.3: Validator accepts the fields

**Files:**
- Modify: `packages/validator-service/src/plugin.ts`, `packages/validator-service/src/forbidden-vocab.ts` only if needed
- Test: `packages/validator-service/src/__tests__/plugin.test.ts`

**Interfaces:** `services:validate` keeps `{ services } → { verdict }`. It now also checks that a `job` has no `publishedPorts`, and that within one list no published port equals any service's container port or another published port.

- [ ] **Step 1: Failing tests** — `'a job with publishedPorts is invalid'`; `'a published port equal to another container port is invalid'` (reason names both services); `'the e2e-shaped fixture is clean'`.
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/validator-service test`.
- [ ] **Step 3: Implement** `checkPortClashes(services: ServiceDescriptor[]): string | null` and the job rule in `plugin.ts`.
- [ ] **Step 4: PASS**, then build.
- [ ] **Step 5: Commit** — `feat(validator-service): port-clash and job checks`

### Task 1.4: The importer (profiles, commands, order, jobs, ports, storage)

**Files:**
- Modify: `packages/skills-parser/src/compose-translate.ts`, `packages/skills-parser/src/index.ts`
- Create: `packages/skills-parser/src/__tests__/fixtures/sharded-stack.compose.yml` (a **synthetic** file shaped like the spec's case: a config server, one shard, `mongos`, three `restart: "no"` init jobs using `$${VAR}`, KRaft Kafka with `PLAINTEXT` + `EXTERNAL://localhost:<published>`, Redis on `tmpfs`, an emulator with no health check, an `app` service that bind-mounts `./src`, and three profiles)
- Test: `packages/skills-parser/src/__tests__/compose-translate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function translateComposeToServices(yaml: string, opts?: { profile?: string }): ComposeTranslateResult;
  // ok result gains:
  //   profiles: string[]                          // every profile in the file
  //   appServices: Array<{ service: string; reason: 'mounts-source' }>
  //   (services are already sorted into start order)
  export function sortByDependsOn(services: ComposeService[]): { order: string[] } | { cycle: string[] };
  export function unescapeComposeDollars(arg: string): string; // "$$" → "$"
  ```
- Rules (spec §4.2): only the chosen profile's services plus profile-less ones; `command`/`entrypoint` as argv (a string is split like compose's shell-less split); `restart: "no"` → `job: true`; both port sides → `ports` + `publishedPorts` (skip when equal); `tmpfs` and named volumes → `writablePaths` (+ `/tmp` for every service); no health check → `{ kind: 'tcp', port: ports[0] }` when a port exists; bind-mounted source → `appServices`, not imported; unknown `depends_on` condition or cycle → `invalid`.

- [ ] **Step 1: Failing tests** (against the fixture):
  - `'imports only the chosen profile and lists all profiles'`
  - `'keeps command and entrypoint and unescapes $$'` → `expect(init.command).toContain('mongo --host ${CONFIGSVR_HOST}:27019')` (inside the `bash -c` arg)
  - `'orders by depends_on: config → init → shard → init → mongos → init → rest'` → exact `services.map(s => s.name)`
  - `'restart "no" becomes a job'`
  - `'keeps published and target ports'` → `{ published: 47017, target: 27017 }`; same-number ports produce none
  - `'tmpfs and named volumes become writable paths, plus /tmp'`
  - `'a service with no health check gets a TCP check on its first port'`
  - `'a source bind mount lands in appServices with reason mounts-source'`
  - `'refuses a depends_on cycle naming both services'` (Review Focus 1)
  - `'refuses an unknown depends_on condition'`
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/skills-parser test -- compose-translate`.
- [ ] **Step 3: Implement.** `sortByDependsOn` is Kahn's algorithm with the compose file's declaration order as the tie-break, so the order is stable.
- [ ] **Step 4: PASS**, then build.
- [ ] **Step 5: Commit** — `feat(skills-parser): import compose profiles, commands, order, jobs and published ports`

### Task 1.5: Pin image tags at import

**Files:**
- Create: `packages/connectors/src/image-pin.ts`
- Modify: `packages/connectors/src/admin-routes.ts` (new admin-only route)
- Test: `packages/connectors/src/__tests__/image-pin.test.ts`, `packages/connectors/src/__tests__/admin-routes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function resolveImageDigest(ref: string, deps: { fetch: typeof fetch }): Promise<{ pinned: string } | { error: string }>;
  // route: POST /admin/connectors/pin-images  body { images: string[] } → { results: Array<{ image, pinned?, error? }> }
  ```
- Behavior: Docker Hub short names → `registry-1.docker.io/library/…`; anonymous bearer token per the registry's `WWW-Authenticate`; `HEAD /v2/<repo>/manifests/<tag>` with the OCI index and Docker manifest-list `Accept`s; `Docker-Content-Digest` → `ref@sha256:…`. Refuses IP-literal and non-HTTPS registries. Admin-only, like other connector admin routes.

- [ ] **Step 1: Failing tests** — `'pins mongo:4.4 via a fake registry'`; `'refuses an IP-literal registry'`; `'a non-admin gets 403'`; `'an already-pinned ref is returned unchanged'`.
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/connectors test -- image-pin admin-routes`.
- [ ] **Step 3: Implement** with an injected `fetch`.
- [ ] **Step 4: PASS**, then build.
- [ ] **Step 5: Commit** — `feat(connectors): pin compose image tags to digests at import`

### Task 1.6: The connector editor

**Files:**
- Modify: `packages/channel-web/src/lib/connector-form.ts` (around `:624-640`), `packages/channel-web/src/components/settings/LegacyConnectorEditDialog.tsx`
- Test: `packages/channel-web/src/lib/__tests__/connector-form.test.ts`

**Interfaces:**
- Consumes: `translateComposeToServices(yaml, { profile })`, `POST /admin/connectors/pin-images`.
- Produces: form state `{ servicesMode: 'always' | 'on-demand'; composeProfile: string | null; pinned: Record<string, string>; appServices: … }`. The dialog shows a profile `Select`, an "On demand" `Switch`, a pinned-digest list, the drops, and "Run these in the sandbox: {names}". shadcn only; copy gets a `ux-designer` pass.

- [ ] **Step 1: Failing tests** — `'picking a profile re-translates and keeps the mode'`; `'pinning replaces tags in the saved services'`; `'app services are listed, not saved'`; `'more than 8 services needs on-demand'` (error copy).
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/channel-web test -- connector-form`.
- [ ] **Step 3: Implement** the glue and the dialog fields.
- [ ] **Step 4: PASS**; `pnpm --filter @ax/channel-web build` (channel-web's tsc includes tests).
- [ ] **Step 5: Commit** — `feat(channel-web): import a compose profile as on-demand services`

### Task 1.7: Render the fields (k8s and subprocess)

**Files:**
- Modify: `packages/sandbox-k8s/src/pod-spec.ts` (`renderServiceSidecars`, `:324-385`; `buildPodSpec`, `:612`), `packages/sandbox-k8s/src/config.ts` (`serviceCpuLimitMaxMillis`, `serviceMemoryLimitMaxMiB`, `serviceStorageDefaultMiB` = 2048), `packages/sandbox-subprocess/src/compose.ts`
- Test: `packages/sandbox-k8s/src/__tests__/pod-spec.test.ts`, `packages/sandbox-subprocess/src/__tests__/compose.test.ts`

**Interfaces:**
- Consumes: Task 1.1 fields.
- Produces (k8s): `command` → container `args` when `entrypoint` is unset, else `command: entrypoint, args: command`; `job` → init container **without** `restartPolicy: 'Always'` and without a startup probe; `emptyDir: { sizeLimit: '<storageMiB>Mi' }`; per-service `resources` clamped to the config maximums (else today's defaults); `spec.hostAliases: [{ ip: '127.0.0.1', hostnames: [every service name] }]` when services exist. (`publishedPorts` reach the runner in Task 3.4.)
- Produces (subprocess): renders `command`/`entrypoint`/`resources`; refuses `job` and `publishedPorts` with `"not supported by the local sandbox"`.

- [ ] **Step 1: Failing tests**
  - `'a job renders as a plain init container in order'` — `initContainers.map(c => [c.name, c.restartPolicy ?? null])` equals the expected order.
  - `'command and entrypoint map to command/args'`
  - `'writable paths get sizeLimit from storageMiB or the default'`
  - `'service resources clamp to the configured maximum'`
  - `'hostAliases lists every service name on 127.0.0.1'`
  - `'no services → no hostAliases'` (a pod with no services is unchanged)
  - subprocess: `'renders command'`, `'refuses a job locally'`
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/sandbox-k8s test -- pod-spec`; `pnpm --filter @ax/sandbox-subprocess test -- compose`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS**, then build both.
- [ ] **Step 5: Commit** — `feat(sandbox-k8s): render service commands, jobs, sizes and host aliases`

*Spec note:* with services present, always-on pods also gain `hostAliases` (names → 127.0.0.1); the spec's §10 step 1 says so.

---

## PR step 2 — Per-agent turn, idle and runner-size settings

One PR (independent of step 1). Boundary review: `sandbox:open-session` gains `runnerSize`. `security-checklist`: sandbox boundary (resource requests, new env vars).

### Task 2.1: Agent fields

**Files:**
- Modify: `packages/agents/src/types.ts` (agent shape near `:52`, input near `:108`), `packages/agents/src/store.ts`, `packages/agents/src/migrations.ts`, `packages/agents/src/plugin.ts` (validation on create/update)
- Test: `packages/agents/src/__tests__/store.test.ts`, `packages/agents/src/__tests__/migrations.test.ts`, `packages/agents/src/__tests__/plugin.test.ts`

**Interfaces:**
- Produces on `Agent` and its input:
  ```ts
  turnLimitMinutes?: number | null;  // int 1..1440 stored; clamped at use
  idleMinutes?: number | null;       // int 1..1440
  runnerSize?: { cpuMillis?: { request: number; limit: number }; memoryMiB?: { request: number; limit: number } } | null;
  ```
- Who may set: unchanged `assertWriteAllowed` (`plugin.ts:1097`).

- [ ] **Step 1: Failing tests** — `'round-trips turn, idle and runner size'`; `'request above limit is refused'`; `'additive migration leaves existing rows null'`; `'a member of a team agent can set them'`.
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/agents test -- store migrations plugin`.
- [ ] **Step 3: Implement**: three nullable columns (`runner_size` as jsonb), zod on input.
- [ ] **Step 4: PASS**, then build.
- [ ] **Step 5: Commit** — `feat(agents): per-agent turn limit, idle and runner size`

### Task 2.2: Chart caps and boot checks

**Files:**
- Modify: `deploy/charts/ax-next/values.yaml` (`chat:` near `:910`), `deploy/charts/ax-next/values.schema.json`, `deploy/charts/ax-next/gke-values.yaml` (`:208` → 7500), `deploy/charts/ax-next/templates/_helpers.tpl` (new `ax-next.validateTurnCap`), `presets/k8s/src/index.ts` (read caps; boot check)
- Test: `deploy/charts/ax-next/__tests__/render.test.ts`, `presets/k8s/src/__tests__/turn-caps.test.ts` (create)

**Interfaces:**
- Values: `chat.maxTurnMinutes: 120`, `chat.maxIdleMinutes: 60`, `chat.maxServiceSandboxesPerAgent: 10`, `sandbox.runnerMax: { cpuMillis: 8000, memoryMiB: 16384 }`, `sandbox.serviceMax: { cpuMillis: 4000, memoryMiB: 4096 }`, `sandbox.serviceStorageDefaultMiB: 2048`, `sandbox.nodeAllocatableMiB` (optional).
- Preset: `export function checkTurnCaps(c: { maxTurnMinutes: number; activeDeadlineSeconds: number }): void` throws unless `maxTurnMinutes*60 + 1200 ≤ activeDeadlineSeconds`; `export function checkNodeFit(c: { runnerMaxMiB: number; largestServiceSetMiB: number; nodeAllocatableMiB?: number }): string | null` (a warning, logged, when it can't fit).

- [ ] **Step 1: Failing tests** — chart: `'gke values render timeoutSec 7500'`, `'render fails when backendConfig is on and timeoutSec ≤ maxTurnMinutes*60'`; preset: `'refuses a turn cap within 20 min of the pod ceiling'`, `'node-fit warns when runner max plus a service set exceeds the node'`.
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/chart-tests test -- render`; `pnpm --filter @ax/preset-k8s test -- turn-caps`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS**, then `pnpm --filter @ax/preset-k8s build`.
- [ ] **Step 5: Commit** — `feat(chart): turn and idle caps, LB timeout above the turn cap, boot checks`

### Task 2.3: Runner size and new env on the wire

**Files:**
- Modify: `packages/sandbox-protocol/src/schemas.ts` (`OpenSessionInput`), `packages/sandbox-protocol/src/bootstrap.ts` (`controlNames`, `:20`: add `AX_INBOX_IDLE_MS`, `AX_TURN_LIMIT_MS`), `packages/sandbox-k8s/src/pod-spec.ts` (runner resources, `:933-936` and `:1008-1010`), `packages/sandbox-k8s/src/shared-pool.ts` (sized sessions skip the pool, beside the services skip near `:170`), `packages/agent-runner-core/src/env.ts` (`RunnerEnv.inboxIdleMs`, `turnLimitMs`), `packages/agent-runner-core/src/run-runner.ts` (pass `idleTimeoutMs`)
- Test: `packages/sandbox-protocol/src/__tests__/schemas.test.ts`, `packages/sandbox-protocol/src/__tests__/bootstrap.test.ts`, `packages/sandbox-k8s/src/__tests__/pod-spec.test.ts`, `packages/sandbox-k8s/src/__tests__/shared-pool.test.ts`, `packages/agent-runner-core/src/__tests__/env.test.ts`, `packages/sandbox-k8s/src/__tests__/open-session-schema.test.ts`

**Interfaces:**
- Produces: `OpenSessionInput.runnerSize?: { cpuMillis?: { request: number; limit: number }; memoryMiB?: { request: number; limit: number } }`; `OpenSessionInput.env` may carry the two new names; k8s renders `cpu: '<m>m'`, `memory: '<MiB>Mi'` clamped to `sandbox.runnerMax`; `readRunnerEnv()` returns `inboxIdleMs?: number`, `turnLimitMs?: number`.

- [ ] **Step 1: Failing tests**
  - `'runnerSize renders on the runner container in both renderers'`
  - `'runnerSize clamps to the configured max'`
  - `'a sized session never takes a pool pod'`
  - `'bootstrap allows AX_INBOX_IDLE_MS and AX_TURN_LIMIT_MS'`
  - `'readRunnerEnv parses AX_INBOX_IDLE_MS'`; `'a non-numeric value is ignored'`
  - `'stored limits above the cap run clamped'` (Review Focus 4) — in `open-session-schema.test.ts`: an oversized request renders at the max.
- [ ] **Step 2: FAIL** — run each package's test filter.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS**; build `@ax/sandbox-protocol`, `@ax/sandbox-k8s`, `@ax/agent-runner-core`.
- [ ] **Step 5: Commit** — `feat(sandbox): per-session runner size and idle/turn env`

### Task 2.4: The orchestrator uses the settings

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` — the turn timer (`:5043-5044`), the reap arming (`:5271`), the hold (`:2248`), the rotate call (`:5222`), session open (pass `runnerSize` and env), warm-sandbox routing (retire when time left < turn limit + 10 min)
- Create: `packages/chat-orchestrator/src/agent-limits.ts`
- Test: `packages/chat-orchestrator/src/__tests__/invoke-timeout.test.ts`, `packages/chat-orchestrator/src/__tests__/keepalive.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface EffectiveLimits { turnMs: number; idleMs: number; inboxIdleMs: number; reapHoldMs: number; runnerSize?: RunnerSize }
  export function effectiveLimits(agent: Pick<Agent,'turnLimitMinutes'|'idleMinutes'|'runnerSize'>, caps: { maxTurnMinutes: number; maxIdleMinutes: number; defaults: { turnMs: number; idleMs: number } }): EffectiveLimits;
  // inboxIdleMs = max(15 min, idleMs + 5 min); reapHoldMs = max(30 min, turnMs)
  ```
- Mid-turn rotation: while a turn runs, `setInterval(30 min)` → `proxy:rotate-session` (cleared at turn end).

- [ ] **Step 1: Failing tests**
  - `'a 120-minute agent turn is not cut at 10 minutes'` (fake timers)
  - `'idleMinutes 30 arms the reaper at 30 min'`
  - `'turn limit above the cap runs at the cap'`
  - `'rotation fires every 30 min during a turn and stops at turn end'`
  - `'a warm sandbox with less than turn limit + 10 min left is retired, not reused'`
  - `'the open-session call carries runnerSize, AX_INBOX_IDLE_MS and AX_TURN_LIMIT_MS'`
  - `'reap hold is max(30 min, turn limit)'`
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/chat-orchestrator test -- invoke-timeout keepalive`.
- [ ] **Step 3: Implement** `effectiveLimits` and wire it in.
- [ ] **Step 4: PASS**, then build.
- [ ] **Step 5: Commit** — `feat(chat-orchestrator): per-agent turn, idle and runner size; mid-turn rotation`

### Task 2.5: Long tool calls in both runners

**Files:**
- Modify: `packages/agent-aisdk-runner/src/tools/builtins.ts` (`:50-54`, `resolveBashTimeoutMs`, `:367`), `packages/agent-aisdk-runner/src/main.ts`, `packages/agent-claude-sdk-runner/src/main.ts` (SDK env)
- Test: `packages/agent-aisdk-runner/src/__tests__/builtins.test.ts`, `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`

**Interfaces:**
- `resolveBashTimeoutMs(raw: unknown, maxMs: number = BASH_MAX_TIMEOUT_MS): number`; `maxMs` = `turnLimitMs` when set.
- claude-sdk: the SDK env gains `BASH_MAX_TIMEOUT_MS: String(turnLimitMs)` and `API_TIMEOUT_MS: '1800000'` when `turnLimitMs` is set.

- [ ] **Step 1: Failing tests** — `'bash max follows the turn limit'` (`resolveBashTimeoutMs(3_600_000, 7_200_000) === 3_600_000`); `'default stays 2 min'`; `'without a turn limit the max stays 10 min'`; claude-sdk `'SDK env carries BASH_MAX_TIMEOUT_MS and API_TIMEOUT_MS'`.
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/agent-aisdk-runner test -- builtins`; `pnpm --filter @ax/agent-claude-sdk-runner test -- main`.
- [ ] **Step 3: Implement.** The Bash tool's description string names the live max.
- [ ] **Step 4: PASS**; build both.
- [ ] **Step 5: Commit** — `feat(runners): long Bash commands up to the turn limit`

### Task 2.6: Stream buffer, Slack cap

**Files:**
- Modify: `packages/channel-web/src/server/plugin.ts` (`:797-800`: size from `maxTurnMinutes`), `presets/k8s/src/index.ts` (`:978`, `:1529`: pass `maxTurnMinutes`), `packages/channel-slack/src/limits.ts` (`:217` → `1_800_000`)
- Test: `packages/channel-web/src/server/__tests__/plugin.test.ts` (or the existing chunk-buffer test), `packages/channel-slack/src/__tests__/turn.test.ts`

**Interfaces:** channel-web config `maxTurnMs?: number` → `shellMaxAgeMs = maxTurnMs + SHELL_AGE_SLACK_MS`.

- [ ] **Step 1: Failing tests** — `'shell max age follows the turn cap, not the default timeout'`; Slack `'a reply is cut at 30 minutes, not 15'` (fake timers at 15:01 → still open; 30:01 → error).
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/channel-web test -- plugin`; `pnpm --filter @ax/channel-slack test -- turn`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS**; build.
- [ ] **Step 5: Commit** — `feat: stream buffer sized from the turn cap; Slack reply cap 30 min`

### Task 2.7: Settings UI

**Files:**
- Modify: `packages/channel-web/src/components/workspace/AgentSettings.tsx`
- Test: `packages/channel-web/src/components/workspace/__tests__/AgentSettings.test.tsx`

**Interfaces:** an "Advanced" `Collapsible` with `Field` + `Input` for turn limit and idle (minutes), and runner CPU/memory (request/limit), with the chart caps shown as hints. Saves through the existing agent update call.

- [ ] **Step 1: Failing tests** — `'Advanced shows turn, idle and runner size'`; `'a value above the cap shows the cap hint'`; `'saving sends the fields'`.
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/channel-web test -- AgentSettings`.
- [ ] **Step 3: Implement** (shadcn skill; `ux-designer` copy pass).
- [ ] **Step 4: PASS**; `pnpm --filter @ax/channel-web build`.
- [ ] **Step 5: Commit** — `feat(channel-web): advanced agent limits`

---

## PR step 3 — Services on demand

One PR, a stack squashed on merge: the conversation hook and the `host-note` entry land with their first caller, the orchestrator (invariant 3). Boundary reviews: `conversations:set-service-set`, `serviceSet` on `conversations:get`, the `host-note` inbox entry. `security-checklist`: IPC (`host-note`) and sandbox (forwards).

### Task 3.1: `serviceSet` on conversations

**Files:**
- Modify: `packages/conversations/src/types.ts`, `packages/conversations/src/store.ts`, `packages/conversations/src/migrations.ts`, `packages/conversations/src/plugin.ts` (register beside `conversations:set-title`, `:260`)
- Create: `packages/conversations/src/__tests__/set-service-set.test.ts`
- Test: `packages/conversations/src/__tests__/migrations.test.ts`, `packages/conversations/src/__tests__/return-schemas.test.ts`

**Interfaces:**
- Produces: service hook `conversations:set-service-set` `{ conversationId: string; serviceSet: string | null } → { ok: true }` (owner-scoped like `set-title`); `conversations:get` returns `serviceSet: string | null`.

- [ ] **Step 1: Failing tests** — `'sets and clears serviceSet'`; `'get returns serviceSet null by default'`; `'another user cannot set it'`; `'additive migration'`.
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/conversations test -- set-service-set migrations return-schemas`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS**; build.
- [ ] **Step 5: Commit** (stacked) — `feat(conversations): per-conversation service set`

### Task 3.2: The `host-note` inbox entry

**Files:**
- Modify: `packages/ipc-protocol/src/actions.ts` (`SessionNextMessageResponseSchema`, `:809-862`), `packages/session-inmemory/src/types.ts` (`InboxEntry`, `:102`; zod `:404`), `packages/session-inmemory/src/inbox.ts`, `packages/session-postgres/src/inbox.ts`, `packages/session-postgres/src/migrations.ts` (`:170` type union), `packages/ipc-core/src/handlers/session-next-message.ts`, `packages/agent-runner-core/src/inbox-loop.ts` (`:69`), `packages/agent-runner-core/src/run-runner.ts` (beside the `decision-resolved` branch, `:1120`)
- Create: `packages/agent-runner-core/src/host-note-turn.ts`
- Test: `packages/ipc-protocol/src/__tests__/actions.test.ts`, `packages/session-inmemory/src/__tests__/inbox.test.ts`, `packages/session-postgres/src/__tests__/plugin.test.ts`, `packages/agent-runner-core/src/__tests__/inbox-loop.test.ts`, `packages/agent-runner-core/src/__tests__/run-runner.test.ts`

**Interfaces:**
- Wire: `{ type: 'host-note'; note: string; cursor: number }`, `note` ≤ 4,000 chars.
- Runner: `export function composeHostNoteMessage(note: string): string`, which frames the note as host-authored the way `decision-turn.ts` does (no person's words). A `host-note` opens a turn like `decision-resolved`, with no `chat:start` re-check: it is the same `agent:invoke`.

- [ ] **Step 1: Failing tests** — `'next-message accepts host-note'`; `'queue-work stores and returns host-note (inmemory, postgres)'`; `'a host-note opens a turn with a host-framed message'`; `'a host-note note containing a fake system line is quoted, not trusted'`.
- [ ] **Step 2: FAIL** — each package's test filter.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS**; build all six packages.
- [ ] **Step 5: Commit** (stacked) — `feat(ipc): host-note inbox entry`

### Task 3.3: Orchestrator — sets, tools, in-turn restart, cap

**Files:**
- Modify: `packages/chat-orchestrator/src/connector-union.ts` (`foldConnectorCaps`, `:860`; connector shape `:99-103`), `packages/chat-orchestrator/src/orchestrator.ts` (fold call `:4457-4470`, routing, invoke loop), `packages/chat-orchestrator/src/plugin.ts` (manifest `calls`/`registers`)
- Create: `packages/chat-orchestrator/src/service-sets.ts`, `packages/chat-orchestrator/src/service-tools.ts`
- Modify: `packages/tool-policy/src/rules.ts` (beside `routines.list`, `:440`: `services.restart` and `services.stop`, `providedBy: 'host'`, `verdict: 'allow'`)
- Test: `packages/chat-orchestrator/src/__tests__/connector-union.test.ts`, `packages/chat-orchestrator/src/__tests__/services-canary.test.ts`, create `packages/chat-orchestrator/src/__tests__/restart-with-services.test.ts`, `packages/tool-policy/src/__tests__/rules.test.ts`

**Interfaces:**
- Consumes: `conversations:set-service-set`, `conversations:get().serviceSet`, `session:queue-work` with `host-note`, `sandbox:open-session`.
- Produces:
  ```ts
  // connector-union.ts (existing function, new last param; connector shape gains servicesMode?: 'always' | 'on-demand')
  export function foldConnectorCaps(connectors, allowSet, creds, slotOwners, opts?: { serviceSet: string | null }): FoldConnectorResult; // on-demand services only when connector.id === opts.serviceSet
  // service-sets.ts
  export function listServiceSets(connectors: FoldConnector[]): Array<{ set: string; label: string; services: Array<{ name: string; ports: number[]; publishedPorts: Array<{published:number;target:number}> }> }>;
  export function buildServicesNote(set: { label: string; services: … }): string; // host constants + names/addresses only
  export class ServiceSandboxCounter { tryReserve(agentId: string, max: number): boolean; release(agentId: string): void; } // counts live + pending
  // service-tools.ts
  export const RESTART_WITH_SERVICES = 'restart_with_services';
  export const STOP_SERVICES = 'stop_services';
  ```
- `restart_with_services({ set })`: refuses when `serviceSet` is set, when this invoke already restarted, when `set` isn't one of `listServiceSets`, or past the cap. Otherwise it sets the conversation's set, marks the invoke `pendingRestart`, and returns the "turn ends here" text. When that runner segment ends, the invoke loop closes the sandbox, opens one with the set, queues `host-note(buildServicesNote(...))`, and keeps the same deferred, SSE and turn timer.
- `stop_services()`: clears the set. A warm sandbox whose folded set ≠ the conversation's is retired at its next routing.

- [ ] **Step 1: Failing tests**
  - `'on-demand services fold only for the matching set'`; `'always-on services always fold'`
  - `'restart swaps the sandbox inside one invoke and the turn continues'`: one `agent:invoke` result, two `sandbox:open-session` calls, the second with the services, and the `host-note` queued
  - `'refuses when services are already on'`; `'refuses a second restart in the same invoke'`; `'refuses an unknown set'`
  - `'concurrent restarts at the cap admit one'` (Review Focus 5)
  - `'a failed restart clears serviceSet and reports the service'` (Review Focus 2): open-session rejects with a TASK-160 diagnosis → `chat:turn-error` carries it, and `set-service-set(null)` is called
  - `'a vanished set is cleared at routing'` (Review Focus 3)
  - `'stop_services clears the set; the next routing retires the warm sandbox'`
  - `'a routine invoke can restart; the next check-in starts without services'`
  - tool-policy: `'restart_with_services and stop_services default to allow'`
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/chat-orchestrator test -- connector-union restart-with-services services-canary`; `pnpm --filter @ax/tool-policy test -- rules`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS**; build `@ax/chat-orchestrator`, `@ax/tool-policy`.
- [ ] **Step 5: Commit** (stacked) — `feat(chat-orchestrator): restart a conversation with on-demand services`

### Task 3.4: Loopback forwards in the runner

**Files:**
- Create: `packages/agent-runner-core/src/service-forwards.ts`
- Modify: `packages/agent-runner-core/src/env.ts` (`serviceForwards`), `packages/agent-runner-core/src/run-runner.ts` (start at boot, close on exit), `packages/sandbox-protocol/src/bootstrap.ts` (allow `AX_SERVICE_FORWARDS`), `packages/sandbox-k8s/src/pod-spec.ts` (set `AX_SERVICE_FORWARDS` = JSON of every service's `publishedPorts` on the runner, only when non-empty)
- Test: create `packages/agent-runner-core/src/__tests__/service-forwards.test.ts`

**Interfaces:**
- `export async function startServiceForwards(map: ReadonlyArray<{ published: number; target: number }>, deps?: { net?: typeof import('node:net') }): Promise<{ close(): Promise<void> }>`: listens on `127.0.0.1:<published>` and pipes to `127.0.0.1:<target>`. A bind failure logs and skips that port, never crashing the runner.

- [ ] **Step 1: Failing tests** — `'bytes flow published → target'`; `'listens on 127.0.0.1 only'`; `'a taken port is skipped with a log line'`; `'close releases the ports'`; pod-spec `'publishedPorts become AX_SERVICE_FORWARDS on the runner'`; bootstrap `'AX_SERVICE_FORWARDS is allowed'`.
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/agent-runner-core test -- service-forwards`; `pnpm --filter @ax/sandbox-k8s test -- pod-spec`; `pnpm --filter @ax/sandbox-protocol test -- bootstrap`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS**; build.
- [ ] **Step 5: Commit** (stacked) — `feat(agent-runner-core): loopback forwards for published service ports`

### Task 3.5: Presets and the canary

**Files:**
- Modify: `presets/k8s/src/index.ts` (pass `maxServiceSandboxesPerAgent`; on-demand on), `presets/memory/src/index.ts` (on-demand sets off: the tools list none), `presets/k8s/src/__tests__/acceptance.test.ts`
- Test: `presets/k8s/src/__tests__/acceptance.test.ts`

**Interfaces:** orchestrator config `onDemandServices: { enabled: boolean; maxPerAgent: number }`. No new plugin is added, so `PLUGINS_TO_DROP` (`acceptance.test.ts:130`) is unchanged; confirm with a grep.

- [ ] **Step 1: Failing test** — `'canary: restart_with_services with a one-service set opens a second sandbox carrying it and the turn ends once'`.
- [ ] **Step 2: FAIL** — `pnpm --filter @ax/preset-k8s test -- acceptance`.
- [ ] **Step 3: Implement** the config wiring.
- [ ] **Step 4: PASS**; build both presets. Then the full gate: `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`.
- [ ] **Step 5: Commit**, then squash the stack for merge — `feat: dev services on demand`

---

## PR step 4 — Walk (walk)

### Task 4.1: Kind walk

**Files:** Modify `deploy/MANUAL-ACCEPTANCE.md` (append the scenario); record results in the PR.

Every `kubectl` call passes `--context kind-ax-next-dev`. Use the `k8s-acceptance-loop` skill with Playwright. Deploy steps 1–3 to kind first.

- [ ] **1. Import.** As an admin, paste a compose file shaped like the spec's (sharded Mongo, KRaft Kafka, Redis, emulator, app service), pick `e2e`, turn on "On demand", pin, and save. **See:** digests pinned, the app service listed as "run in the sandbox", 9 services saved.
- [ ] **2. Restart in a chat.** Give the coding agent `turnLimitMinutes: 120`, `idleMinutes: 30` and runner request 2 CPU / 6 GiB. In a chat, ask it to run the e2e stack. **See:** it calls `restart_with_services({ set: 'e2e' })`; one stream, no second turn in the UI; `kubectl --context kind-ax-next-dev get pod -o yaml` shows init containers in the §4.3 order (jobs without `restartPolicy`), `hostAliases`, and runner resources 2/6Gi; the host note appears in the transcript as host-authored. Record any writable paths images needed.
- [ ] **3. In the sandbox.** `npm install` against the private registry host through the proxy; start the worker with the compose addresses; run the e2e command. **See:** install succeeds with no token in the sandbox env; `mongos-e2e:27017`, `kafka-e2e:9092` and `localhost:47017` all connect; tests pass with the GDAL ones skipped.
- [ ] **4. Silent long think.** Prompt for a 20-minute deliberation before any tool call (or stub the provider to stream thinking for 20 min). **See:** the turn completes; no `chat-run-timeout`, no tunnel teardown, and the web stream stays open.
- [ ] **5. Long test run.** Run `sleep 900 && echo done` as one Bash call with a 20-minute timeout. **See:** `done` comes back; no Bash timeout at 10 min.
- [ ] **6. Long turn past an hour** (a 70-minute turn with periodic output). **See:** the web stream survives 60 minutes on GKE values rendered locally (check the template output), and rotation logs fire at 30 and 60 minutes.
- [ ] **7. Slack's 30 minutes.** From Slack, start a 20-minute task in a thread. **See:** the reply completes (it would have been cut at 15). A 35-minute one is cut at 30 with the usual error.
- [ ] **8. Check-in.** A task check-in restarts with `e2e`. **See:** the fire logs one run; the next check-in's pod has no services.
- [ ] **9. Parallel and cap.** Two chats on the same agent each restart. **See:** two pods with separate data. Set the cap to 2 and restart a third. **See:** the refusal names the cap.
- [ ] **10. Stop.** `stop_services`, then the next message after reap. **See:** the new pod has no sidecars.
- [ ] **11. Commit** the MANUAL-ACCEPTANCE addition and the results.
