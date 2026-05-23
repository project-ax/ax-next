# Fault-injection battery

Four faults. Each: the **lever**, **when** to inject, the **expected UI surface**, the
PASS/FAIL call, and the mandatory **RESTORE** step. Run them **after** the happy-path
battery, one at a time, restoring to a clean baseline between each.

The shared contract: an injected fault must surface a user-visible error in an *existing*
component (`AgentStatus` error+retry, `Thread` `.msg-error`, `Toast`, `PaneStatus`, or
`Alert`) — never a silent hang or white-screen — and the UI must recover after restore.
You saw what a *correctly* surfaced error looks like in happy-path **#15** (`/error`
triggers); a real fault that produces *less* than that — empty bubble, infinite spinner,
white-screen — is the bug this battery exists to catch.

## Two operational rules that bite hard here

1. **Shell state does NOT persist between tool calls, and a bare `&` is unreliable across
   them.** Start the port-forward with the harness's background-run mechanism, and persist
   anything you must remember (like the original API key) to a **file on disk**, not a
   shell variable — a variable set in one call is gone in the next.
2. **Restore from captured ground truth, never from an assumed env var.** The single most
   dangerous mistake in this skill is "restore the key from `$ANTHROPIC_API_KEY`" — if that
   var is unset in the current shell, you set the key to an **empty string** and brick the
   cluster while the script looks like it succeeded. Capture the live value first; restore
   that.

Cluster handles (same as `k8s-acceptance-loop`):
- host: namespace `ax-next`, `deploy/ax-next-host`, label
  `app.kubernetes.io/component=ax-next-host`
- runners: namespace `ax-next-runners`, label
  `app.kubernetes.io/component=ax-next-runner`
- helm release `ax-next`; public port-forward `svc/ax-next-host 9090:9090`

**Before each fault:** confirm a clean baseline — host `Ready`, port-forward alive
(`curl -fsS http://localhost:9090/health`), one normal message → normal reply. Don't inject
onto an already-broken baseline.

---

## A. Sandbox killed mid-session

A runner pod dies while it's mid-turn. The session should report the failure and recover on
the next message.

