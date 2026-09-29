# TASK-718: deleting an agent leaves data behind

Found by the TASK-346 prod walk (W8): one throwaway agent was deleted through the
product and the delete returned 204, but (a) the Filestore reclaim pod exited 1 and
left an empty `/user-files/<agentId>/` directory, and (b) rows keyed on the agent
stayed in seven tables.

## What was measured here (not just inferred)

- **Reclaim root cause reproduced.** The reclaim pod runs `rm -rf` as uid 1000 with every
  capability dropped. The runner's root chown init container hands `/export/<agentId>` to
  uid 1000, but the export root itself stays root-owned. Reproduced with the prod agent
  image (`agent:69202ea0`, OrbStack, root-owned volume root, agent dir chowned to 1000):
  `rm: cannot remove '/export/agt_X': Permission denied`, exit 1, contents gone, empty dir
  left. This is the permission mechanic only. NFS and gVisor were not in the loop.
- **Nobody hard-deletes any of the seven tables, ever.** `conversations:delete` is a soft
  delete; `session:terminate` only sets a flag. So this is not only an agent-delete gap.
- **`agents:deleted` has three subscribers** (sandbox-k8s, sandbox-subprocess, routines).
  Nothing else cleans up. Nothing terminates the deleted agent's live sessions either: a
  warm runner keeps its mount and credential-proxy session for up to the 5 minute idle
  window.

## Retention decision

Conversations are **deleted** with the agent. Evidence that retention is not deliberate:
the only statement is the `@ax/conversations` migration header ("orphan rows ... are
tolerable and can be GC'd later"), which is tolerated debt; every per-conversation hook
calls `agents:resolve` first, so a deleted agent's conversations answer 404 to every read;
no view lists them; the delete dialog says only "This cannot be undone." No doc or test
promises history that outlives the agent. Users deleting an agent expect their words to
go with it, so we do that and make the dialog say so.

## Design

Each data-owning plugin subscribes to `agents:deleted` and deletes its own rows. No
cross-plugin table access (invariants 2 and 4). Attachments only knows conversation ids, so
conversations announces what it purged on a new subscriber hook, `conversations:purged`.

| # | Task | Package |
|---|------|---------|
| 1 | Reclaim pod runs as root with `DAC_OVERRIDE` + `FOWNER` only; script refuses an empty `SUBPATH`, retries a racing writer, asserts the directory is gone; failure carries the pod's stderr tail and logs at error; a null exit code is a failure | `@ax/sandbox-k8s` |
| 2 | Purge the agent's conversations + events + transcripts in one transaction; fire `conversations:purged`; guard the append paths against a missing conversation row | `@ax/conversations` |
| 3 | Subscribe to `conversations:purged`; delete `attachments_v1_files` + `attachments_v1_artifacts` rows | `@ax/attachments` |
| 4 | Terminate the agent's live sessions, then delete `session_postgres_v1_inbox`, `_v1_sessions`, `_v2_session_agent` rows | `@ax/session-postgres` |
| 5 | Kill the agent's warm sandboxes at once | `@ax/chat-orchestrator` |
| 6 | Same-shape agent-keyed tables the walker did not hit: skills (4 tables), connectors_authored, host_grants, decisions, mcp_oauth_pending, memory_facts_v1 (postgres + sqlite) | one subscriber each |
| 7 | Delete-agent dialog copy says what goes; static guard that reddens when a new `agent_id` table has no cleanup; docs | `@ax/channel-web`, `scripts/` |

Deliberately NOT in this PR (each becomes a follow-up card): the agent's git workspace repo
(no delete hook exists), blob bytes behind attachments (content-addressed and shared, so
deleting needs a cross-plugin reference authority), `routines_v1_fires` history (TASK-680
kept it on purpose), `attachments_v1_temps` (TTL janitor), kv leftovers (memory observer
cursors, declined-grant markers), and making user-initiated `conversations:delete` a real
purge.

## YAGNI pass

- Retry loop in the reclaim script: load-bearing. A warm runner can still be writing while
  the reclaim pod runs, and `rm -rf` then fails with "Directory not empty".
- Append-path guards: load-bearing for the live-runner case; without them an in-flight
  turn resurrects orphan event rows after the purge.
- A boot-time sweep of orphans: cut, but it is the follow-up that matters most. The
  subscribers are the fix for every new delete; they are not a recovery path. Each
  cleanup is idempotent, but `deleteAgent` removes the row BEFORE it fires the event,
  so a host that dies in between skips every subscriber and the id can never be
  deleted again; and attachments hears about a conversation once, from the purge that
  deletes it, so a lost `conversations:purged` is not healed by firing `agents:deleted`
  again. What a failure leaves is unreadable (every read gates on the agent or the
  conversation, both gone), not exposed. Prod residue is cleaned by hand under
  Vinay's OK; a sweep that finds agent-keyed rows whose agent no longer exists would
  heal both.
