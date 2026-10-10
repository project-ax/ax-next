# DB-backed routines validation

Validation date: 2026-10-10. Branch: `codex/db-backed-routines`; implementation base: `a730c4c6e`; Task 12 base: `af088a2ca`. **In progress:** local gates below are completed evidence; kind cutover and browser acceptance remain pending. This document must not be interpreted as deployment sign-off until those sections contain completed results.

## Completed local gates

Commands use `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`; no Docker context discovery or daemon settings changed. `VITEST_MAX_WORKERS=2` bounded Vitest file concurrency for the full package run.

| Command | Completed result | Evidence |
| --- | --- | --- |
| `pnpm build` | exit 0 | `/tmp/task12-build.log` |
| `pnpm -r --no-bail run test` | exit 0; 86 package summaries, 18,528 passed, 13 skipped, no failed tests | `/tmp/task12-recursive.log` |
| `pnpm test:eslint-rules` | exit 0; 22 tests | `/tmp/task12-eslint-rules.log` |
| `pnpm test:scripts` | initial exit 1, 1139 passed/1 failed/3 skipped: inventory omitted three deliberate deletion tombstones; inventory corrected | `/tmp/task12-scripts.log` |
| Scripts rerun | inventory passed; unrelated zsh process-count probe timed out at 5s, 1139 passed/1 failed/3 skipped; subsequent serial root retry passed | `/tmp/task12-scripts-final.log` |
| `VITEST_MAX_WORKERS=1 pnpm test:scripts` | exit 0; all 49 files, 1140 passed/3 skipped | `/tmp/task12-scripts-serial.log` |
| `pnpm exec vitest run --root scripts __tests__/agent-keyed-tables-are-cleaned.test.js` | exit 0; 10 passed after obsolete history exemption removal; focused lint exit 0 | `/tmp/task12-inventory-final.log`, `/tmp/task12-inventory-final-lint.log` |
| `pnpm exec tsc --build` | exit 0 | `/tmp/task12-tsc.log` |
| `pnpm typecheck` | exit 0, including runner bench typecheck | `/tmp/task12-typecheck.log` |
| `pnpm lint` | exit 0 | `/tmp/task12-lint.log` |

The recursive command is only one of the three root suites. Both root suites actually ran. Completed shell process statuses, not partial logs, establish these results. No stopped-at-first-package run is called green.

The full package gate retains the existing Vite >500 kB advisory and exercised negative-path diagnostics. Expected diagnostic captures match individual messages and assert their occurrences; unexpected errors are not broadly suppressed. The focused combined canary completed without unexpected diagnostics.

## Reachability canary

`packages/routines/src/__tests__/canary.test.ts`, **holds a real owner tool, releases approval, ticks, reads Settings edits, signs a static webhook and deletes without workspace writes**, uses actual policy, decisions, agents ACL and PostgreSQL. It calls the registered `routine_create` pre-call, proves a hold and zero authored definitions, approves as the real person, proves the grace window still refuses execution, advances the decisions clock and executes/replays the exact call once. A controlled plugin Clock wakes the real elected tick loop; correlated invoke/turn-end records the interval fire. A Settings service patch is read back exactly by registered `routine_get`; an unrelated real actor is denied. Human secret set drives a signed POST through an actual HTTP socket and the plugin's single static receiver route. It records another fire, deletes the routine, verifies credential deletion and absence, rejects the old endpoint, advances another tick and proves no later invoke. The workspace apply spy stays at zero.

The harness substitutes only infrastructure endpoints (invoke completion, conversations, credentials and attendance); agents ownership is the real plugin with stored personal/team identities. It does not make `agents:resolve` always succeed. The secret fixture retains/removes actual bytes for this canary and never prints them. The new test initially exposed fixture assumptions about equal simulated timestamps and the deletion receipt's committed cleanupPending state, both corrected before the passing full run.

Existing `canary-defaults.test.ts` pins stable default identity/current owner/shared conversation key, refresh/history preservation, enabled AND disabled authored heartbeat shadowing, per-agent overrides and catalog kill switches. Migration/seed tests preserve heartbeat and disabled skill-reflection fields. The skills crystallization canary reaches the registered DB routine services with a real agent. Runtime silence, warnings, conversation modes and deletion-completion fences are separately exercised by `canary.test.ts` and `plugin.test.ts`.