**Caveat (warm-runner reuse, PR #124):** runners are kept warm and reused, and a fresh one
can respawn fast. So (i) use a genuinely long stream so the kill lands *during* the turn,
and (ii) confirm you delete the pod actually serving this turn — list pods, send, watch
which one is busy, kill that one. If you kill an idle warm pod, the fault never fires and a
"PASS" is meaningless.

**Inject:**
```bash
# 1. Note current runners.
kubectl -n ax-next-runners get pods -l app.kubernetes.io/component=ax-next-runner
# 2. In the UI send: "count slowly from 1 to 50, one number per line, pausing between each."
# 3. While it's streaming, delete the serving runner pod:
kubectl -n ax-next-runners delete pod <serving-pod> --now
```

**Expected UI:** the in-flight turn stops and an error surfaces (`AgentStatus` error /
`.msg-error` / `Toast`) — not a spinner that hangs past its bound. Then a fresh message
spawns a new sandbox and completes normally.

**PASS:** error surfaced for the killed turn AND the next message works.
**FAIL:** spinner hangs with no error; or the session is permanently wedged.

**Variant worth a row if you have time — runner never spawns:** scale the runner's ability
to schedule to zero (e.g. cordon, or a bogus nodeSelector) so a *new* turn's pod sits
`Pending` forever. The UI should surface "starting…" then a timeout error, not hang
silently. Restore by undoing the scheduling block.

**RESTORE:** none for the basic kill — the pod is gone; the next turn respawns one. Confirm
a normal message works before moving on. (If you ran the never-spawns variant, undo the
scheduling block and confirm pods schedule again.)

---

## B. Host killed mid-session

The host pod restarts while a turn is in flight. The browser loses its connection; the
session must survive a host bounce.

**Prefer `rollout restart` over `delete pod`.** On a loaded kind node a hard `delete pod`
can be slow to reschedule, `rollout status` can time out, and you're left mid-battery with
a down host and a dead port-forward — the contaminated baseline this skill warns against.
`rollout restart` is graceful and recoverable.

**Inject** — start a turn, then bounce the host mid-stream:
```bash
kubectl -n ax-next rollout restart deployment/ax-next-host
```

**Expected UI:** a connection-lost / network error surfaces (`Failed to fetch` in the
console, plus a visible `AgentStatus`/`Toast` error) — not a white-screen, not a frozen
spinner. After the host is `Ready` again and the port-forward is back, reloading the session
shows the transcript and a new message works.

**PASS:** error surfaced during the outage AND the session reloads + continues after
recovery.
**FAIL:** white-screen, unhandled exception, or session unrecoverable after the host
returns.

**RESTORE:**
```bash
kubectl -n ax-next rollout status deployment/ax-next-host --timeout=180s
```
The port-forward died with the old pod — **restart it via the background-run mechanism**
(not a bare `&`), then `curl -fsS http://localhost:9090/health`. If `rollout status` times
out, treat the cluster as not-ready: stop the battery and report it rather than pressing on
against a sick host. Re-navigate the browser (cached bundle may mask state) and confirm a
normal message works.

---

## C. LLM provider error  ⚠️ the cluster-bricking one — read the RESTORE first

The provider rejects the request. A bad/revoked key forces a 401-style auth rejection.

> **Note:** a bad key yields a provider *auth rejection*, not true quota exhaustion ("out of
> tokens" / 429), which can't be forced on demand — so this stands in for the whole
> "provider rejects the request" class. A related **mid-stream truncation** variant (the
> provider returns 200 then the upstream drops before a `done` frame) is worth a look too:
> the turn must still end with an error, not hang. The SSE relies on the `chat:turn-end`
> audit invariant + the client transport synthesizing a finish on a `done`-less close; a
> hang here means that guard failed.

### Step 1 — capture the live key to a FILE (survives across tool calls)

Do this BEFORE injecting. If you can't capture it, **do not inject** — you'd have nothing
to restore to.

```bash
# Field/secret name may differ — verify against the chart if this comes back empty:
#   kubectl -n ax-next get secret -o yaml | grep -i anthropic
kubectl -n ax-next get secret ax-next-secrets \
  -o jsonpath='{.data.anthropic-api-key}' | base64 -d > /tmp/ax-orig-anthropic-key
test -s /tmp/ax-orig-anthropic-key || { echo "ABORT: could not capture current key — do NOT inject"; exit 1; }
```

If the key is sourced from a **postgres credential row** (seeded via the credentials admin
UI) rather than the helm value, the helm `--set` below will no-op (fault never fires) — and
so would a helm restore. In that case capture and swap the **DB credential** instead, and
write which path you used to a file (`echo db > /tmp/ax-fault-c-path`) so RESTORE reads it
back. Default path marker: `echo helm > /tmp/ax-fault-c-path`.

### Step 2 — inject the bad key

```bash
helm upgrade ax-next deploy/charts/ax-next --namespace ax-next --reuse-values \
  --set anthropic.apiKey='sk-ant-DELIBERATELY-INVALID-000'
kubectl -n ax-next rollout restart deployment/ax-next-host
kubectl -n ax-next rollout status  deployment/ax-next-host --timeout=180s
# restart the port-forward (background-run mechanism), then verify the lever TOOK:
curl -fsS http://localhost:9090/health
```

**Verify the fault actually fired** before trusting the result: send a message and confirm
the turn fails with a provider/auth error. If it still succeeds, the key came from the DB
path — go back to Step 1's DB branch. Don't report a PASS off a fault that never fired.

**Expected UI:** the turn fails and a provider error surfaces (`.msg-error` /
`AgentStatus` / `Toast` / `Alert`) — readable, not a raw stack, not a silent empty bubble.

**PASS:** provider error surfaced clearly.
**FAIL:** silent empty bubble, infinite spinner, or raw unhandled console error with nothing
in the UI.

### Step 3 — RESTORE from the captured file (mandatory)

```bash
ORIG=$(cat /tmp/ax-orig-anthropic-key)
test -n "$ORIG" || { echo "REFUSING to restore an empty key — recover the real key manually"; exit 1; }
helm upgrade ax-next deploy/charts/ax-next --namespace ax-next --reuse-values \
  --set anthropic.apiKey="$ORIG"
kubectl -n ax-next rollout restart deployment/ax-next-host
kubectl -n ax-next rollout status  deployment/ax-next-host --timeout=180s
# restart port-forward, then prove recovery:
curl -fsS http://localhost:9090/health
```

(If `/tmp/ax-fault-c-path` says `db`, restore the DB credential instead.) Send a normal
message and confirm a normal reply **before** continuing. A forgotten/empty key bricks the
cluster for everyone after you — this is not optional cleanup.

---

## D. Temporary network error

A transient client↔host network blip. Dropping the port-forward is the cheapest faithful
lever — to the browser it looks exactly like the network going away mid-request.

**Inject** — kill the port-forward while a request is in flight:
```bash
# Send a message in the UI, then immediately kill the forward:
pkill -f 'port-forward svc/ax-next-host 9090:9090' || true
```

**Expected UI:** the in-flight request fails with `Failed to fetch` / `net::ERR_*` (visible
in console + network) and the UI shows a network/retry state (`AgentStatus`/`Toast`) — not a
white-screen, not a forever-spinner.

**PASS:** network error surfaced AND, once the forward is back, a retry or fresh message
works (the app recovers, doesn't stay wedged).
**FAIL:** white-screen, unhandled exception, or permanently stuck after the forward returns.

**RESTORE:** restart the port-forward via the background-run mechanism, then
`curl -fsS http://localhost:9090/health`. Re-navigate / refresh the browser and confirm a
normal message works.

---

## Restore checklist (carry into the report)

The cluster must be left exactly as you found it. Before declaring the sweep done, confirm:

- [ ] **A** — a normal message gets a normal reply (new sandbox spawns fine); any
      scheduling block from the never-spawns variant is undone.
- [ ] **B** — host `Ready`, port-forward alive, session reloads.
- [ ] **C** — **real Anthropic key restored** from `/tmp/ax-orig-anthropic-key` (or the DB
      credential per `/tmp/ax-fault-c-path`); a normal message succeeds. *This is the
      dangerous one — a forgotten/empty key bricks the cluster.*
- [ ] **D** — port-forward alive, `/health` 200.
- [ ] Final: one clean end-to-end message + response, no console errors. Clean up the
      `/tmp/ax-*` scratch files.
