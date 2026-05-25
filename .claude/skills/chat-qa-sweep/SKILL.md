---
name: chat-qa-sweep
description: Use when you want to QA / pressure-test / smoke-test / regression-sweep the chat UI against the local kind cluster ax-next-dev and get a findings report — not fix one bug, but run a fixed battery of common activities (new chat, npx, skills, attachments, artifacts, reload old sessions, title generation, parallel sessions) plus fault injection (sandbox killed mid-turn, host killed, provider error, network blip) and report what broke or glitched. Triggers on "pressure test the chat", "QA the chat UI", "run a chat smoke sweep", "chaos-test chat", "find UI glitches", "make sure chat still works end to end".
---

# chat-qa-sweep (battery + report, Playwright-verified)

A QA pressure-test for the chat UI. You drive the running chat surface against the
`ax-next-dev` kind cluster via Playwright MCP, run a **fixed catalog** of common-activity
scenarios plus a fault-injection battery, capture evidence, and emit a findings report.

This skill **finds** problems. It does not fix them. Each real bug it surfaces is filed and
fixed separately, with a regression test (per `CLAUDE.md`'s bug-fix policy). A passing sweep
is necessary, not sufficient.

## Not the same as k8s-acceptance-loop

| | `k8s-acceptance-loop` | `chat-qa-sweep` (this skill) |
|---|---|---|
| Shape | fix-until-one-scenario-passes | run-whole-battery-and-report |
| Stops on | first pass | never (records + continues) |
| Output | a working behavior | a findings report |
| Fixes bugs? | yes, iterates | no, hands findings off |

They're complementary: a failure this sweep finds is often handed to `k8s-acceptance-loop`
to actually fix.

## Don't duplicate the cluster scaffolding

This skill assumes a running `ax-next-dev` cluster and a working browser entry point. It
does **not** restate any of that. For:

- **cluster preconditions / first-run setup** → `k8s-acceptance-loop` §3
- **browser entry point** (port-forward to `:9090`) →
  `k8s-acceptance-loop` §4 + its `references/playwright-recipes.md` (Recipe 2
  send-and-wait, Recipe 4 multi-turn, Recipe 5 failure capture)

**Auth — don't trust dev-bootstrap on an existing cluster.** Recipe 1's `POST
/auth/dev-bootstrap` returns **404 once the cluster is bootstrapped** (an admin exists),
which is the normal state of a long-lived dev cluster. The working path is to **mint the
`ax_auth_session` cookie from a live DB session** (see `claude-memory`
`reference_headless_authed_chat_kind`): grab a non-expired `token` from
`auth_better_v1_sessions` (postgres superuser password is secret
`ax-next-postgresql/postgres-password`, db `ax_next`, psql at
`/opt/bitnami/postgresql/bin/psql`), sign it `b64url(token).b64url(hmac-sha256(keyBytes,
token))` with the **hex-decoded** `ax-next-secrets/http-cookie-key` (64 hex → 32 bytes),
then **verify** the cookie with `curl /api/chat/agents -H "Cookie: ax_auth_session=…"` (200
= good) before planting it in the browser via `browser_evaluate(() => document.cookie =
'ax_auth_session=…; Path=/; SameSite=Lax')` and re-navigating.

If the cluster isn't up or you can't sign in, **stop** and report "environment not ready."
Go run `k8s-acceptance-loop` §3 first. Don't half-run the battery against a sick cluster.

## The run model

```text
preconditions  →  happy-path battery  →  fault battery  →  report
   (§ k8s)         (cluster healthy)     (inject→observe
                                          →RESTORE→confirm)
```

1. **Preconditions.** Cluster up, chat surface loads, signed in. Then, before any
   scenario, **record the run header** (git sha/branch under test, image tag, the agent
   you'll test) and **pre-check the agent's capabilities** so capability-gated scenarios
   don't surprise you mid-run: does it have a skill attached (#4)? `artifact_publish`
   (#7)? **npx — is `registry.npmjs.org` reachable for it (#3)?** Any it lacks → that
   scenario is a planned `SKIP`, noted now, not discovered later — **except npx, which you
   GRANT, not skip** (see below). If the cluster/sign-in fails → stop + report "environment
   not ready."
   - **Granting npm egress for #3 (setup, not skip).** npm egress is skill-gated by design
     (`chat-orchestrator` only allowlists `registry.npmjs.org` when a skill in the agent's
     union declares `capabilities.packages.npm` — invariant #5, no blanket egress;
     `allowedHosts` is not a persisted agent column, so a skill is the *only* lever). If the
     test agent has no such skill, **create one via the real admin install path** so #3 tests
     genuine npx. From the authed browser (signed in as an admin), POST a SKILL.md whose
     frontmatter declares the capability — same code prod uses:
     ```js
     // browser_evaluate, admin session:
     await fetch('/admin/skills', { method:'POST',
       headers:{'content-type':'application/json','x-requested-with':'ax-admin'},
       credentials:'include',
       body: JSON.stringify({ defaultAttached: true, skillMd:
         "---\nname: npm-runner\ndescription: Run Node CLI tools via npx by allowlisting the npm registry.\nversion: 1\ncapabilities:\n  packages:\n    npm:\n      - cowsay\n---\n# npm-runner\nRun npx tools directly with Bash; the npm registry is reachable.\n" }) });
     ```
     `defaultAttached: true` grants it to **every** agent (broadest — record it as a cluster
     mutation in the report; leave it or delete after). To scope to one agent, omit
     `defaultAttached` and attach the returned `skillId` via the agents admin route. Either
     way, **start a NEW conversation** after granting (the allowlist is fixed at session-open;
     warm pods reuse the old one), then confirm #3 sees real npm output (the `npm notice`
     banner) and no 403. (A skill declaring credential slots can't be default-attached; a
     packages-only one can.)
   - **Port-forward:** start it as a real background process (the harness's
   background-run mechanism), not a bare `&` — shell state doesn't persist between tool
   calls, so a `&`-job from one call isn't reliably alive in the next, and the fault
   battery tears the forward down and back up repeatedly across calls.
2. **Happy-path battery** — all scenarios in `references/scenario-catalog.md`. Most are
   order-independent; the catalog's dependency graph shows the one real coupling
   (#3 → #5 → #8 share a session). Follow it.
3. **Fault battery** — all 4 faults in `references/fault-injection.md`. For each:
   inject → observe the UI → **restore the cluster to a clean baseline** → confirm-clean
   before the next fault.
4. **Report** — emit the findings report per `references/report-template.md`.

**Run the whole battery — don't stop on first failure.** A pressure test wants the full
picture; record the failure and keep going. The *only* early exit is a precondition /
environment failure that makes remaining scenarios meaningless.

**Restore discipline is mandatory.** The fault battery mutates cluster state (pod kills,
key swaps, dropped port-forward). A contaminated baseline makes every later result a lie.
Every fault has a RESTORE step, and the report's restored-checklist proves you ran it.

## Per-scenario protocol

For every scenario (happy or fault), in order:

1. **Drive** it via Playwright MCP (`browser_navigate` / `browser_type` /
   `browser_click` / `browser_press_key`).
2. **Wait** on the real signal with `browser_wait_for({ text | textGone })` — never
   `{ time }`. If you can't name the condition you're waiting on, you don't know what
   passing looks like. **Bound every wait** (`browser_wait_for` takes a timeout): pick a
   generous-but-finite max (e.g. ~60s for a turn to complete). If it elapses, that's the
   definition of a "hung spinner" → record **FAIL** and move on. Never wait unbounded —
   one stuck scenario must not stall the whole sweep.
3. **Capture** evidence: `browser_snapshot` + `browser_console_messages` +
   `browser_network_requests`, plus `browser_take_screenshot` for the report.
4. **Classify** strictly:
   - **PASS** — criteria met, no console errors, no white-screen.
   - **GLITCH** — works but with a visible defect (orphaned/dup message, layout break,
     spinner that lingers then resolves, console warning/error that doesn't break the
     flow). Record it; it's a finding.
   - **FAIL** — criteria not met, hung spinner, white-screen, unhandled exception, or
     (for faults) an error that was swallowed instead of surfaced.
   "Almost matches" is a FAIL or GLITCH, never a PASS.
5. **Record** the row (scenario · category · result · evidence · UI surface) immediately —
   don't trust memory across 15 scenarios.

## Errors must land in an existing UI component

A fault PASSES only if its error reaches an *existing* error-display surface — never a
silent hang or white-screen. The surfaces, in `packages/channel-web/src` (assert by the
DOM signal in parens — `browser_snapshot` gives an accessibility tree, not React source
names):

- `components/AgentStatus.tsx` — the status row that sits outside the timeline. In `error`
  mode it's the persistent "this turn failed" surface, with **stop / retry / dismiss**
  actions (DOM: `.agent-status` in error state, `role=alert`-ish, a retry button).
- `components/Thread.tsx` — per-message inline error (DOM: `.msg-error` row attached to the
  last `.msg.you`, `role=alert`, Retry/Dismiss).
- `components/Toast.tsx` — transient error toast (DOM: the toast region).
- `components/PaneStatus.tsx` — pane-level `error` variant (`bg-destructive-soft`), for a
  whole pane that failed to load.
- `components/ui/alert.tsx` — the shadcn `Alert` primitive for inline error blocks.

**Know what "surfaced correctly" looks like before you inject anything.** The chat has
client-side dev triggers (intercepted in `Composer.tsx`) that fire these surfaces on
demand, no backend needed: `/error transient` → `AgentStatus` error+retry; `/error inline`
→ `.msg-error`; `/error toast` → toast; `/error all` → all three. **⚠️ But these triggers
are gated behind `if (!import.meta.env.DEV) return;` (Composer.tsx ~L112) — they fire ONLY
in a Vite dev build. The kind cluster serves the PROD SPA, where `import.meta.env.DEV` is
`false`, so against the cluster they are NOT intercepted: typing `/error all` just sends a
real chat message.** So scenario #14 is an expected `SKIP` against kind (verified
2026-05-25) — don't rely on it as your in-cluster baseline. Instead, treat the component
contract above (AgentStatus error+retry, `.msg-error`, Toast) as the spec: when you inject a
*real* fault, its error should look like one of those — if instead you get a silent hang,
empty bubble, or white-screen, that's a **FAIL**. Swallowed errors are the bug this battery
exists to catch. (The fault battery itself is the real exercise of these surfaces; #14 only
adds value when driving the Vite dev server.)

## What this skill does NOT do

- Fix bugs. Findings go out separately, each with a regression test.
- Improvise scenarios. The catalog is fixed so runs compare across sessions.
- Restate cluster setup or the Playwright driver basics — that's `k8s-acceptance-loop`.
- Deploy to a real cluster. Kind (`ax-next-dev`) only.
- Leave the cluster dirty. The restore checklist is part of "done."
