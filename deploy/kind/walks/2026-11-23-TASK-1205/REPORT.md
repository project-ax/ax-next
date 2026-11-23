# TASK-1205 walk: §4c, a team agent's memory shared with anyone who talks to it

- **Date:** 2026-11-22/23, on kind `ax-next-dev`, in the real Canopy Slack workspace. Vinay was the member; `test@canopyworks.com` was the outsider (not in Walk Team).
- **Source:** `main` at `aaf09f39c`. It includes TASK-1202 (#1236), 1204 (#1239), 1203 (#1241), 1209 (#1243), 1200 (#1235), 1199 (#1238), 1198 (#1240), 1208 (#1242) and 1211 (#1244). Kind host rebuilt with `make image`.
- **Setup:** as in `deploy/kind/walks/2026-11-22-TASK-1192/REPORT.md`. New this time: a privacy hook refuses commands that carry the account email, so the walker runs `scripts/kind-login.sh` themselves (`! bash scripts/kind-login.sh <email> admin`).

## Results

| # | Check | Result |
|---|---|---|
| 1 | The notice: a new public and a new private channel each get "shared with anyone who talks to me" once; a second mention posts nothing | **Pass** |
| 2 | A team fact said in a private channel is recalled in a public one | **Pass** |
| 3 | "my favorite color is teal" is recalled in another channel, about Vinay by name | **Pass** |
| 4 | An outsider's fact is not kept; an outsider recalls a team fact | **Pass** |
| 5 | The Slack card has no remember switch and shows the shared line; the web chat line; the bot's profile description | **Pass.** Fern predated TASK-1203, so its description updated after a rename. |
| 6 | A routine request goes through AX and asks for Allow; no `CronCreate` | **Pass, after a config fix.** At first Fern couldn't make routines: its tool list was `Bash, Read, Write, Edit`, and "routines" (added by hand) matched nothing, because tools match by exact name. With `routine_create, routine_list, routine_get, routine_update, routine_delete` it asked for Allow and created the routine. No `CronCreate` (TASK-1200 holds). **Finding → TASK-1214:** the tools field accepts any text. |
| 7 | A website Allow sticks: "try again" works, and so does a new thread | **Pass** |
| — | Which `restricted_action` code an announcement-only channel returns (TASK-1203 follow-up) | **Not run.** No announcement-only channel was set up. |

## Findings

- **TASK-1214:** Admin › Agents' allowed-tools field is free text, so "routines" saved but matched nothing. Make it a picker of real tool names.

## Cleanup

Kind keeps Walk Team, Fern (with the routine tools added), Moss, their bots, the new channels and the test routine.
