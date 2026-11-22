# TASK-1192 walk: who-is-asking notes, team memory, and the 1190/1191/1148 fixes

- **Date:** 2026-11-22 (about 10:25–11:20 UTC), on kind `ax-next-dev`, in the real Canopy Slack workspace. Vinay was the owner and a team member; `test@canopyworks.com` was an outsider (not in Walk Team).
- **Source:** `main` at `7236ba7a7` (TASK-1155, 1191, 1148 and 1190 merged). Kind host rebuilt with `make image`.
- **Setup:** as in `deploy/kind/walks/2026-11-21-TASK-1189/REPORT.md`: the same tunnel, a port-forward restarted after the rollout, fresh session cookies. Fern and Moss bots in `#walk-two-bots` (remembered) and `#walk-private-3` (private).
- **Evidence:** `conversations_v1_events` rows (thinking included), `channel_slack_v1_threads`, and the host's `memory_*` and `slack_*` log lines. No token values were read.
- **Folds in:** TASK-1149 (who-is-asking probes), TASK-1154 (team memory) and TASK-1156 (skill card).

## Results

| # | Check | Result |
|---|---|---|
| A.1 | TASK-1190: "@Fern ask @moss …" | **Pass.** The agents got `@[moss]` and `@[Fern (you)]`, not raw IDs. Moss answered as itself. Fern named Moss. **Finding (added to TASK-1196):** Fern wrote "@[moss]" into its Slack reply. |
| A.2 | Member, plain: "alpha beta gamma" | **Pass.** |
| A.3 | Member, broadcast text ("hello @channel, testing") | **Pass.** No injection talk. The reply's `<!channel>` showed as text and pinged nobody, because outgoing `<` is escaped. **Finding (TASK-1196):** the raw `<!channel>` form is visible. |
| A.4 | TASK-1154: team fact plus person fact in a remembered channel | **Fail → TASK-1198.** The person fact (teal) was dropped (`speakerFacts` 1). But the team fact (standup at 9:30) wasn't recalled in a new thread. Memory held only echoes of the assistant's replies ("assistant replied_with: …"). Fern also said "I'll keep that in mind" about teal (TASK-1193). |
| A.5 | Member, a held call then Allow | **Fail → TASK-1199.** The fetch hit a host prompt, not a held call. After Allow ("Ask me again"), Fern refused to retry in the same thread: the block message said retrying won't help. A new thread was a new session, and the host was blocked again. |
| A.5b | Member, "create a routine…" | **Fail → TASK-1200.** No AX routine and no approval: Fern used the Claude Code SDK's built-in `CronCreate`, which the runner doesn't disallow. A sandbox-local job that won't run, reported as done. |
| B.6 | TASK-1191: "remember … mango" in a private channel | **Pass.** The turn carried "This conversation isn't remembered: don't say you'll remember it."; no promise and no file write. |
| C.7 | TASK-1148 / probe 2: outsider asks for a fetch | **Pass** (Vinay). |
| — | Files bypass memory's rules | **Fail → TASK-1197 (proposed deploy blocker).** On 2026-11-22 01:23 UTC, in `#walk-two-bots` with remember OFF, Fern wrote "Favorite nut: cashew" under `## vinay (UHTE83XE1)` to `user-preferences.md` in its files, and later read it back in another thread. Memory had refused the same fact. |
| — | TASK-1155 and TASK-1156 skill checks | **Not run → TASK-1201.** Kind's skill catalog was empty (`skills_v1_skills` had 0 rows), so there was no `walk-weather-report` skill to ask for. |
| — | Probe 4 (outsider, an unheld external action) | **Not run.** It needs a connector whose send tool is allowed without a hold. It waits on Vinay's outsider-"yes" decision (from TASK-1148). |

## Findings filed

- **TASK-1197:** the agent can write refused facts to its files, and every channel then reads them. Proposed deploy blocker.
- **TASK-1198:** shared-turn memory keeps assistant echoes and misses team facts.
- **TASK-1199:** the website Allow has no working path in Slack.
- **TASK-1200:** Claude Code SDK built-ins (`CronCreate` and others) bypass AX policy.
- **TASK-1196** (amended): `@[Name]` and `<!channel>` leak into replies.
- **TASK-1201:** the skill-card walk left over from this one.

## Cleanup

Kind keeps Walk Team, Fern, Moss, their bots, and Fern's `user-preferences.md` (evidence for TASK-1197). Fern's sandbox `CronCreate` job lives only in that sandbox.
