# Slack phase 1 walk on kind — TASK-1097

**PARTIAL PASS, with one blocking bug (TASK-1129).** 2026-11-15 ET (2026-11-15 22:00 – 2026-11-16 01:40 UTC). Every step that ran passed except Rename after the first one. The steps that couldn't run are carried to TASK-1134. No production deployment was performed.

## Setup

- Source: `main` at `0aaed95f3` (TASK-1091–1096 merged). Kind host rebuilt with `make image`. Cluster `kind-ax-next-dev`, namespace `ax-next`.
- Public address: a cloudflared quick tunnel to a `localhost:9090` port-forward, with `AX_PUBLIC_BASE_URL` set to it.
- Slack: the Canopy workspace. Vinay (workspace admin) pasted the configuration tokens and clicked Allow himself. No token passed through the agent.
- People: Vinay (AX admin, team admin of "Walk Team"); `test@canopyworks.com` (a company member with no AX account); a guest/off-domain user; someone from another org in a Slack Connect channel.
- Agents: Juniper (Vinay's personal agent); Fern (a team agent in "Walk Team", made for this walk).
- Channels: `#ax-test-internal` (internal); `#ax-test` (Slack Connect).
- Held calls came from `routine_create`, which is held for approval with no connector needed.

## Results

| # | Step | Result |
|---|---|---|
| 1 | Connect with the default name, then Rename in Admin › Slack | **Pass.** The new name showed in Slack without a reload. **Docs wrong:** the @handle changed too (`ax-walk`), but the design and the Rename copy say it stays. Correction is in TASK-1129. |
| 2 | Messages posted through the Slack connector (an app acting for a user) | **Refused** (`slack_event_ignored {reason:'bot'}`, `admission.ts:242`: they carry the connector's `bot_id`). That's correct: another app can't talk to an agent on a person's behalf. From here on the people typed every message. |
| 3 | Owner DMs the personal agent | **Pass.** The reply streamed in, from Juniper. |
| 4 | Host card in a DM ("Wants to connect to example.org") | **Pass.** Allow continued the turn. A domain in a `plain_text` section is **not** auto-linked. Button clicks pass the same v0 signature check as events. |
| 5 | Deny, then a new message straight away (the TASK-1126 gap) | **Pass.** The new reply arrived. |
| 6 | Another member DMs the bot | **Pass.** They got the sign-in prompt (no AX account), never Juniper. |
| 7 | Held call in a DM (`routine_create`) | **Pass.** Allow and Deny appeared after the reply, and Allow carried on. |
| 8 | `/ax connect Fern` in `#ax-test-internal` | **Pass.** |
| 9 | Streamed reply in a channel thread | **Pass.** The other member saw it stream in the thread, so `recipient_user_id` doesn't make it private. |
| 10 | Broadcast words | **Partial.** Every `@channel`, `<!here>` and `&#64;channel` the model wrote reached Slack with a zero-width space after the `@` or `<`. `＠channel` (fullwidth) arrived as-is, and Slack doesn't treat it as a mention. The model refused to write the bare forms outside code spans, so whether an unfiltered bare `@channel` in `markdown_text` broadcasts is still unmeasured (TASK-1134). |
| 11 | Held call in a member's channel thread; a bystander clicks | **Pass.** The bystander's Allow got a private "only the person who asked" note and did nothing. The asker's Allow continued in the same thread. |
| 12 | An outsider's mention (member with no AX account) | **Pass.** Fern answered, running as the person who connected the channel. The thread is marked `external`. |
| 13 | An outsider's held call | **Pass.** No buttons, our fixed "needs my owner's OK" line, and the hold landed `unattended` in Vinay's Today (`14-outsider-hold-in-owner-today.png`). **Finding:** the agent also told the outsider "you should see a card to approve it" (TASK-1131). |
| 14 | Guest or off-domain user mentions the bot | **Pass.** Silence. |
| 15 | Slack Connect channel | **Pass.** Silence (`slack-connect`). |
| 16 | Group DM that includes someone from another org | **Pass.** Silence (`slack-connect`, correct: Slack marks it shared). A group DM with only internal people was not tried. |
| 17 | Memory switch off: new thread; switch back on: reply in the same thread | **Pass.** The thread stayed `not_remembered`. `memory_note` was refused (`forbidden`) on both turns, capture was vetoed, and neither phrase reached the facts store. The positive case can't be seen on kind (`memory_no_llm_credential`). |
| 18 | `/ax disconnect`, then a mention | **Pass.** "No agent is connected here…" with how to connect one. |
| 19 | Rename with a dead configuration token (TASK-1096 check 3) | **Pass.** The dialog says the token can't be used and to disconnect and connect again (`12-rename-dead-token.png`). |
| 20 | Rename more than once | **FAIL, TASK-1129.** Details below. |

## TASK-1129: the stored refresh token dies a few minutes after its first rotate

TASK-1093 stores the pasted configuration refresh token and never replaces it. TASK-1096 reuses it for every rename. Both rest on TASK-1090's measurement that "the old refresh token keeps working" after a rotate. That holds only for a few minutes.

- **First install:**
  - Connect at 22:01 UTC.
  - Rename at 22:08 worked.
  - At 01:06, six renames all failed `slack_admin_failed {stage:'rotate', code:'invalid_refresh_token'}`.
  - Nobody touched the tokens page in between.
- **Second install:**
  - Connect at 01:30:49 with a new pair.
  - Four renames between 01:31:26 and 01:31:44 all worked.
  - At 01:37:42 the next one failed the same way.

  One confound: the admin saved an Interactivity change on api.slack.com in that gap.
- **Effect:**
  - Rename works only within a few minutes of the first rotate.
  - Disconnect after any rename can't delete the Slack app (`appDeleted:false`, seen at 01:25).
- **Prod:** rev 86 has no Rename, and its single rotate at Disconnect still works. **TASK-1096 should not be deployed before TASK-1129 is fixed.**

## Other findings

- **TASK-1130:** runner narration ("Loading the routine creation tool schema.", "Generating a unique request identifier for retry.") shows up in Slack replies. *Measured later (TASK-1130): it wasn't runner narration or model text. Both are `@ax/step-summaries` lines, shown as the reply's status card title. The first summarizes the SDK's `ToolSearch` call (loading a tool's schema), which the web already hid and Slack now hides too. The second is a real `routine_create` call's summary, which the web shows as well.*
- **TASK-1131:** the agent isn't told who is asking in a channel turn. It told an outsider to approve a card, and it called a member's plain request a "prompt injection".
- **TASK-1132:** a refused install callback (`unauthenticated`: the admin's cookie wasn't on the public address), followed by a second Connect, leaves an orphan Slack app. *Found later (TASK-1132): the refused callback itself leaves nothing behind. The install stays pending, Continue in Slack reuses its app, and Connect refuses while an install is pending. A second app needs a Cancel first. Cancel deletes the app with the stored configuration token, and when that token is dead or revoked the delete fails (`appDeleted:false`) and AX forgot the app. It now remembers it: the Slack tab names it until it's gone, and the next Connect tries to delete it.*
- **TASK-1133:** `apps.icon.set` refuses our avatar on every Connect (`error_bad_format`).
- **Thread replies need an @mention.** A plain reply in a channel thread is ignored, by design. Noted as friction, not filed.
- **Kind sessions:** the agent's browser session was signed out twice during the walk, near the Connect steps. The rows were still in `auth_better_v1_sessions`, so the cookie was most likely lost on the browser side. Not filed.

## Not walked (TASK-1134, after TASK-1129)

- **TASK-1096 check (2):** a rename restores a cleared Interactivity URL. Blocked when the token died.
- **TASK-1096 check (5):** whether Slack caps live configuration tokens.
- **Revoke:** Revoke on Slack's page, then rename.
- **Channel connect from the agent settings UI.**
- **Removing the connector from the team** gives a "reconnect" line.
- **The skill permission card.**
- **Broadcast words:** the unfiltered bare-`@channel` question, and the invisible-character forms.
- **The memory positive case.**

## Teardown state

- The kind install `iEyaszNcN9J27FsPTdSzAQ` (app `A0CHHCT1Z8X`) is connected, but its stored token is dead and its Interactivity URL was cleared for check (2). Buttons won't work until it's disconnected and connected again.
- Orphan apps from this walk may be left on api.slack.com/apps (the 01:27 attempt, and the old `A0CHZPVDJHX` if it wasn't deleted). Delete them by hand.
