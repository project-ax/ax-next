#!/usr/bin/env bash
# delete_user.sh — remove one user, and everything they own, from the KIND dev cluster.
#
#   bash delete_user.sh <email>
#
# Kind only. Every kubectl call below is pinned to the kind context, so it cannot
# touch another cluster whatever your default context is
# (scripts/__tests__/kind-tooling-pinned-to-kind-context.test.js holds that line).
#
# What it does, in this order (TASK-994):
#   1. Looks the user up. The email reaches psql as a variable (-v email=...),
#      never as SQL text, so a quote in an email cannot change a query. Same for
#      every other value below.
#   2. Deletes each of the user's personal agents THROUGH THE HOST, with the
#      product's own DELETE /admin/agents/:id. That fires agents:deleted, and every
#      plugin cleans up its own rows for the agent: chats, sessions, routines,
#      files, facts, sign-ins. (Deleting agents_v1_agents rows with SQL skips all
#      of that and strands the agent's data with nothing pointing at it.)
#      To be allowed to, it mints a 10-minute login session for the user — an owner
#      may delete their own personal agents, so no admin login is involved — and
#      scripts/delete-user-agents.mjs signs the session cookie inside the host pod
#      with the pod's own key, so the key never leaves the cluster. The session is
#      deleted again as soon as the host is done, and on any exit before that.
#   3. Stops before deleting a single row if the host refuses or fails any agent
#      (a cookie it does not accept, a restart, an agent already gone), or if a
#      personal agent is still there afterwards. Fix the cause and run it again:
#      agents already deleted stay deleted, and nothing else has been touched.
#   4. Deletes the user's remaining rows in one transaction, auth rows last.

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "delete_user.sh: run it (bash delete_user.sh <email>) rather than sourcing it" >&2
  return 2
fi
set -euo pipefail

ctx=kind-ax-next-dev
ns=ax-next
pg_pod=ax-next-postgresql-0
db=ax_next
helper="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/scripts/delete-user-agents.mjs"
pgpw=''
# The id of the login session this script minted, while it exists. The EXIT trap
# deletes it, so a failure or a Ctrl-C cannot leave a live session behind.
minted_sid=''

# psql inside the kind postgres pod. SQL arrives on stdin; values arrive as psql
# variables (-v name=value) that psql quotes itself (:'name'). Variables are not
# interpolated in -c strings, which is why nothing below uses -c.
psql_run() {
  kubectl --context "$ctx" -n "$ns" exec -i "$pg_pod" -- \
    env PGPASSWORD="$pgpw" psql -X -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"
}

drop_minted_session() {
  if [ -z "$minted_sid" ]; then return 0; fi
  local sid=$minted_sid
  minted_sid=''
  if printf '%s\n' "DELETE FROM auth_better_v1_sessions WHERE id = :'sid';" |
    psql_run -q -v sid="$sid"; then
    echo ">> removed the temporary login session"
  else
    echo "!! could not remove temporary login session $sid; it expires on its own within 10 minutes" >&2
  fi
}
trap drop_minted_session EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

