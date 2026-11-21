# Slack phase 2 real-Slack walk: TASK-1174

**PASS, with two real bugs filed.** Ran 2026-11-21, about 12:00–13:50 UTC, on kind against the real Canopy Slack workspace. Every step of the walk ran, and every step passed except two findings, each filed as its own card: a channel that turns private after it is bound keeps getting answers (TASK-1184), and AX shows a bot's legacy username instead of the @handle people type (TASK-1185). Dedicated per-agent bots work end to end: request, self-approve, ask-an-admin with Slack DMs, rename and picture, Replace, Claim, Rebuild, Disconnect and agent delete.

## Setup

- **Source:** `main` at `8f0aeb7f0` (every phase 2 card: TASK-1167..1173, 1175, 1179, 1180, 1182). Kind host rebuilt with `make image`.
- **Public address:** a cloudflared quick tunnel to a port-forward of the host's **public-http port 9090**, with `AX_PUBLIC_BASE_URL` set to it. (The service's port 80 is IPC, not the web UI. Forwarding it gives `SESSION_INVALID` on every page.)
- **Sign-in:** Google sign-in isn't configured on kind (`Provider not found: google`), so each person got an 8-hour session minted by a local, untracked kind-login helper, pasted as the `ax_auth_session` cookie for the tunnel domain. The second person was `test@canopyworks.com`, created with a verified email so they'd get bot-request DMs.
- **Slack:** the Canopy workspace. Vinay and test@ generated and revoked every configuration token themselves and pasted them straight into AX. No token passed through the agent.
- **Evidence:** the host's `slack_*` log lines and the `channel_slack_v1_*` rows. No token values were logged or read.
- **Test fixtures on kind:** team "Walk Team" with agents Fern and Moss. Team roles and test@'s AX account were changed in the database to set up Claim and Rebuild (below).

## Results