The CLI `serve` loads `createMemoryPlugins`, which composes the actual k8s base assembly. `serve-preset.test.ts` pins that selection; memory canary boots the actual composed plugins. The k8s `preset.test.ts` checks exact routine host-tool hooks, static HTTP dependency, absence of workspace subscriptions, unique/satisfied registrants, and the required plus present-optional call graph without cycles. The k8s destination lifecycle acceptance uses the real routines and credentials plugins. Removed validator package/imports/tsconfig/lock/preset edges are absent; the old name remains only in deliberate historical documentation or rejection fixtures.

## Motivating regression coverage

| Bug class | Concrete regression |
| --- | --- |
| Re-ownership / prompt authority | `services.test.ts`: **pins team creator, lets another admin stop only, and denies ordinary member mutations**; **reconciles transferred personal ownership on management reads**; tools **repeats ACL after approval and refuses endpoint/name substitution** |
| Sync only on commit; storage-full blocks edits | Combined canary above and tools **creates, reads, patches and deletes without workspace effects; normal pre-call retries reuse approval**; workspace fixture rejects every apply |
| Late webhook clash | `store.test.ts`: **unique webhook path is scoped to agent and serializes concurrent creates** |
| Credential cleanup requires file delete | `store.test.ts`: **delete atomically queues the exact owner credential and retries after row disappearance**; cleanup **keeps failed removal retry away from a reconfigured secret and stale discovery** |
| Sandbox file grants privilege | Core retired-prefix veto, public workspace apply and IPC commit-notify rejection fixtures; offline CLI/helper direct-prefix-only dry/apply/zero regressions |
| Host-local receiver routing | `webhook-router.test.ts`: **routes the persisted definition after handler restart**; **rechecks disable, path edits, deletion and token rotation without registering new routes** |
| Deleted agent retains authority/history | Plugin **does not recreate dispatch/history/status after deletion during a deferred invoke**; cleanup **uses canonical purge on the actual agents:deleted event**; policy **purges consent/deliveries for only the deleted agent and rejects late already-authorized writes** |

## Five review-focus cases

| Focus | Completed regression evidence |
| --- | --- |
| Old removal cannot delete reconfigured secret; stale form cannot write after deletion | cleanup **keeps failed removal retry away from a reconfigured secret and stale discovery**; **holds deletion behind an in-flight secret and refuses stale forms afterward**; **retains the row lock after a nested credential timeout until its actual write settles** |
| Old grant cannot reverse revocation; Undo grants nothing | policy **duplicate deliveries are atomic, and replay after revoke never restores permission**; decisions **Undo grants nothing and no consent is delivered during grace**; **consent CAS conflict is terminal and never retries the grant intent** |
| Accepted fire after agent deletion cannot restore data | plugin **does not recreate dispatch/history/status after deletion during a deferred invoke**; store **keeps purged-agent credential cleanup drainable without resurrecting routine data** |
| Failed policy/freshness/ACL reads fail closed despite subscriber isolation | tools **keeps preflight errors closed under DB outage and corrupted SafeToolError properties**; decisions **missing policy provider and consent outage fail closed**; policy **missing ACL provider and read/management outages never relax holds or fabricate disabled success** |
| Disabled authored heartbeat does not wake default | defaults canary **an authored heartbeat shadows the default even when enabled=%s**, both true and false |

Additional refinements: decisions **reconciles a claimed grant lost acknowledgement after expiry without executing the expired call** separates consent delivery from expired effect authority. Tools **leaves actual host replay pending across commit-ack plus receipt-read outage, then restart recovers exactly once** tests the narrowly scoped pending receipt rather than inventing success. Joined hook calls keep serialized effect locks until nested promises settle; opt-in joined plugin shutdown drains admitted routine work. The HTTP socket test **rejects literal and encoded dot aliases through the actual HTTP socket adapter** proves validation sees the original target, before path normalization.

## Boundary review

The following is the approved table updated for the implemented contract. Grouped rows enumerate every member; there are fifteen routines services and six tools. IDs, revisions, cursors and request IDs are opaque domain tokens, never parsed as DB keys or former workspace paths. No hook passes a transaction, socket, filesystem capability or credential ref.

