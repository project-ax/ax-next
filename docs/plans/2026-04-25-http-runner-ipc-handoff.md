# HTTP runner-IPC handoff — close the host ↔ runner-pod gap

**For:** session picking up follow-up #1 from `docs/plans/2026-04-25-week-7-9-followups.md`.
**Previous slices:** Weeks 1–9 (PR #9 merged). The k8s slice ships a runner pod, a NetworkPolicy that allows host→runner on TCP 7777, and an `AX_AUTH_TOKEN` env var on every pod. What it doesn't ship is the wire — the host's `http://` IPC client throws `HostUnavailableError("not implemented yet")` and there's no listener inside the runner pod for it to connect to anyway.

**Assumes the following are in place:**
- `@ax/sandbox-k8s` returns `runnerEndpoint = http://${podIP}:${RUNNER_PORT}` from `sandbox:open-session` (`packages/sandbox-k8s/src/open-session.ts:234`). `RUNNER_PORT` is exported from `packages/sandbox-k8s/src/pod-spec.ts`.
- `@ax/agent-runner-core/src/ipc-client.ts` has `parseRunnerEndpoint` (line 108) with a working `unix:` branch and an `http:` branch that throws `HostUnavailableError("http:// runnerEndpoint is not implemented yet (Task 14 deliverable)")` (lines 131–140). The defensive guard in `requestOnce` (lines 236–245) also throws if a non-`unix` target reaches the wire.
- Both runners (`@ax/agent-native-runner`, `@ax/agent-claude-sdk-runner`) start a Unix-socket dispatcher via `@ax/ipc-server`. `packages/ipc-server/src/` exposes `dispatcher.ts`, `listener.ts`, `auth.ts`, `body.ts`, `response.ts`, `plugin.ts`, `handlers/` — the dispatcher is already framework-free.
- The runner pod env carries `AX_AUTH_TOKEN` (set by `buildPodSpec` from `created.token` minted by `session:create` — see `packages/sandbox-k8s/src/open-session.ts:166`). Same token is the bearer the host's IPC client sends today on the `unix:` branch (`packages/agent-runner-core/src/ipc-client.ts:217`).
- `deploy/charts/ax-next/templates/networkpolicies/agent-runtime-network.yaml` already permits host pod → runner pod on TCP 7777.
- Known-limit notes in `packages/sandbox-k8s/SECURITY.md` and `deploy/MANUAL-ACCEPTANCE.md` (the "chat returns a response" criterion is currently unchecked because of this gap).

If any predecessor diverged — particularly if the dispatcher in `@ax/ipc-server` was already factored out — revisit decisions below.

---

## Goal

Make the `http://` runner-endpoint URI work end-to-end so a chat sent through the k8s preset reaches a runner pod, executes, and returns. After this lands, kind-cluster acceptance can finally tick the "chat returns a response" box in `deploy/MANUAL-ACCEPTANCE.md`.

This is the largest deferred chunk from Week 7–9. Without it the k8s slice is structurally complete but functionally inert.

## Deliverables

- **Host-side HTTP IPC client.** `parseRunnerEndpoint` in `@ax/agent-runner-core/src/ipc-client.ts` returns a working `http` target (today it constructs a "deferred" branch and the `requestOnce` guard at line 236 then throws). The `unix:` branch is the reference shape — same dispatcher contract (`{action, payload}` request, JSON response), same `IPC_TIMEOUTS_MS` map from `@ax/ipc-protocol/src/timeouts.ts`, same retry/backoff/cap logic, same `Authorization: Bearer ${token}` header. Use Node `http.request` (no Express, no `fetch` — match the dispatcher's framework-free style). The TCP arg shape for `http.request` is `{ host, port, path, method, headers, signal }` instead of `{ socketPath, ... }`; everything else (response draining, MAX_RESPONSE_BYTES cap, error classification, AbortController-based timeout) is identical.
- **Pod-side HTTP server.** A new `@ax/ipc-http` package that mirrors `@ax/ipc-server` but listens on TCP `0.0.0.0:7777` instead of a Unix socket. **Decision baked in (verified by reading the source):** extract a new `@ax/ipc-core` package containing the transport-agnostic four — `dispatcher.ts`, `auth.ts`, `body.ts`, `response.ts`, plus `errors.ts` and `handlers/`. `@ax/ipc-server` shrinks to just its listener (the Unix-socket-specific bits) and depends on `@ax/ipc-core`. `@ax/ipc-http` ships its own listener and depends on `@ax/ipc-core` too.
  - Why this works (verified by reading the source): `dispatcher.ts` imports only `node:http` *types*, `@ax/core` types, and sibling files — no Unix vocabulary. Same story for `auth.ts` (operates on `Authorization` header string), `body.ts` (operates on `IncomingMessage` events), `response.ts` (trivial JSON writers). The `IncomingMessage`/`ServerResponse` types are identical for Unix-socket and TCP servers — Node's `http` module abstracts that.
  - The Unix-specific code lives entirely in `listener.ts`: `fs.unlink` for stale-socket cleanup (lines 137, 160), `server.listen(socketPath, ...)` (line 145), the `socketPath` field on the `Listener` interface (line 41).
  - Why not put the four into `@ax/core`: the dispatcher imports protocol handlers (`handlers/llm-call.js` etc.) that own hook-bus calls and protocol logic. That's not kernel material — it's IPC material. A sibling `@ax/ipc-core` keeps the kernel small and gives both transports a clean, shared dependency. (We considered moving to `@ax/core`; rejected because `@ax/core` shouldn't grow to import every IPC handler in the system.)
  - Why not let `@ax/ipc-http` import directly from `@ax/ipc-server`: bends invariant 2 (no cross-plugin imports) for no reason — extracting the shared core is a few hours of work and gives a strictly better module boundary.
  - **Order of operations:** do the `@ax/ipc-server` → `@ax/ipc-core` extraction in a separate prep commit so the diff stays readable. Existing tests in `@ax/ipc-server` should keep passing against the relocated modules unchanged (they exercise the listener end-to-end; the listener's contract is unchanged).
- **Runner-side wiring.** Both runners (`@ax/agent-native-runner`, `@ax/agent-claude-sdk-runner`) currently spawn a Unix-socket listener via `@ax/ipc-server`. Switch on `AX_RUNNER_ENDPOINT`'s scheme: `unix://` → `@ax/ipc-server`, `http://` → `@ax/ipc-http`. The runner doesn't pick — the sandbox provider sets the scheme via the env var. Mirror what `parseRunnerEndpoint` does on the client side; consider lifting the parser into `@ax/ipc-protocol` so client + servers + runners agree on the URI grammar.
- **`@ax/sandbox-k8s` updates.** Today the runner pod env carries `AX_RUNNER_ENDPOINT='pending://await-pod-ready'` and the function returns the real `http://${podIP}:${RUNNER_PORT}` to the orchestrator (see comment block at `packages/sandbox-k8s/src/open-session.ts:127–161`). The downward-API plan in that comment — `POD_IP` env var via `fieldRef`, runner builds the URI itself — is the right shape now that the runner actually needs to know the URI to choose a transport. Implement it: add `POD_IP` to the env via `fieldRef`, have the runner construct `http://${POD_IP}:7777` at startup. Verify the host pod can reach `containerPort: 7777` from `podIP`.
- **Auth.** The host opens a TCP connection to a runner pod. NetworkPolicy is the perimeter, but defense-in-depth: require the `Authorization: Bearer ${AX_AUTH_TOKEN}` header on every request and validate it server-side. **Use `crypto.timingSafeEqual` for the comparison** — the `unix:` server side already does this; reuse the same helper. Without this, any pod-network attacker (a compromised neighbor pod that slips past NetworkPolicy, a misconfigured cluster, a future runner image with a CVE) can talk to any runner. **This is the security gate.**
- **TLS.** Open question, see Scope decisions.

## Scope decisions to make while writing the plan

1. ~~**Where do the shared primitives live?**~~ **Decided.** Extract `@ax/ipc-core` (see Deliverables). Listed here so a planning session sees the trail: the four files are all transport-agnostic; `listener.ts` is the only Unix-specific module; `@ax/core` is the wrong destination because it'd pull every IPC handler into the kernel.

2. **TLS or plain HTTP within the cluster?**
   - **(a)** Plain HTTP, NetworkPolicy as perimeter, bearer auth at the application layer. Same posture as legacy v1.
   - **(b)** mTLS with a CA managed by the host pod. Stronger; real complexity (cert rotation, CA bootstrapping, init containers).
   - **Recommendation: (a) for the first impl.** (b) is a security upgrade with cost; defer it as its own follow-up. Document the choice in the new SECURITY.md so future-us knows it was a deliberate posture, not an oversight.

3. **Long-poll endpoint timeout grace.** The `unix:` client adds 5s of slack on `session.next-message` so the server's `{type:'timeout'}` response wins the race against the client's abort (`packages/agent-runner-core/src/ipc-client.ts:347–360`). The HTTP path inherits this verbatim — but verify TCP behavior is the same as Unix-socket behavior under `AbortController.abort()`. Likely is; worth a test.

4. **Connection reuse / keep-alive.** The `unix:` client today creates and tears down a `http.ClientRequest` per call (see `close()` at line 491 — explicitly a no-op). For TCP, that's more expensive (TCP 3-way handshake every call). Options: keep the same per-request shape (simple, slower), or hold a `http.Agent({ keepAlive: true })` per client (faster, more state to manage on shutdown). Pick simple first; benchmark before optimizing. Note the `close()` no-op stops being a no-op if you take the keep-alive path.

5. **Health endpoint.** The pod's HTTP server has TCP-listening as its readiness signal today (`waitForPodReady` polls phase + readiness gate, doesn't probe the application layer). Cheap addition: add a `GET /healthz` route that returns 200 once the dispatcher is wired. Lets the readiness probe be more honest. Optional for MVP; recommend.

6. **Where does `parseRunnerEndpoint` live?** It's currently sandbox-side only (`@ax/agent-runner-core/src/ipc-client.ts:108`). Now that runners need to parse the same URI to pick a server transport, lift it into `@ax/ipc-protocol` (which already owns `IPC_TIMEOUTS_MS`, `IpcActionName`, the response schemas). Single source of truth; matches invariant 4.

## Security — `security-checklist` required (heavy)

Three threat models, and this is the first plugin in the codebase that opens an inbound HTTP listener on a network port. Most security review attention should land here.

- **Sandbox escape.** A runner pod accepts inbound traffic. The blast radius if auth fails open is "any pod that can reach 7777 can drive any runner as if it were the host." NetworkPolicy is the perimeter; bearer auth is the wall behind it; `crypto.timingSafeEqual` is the lock on the wall. All three must hold.
- **Prompt injection.** Tool output reaches the host through this transport. Already a known surface — but the encoding/decoding boundary is new code, so it's a fresh place for injection bugs. Schema-validate both directions (the client already does on responses; the server must validate request bodies the same way).
- **Supply chain.** Node's built-in `http` is the only new dep this slice strictly needs. Resist adding Express, Koa, undici, or "just one tiny" middleware — every one is a new attack surface. The `unix:` server is framework-free for exactly this reason; the `http:` server should match.

New `@ax/ipc-http/SECURITY.md` is required. The new capability is "host pod opens TCP connections to runner pods on port 7777 with bearer auth, validated `timingSafeEqual`-style." Walk all three threat models. Update `packages/sandbox-k8s/SECURITY.md` to drop the known-limit note about HTTP IPC being unimplemented.

## Legacy helpers to port (read-only `~/dev/ai/ax/`)

- Legacy ran a similar host↔pod IPC over HTTP. Read its server-side request handler for the auth + body-framing shape — particularly how it validated the bearer header. The `crypto.timingSafeEqual` pattern likely lives there.
- The pod-side dispatcher in legacy may share more with our existing `@ax/ipc-server/dispatcher.ts` than expected — comparing the two will tell you whether option (a) above is the obvious move or whether legacy's shape diverges enough that we should design fresh.
- Do NOT port legacy's transport-selection logic if it's coupled to its sandbox lifecycle — we want a clean URI-scheme switch, not a runtime config branch.

## Acceptance test

**Automated:**
- New tests in `@ax/ipc-http`: route dispatch, auth header check, missing/invalid auth → 401, malformed body → 400, oversized body → 413 (matching the `MAX_FRAME` contract), action-not-found → 404, timeout enforcement.
- New test in `@ax/agent-runner-core/src/__tests__/ipc-client.test.ts` for the `http:` branch — round-trip a real action (e.g., `tool.list`) against an in-process HTTP server. Mirror the structure of the existing `unix:` round-trip test.
- Existing `pnpm test` stays green. The dispatcher move (option a) is the most likely thing to ripple — `@ax/ipc-server`'s tests should pass against the relocated module unchanged.

**Manual:**
- `deploy/MANUAL-ACCEPTANCE.md`'s "chat returns a response" criterion gets ticked. Run the kind-cluster recipe; send a chat through the CLI pointed at the k8s preset; verify it returns. This is the proof the slice was worth shipping.

**Estimated size:** ~600–1000 LOC of impl + tests + SECURITY.md. 1–2 days of focused work. The `@ax/ipc-core` extraction is the riskiest moving part — five files (`dispatcher.ts`, `auth.ts`, `body.ts`, `response.ts`, `errors.ts`) plus `handlers/` plus the `__tests__` that currently live in `@ax/ipc-server`. Mostly file moves + import-path updates; the protocol logic is unchanged.

## Kickoff prompt for next session

After `/clear`:

```
Write an implementation plan for HTTP runner-IPC (follow-up #1 from
docs/plans/2026-04-25-week-7-9-followups.md). Read
docs/plans/2026-04-25-http-runner-ipc-handoff.md first — it has file
pointers, scope decisions (TLS posture, keep-alive, parseRunnerEndpoint
location), and the security walk this slice requires. The shared-
primitives question is already decided: extract @ax/ipc-core from
@ax/ipc-server in a prep commit, then add @ax/ipc-http on top. Branch off
main (PR #9 merged). Invoke security-checklist — this is the first plugin
opening an inbound network listener; bearer auth + timingSafeEqual is
the gate. The plan should be executable via subagent-driven-development.
```