| # | Step | Result |
|---|---|---|
| 0 | Shared bot connected (phase 1) | **Pass.** `slack_connected`. The Connect form asks for both the access and the refresh token. |
| 1 | Request a bot on a team agent, self-approve | **Pass.** No token asked for: AX used Vinay's stored per-person token (TASK-1175). |
| 2 | Allow, then "live" with Slack's name; creator on api.slack.com | **Pass,** with one wrong detail: settings said "@fernwalk is live", but in Slack the bot is `@fern-walk`. **TASK-1185.** The app's creator was Vinay. |
| 3 | Answers in a public channel's thread, as the agent; private and Slack Connect get no turn | **Pass** for public (threaded, as Fern), for a channel private from the start (refused, `channel-not-allowed missing_scope`), and for Slack Connect (`slack_event_ignored reason:slack-connect`). **Fail:** a channel bound while public and then converted to private kept getting answers. **TASK-1184.** |
| 3b | Outsider turn runs as the requester | **Not seen.** There was no third Slack user without an AX account. |
| 4 | Channels the shared bot already served | **Pass.** `#walk-a` was listed as needing `/invite`. `@ax` there gave the private hint naming Fern's own bot (`slack_event_ignored reason:own-bot`). Moss still answered through `@ax` in `#walk-b`. **Memory carry-over (TASK-1180): pass.** `#walk-a` had remember OFF on the shared bot, and Fern's own binding started OFF. |
| 5 | Name clash | **Pass.** `fern-walk` and `fernwalk` were both refused on Moss. |
| 6 | Ask an AX admin | **Pass.** The request showed in Admin › Slack and as a Slack DM to test@ (`slack_bot_request_dms_sent sent:1 skipped:2`; the skipped two are AX admins with no Slack account, `users_not_found`). So `chat.postMessage` to a user id with only `chat:write` works. A Decline clicked by a non-admin was refused (`slack_bot_request_click_refused reason:not-admin`), and the request stayed open. test@ approved with their own pasted token and clicked Allow. Vinay got the "live" DM (`slack_bot_request_owner_dm_sent notice:live`). Creator on api.slack.com: test@. |
| 7 | Rename and picture from agent settings | **Pass.** No reinstall. Slack's autocomplete followed the new name. `slack_bot_renamed`, `slack_bot_picture_changed`. The stored handle stayed `fernwalk` (see TASK-1185). |
| 8 | Admin › Slack lists both bots with approvers | **Pass.** |
| — | Memory switch on a bot channel (TASK-1180) | **Pass.** Turning `#walk-c` OFF in Fern's settings saved. Later turns logged `memory_capture_refused reason:channel-not-remembered`. |
| 9 | Replace by the approver after revoking | **Pass.** `slack_bot_token_replaced`, and a rename afterwards worked. |
| 9b | Someone else's token is refused | **Pass.** test@'s fresh token pasted into Fern's Replace was refused at `check-app` with Slack's `no_permission`. Nothing was stored, and Fern's bot kept working. |
| 10a | Claim (the requester stops being a team admin) | **Pass.** With Vinay demoted to member, test@ (a team admin) saw "needs a team admin to claim it" and claimed it (`slack_bot_claimed`). The requester and all three channel bindings moved to test@ in one step. The approver stayed Vinay. Members' turns kept working before the claim. |
| 10b | Rebuild (the approver no longer exists) | **Pass.** With test@'s AX account deleted, Moss showed "needs rebuilding". Rebuild deleted the old app with test@'s stored token (`slack_bot_disconnected appDeleted:true`, nothing left over). Vinay then self-approved a new `moss-walk`. `#walk-b` needed `/invite` again and then answered. |
| 10c | Claim after the requester was deleted | **Pass.** Fern's bot (requester test@, now gone) was claimed back by Vinay. |
| 12 | Disconnecting the shared bot leaves dedicated bots alone | **Pass.** `slack_disconnected appDeleted:true` for the shared app. Both dedicated bots kept answering. |
| 11 | Delete the agent, and Disconnect a bot | **Pass.** Deleting Fern logged `slack_agent_channels_removed` (3 channels, 18 threads) and `slack_agent_bot_removed appDeleted:true`. The app was gone from api.slack.com and `#walk-c` went silent. Disconnecting Moss's bot deleted its app the same way. Afterwards kind had no Slack installs, channels or leftover apps. |
| — | Cleanup | Vinay confirmed no walk app is left on api.slack.com and revoked both configuration tokens. |

## Findings

- **TASK-1184 (To Do): a channel that turns private after it is bound keeps getting answers.** `connectable()` runs only when a channel is bound, and an `app_mention` event carries no channel type. The shared bot very likely has the same gap. Fix: re-check the channel when a turn starts, and fail closed.
- **TASK-1185 (To Do): AX shows the legacy username, not the @handle.** `handleFrom` stores `users.info` → `name` (`fernwalk`). People type the display name (`@fern-walk`), which also follows a rename, while `name` does not.
- **TASK-1183 (Backlog): Admin › Agents can't create a team agent.** The identity save answers 403 (TASK-465's rule refuses team agents), and the form's rollback is unreliable: of three attempts, one agent was purged and two were left behind.
- **Not filed:** the first click on Delete for Fern showed an error and the second succeeded. The host logged one delete, which took about 5 seconds to purge (20 sessions, 19 conversations), so the first click probably stopped waiting while the server finished. The error text wasn't kept.
- **Walk mechanics, not product:**
  - An Approve link clicked in Slack opens a browser window that may not hold the walk's hand-made session cookie, so it lands on sign-in. On a real deployment the person just signs in.
  - Only AX admins with a verified email get bot-request DMs (TASK-1170). On kind, the local kind-login helper creates users as verified.
- **What Slack did that §7 doesn't already say:**
  - A bot's legacy `name` drops the hyphen from the requested name and does not follow a rename. The display name does both.
  - `conversations.info` on a private channel with the dedicated bot's channels-only scopes answers `missing_scope`, which AX treats as a refusal. That's correct, and it fails closed.
