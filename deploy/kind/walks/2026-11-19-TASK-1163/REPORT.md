# Slack real-Slack walk: TASK-1163

**PASS, with one design-changing answer.** Ran 2026-11-19, 01:10–03:17 UTC, on kind against the real Canopy Slack workspace. Every check that could run passed. The measurement phase 2 was waiting on is answered: **only the app creator's own configuration token can manage a Slack app.**

## Setup

- **Source:** `main` at `df1d0b4ae`, the same build as prod rev 90 (TASK-1159, 1139, 1128, 1133). Kind host rebuilt with `make image`.
- **Public address:** a cloudflared quick tunnel to a `localhost:9090` port-forward, with `AX_PUBLIC_BASE_URL` set to it.
- **Slack:** the Canopy workspace. Vinay generated and revoked every configuration token himself and pasted them straight into AX's Slack form, so no token passed through the agent. A second person's tokens came from `test@canopyworks.com`.
- **Evidence:** the host's `slack_*` log lines and the `channel_slack_v1_installs` / `channel_slack_v1_leftover_apps` rows. No token values were logged or read.

## Results

| # | Check | Result |
|---|---|---|
| 1 | Can a newer token from the same person delete an app their older token made? | **Yes.** Connect with T1; revoke T1, generate T2; Replace with T2 (`slack_config_token_replaced`); Disconnect → `slack_disconnected{appDeleted:true}`. Again at the end through the leftover path: Connect with a fresh token logged `slack_leftover_app_deleted` for an app made with an older one. |
| 2 | Another person's token, before and after they're an app collaborator | **Refused both times.** Six Replaces with test@'s token failed at `check-app` with Slack's `no_permission` on `apps.manifest.update`: before the collaborator add, after it (Vinay confirmed test@ listed on the Collaborators page), and with a token test@ generated after the add. Nothing was stored, and the install kept working. |
| 3 | A token from another Slack workspace | **Not run.** No second workspace at hand. |
| 4 | Revoke the old token after Replace | **Folded into 1.** Slack allows only one configuration token per person per workspace (Generate is unavailable while one exists), so the only possible order is revoke, then generate, then Replace, and that worked. Rename after the revoke and before the Replace failed at `rotate` with `invalid_refresh_token`, as designed. |
| 5 | Tokens page after Replace | **Measured indirectly:** one token per person per workspace, see 4. |
| 6 | Bot picture (TASK-1133) | **Pass.** The new bot showed the AX mark on Slack. No `icon` failure line. |
| 7 | New log lines (TASK-1139) | **Pass.** `slack_connected`, `slack_disconnected{appDeleted}` (true and false both seen), and `slack_leftover_app_deleted`. |
| — | Leftover safety net (TASK-1132) | **Pass.** A Disconnect whose stored token was dead logged `appDeleted:false` and kept the app on the leftover list. The next Connect deleted it, and the list emptied. |

## Findings

- **Phase 2 design (now §8 Q6):** since only the creator's token can manage an app, whoever's token creates each per-agent bot is the only person who can ever rename, re-sync or delete it. Handing a bot over means making a new app. This needs a decision before decomposing phase 2.
- **Replace's copy is now wrong.** It asks for a token "from someone who can manage this Slack app", and a collaborator's token is refused. It should ask for a new token from the person who created the app. Added to TASK-1164.
- **Unexplained:** Vinay's T3 was dead by the final Disconnect (03:13), though nothing in AX had used it since Connect (02:46) and the six refused Replaces stored nothing. Either it was revoked by hand during the walk, or something on Slack's side (test@'s token churn?) killed it. Not filed; watch for it.
- Rename success logs nothing, so the log can't confirm a Rename by itself (TASK-1165 adds reason lines for the picture; renames have the same gap).

## Not measured

- A token from a different Slack workspace (check 3).
- Whether a Slack *workspace owner or admin* (rather than a collaborator) gets a different answer on `apps.manifest.update` for someone else's app. test@ is a plain member.
