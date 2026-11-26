# Dev services on demand, and longer turns (design)

**Status:** approved 2026-11-23 (Vinay). Replaces the env-pod design approved
2026-11-13.
**Owner:** Vinay · **Started:** 2026-11-12 · **Code cited at:** `f952512ad` (main)
**Siblings:** `2026-11-12-agent-handoff-design.md` (Project 2),
`2026-11-12-unattended-task-questions-design.md` (Project 3). This is Project 1,
and it ships first. (The file keeps its first name so links don't break.)

A coding agent needs real services to test against: a sharded Mongo, Kafka,
Redis, a Firestore emulator. AX can already run services like these inside the
agent's sandbox pod, as sidecars (TASK-150..160). This design does three things
with that:

1. **On demand.** The services start only in a conversation that asks for them,
   through one tool. Everything else keeps a plain, fast sandbox.
2. **From the repo's compose file.** An admin pastes `docker-compose.yml`, picks
   a profile, and gets services that work without editing the file.
3. **Longer turns.** A coding agent can think, build and run tests for up to 2
   hours in one turn without any clock cutting it off.

The short version of the security model: **nothing new crosses the pod.** The
services live in the sandbox pod, share its network, and reach nothing the
sandbox can't already reach. Only an admin picks which images run.

---

## 1. Decisions

| # | Decision | Status |
|---|---|---|
| 1 | **No separate env pods.** Services run inside the agent's sandbox pod, as today's sidecars. | Decided (Vinay, 2026-11-23) |
| 2 | **On-demand connectors.** An admin marks a connector's services "on demand" instead of always-on. Always-on connectors keep today's behavior. | Decided (Vinay, 2026-11-23) |
| 3 | **One tool restarts the conversation with services**, from any conversation: a chat, a check-in, Slack (§3). | Decided (Vinay, 2026-11-23) |
| 4 | **The setting is per conversation and sticky** until the agent turns it off. Task check-ins are fresh conversations, so they start without services. | Our call |
| 5 | **The restart happens inside the same turn.** To the caller (web chat, Slack, a check-in) it is one turn; the orchestrator swaps the sandbox in the middle (§3.2). | Our call |
| 6 | **A per-agent cap on sandboxes running with services: 10**, a chart value. Past it the tool refuses in plain words. Up to **16 services per set**. | Decided (Vinay, 2026-11-23) |
| 7 | **Services come from the repo's compose file, one profile.** For the coding agent that's `e2e`. | Decided (Vinay, 2026-11-23) |
| 8 | **The importer learns what `e2e` needs** (§4): `command`/`entrypoint`, start order, one-shot jobs, service names on `localhost`, published ports, pinning at import, sizes, more than 8 services. | Our call |
| 9 | **The worker runs in the sandbox, without GDAL, for now.** The repo's code must run when GDAL isn't found; e2e tests that need it skip. | Decided (Vinay, 2026-11-23) |
| 10 | **npm reaches the private package registry host** through a connector host and a credential slot. | Decided (Vinay, 2026-11-23) |
| 11 | **Per-agent turn and idle settings**, with chart caps, mid-turn credential refresh and the stream fixes (§6). | Decided (Vinay, 2026-11-12) |
| 12 | **No clock may cut off a long silent think or a long test run** inside the agent's turn limit (§6.1). | Decided (Vinay, 2026-11-23) |
| 13 | **A per-agent runner size** (CPU and memory, request and limit), clamped by chart maximums; defaults unchanged (§3.5). | Decided (Vinay, 2026-11-23) |
| 14 | **Slack's cap on one reply goes from 15 to 30 minutes** (§6.5). | Decided (Vinay, 2026-11-23) |

## 2. How we got here

- **First, env pods.** Services in their own pods, started by the host, fenced
  by network policy and owner labels, so their data could survive from one
  check-in to the next.
- **Then, an outside service.** We moved that to a separate env service with a
  small AX bridge, then added a gateway so engineers could run envs in parallel,
  share them and inspect an agent's. It kept growing.
- **Back to the sandbox.** The one requirement that pushed services out of the
  sandbox was data surviving between check-ins. The repo says nobody needs
  that: its `test` and `e2e` profiles, and `agent-compose.yaml`, all keep data
  on `tmpfs`. The tests expect a fresh stack every run. So the services can live
  and die with the sandbox, which AX already supports.

Remote envs for engineers (many in parallel, sharing, inspecting an agent's) are
a possible later project. They're not designed here. Engineers keep
`agent-compose.sh` on their own machines.

## 3. Services on demand

### 3.1 On-demand connectors

A connector's `services` already fold into `sandbox:open-session`
(`chat-orchestrator/src/orchestrator.ts:4466-4490`, collisions refused with
`ConnectorServiceCollisionError`, then `services:validate`). Each becomes a
native sidecar in the sandbox pod (`sandbox-k8s/src/pod-spec.ts:298-385`):
started in order, each gated by its startup probe, sharing the pod's
`localhost`.

**New:** a per-connector mode, *always-on* (today, the default) or *on
demand*. An on-demand connector's services are a **service set** named after
the connector (`e2e`, say). The orchestrator folds them only into a sandbox
whose conversation has that set turned on (§3.3). The builder names the field.
*Our call.*

### 3.2 The tool

`restart_with_services({ set })` (working name), registered as a host tool by
`@ax/chat-orchestrator` with `tool:register`, the way `@ax/routines` registers
`routine_*` (`routines/src/plugin.ts:56`). Its description lists the agent's
service sets and what each contains, and says: **save your work first** (push
the branch, or write to `/files`). The sandbox's working directory doesn't
survive; the conversation does.

What happens, all inside the one `agent:invoke`:

1. The tool records the set on the conversation (§3.3) and returns "Restarting
   with the `e2e` services. Your turn ends here and continues in a new
   sandbox." The runner finishes its segment.
2. The orchestrator closes the sandbox and opens a new one for the same
   conversation, with the set's services. Opening already waits for sidecars,
   with a budget that grows by 2 minutes per service
   (`sandbox-k8s/src/config.ts`, `perServiceColdStartMs`;
   `open-session.ts:574-580`).
3. It sends the new runner a **host-written opening note**, never the person's
   words: "You're now running with the e2e services: Mongo at
   `mongos-e2e:27017` (also `localhost:47017`), Kafka at `kafka-e2e:9092` (also
   `localhost:9294`), … Continue where you left off." The host already keeps
   the transcript (the runner reads it back with the `session.get-transcript`
   IPC action), so the model sees everything before the restart.
4. The turn carries on and ends as usual. The caller never saw a second turn:
   the web chat keeps one stream, Slack keeps one reply, a check-in is one
   fire. A message sent while the first segment ran, which the runner folded
   into it, ends with the turn too: the final turn-end names it, so its own
   spinner stops then (TASK-1224).

**Why inside one turn.** Starting a *new* turn would need every caller (web,
Slack, routines) to learn about it and to show its output. Keeping it one
turn changes none of them. The turn limit (§6) counts the whole thing,
restart included. *Our call.*

**The opening note reuses a mechanism that exists.** A resolved decision already
wakes a runner with a host-authored note (`decision-resolved`,
`agent-runner-core/src/inbox-loop.ts:69-101`, `decision-turn.ts`,
`ipc-protocol/src/actions.ts:837`). The restart needs the same thing for a
fresh runner: a general `host-note` entry, or `decision-resolved` widened.
That's a wire change, with a boundary review (§7).

**Guards.** *Our call.*

- The tool refuses when the conversation already has a set on ("Services are
  already running"). To switch sets, turn them off first.
- It refuses in a turn that has already restarted once, so an agent can't loop.
- It refuses past the per-agent cap (§3.4), naming it.
- An unattended turn (a check-in, a Slack outsider's turn) can call it. The
  continuation is an ordinary turn: anything that needs approval is held and
  waits as usual.
- Default tool verdict: allowed. It only starts admin-approved images inside
  the agent's own sandbox. The builder checks this against `@ax/tool-policy`'s
  defaults.

**Turning services off:** `stop_services()` clears the conversation's set. It
doesn't restart anything. The running sandbox keeps its services until it's
reaped; the conversation's next sandbox has none. A warm sandbox whose set no
longer matches the conversation's is retired at its next turn, the way the
orchestrator already retires warm sandboxes for other reasons
(`orchestrator.ts:2486-2720`). *Our call.*

### 3.3 Where the setting lives

On the conversation row, owned by `@ax/conversations`: a nullable `serviceSet`
(the builder names it), set and cleared through a new service hook. The
orchestrator already reads the conversation when it routes a turn
(`conversations:get`), and reads `serviceSet` there before opening a sandbox.
One source of truth (invariant 4). *Our call.*

- A chat's later turns reuse the warm sandbox, services and data included,
  while it lives (§5).
- If it was reaped, the next sandbox starts the services again, **empty**.
- A task's check-ins each start a fresh conversation
  (`routines-contract/src/definition.ts:450`), so a check-in starts without
  services and asks again when it needs them.

### 3.4 The cap

At most 10 live sandboxes with services per agent (`chat.maxServiceSandboxesPerAgent`,
the builder names it; decision 6). The orchestrator counts its own warm sandboxes, which is
exact because the chart pins the host to one replica
(`ax-next.validateHostReplicas`, `templates/_helpers.tpl:538`). Past it, the tool says: "Fern already has 10
conversations running services. Try again when one finishes." *Our call.*

**What 10 costs.** One `e2e` sandbox is about 3 GiB of services (§4.5) plus
the coding agent's runner (§3.5): about 11 GiB at the limits, about 9 GiB of
requests. Ten of them is roughly 110 GiB at the limits for one agent, which is
what the sandbox node pool and the budget should be sized for.

### 3.5 Sizing the sandbox

Today every sidecar gets the same chart-wide resources (limit 1 CPU / 1 GiB,
request 100m / 512 MiB: `serviceCpuLimit` and friends, `config.ts:266-269`), and
the runner container gets one chart-wide size too (limit 1 CPU / 1 GiB, request
100m / 256 MiB: `cpuLimit`, `memoryLimit`, `config.ts:259-262`, rendered at
`pod-spec.ts:933-936` and `:1008-1010`). Nothing about size is on the
`sandbox:open-session` wire.

- **Per-service resources.** The descriptor gets an optional `resources`
  (request and limit), clamped by chart maximums. JVM Kafka and the Firestore
  emulator need more than 1 GiB.
- **A per-agent runner size** (decision 13). Two optional agent fields, CPU and
  memory, each a request and a limit, beside `turnLimitMinutes` (§6.2). Whoever
  can edit the agent sets them; the chart's maximums clamp them; unset means
  today's 1 CPU / 1 GiB. The orchestrator passes the size on
  `sandbox:open-session` (a new optional field, §7), and the k8s backend renders
  it on the runner container.
- **The coding agent: request 2 CPU / 6 GiB, limit 4 CPU / 8 GiB.** Why:
  `npm install`, the worker (Node) and the e2e test runner all run in the runner
  container, at the same time, while the services run beside it. 1 GiB fits
  none of that.
- **Sized sessions skip the warm pool.** Pool pods come from one template
  (`sandbox-k8s/src/shared-pool.ts`), so a session with a non-default size, like
  one with services, always gets a fresh pod.

**How it fits on a node.** The pod's request is what the scheduler places.
Native sidecars run for the pod's whole life, so their requests add to the
runner's; a job (a plain init container) counts only while it runs, so it adds
nothing past the largest of them. For the coding agent's `e2e` sandbox that's
about 6 GiB (runner) + 6 × 512 MiB (the long-running services, at today's
default request) ≈ 9 GiB requested, about 11 GiB at the limits. So the sandbox
nodes need at least about 12 GiB allocatable (a 16 GB machine), or the pod
never schedules. The preset checks at boot that the chart's largest runner plus
its largest service set fits the configured node size, where it knows it, and
says so plainly when it doesn't. *Our call.*

## 4. Importing the compose file

### 4.1 The test case

The repo's `docker-compose.yml`, profile `e2e`: a sharded Mongo 4.4 (config
server, one shard, `mongos`, three one-shot init jobs), Kafka in KRaft mode,
Redis, the Firestore emulator, and a `worker` built from the repo's own source.
The repo also has `agent-compose.yaml`, written for agents running in parallel
(no profiles, no `container_name`, no published ports, data on `tmpfs`). It
mirrors `test`, not `e2e`, so it has no Firestore emulator. It may be the better
source once the repo's owners add an e2e variant.

The connector editor already turns a pasted compose file into descriptors
(`skills-parser/src/compose-translate.ts`, from
`channel-web/src/lib/connector-form.ts:631`). It keeps only `image`,
`environment`, container `ports` and a `CMD` health check, and drops and
reports bind mounts, `privileged` and the other escape hatches. On this file
that gives a broken stack: every `mongod` would start with the image's default
command, the init jobs would run with no order, and `shard0-e2e:27018` resolves
to nothing.

### 4.2 What the importer and the pod learn

*Our call* throughout.

| Compose | Becomes | Why `e2e` needs it |
|---|---|---|
| `profiles:` | The admin picks one at import; only that profile's services (and any with no profile) come in. | Three profiles in one pod would clash: every `mongos` is 27017. |
| `command`, `entrypoint` | New descriptor fields (argv arrays; a string is split the way compose splits it). Compose's `$$` becomes `$`, so `$${SHARD_HOST}` reaches the init job's `bash -c` as a variable. | `mongod --shardsvr …`, `mongos --configdb …`, the init scripts. The sidecar renderer sets no `command` today (`pod-spec.ts:347-371`). |
| `depends_on` (`service_healthy`, `service_completed_successfully`) | One start order, sorted at import. A cycle, or a condition we don't know, is refused. | `mongos` needs the config set initialized; `mongo-init` needs `mongos` healthy and the shard initialized. |
| `restart: "no"` | A **job**: a plain init container (no `restartPolicy: Always`), placed in the order, that must exit 0. | The three init jobs. |
| Service names | `hostAliases` on the sandbox pod: every service name → `127.0.0.1`. | All containers share `localhost`. The jobs, `rs.initiate`'s member hosts, `mongos --configdb` and Kafka's controller voters use names. It also means the compose values work unchanged in the sandbox: `MONGO_HOST=mongos-e2e:27017`, and `KAFKA_URL=kafka-e2e:9092` (its `PLAINTEXT` listener advertises `kafka-e2e:9092`, which now resolves). |
| `ports: "47017:27017"` | Both sides kept. The runner opens a loopback forward from the published port to the container port when it starts. Same-number ports (`8085:8085`) need none. | Test configs that say `localhost:47017`, and Kafka's `EXTERNAL://localhost:9294`. |
| Tags (`mongo:4.4`, `bitnamilegacy/kafka:latest`) | Pinned at import: the host looks up each digest, shows it, stores `image@sha256:…`. Re-importing re-pins. | The schema requires digests (`service-descriptor.ts`); today the admin pins by hand. |
| `tmpfs:`, named volumes | Writable paths, each an `emptyDir` with a size limit (a chart default, say 2 GiB). Every service also gets `/tmp`. | Mongo, Kafka and Redis data. Today's `emptyDir`s have no size limit (`pod-spec.ts:344`). |
| No health check | A TCP check on the service's first port. | The Firestore emulator has none, and the order needs something to gate on. |
| More than 8 services | `SERVICES_MAX` rises to 16 for on-demand connectors (`service-descriptor.ts`, `connectors/src/types.ts:233`). Always-on keeps 8. | `e2e` has 9 without the worker. |
| A service that bind-mounts source | Flagged "this looks like your app: run it in the sandbox", not imported. | The app's worker service (§4.4). |

Ignored, as today: `container_name`, `networks`, `platform`, `restart` other
than `"no"`, and the `x-` anchors once YAML has merged them.

**Port clashes.** Every container in the pod shares one port space, the runner
included. The importer refuses a profile where a published port equals another
service's container port, or two services use the same container port. `e2e`
has none.

### 4.3 Start order

Native sidecars already start one at a time, each held until its startup probe
passes (`pod-spec.ts:298-322`; Kubernetes 1.29+, which dev services already
require). A job is a plain init container in the same list: it runs to
completion before the next entry starts. So the renderer just emits the sorted
order. For `e2e`: `configsvr-e2e` → `configsvr-init-e2e` → `shard0-e2e` →
`shard-init-e2e` → `mongos-e2e` → `mongo-init-e2e` → Kafka → Redis → Firestore.
The runner starts after all of them.

### 4.4 The worker, without GDAL

The app's worker service is the app itself, not infrastructure: compose
mounts the app source directory, runs `npm install` with the person's
`~/.npmrc`, and builds on a GDAL base image. In the sandbox the agent:

1. runs `npm install` in the app source directory. The packages come from
   **the private package registry host**. An admin adds it as a connector
   host with a credential slot. The sandbox's `.npmrc` names the slot's placeholder, and the credential
   proxy swaps in the real token only on requests to that host
   (`credential-proxy/src/listener.ts:797-829`). The token never enters the
   sandbox. The registry host is probably already allowed for pushing code, so
   the token needs package-registry read scope, or a second credential goes on
   the same host.
2. starts the worker in the background, with the compose values unchanged
   (`MONGO_HOST=mongos-e2e:27017`, `KAFKA_URL=kafka-e2e:9092`) and
   `FIRESTORE_EMULATOR_HOST=localhost:8085`.
3. runs the e2e test command.

**The repo's change, not AX's:** the worker must run when GDAL isn't found, and
e2e tests that need GDAL must skip. Those paths go untested in the agent's runs
for now.

### 4.5 Real images under our hardening

Every sidecar runs as uid 1000 with a read-only root filesystem and no
capabilities (`CONTAINER_SECURITY`, `pod-spec.ts:241-248`). We don't relax that
per image; we give images the paths they write. The importer adds `/tmp`. Known
extras: Bitnami Kafka writes generated config under `/opt/bitnami/kafka/config`
(and normally runs as 1001), the gcloud emulator writes `~/.config/gcloud`. The
walk (§10) finds the rest, which the admin adds as writable paths.

**Size.** One `e2e` stack is about 3 GiB (three Mongo processes, a JVM Kafka,
Redis, a JVM emulator). The gcloud image is several GB, so the first start on a
cold node is slow. **Mongo version:** the file uses 4.4 only because 4.2 has no
ARM64 image; cluster nodes are amd64, so the repo's owners could run
production's 4.2.2 here.

## 5. Lifetimes

There's one sandbox per conversation, kept warm between turns
(`orchestrator.ts:2250-2283`, `WarmEntry`). Parallel conversations each get their
own sandbox, so each gets its own services. Nothing deletes a sandbox on
request today. These do:

| What | When | Where |
|---|---|---|
| Idle reaper | 5 min after a turn ends, then a 10 s grace | `orchestrator.ts:2246-2247`, armed at turn end `:5271` |
| Continuation hold | delays the reaper up to 15 min while an approved continuation is bound (moves to 30 min or the turn limit, §6.5) | `orchestrator.ts:2248`, TASK-1150 |
| Runner idle floor | the runner exits after 15 min with no work | `agent-runner-core/src/inbox-loop.ts:42` |
| Pod ceiling | 6 h after the pod started | `sandbox-k8s/src/config.ts:263` |
| Agent deleted, connector deleted, a turn error | at once | `orchestrator.ts` (TASK-718, TASK-833) |

Services live exactly as long as their sandbox. A coding agent with
`idleMinutes: 30` keeps its stack for half an hour between chat messages.

## 6. Longer turns

### 6.1 Every clock a long turn meets

Two kinds of long turn matter: the model thinking for many minutes with no tool
call, and one long tool call (a 10-minute e2e run, `npm install`).

| Clock | Default | Where | Long think | Long tool call | Fix / coding setting |
|---|---|---|---|---|---|
| Turn limit | 10 min, wall clock from turn start | `orchestrator.ts:1232`, armed `:5043-5044` | **fires** | **fires** | per-agent `turnLimitMinutes`; coding agent **120** (§6.2) |
| Bash timeout, aisdk runner | 2 min default, 10 min max | `agent-aisdk-runner/src/tools/builtins.ts:50-52` | no | **fires** past 10 min | max follows the agent's turn limit (§6.3) |
| Bash timeout, claude-sdk runner | the SDK's own (documented 2 min default, 10 min max); AX sets no `BASH_*` env | `agent-claude-sdk-runner/src` sets none | no | **fires** past 10 min | runner sets `BASH_MAX_TIMEOUT_MS` from the turn limit (§6.3) |
| One model request, claude-sdk | the SDK's documented `API_TIMEOUT_MS` (10 min); AX doesn't set it | not set in the runner | **may fire** on a very long single response | no | runner sets it to 30 min; the walk confirms |
| One model request, aisdk | none unless configured | `llm-anthropic/src/plugin.ts:189`, `llm-openrouter/src/plugin.ts:460` | no | no | none |
| Proxy tunnel silence | 15 min with no bytes either way | `credential-proxy/src/listener.ts:294`, `:1120-1121` | no: a streamed response keeps sending | no | none |
| MCP connector call, aisdk | 5 min per call | `agent-aisdk-runner/src/tools/connector-tools.ts:83` | no | only a slow connector | none |
| Host-tool wire | 30 s | `ipc-protocol/src/timeouts.ts` (`tool.execute-host`) | no | host tools only | none; `restart_with_services` returns at once |
| IPC socket idle | 130 s per socket | `ipc-http/src/listener.ts:42` | no | no | none |
| Runner idle floor | 15 min | `inbox-loop.ts:42` | no: a read that outlives a turn is discarded (`run-runner.ts:957-1002`) | no | `AX_INBOX_IDLE_MS` above `idleMinutes` (§6.4) |
| Idle reaper | 5 min | `orchestrator.ts:2246`, armed only at turn end `:5271` | no | no | per-agent `idleMinutes`; coding agent **30** |
| Pod ceiling | 6 h from pod start | `config.ts:263` | fires on an old warm pod | same | don't route a long turn into an old pod (§6.4) |
| SSE keepalive | 25 s heartbeat | `channel-web/src/server/sse.ts:47` | no | no | none |
| Stream buffer | turn timeout + slack | `channel-web/src/server/plugin.ts:797-800`; preset `index.ts:1529` | after 10 min | same | size from the chart's turn cap (§6.4) |
| GKE load balancer | 3,600 s on the whole streamed response | `gke-values.yaml:208`, `templates/host/backendconfig.yaml:22` | **fires** at 60 min | same | 7,500 plus a template check (§6.4) |
| OAuth tokens | about 1 h; rotated only at turn end | `orchestrator.ts:5222` | after ~60 min | same | rotate every 5 min mid-turn (§6.4) |
| Slack turn cap | 15 min per reply | `channel-slack/src/limits.ts:217`, armed `turn.ts:820` | **fires** | **fires** | **30 min** (§6.5) |
| Continuation reap hold | 15 min, "the cap channel-slack puts on one reply" | `orchestrator.ts:2248`, doc at `:252-263` | fires on a long woken continuation | same | moves with the Slack cap (§6.5) |
| Routine dispatch lease | 120 s, renewed by a 10 s heartbeat | `routines/src/store.ts:1219`, `repeat-limits.ts` | no: it tracks the host, not the turn | no | none |
| Routine turn-end grace | 60 s after the invoke settles | `routines/src/fire.ts:158` | no | no | none |
| `agent:invoke` bus timeout | none | `orchestrator.ts:1238-1291` (TASK-498) | no | no | none |
| Sandbox readiness | 60 s + 2 min per service | `config.ts`, `open-session.ts:574-580` | no | no | at open only; covers the restart, and the bus timeout below follows it |
| `sandbox:open-session` bus timeout | the readiness budget + `readinessTimeoutMs` + 3 min, per call (300 s with no services); a fixed 300 s until TASK-1240, which fired first from 3 services up | `sandbox-k8s/src/config.ts` `computeOpenSessionTimeoutMs`, `plugin.ts` | no | no | at open only; never before the readiness budget |

No stall or no-progress watchdog exists anywhere in the orchestrator, runner or
web client. Nothing counts silence except the proxy tunnel, and a streaming
model isn't silent.

**What still bites, plainly:**

- **The turn limit, by design.** 120 minutes is the ceiling for any one turn.
- **Slack's cap, now 30 minutes.** A coding turn started from Slack is cut at
  30 minutes (§6.5).
- **The claude-sdk model-request timeout** until the runner sets it; worth
  confirming in the walk, since it comes from the SDK, not AX.

### 6.2 The per-agent settings

Two optional fields on the agent row, beside `model` and `runner`
(`packages/agents/src/types.ts`):

| Field | Means | Default | Cap (chart) | Coding agent |
|---|---|---|---|---|
| `turnLimitMinutes` | Longest one turn may run | 10 (today's) | `chat.maxTurnMinutes`, 120 | 120 |
| `idleMinutes` | How long a finished turn's sandbox waits for the next message | 5 (today's) | `chat.maxIdleMinutes`, 60 | 30 |

- Whoever can edit the agent sets them (`assertWriteAllowed`,
  `agents/src/plugin.ts:1097`). The chart caps are the capacity control. *Our
  call.*
- Clamped when used, never refused on read, so lowering a cap doesn't break
  rows.
- The preset refuses to boot unless `maxTurnMinutes` sits at least 20 minutes
  inside the pod ceiling.
- In the UI, both go under "Advanced" on the agent's settings (shadcn `Field`
  and `Input`).

### 6.3 Long tool calls

A Bash command may run as long as the turn allows. *Our call.*

- **aisdk runner:** the Bash tool's max becomes the agent's turn limit, passed
  in the runner's config (`builtins.ts:50-52`, `resolveBashTimeoutMs`). The
  2-minute default stays, so the model asks for a long timeout on purpose.
- **claude-sdk runner:** the runner sets `BASH_MAX_TIMEOUT_MS` to the turn
  limit and `API_TIMEOUT_MS` to 30 minutes in the SDK's environment.
- The tool descriptions and the coding agent's instructions say: give e2e runs
  and `npm install` an explicit timeout, or start them with a shell `&`
  (output redirected to a file) and check that file in a later call. There is
  no background-task mode to lean on: the claude-sdk runner switches the
  CLI's off (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, TASK-1217), so its Bash
  tool has no `run_in_background`, and the aisdk Bash tool never had one.

### 6.4 What a long turn breaks, and the fixes

1. **Runner idle floor.** No runner passes `idleTimeoutMs` today, so it's 15
   minutes. The host passes `max(15 min, idleMinutes + 5 min)` as
   `AX_INBOX_IDLE_MS`, added to the env allowlist
   (`sandbox-protocol/src/bootstrap.ts:20`) and parsed in `agent-runner-core`.
2. **Sign-ins go stale mid-turn.** `proxy:rotate-session` runs at turn end
   (`orchestrator.ts:5222`). While a turn runs, sessions that need it also
   rotate every 5 minutes, through the same hook. (Five, not thirty: the
   OAuth plugin refreshes a token only once it has under 5 minutes left, so
   a 30-minute beat could leave an expired token in use for ~25 minutes.)
3. **The stream buffer** sizes from the global timeout
   (`channel-web/src/server/plugin.ts:797-800`). It must size from
   `maxTurnMinutes`.
4. **The load balancer cuts the stream at an hour** (`gke-values.yaml:208`). Raise
   it to 7,500 for a 120-minute cap, and add a template check that fails when
   backend config is on and `timeoutSec` isn't above `maxTurnMinutes × 60`.
5. **An old warm sandbox may not have 2 hours left** before its 6-hour ceiling.
   Before routing a turn into a warm sandbox, the orchestrator checks time left
   against the agent's turn limit plus a margin, and spawns fresh if it's short,
   as it already retires sandboxes for other reasons. The restart (§3.2) always
   gets a fresh pod.

Task check-ins get the same turn limit, since they go through `agent:invoke`
(`routines/src/fire.ts:488`). Only one check-in per task runs at a time
(`routines/src/store.ts:1211`), so a 2-hour check-in doesn't stack others
behind it.

### 6.5 Slack's cap: 30 minutes

`TURN_HARD_CAP_MS` (`channel-slack/src/limits.ts:217`, armed in `turn.ts:820`)
caps one Slack reply. It goes from 15 to 30 minutes (decision 14), whatever the
agent's turn limit. Longer coding work still belongs in a task.

**What else keys off 15 minutes.** The orchestrator's continuation reap hold,
`reapHoldMaxMs` (`orchestrator.ts:2248`), defaults to 15 minutes because it's
"the cap channel-slack puts on one reply, a woken continuation's included"
(`:252-263`). It keeps a warm sandbox alive while an approved continuation runs
there without an `agent:invoke`. If the Slack cap rises and the hold doesn't, a
continuation running past 15 minutes can be reaped mid-run. So it **moves
with it**: the hold becomes the longer of 30 minutes and the agent's turn limit,
since a web chat's continuation can now run as long as the turn limit too.
*Our call.* `STREAM_MAX_AGE_MS` (9 minutes, Slack's own stream limit) and
`CONTINUATION_WAKE_MAX_MS` (5 minutes) don't change: they're about Slack's
streams and waking, not the reply's length.

## 7. Hooks and the boundary review

| Hook / wire | Kind | Owner | Payload |
|---|---|---|---|
| `conversations:set-service-set` | service | `@ax/conversations` | in: `conversationId`, `serviceSet: string \| null`; out: ok |
| `serviceSet` on `conversations:get` | field | `@ax/conversations` | `string \| null` |
| `host-note` inbox entry | IPC (`session.next-message` response) | `@ax/ipc-protocol`, handled in `agent-runner-core` | `{ type: 'host-note', note }`, host-authored |
| runner size on `sandbox:open-session` | optional field | `@ax/sandbox-protocol` | `{ cpu?, memory? }`, each `{ request, limit }` |

**`conversations:set-service-set`.**

- **Alternate implementation:** a local preset that runs the same set through
  `docker compose` (`sandbox-subprocess/src/compose.ts`, TASK-152).
- **Leaky names:** none. `serviceSet` is a connector-chosen label, not a pod,
  container or compose term.
- **Subscriber risk:** none; it's a service.

**`host-note`.**

- **Alternate implementation:** any host-started continuation, such as a
  decision wake-up. `decision-resolved` could become a case of it.
- **Leaky names:** none.
- **Wire surface:** a new entry in `ipc-protocol/src/actions.ts`'s
  `session.next-message` response, validated there. The note is built only from
  host constants plus the set's service names and addresses, never from model
  or user text, the same rule as `decision-turn.ts`.

**Runner size on `sandbox:open-session`.**

- **Alternate implementation:** the subprocess backend applies it as a process
  limit, or ignores it (a laptop has no quota to ask for).
- **Leaky names:** keep Kubernetes quantity strings out of the payload: CPU in
  millicores and memory in MiB, as numbers. The k8s backend turns them into
  `"2"` and `"6Gi"`.
- **Subscriber risk:** none; it's an input.

The tools (`restart_with_services`, `stop_services`) are host tools, not hooks.
The importer changes are internal to `skills-parser` and `channel-web`, plus the
descriptor fields, which go in all three schema copies
(`skills-parser/src/service-descriptor.ts`, `connectors/src/types.ts`,
`sandbox-protocol/src/schemas.ts`) and `@ax/validator-service`.

## 8. Security

Run `security-checklist` on steps 1 and 3 (§10).

- **No new network path.** Services share the sandbox pod's network namespace,
  as today's sidecars do. They reach what the sandbox reaches; nothing new can
  reach them.
- **The agent can't choose images.** Images come only from an admin's paste,
  pinned to digests at import. The importer never reads the agent's branch.
- **Hardening unchanged:** non-root, read-only root, no capabilities, gVisor.
  Writable paths are size-limited.
- **The opening note is host-authored**, from constants and the set's names and
  addresses.
- **Untrusted inputs:** the pasted compose file is parsed with `js-yaml`'s safe
  schema (`compose-translate.ts`). `command` and `entrypoint` are argv arrays,
  never shell strings we run; they run inside the service's own container.
- **The private npm token** never enters the sandbox (§4.4).
- **Cost abuse:** the per-agent cap (§3.4) and the turn caps bound how much one
  agent can start.

## 9. Open questions

None open. Vinay answered the last three on 2026-11-23 (decisions 6, 13 and 14).

## 10. Delivery

Each step is a PR (invariant 3).

1. **Descriptor and importer.** On-demand mode on connectors; `command`,
   `entrypoint`, jobs, order, published ports, `resources`, a storage size and
   16 services for on-demand sets, in all three schemas and the validator. The
   importer: profile choice, `$$`, `depends_on`, pinning at import, `/tmp`, the
   source-mount flag, the clash check. Its tests run the real `e2e` profile as a
   fixture. The k8s renderer: `command`, jobs as init containers, `hostAliases`,
   `sizeLimit`, per-service resources. Always-on connectors render as today, plus
   `hostAliases` for their service names. Boundary review.
2. **Per-agent turn, idle and runner-size settings.** Agent fields and UI, chart
   caps and the boot checks (turn cap inside the pod ceiling; largest runner
   plus largest service set fits a node), the runner size on
   `sandbox:open-session` and in both k8s renderers (with a boundary review),
   sized sessions skipping the warm pool, the orchestrator using them, `AX_INBOX_IDLE_MS`, the stream
   buffer, mid-turn rotation, the GKE timeout and its template check, no long
   turn into an old pod, the Bash and model-request timeouts in both runners,
   and Slack's 30-minute cap with the reap hold moving with it. Independent
   of 1.
3. **Services on demand.** `serviceSet` on conversations and its hook; the
   orchestrator folding on-demand sets by it; the two tools; the in-turn
   restart; the `host-note` entry; the runner's loopback forwards; the cap.
   Boundary review and security walk. The canary acceptance test
   (`presets/k8s/src/__tests__/acceptance.test.ts`) restarts a conversation with
   a small set and sees the service. Depends on 1. The local preset leaves
   on-demand sets out until it can run them.
4. **Walk (walk), on `kind-ax-next-dev`.**
   - An admin imports the repo's compose file with `e2e`; the importer pins,
     drops the worker with its note, and saves.
   - In a chat, the coding agent calls `restart_with_services({ set: 'e2e' })`.
     The stack starts in order, the sharded cluster initializes, and the turn
     continues in the same stream with the host's note. Record any writable
     paths the images needed.
   - In the sandbox, `npm install` reaches the private package registry host
     through the proxy, the worker starts without GDAL, and the e2e command passes with GDAL tests
     skipped.
   - A task check-in does the same; the next check-in starts without services.
   - A second conversation on the same agent gets its own stack; the eleventh
     past the cap of 10 is refused.
   - The coding agent's sandbox runs with its 2 CPU / 6 GiB runner request and
     schedules on a sandbox node.
   - A 20-minute silent think and a 15-minute test command both finish inside a
     120-minute turn; a 70-minute turn keeps its web stream.

   Depends on 1–3.

## 11. Left to the builder

- Names: the connector mode, the descriptor fields, the conversation field, the
  hook, the tools, the chart keys.
- How the runner learns the published-port map for its forwards (session config
  is the natural place).
- Whether `host-note` replaces `decision-resolved` or sits beside it.
- How the orchestrator knows a warm sandbox's time left (§6.4).
- The import screen: the profile, the pinned digests, what was dropped, the
  "run it in the sandbox" services (shadcn).
- Exact copy for the tools, the refusals and the opening note.
