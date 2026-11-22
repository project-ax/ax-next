# TASK-1189 walk: Slack §4b (several bots in one channel, a private channel, the new Slack card)

- **Date:** 2026-11-21 (UTC 2026-11-22 00:50–01:50), on kind `ax-next-dev`, with Vinay typing in the real Canopy Slack workspace.
- **Source:** `main` at `f2cd94767` (TASK-1184, 1186, 1187 and 1188 merged). Kind host rebuilt with `make image`.
- **Setup:** same recipe as TASK-1174 (`deploy/kind/walks/2026-11-21-TASK-1174/REPORT.md`): port-forward the host's public-http port 9090, a cloudflared quick tunnel, `AX_PUBLIC_BASE_URL` set to it, and a locally minted `ax_auth_session` cookie. Kind started with no Slack installs at all, so the shared app was connected fresh with the 1186 manifest (no Disconnect needed). Walk Team had Moss; Fern was created again.
- **Evidence:** the host's `slack_*` and `memory_*` log lines and the `channel_slack_v1_*` rows. No token values were logged or read. Every configuration token went straight from Vinay into the AX form.

## Results

| # | Check | Result |
|---|---|---|
| 0 | Set up: shared app Connect, Fern created, Fern and Moss bots added from the new Slack card | **Pass.** The card went from "not in Slack" to Add to Slack, then waiting, then live. Creating Fern showed a 403 but created the agent (the known TASK-1183). |
| 1 | Two bots in one public channel: each answers only its own mention | **Pass.** One conversation per mention. |
| 2 | One message mentioning both bots | **Pass.** Two replies in the thread, one conversation per bot. |
| 3 | "@Fern ask @moss …": Moss doesn't answer Fern | **Pass on routing.** Each bot had exactly 3 conversations after checks 1–3: Fern's reply naming Moss started nothing. **Bug: TASK-1190.** Both agents saw Slack's raw `<@U…>` IDs. Fern didn't know the ID was Moss, and Moss asked itself the question. |
| 4 | Private channel: the bot answers and nothing is remembered | **Pass.** The thread was recorded private and `not_remembered`; the memory step logged `memory_capture_refused reason:channel-not-remembered` and never recorded a fact. The card showed "Private channels aren't remembered". **Bug: TASK-1191.** Fern still replied that "the memory system will pick this up". |
| 5 | Public channel remembered; "Don't remember this channel" from the ⋯ menu stops it | **Pass.** Checks 1–3 recorded facts. After the switch, the next turn was refused. A turn made a minute *before* the switch was refused too: the switch applies when the memory step runs (about 2 minutes after the turn), not when the turn ran. That favours privacy. |
| 6 | Shared app: no channel turns, no `/ax`, DMs and Allow/Deny still work | **Pass.** A channel mention got one private line ("I don't answer in channels"). Kind logged no `/ax` request. The `/ax` help text Vinay saw came from the **prod** app in the same workspace, which still runs `/ax` until it is deployed and reconnected. The DM with a personal agent, with Allow, worked. |
| 7 | Card problem state: a revoked token, then Reconnect | **Pass, through localhost.** Through the tunnel, the refusal read "Something went wrong": Cloudflare replaces any 502 body with its own HTML page, so the card never saw `slack-config-token`. Replayed directly, the host answered `502 {"error":"slack-config-token"}`, and on localhost the card showed Reconnect, which worked. The rename then went through. The card's @handle showed the old name for a short while before Slack's display name caught up. Prod sits behind Google's load balancer (`via: 1.1 google`), which passes 502 bodies through. |
| 8 | Admin › Slack lists the bots with their approvers | **Pass.** |

## Findings

- **TASK-1190** (Backlog): mentions reach the agent as raw `<@U…>` IDs, the agent's own included. Outgoing `<` is escaped on purpose, so the IDs also show as text in replies.
- **TASK-1191** (Backlog): the agent isn't told a conversation won't be remembered, and promises to remember it.
- **Walk-only:** a Cloudflare quick tunnel swallows 502 response bodies. In future walks, drive change-refusal checks through `localhost:9090`.
- **Known:** TASK-1183 (team-agent identity save gives a 403). TASK-1178 item 19 (Reconnect shows only after a failed change).

## Cleanup

Kind keeps Walk Team, Fern, Moss, their bots and the shared install for the next walk. Configuration tokens still active are Vinay's to revoke in Slack.
