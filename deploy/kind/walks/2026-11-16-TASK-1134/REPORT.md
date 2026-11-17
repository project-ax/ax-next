# Slack phase 1 walk on kind, part 2: TASK-1134

**PASS, with findings.** Ran 2026-11-16, from about 13:00 UTC to 2026-11-17 01:20 UTC. Every step that TASK-1097 carried over ran, and each one did what the code promises. The findings below are UX and agent-behaviour gaps, not broken guards. We didn't deploy anything to production during the walk.

## Setup

- **Source:** `main` at `e0235191e` (TASK-1095, 1096 and 1129 merged; the same build as prod rev 87). The kind host was rebuilt with `make image`.
- **Public address:** a cloudflared quick tunnel to a `localhost:9090` port-forward.
- **Slack:** the Canopy workspace. Vinay (workspace admin) made the configuration tokens and clicked Allow himself, and handed tokens over only in a mode-600 scratch file. The bot token used for the broadcast test was shredded afterwards.
- **People:** Vinay (AX admin, team admin of Fern's team) and `test@canopyworks.com` (a company member with no AX account).
- **Agents:** Juniper (Vinay's personal agent, claude-sdk) and Fern (team agent).
- **Channel:** `#ax-test-internal`.
- **Install:** the old install's Disconnect failed with `invalid_refresh_token` and `appDeleted:false`, so Vinay deleted the old apps by hand and connected a fresh one.

## Results

| # | Step | Result |
|---|---|---|
| 1 | Rename, repeated (TASK-1129 acceptance) | **Pass.** A detached probe renamed every 10 minutes from 13:07 to 16:07 UTC, 19 times, plus manual renames. Every one returned 200, and the stored refresh token changed on every call. That's past TASK-1097's ~6-minute failure, and Slack showed no cap after 21+ rotations. |
| 2 | Allow and Deny with the Interactivity URL cleared, then a rename | **Pass.** The rename put the URL back. Allow ran the held `routine_create`, and Deny dismissed it. |
| 3 | Channel picker (`/ax connect` with no name, choose, re-choose, cancel, already connected) | **Pass.** All five sub-steps behaved as designed. |
| 4 | Fern's team loses its channel connection, then an outsider mentions Fern | **Pass.** The outsider got a private "I can't answer here right now. A team admin needs to connect me to this channel again." The host logged `slack_channel_unavailable` with reason `connector-no-access`. |
| 5 | Broadcast words, sent with the bot token as `chat.postMessage` + `markdown_text` | **Measured.** Bare `@channel` and `@here` stayed plain text, and so did `@channel` with a soft hyphen or word joiner inside. Only `<!channel>` and `<!here>` broadcast. Our marking stays as it is (it's cheap insurance), and the stale "unmeasured" comment in `format.ts` is corrected in this PR. The 7 test posts were deleted. |
| 6 | Team memory in a channel | **Pass, with findings.** The idle observer stored 2 facts with the shared audience. For example: "vinay: stated_standup_time: Team standup moved to 10:15 on Tuesdays". See findings 3 and 4. |
| 7 | Skill card for a skill with no reach (`walk-haiku`) | **Partial.** Only the held `request_capability` prompt appeared. Allow let the agent write the haiku, but the skill was never attached. See finding 5. |
| 8 | Skill card for a skill that reaches a connector (`walk-weather-report` → `api.open-meteo.com`) | **Pass, with findings.** The skill card appeared ("Wants to start using the walk-weather-report skill"), and Allow attached it. Three prompts came before it, though (finding 1), and the agent's narration was wrong (finding 2). |
| 9 | Disconnect (configuration token alive) | **Pass on our side.** All four secrets for the install were emptied (28-byte tombstones, like the other disconnected installs). The host doesn't log a successful disconnect, so the logs don't confirm `appDeleted:true` (see finding 8). |
| 10 | Reconnect, revoke the configuration token on Slack, then Rename | **Pass.** Rename failed at `rotate` with `invalid_refresh_token`, which maps to the "Disconnect, then Connect again" message. |
| 11 | Disconnect after the revoke | **Pass.** The rotate failed the same way, the secrets were emptied, and Vinay deleted the app by hand. |

## Findings

1. **Double approval for a skill that reaches a connector.** One request gave three prompts: the held `request_capability`, a held `web_extract` (the agent's workaround), and then the skill card. One "use this skill" decision should be one prompt.
2. **The agent's narration ran ahead of reality.** It said "now connected!" before Allow and claimed a "queued" web request that didn't exist. After Allow, the reply was "Connected. Send your message again and I'll use it." (`copy.ts:162`) and the sandbox pod exited (TASK-1127). The agent then kept choosing `web_extract`, and only used the connector after being told to use curl in the sandbox. That worked, with no further prompt. This ties to TASK-1130. *Measured later (TASK-1130): these were the model's own words, not runner narration or a step summary, so they need a follow-up of their own (filed from TASK-1130's handoff).*
3. **`memory_note` refused in a shared channel, but the fact was saved anyway.** The agent's note about a person was refused (person subject with the shared audience), so it told the channel it couldn't save it. The idle observer then stored the same fact. The two paths disagree about what may be remembered.
4. **A junk fact was saved:** "assistant: could_not_save_memory". The extractor stores the agent's own failure narration.
5. **A skill with no reach is never attached.** `request_capability` for `walk-haiku` produced no skill card and no attachment, so the skill isn't there on the next turn.
6. **A global admin outside a team can't re-add themselves (403).** Only a team admin can change members. Re-adding Vinay needed a stand-in team admin. Also, the Teams UI is view-only, so all of this was done through the API.
7. **The skill card doesn't name the host** it will reach. This was already known.
8. **A successful Disconnect leaves no log line,** so `appDeleted` can't be verified after the fact. Log `{installId, appDeleted}`.
9. **The connect logged two `slack_install_refused {reason:'unauthenticated'}`** (01:16:37 and 01:16:59 UTC) in the middle of a connect that succeeded. The cause isn't known.
10. **The icon upload still fails** with `error_bad_format` on every connect (TASK-1133).

## Still unmeasured

- Whether an access token from an earlier rotation still works after later rotations.
- How long an unused configuration refresh token stays valid.
- HTML-entity decoding in `markdown_text`, and whether `plain_text` reads a `<!channel>` reference. The comments in `format.ts` around these stay marked unmeasured.

## Follow-ups filed (Backlog)

- TASK-1135: findings 1 and 7
- TASK-1136: findings 3 and 4
- TASK-1137: finding 5
- TASK-1138: finding 6
- TASK-1139: findings 8 and 9
- Finding 2 belongs to TASK-1130, and finding 10 to TASK-1133. *Measured later (TASK-1130): finding 2 is the model's own words, so it gets its own follow-up, filed from TASK-1130's handoff.*