| New/changed surface | Alternate implementation | Potential leaks and subscriber risk | Wire/schema ownership |
| --- | --- | --- | --- |
| `routines:list`, `routines:get` | SQLite-backed routine plugin | None; routineId/revision opaque. Readers must not parse former path/default prefixes. | Pure routines contract; REST validation in routines-admin-routes. |
| `routines:create`, `routines:update`, `routines:delete` | Remote durable routine service | None; requestId/revision are logical tokens, no transaction handles. Subscribers cannot assume commit/file events. | Routines contract; no new raw routines IPC action. |
| `routines:fire-now` | Scheduler invoking an external execution provider | None; source/payload removed from caller surface. Consumers must distinguish dispatch from completed fire. | Routines contract and host tool schema. |
| `routines:recent-fires`, `routines:recent-fires-for-agent` | Append-only durable fire log | None; no serial DB IDs. Readers use opaque routineId and scoped actor. | Routines contract; route projections in their plugin. |
| `routines:set-webhook-secret` | Routine service coordinating a remote credential vault | None; secret is a bounded credential value, never a ref/transaction handle. Human adapter keeps existing credential ACL and service enforces routine ACL/CAS. No tool or raw IPC action exposes this hook. | Routines host-only schema; credential HTTP body schema stays in credentials-admin-routes. |
| `routines:list-defaults`, `routines:get-default`, `routines:upsert-default`, `routines:delete-default` | Remote default catalog | None; structured definition replaces markdown. No consumer relies on sourceMd or seed encoding. | Routines contract; admin route schema local. |
| `routines:set-agent-default-enabled`, `routines:list-agent-defaults` | Durable settings provider | None; enforce actual caller ACL without exposing storage override rows. | Routines contract. |
| `tool:execute:routine_list`, `tool:execute:routine_get` | Tools calling a remote authorized routine service | None; agent/actor derived, definitions untrusted text. No FS capability. | Strict tools schema in routines; existing tool IPC envelope. |
| `tool:execute:routine_create`, `tool:execute:routine_update` | Same tools over remote service | None; CAS/request tokens opaque; host approval check mandatory. No caller owner/admin/ref. | Routines tool schema; safe errors in IPC plugin's error surface. |
| `tool:execute:routine_delete`, `tool:execute:routine_fire_now` | External execution/cleanup provider | None; hold-once separate from create/update consent. No arbitrary source/payload. | Routines tool schema. |
| `tool:register` descriptors for all six tools | Another host-tool implementation | Existing transport-neutral descriptor; no flush workspace. Policy must match exact tool names. | Existing core registration contract. |
| Routine `tool:pre-call` validation subscriber | Read-only validation against a remote routine provider | No payload changes; model call is untrusted. Must run before hold and return rejection rather than throw; effect rechecks prevent stale preflight authorization. | Existing core ToolCall and rejection contract; routine schemas local. |
| `agents:can-manage-routines`; webhook-token ensure/rotation ACL | Agent directory with remote team membership | None; real actor and domain permission only. Missing provider denies; lookup outage propagates. HTTP path/token are actual domain data, not storage vocabulary. | Agents plugin schemas; no new sandbox permission hook. |
| `tool-policy:get-routine-consent`, `grant-routine-consent`, `revoke-routine-consent` | Durable external authorization provider | None; grant binds real person/agent/eligible tools. Never infer grant from model fields or process cache. | Tool-policy schemas, trusted human/decision adapters only. |
| `decisions:approve`; `decisions:authorize-routine-call` | Human authorization queue backed by another durable store | None; approvalScope and exact call are domain data. No subscriber may treat a returned mutation error as success. | Decisions plugin schemas; approve HTTP body belongs in web route. |
| Retired-prefix apply veto; existing agent-deletion events | Object-store workspace / remote agent directory | No payload changes. Prefix is workspace content policy, not a git ref. Hard veto must precede write; cleanup uses hooks, not other plugins' tables. | Existing workspace IPC schemas stay local to workspace handlers. |
| Safe host-tool failure detail | Alternate host-tool transport | Closed domain error codes/field paths only; no backend exceptions or arbitrary message passthrough. | Core subtype; IPC plugin local safe error schema; both runner adapters. |

| Final refinement | Alternate implementation | Potential leaks and subscriber risk | Wire/schema ownership |
| --- | --- | --- | --- |
| `HookBus.subscribe(..., {priority})` | Ordered external middleware pipeline | Stable ascending domain ordering; no backend/transport vocabulary. Default priority preserves registration order. A subscriber failure still cannot grant effect authority. | Kernel registration option only; no payload or IPC field |
| `HookBus.callJoined` and `Plugin.shutdownMode: joined` | External task supervisor with completion joins | Completion/ownership semantics only; callers must join actual effects before releasing locks. Deadline reports do not falsely assert cancellation. | Kernel API; no sandbox hook or IPC payload |
| `routines:update`, `routines:delete` requestId refinement | Remote durable routine service | Logical retry ID commits with effect; actor scope and exact payload checked. A stale matching retry returns the committed receipt without a second effect. | Pure contract services/tools; local REST adapters |
| `routines:set-webhook-secret` set/delete union | External vault coordinator | Bounded secret bytes only for set; delete shares lifecycle/CAS fence. Neither branch is an agent tool. | Pure host-only routine contract; credential route owns HTTP body |
| `decisions:settle-routine-call` | Durable external human authorization queue | Exact claimed authorization and real actor required. Outcomes use closed vocabulary; arbitrary plugin exceptions cannot become saved success. | Decisions schema; no sandbox action |
| Original HTTP `rawPath` | Another HTTP listener preserving request target | Literal request data, not backend state. URL normalization must not create a receiver alias. Tokens remain human-only and excluded from diagnostics. | HTTP-server request interface; routines static route validates |

