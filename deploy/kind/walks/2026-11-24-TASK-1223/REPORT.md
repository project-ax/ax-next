# TASK-1223 walk: dev services on demand

- **Date:** 2026-11-24/25, on kind `ax-next-dev` (Kubernetes 1.35).
- **Source:** `main` at `7a30a71be` (#1255). The agent image was built from that commit and loaded into kind. The chart was upgraded to revision 34 from the same tree, with `chat.maxServiceSandboxesPerAgent=2` for the cap check. The release's saved values went on top with `-f`, not `--reuse-values`, so the new chart defaults applied (Helm 3.13 has no `--reset-then-reuse-values`).
- **Who:** `claude-walk` (admin) and a new personal agent, Walker. Walker's turn limit was set to 100 minutes in its Advanced settings.
- **Stack:** a synthetic compose file with two profiles. `e2e` has redis (published 16379), postgres (published 15432, `depends_on` redis) and a one-shot `seed` job (`restart: "no"`, `command` with a `$$HOSTNAME` escape, `depends_on` postgres). `dev` has redis and an nginx.
- **Browser:** a headless Chromium driven by the repo's own Playwright, because the Playwright MCP profile was held by another session.

## Results

| # | Check | Result |
|---|---|---|
| 1 | Import a compose profile, pin the images, mark it on-demand | **Pass, with a workaround.** The editor read both profiles. Choosing `e2e` brought in redis, postgres and seed in dependency order, and left out the `dev`-only nginx. All three images were pinned to digests and the pins were shown. Published ports, the job flag, the command and the `$$`→`$` escape were stored. A plain edit and a re-import both kept them, and on-demand stayed on. **But** there is no UI path to start such a connector (finding → TASK-1239), so the walk created an empty one through `POST /admin/connectors` and did everything else in the editor. |
| 2 | `restart_with_services`: the stack starts and answers on its published ports | **Pass, on the second try.** The first try failed because postgres can't start as user 1000 on a root-owned volume (finding → TASK-1241). That failure surfaced as a generic error (finding → TASK-1240). With `PGDATA` set to a subdirectory, the restart swapped sandboxes and the pod carried `svc-redis`, `svc-postgres` and `svc-seed`. The agent got `+PONG` from `localhost:16379` and a connection on `localhost:15432`. The seed job printed `seeded-ax-sandbox-e24b6e1e`. |
| 3 | One stream, one turn end | **Pass.** One reply that continues across the swap, then ends once. The display log holds one user turn and two assistant turns: before the swap and the continuation. |
| 4 | `stop_services` works | **Pass.** It cleared the conversation's set (`service_set_stopped`). As the spec says (§2), the running sandbox keeps its services, so redis still answered in that turn. The next turn got a fresh plain sandbox, where `localhost:16379` was refused. |
| 5 | A 20-minute silent think | **Pass, as a stand-in.** A model can't be made to think silently for 20 minutes. Instead one Bash call ran `sleep 1200` with no output: sent 01:07:29, replied `T1-WOKE` at 01:27. The idle and turn clocks see the same silence. Not walked: claude-sdk's own `API_TIMEOUT_MS` on one long model response. |
| 6 | A 15-minute Bash call | **Pass.** Sent 01:08:42, `T2-DONE` at 01:23. |
| 7 | A 70-minute turn | **Pass.** Five 14-minute Bash calls in one turn. Sent 01:09:26, all five parts at 02:19. No turn error, idle cut-off or credential failure in the host log. |
| 8 | Slack's 30-minute cap holds | **Verified in code and tests, not walked live** (Vinay's call: no post to the real Slack workspace). The cap is channel-slack's own timer (`TURN_HARD_CAP_MS`, armed at the turn's first chunk, `turn.ts:820`). It doesn't depend on the agent's turn limit, and it stops the turn when it fires. `router.test.ts` and `turn.test.ts` pass (331 tests), including both hard-cap tests. |
| 9 | Two conversations at a cap of 2: the third is refused | **Pass.** With two service sandboxes live, a third conversation's `restart_with_services` got "Nothing restarted. This agent already has 2 conversations running services. Try again when one finishes." (`service_restart_refused {reason: at-cap, max: 2}`). It stayed on its plain sandbox. A slot freed by the idle reaper (about 5 minutes after a reply) is reused, as it should be. |
| 10 | A message sent while the restart sandbox is opening routes in behind the note | **Pass, with a finding.** A second message posted through the API during the swap was answered after the continuation, in the new sandbox (`42`, and `CONNECTED` on 16379). But the POST didn't return until the new sandbox was ready, 73 s later (finding → TASK-1242). |

## Findings

- **TASK-1239:** No UI path to create a compose connector. "New connector" opens only the remote MCP form (since #833), and the directory lists only MCP servers.
- **TASK-1240 (important):** A service that never becomes ready ends the turn with "The agent stopped unexpectedly." `sandbox:open-session`'s 300 s hook timeout fires before the sandbox's own readiness budget (60 s + 120 s per service, 420 s here). So the sidecar diagnosis naming the service lands 2 minutes later with nobody listening, and the pod lives until then. A healthy stack that needs more than 300 s would fail the same way.
- **TASK-1241:** Images that chmod or chown their data directory (postgres) can't start as user 1000 on a root-owned emptyDir. The importer only adds `/tmp`, so the admin has to know each image's data paths.
- **TASK-1242:** Posting a message during a restart blocks the request until the new sandbox opens.
- **TASK-1243:** Polish. A refused restart still shows "Restarting with dev services". The connector's skill stub doesn't name the services or their ports. The two service tools sit under "Other tools" with no description.

Checked and not filed: every chat logs `transcript_display_divergence` (a tool row before the assistant row). It also happens in chats that never used services, and it's the known warn-level diagnostic from TASK-67/TASK-85.

## Cleanup

Kind keeps the `walk-e2e` connector (attached to Walker), Walker and its conversations, and revision 34 with the cap at 2. To put the cap back: `helm --kube-context kind-ax-next-dev upgrade ax-next deploy/charts/ax-next -n ax-next -f deploy/charts/ax-next/kind-dev-values.yaml -f <saved values> --set chat.maxServiceSandboxesPerAgent=10`.
