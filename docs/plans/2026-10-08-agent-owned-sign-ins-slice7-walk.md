# Agent-Owned Sign-Ins — Slice 7 Walk Plan

> **For agentic workers:** this is a manual-acceptance walk, not a build plan. Run it on kind with `--context kind-ax-next-dev` ONLY (the default context on this machine is production). A finding becomes a fix commit with a regression test on `feat/agent-owned-sign-ins-7`, stacked on slice 6.

**Goal:** Show on a real cluster that two agents signed in to the same connector act as two different accounts, and that the deploy-day paths (purge, re-sign-in, routines) behave as the spec says.

**Architecture:** The slice 6 image (`feat/agent-owned-sign-ins-6`) is loaded into kind via `make image`. The provider is the real Linear MCP (`mcp.linear.app`, full DCR). A person completes both Linear logins in the popup. Everything else is checked over the API, the DB and the host logs.

**Spec:** `docs/plans/2026-10-07-agent-owned-connector-sign-ins-design.md` (slice list item 7: "Kind acceptance with two Linear accounts").

## Global Constraints

- Every `kubectl` uses `--context kind-ax-next-dev`; `make` targets already pin it.
- Two distinct Linear accounts (L1 and L2), signed in by a person. No credentials are typed by an agent.
- Never `clearCookies()` to switch AX users, because it also drops the Linear session. Replace `ax_auth_session` instead.
- `make kind-prune` after any extra `kind load`.

## Review Focus

- Account isolation: agent B's `viewer` must never return L1, even though the same person signed in to both.
- `prompt=select_account` must actually show Linear's account chooser. Without it, the second Add silently reuses L1.
- The deploy purge: an old person-level `account:` row must be gone after boot, and the agent must ask for a sign-in, not fall back.
- A routine on an agent whose sign-in is rejected must run without Linear and show the warning, rather than fail.
- A team-agent member sees no sign-in, key or remove actions.

---

## Setup

1. Run `make image` from the slice 6 head and wait for the rollout. Confirm the bundle hash, and grep the host's compiled `main.js` for `chat:connectors-skipped`, since Docker's build cache can hide changes.
2. Run `kubectl --context kind-ax-next-dev -n ax-next set env deploy/ax-next-host AX_PUBLIC_BASE_URL=http://localhost:9090` if it isn't already set. Then port-forward `svc/ax-next-host 9090:9090`.
3. Log in by running `scripts/kind-login.sh <admin email> admin` (and a `user` member for W9), then paste the cookie.

## Scenarios

- **W1 — Deploy purge.**
  - The host log shows the purge line once.
  - Marker `credentials:agent-owned-sign-ins:user-account-purged` is set.
  - `SELECT count(*) FROM credentials… WHERE scope='user' AND ref LIKE 'account:%'` returns 0.
  - A restart doesn't purge again.
- **W2 — Admin › Connectors.**
  - Linear (OAuth, DCR) exists or is created by an admin, as shared.
  - The person-level Settings › Connectors is gone.
  - Site lists are under Settings › Sites.
- **W3 — Agent A adds Linear as L1.**
  - Rail › Add › Linear opens the provider popup directly, and the authorize URL has `prompt=select_account`.
  - Sign in as L1.
  - The row reads "Linear · <L1 email>", and the details view says "Signed in as …".
- **W4 — Agent B adds Linear as L2.** Same flow. Linear's chooser appears; pick or add L2. The row reads "Linear · <L2 email>".
- **W5 — Isolation.**
  - Chat agent A: "use the Linear viewer tool and tell me my name/email". It returns L1.
  - Agent B returns L2.
  - In the DB, two agent-scope rows have the same ref and different owners. There is no user-scope row.
- **W6 — Sign in again.** On B, use Sign in again and pick L1. The row reads "Now L1 (was L2)", and the attachment and permissions are unchanged. Then switch back to L2.
- **W7 — Cancel or fail is all or nothing.**
  - On a third agent, Add Linear and close the popup. The connector is not attached, no token is stored, and the reason is `cancelled`.
- **W8 — Routine skip warning.**
  - On agent A, force a rejected sign-in: tamper the blob expiry and delete the DCR client row, or write the needs-reconnect marker.
  - Fire a routine now. The run completes without Linear.
  - The Routines list and the fire row show "Linear needs signing in again on <A>, so this run went without it."
  - Sign in again and fire again. The warning clears.
- **W9 — Team member.**
  - Share agent B to a team. Log in as a `user` member.
  - The rail shows Linear but no Sign in again, Add key or Remove.
  - A chat as the member on B returns L2, the agent's account.
- **W10 — Remove.**
  - Remove Linear from A. A's agent-scope row is deleted, and B still works as L2.

## Exit

Every scenario passes, or its finding is fixed with a regression test and re-walked. Record the results in the slice 7 PR body and in a SIGNINS-9 context shard.

## After the walk — owner decision (2026-10-08)

**Every connector is shared and usable by agents.** Remove the Private option. This supersedes the slice 5 ruling "private connectors aren't auto-shared".

- Drop the Sharing control from `RemoteMcpConnectorForm` and `LegacyConnectorEditDialog`, along with the "private connector" notices and the Add-list exclusion.
- Migrate the existing private connectors to shared once, guarded by a marker. Creation always writes shared.
- The server-side 403 `agent-store-refused` for non-shared connectors becomes unreachable. Remove it, or keep it only as a defensive backstop with a test.
- Tests for each piece. Add a SIGNINS-9 decisions shard recording the superseded ruling.