is_hex() { # <value> <length>
  [ "${#1}" -eq "$2" ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
}

delete_agents_through_host() { # <uid> <agent ids, one per line>
  local uid="$1" agents="$2" token sid
  token=$(openssl rand -hex 32)
  sid=$(openssl rand -hex 16)
  if ! is_hex "$token" 64 || ! is_hex "$sid" 32; then
    echo "!! openssl did not produce a random hex token; nothing was changed" >&2
    exit 1
  fi
  sid="sess_$sid"

  minted_sid=$sid
  echo ">> minting a 10-minute login session for $uid, so the host accepts the deletes"
  # The token is the login credential, so it travels on stdin, never in a command line.
  printf '%s\n' "\\set token '$token'" \
    "INSERT INTO auth_better_v1_sessions (id, user_id, token, expires_at) VALUES (:'sid', :'uid', :'token', NOW() + INTERVAL '10 minutes');" |
    psql_run -q -v sid="$sid" -v uid="$uid"

  echo ">> deleting personal agents through the host, so agents:deleted fires for each one"
  if ! { printf '%s\n' "$token"; printf '%s\n' "$agents"; } |
    kubectl --context "$ctx" -n "$ns" exec -i deploy/ax-next-host -c host -- \
      node --input-type=module -e "$(cat "$helper")"; then
    echo "!! the host did not delete every agent (see above), so no rows were deleted." >&2
    echo "!! Fix that and run this again; agents already deleted stay deleted." >&2
    exit 1
  fi
  drop_minted_session
}

# Everything the user still owns once their personal agents are gone. One
# transaction under ON_ERROR_STOP: a failing statement rolls all of it back.
#
# Routines are not deleted here. A personal agent's routines went with its
# agents:deleted (the routines plugin subscribes to it). Routines this user wrote
# on a TEAM agent stay: whether those should leave with the member is an open
# product question. (The statements that used to be here named columns the
# routines schema has since renamed, so the whole transaction failed and the old
# script deleted nothing at all.)
remaining_rows_sql() {
  cat <<'SQL'
BEGIN;
-- conversations with team agents (those with personal agents went with agents:deleted)
DELETE FROM conversations_v1_events WHERE conversation_id IN (SELECT conversation_id FROM conversations_v1_conversations WHERE user_id = :'uid');
DELETE FROM conversations_v1_transcripts WHERE conversation_id IN (SELECT conversation_id FROM conversations_v1_conversations WHERE user_id = :'uid');
DELETE FROM attachments_v1_artifacts WHERE user_id = :'uid' OR conversation_id IN (SELECT conversation_id FROM conversations_v1_conversations WHERE user_id = :'uid');
DELETE FROM attachments_v1_files WHERE user_id = :'uid' OR conversation_id IN (SELECT conversation_id FROM conversations_v1_conversations WHERE user_id = :'uid');
DELETE FROM attachments_v1_temps WHERE user_id = :'uid';
-- runner session state (find the ids before removing the rows that name them)
DELETE FROM session_postgres_v1_inbox WHERE session_id IN (SELECT session_id FROM session_postgres_v2_session_agent WHERE user_id = :'uid');
DELETE FROM session_postgres_v1_sessions WHERE session_id IN (SELECT session_id FROM session_postgres_v2_session_agent WHERE user_id = :'uid');
DELETE FROM session_postgres_v2_session_agent WHERE user_id = :'uid';
-- owned data
DELETE FROM connectors_v1_connectors WHERE owner_user_id = :'uid';
DELETE FROM connectors_v1_authored WHERE owner_user_id = :'uid';
DELETE FROM conversations_v1_conversations WHERE user_id = :'uid';
-- auth: sessions and sign-in accounts, then the user row last
DELETE FROM auth_better_v1_sessions WHERE user_id = :'uid';
DELETE FROM auth_better_v1_accounts WHERE user_id = :'uid';
DELETE FROM auth_better_v1_users WHERE id = :'uid';
COMMIT;
SQL
}

delete_ax_user() {
  if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
    echo "usage: bash delete_user.sh <email>" >&2
    exit 2
  fi
  local email="$1" row uid role agents remaining
  if [ ! -r "$helper" ]; then
    echo "!! $helper is missing (it runs inside the host pod); nothing was changed" >&2
    exit 2
  fi

  pgpw=$(kubectl --context "$ctx" -n "$ns" get secret ax-next-postgresql \
    -o jsonpath='{.data.postgres-password}' | base64 -d)

  row=$(printf '%s\n' "SELECT id, role FROM auth_better_v1_users WHERE email = :'email';" |
    psql_run -tA -v email="$email")
  if [ -z "$row" ]; then
    echo "no user with email $email" >&2
    exit 1
  fi
  uid=${row%%|*}
  role=${row#*|}
  case "$uid" in
    '' | *[!A-Za-z0-9_-]*)
      echo "!! unexpected answer to the user lookup: $row" >&2
      exit 1
      ;;
  esac
  echo ">> deleting $email  id=$uid  role=$role"
  if [ "$role" = admin ]; then
    echo "!! WARNING: this is an ADMIN user (bootstrap gate keys off admin existence)."
  fi

  # A user owns an agent exactly when owner_type = 'user'; the schema pairs that
  # with visibility = 'personal' (packages/agents/src/migrations.ts).
  agents=$(printf '%s\n' "SELECT agent_id FROM agents_v1_agents WHERE owner_type = 'user' AND owner_id = :'uid' ORDER BY agent_id;" |
    psql_run -tA -v uid="$uid")
  if [ -n "$agents" ]; then
    delete_agents_through_host "$uid" "$agents"
  fi

  remaining=$(printf '%s\n' "SELECT COUNT(*) FROM agents_v1_agents WHERE owner_type = 'user' AND owner_id = :'uid';" |
    psql_run -tA -v uid="$uid")
  if [ "$remaining" != 0 ]; then
    echo "!! $email still owns $remaining personal agent(s), so no rows were deleted. Run this again." >&2
    exit 1
  fi

  echo ">> deleting the rest of $email's rows (one transaction)"
  remaining_rows_sql | psql_run -v uid="$uid"
  echo ">> done: $email is gone"
}

delete_ax_user "$@"