## Security review

- **Sandbox/capabilities:** Six tools grant bounded routine CRUD/read/dispatch authority under authenticated agent/person, with fresh ACL and execution-time approvals. No new process spawn, environment lookup, network destination, filesystem path or workspace flush/apply is exposed by those tools. Public routine service hooks are not raw sandbox IPC actions. HTTP receiver routing resolves token and current DB definition on every request; no host-local authoritative route/consent/deduplication cache. Per-turn correlation maps are transient only. Human credential writes are bounded, version-checked and serialized with cleanup; no key or token enters the model-facing view. Offline retirement is a CLI-only function, not a hook: explicit recognized store root, fixed direct `.ax/routines/*.md` blobs and main ref, no symlinks/alternate stores, CAS lock and verified atomic loose-object publication. Host-stopped operation under the writer UID/GID remains a required operational precondition.
- **Injection:** Model tool arguments, definition text, webhook paths/events/raw bodies and external responses are untrusted. Strict full/patch validation and 64 KiB aggregate UTF-8 bound apply at boundaries. Parameterized storage writes, React text rendering and structured patch/CAS avoid SQL/HTML/command interpolation. Webhook HMAC uses exact raw bytes before parsing; original request targets reject dot/encoded aliases. Prompt interpolation cannot confer host approval or caller identity. Safe errors are regenerated from closed core codes/field vocabulary and revalidated at outward adapters; host exception strings, HMAC bytes, tokens and credential refs do not become model output. An instruction such as `ignore previous instructions` remains prompt content and cannot forge the separately authenticated authorization binding. No caller-controlled argv0, shell expansion or arbitrary env-name access is added.
- **Supply chain:** New pure `@ax/routines-contract` declares exact `croner: 8.1.2` and `zod: 3.25.76`; both are existing resolved dependencies, with no runtime transitive dependencies or preinstall/postinstall/prepare scripts in installed metadata. The offline helper reuses existing exact `isomorphic-git: 1.37.5`; its existing dependency graph is unchanged and it has no such lifecycle hook. All remaining additions are internal workspace links/test dependencies; validator importer and links are removed. Lockfile changes affect importers only; the complete `packages:` and `snapshots:` sections are byte-identical to the branch base, adding no external resolution, transitive package or new maintainer trust. Existing development dependency ranges were not upgraded. Repository lifecycle script allowlist remains `better-sqlite3`; no new install allowlist entry. Existing established-package maintainer trust is reused, not newly introduced.

The obsolete routine-fire retention exemption was removed: current agent purge deletes that history, and the inventory now requires its cleanup. The new routine-related exceptions retain only the three deletion-fence tables. `routines_v1_retired_agents` stores opaque ID and retirement time; decisions and policy tombstones store only opaque IDs. Other scoped definitions, history, receipts, authority and consent are purged. Dropping these fences would allow already-running work to recreate purged rows.

## Kind cutover and browser acceptance

Pending. Target exclusively `kind-ax-next-dev`, namespace `ax-next`. Every explicit kubectl selects that context. Preserve provider/auth settings. Stop host/runners/git writers, coordinated private backup, UID/GID 1000 offline dry/apply/zero verification precede `make image KIND_CLUSTER=ax-next-dev`, which builds and auto-rolls out. Native browser connection unavailable; authorized standalone Playwright will use the real dev-bootstrap Set-Cookie without fabricated authority or exposed tokens. Screenshots must mask/omit receiver tokens and secrets.

Required outstanding walk: chat hold/no definition → Allow → Settings exact edit → routine_get → actual interval Activity/history; Always Allow scoped to one agent/person, next create/edit skip hold, second agent holds, revoke then hold; human HMAC UI and signed local POST/fire; Enabled, draft URL preview and stale revision conflict; delete/no later dispatch and cleanup of test objects/secrets/grants. Figma references and prior Task 10 visual evidence remain documented in its report; final live captures are not yet complete.
