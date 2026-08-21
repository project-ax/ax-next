delete_ax_user() {
    local email="$1"
    [ -z "$email" ] && { echo "usage: delete_ax_user <email>"; return 2; }
    local ctx=kind-ax-next-dev ns=ax-next pod=ax-next-postgresql-0 db=ax_next
    local pgpw; pgpw=$(kubectl --context "$ctx" -n "$ns" get secret ax-next-postgresql \
                       -o jsonpath='{.data.postgres-password}' | base64 -d)
    local psql=(kubectl --context "$ctx" -n "$ns" exec -i "$pod" --
                env PGPASSWORD="$pgpw" psql -U postgres -d "$db" -v ON_ERROR_STOP=1)

    local uid; uid=$("${psql[@]}" -tAc \
      "SELECT id FROM auth_better_v1_users WHERE email='$email';" | tr -d '[:space:]')
    [ -z "$uid" ] && { echo "no user with email $email"; return 1; }
    local role; role=$("${psql[@]}" -tAc \
      "SELECT role FROM auth_better_v1_users WHERE id='$uid';" | tr -d '[:space:]')
    echo ">> deleting $email  id=$uid  role=$role"
    [ "$role" = admin ] && echo "!! WARNING: this is an ADMIN user (bootstrap gate keys off admin existence)."

    "${psql[@]}" -c "
  BEGIN;
  -- conversation children
  DELETE FROM conversations_v1_events       WHERE conversation_id IN (SELECT conversation_id FROM conversations_v1_conversations WHERE
  user_id='$uid');
  DELETE FROM conversations_v1_transcripts  WHERE conversation_id IN (SELECT conversation_id FROM conversations_v1_conversations WHERE
  user_id='$uid');
  DELETE FROM attachments_v1_artifacts      WHERE user_id='$uid' OR conversation_id IN (SELECT conversation_id FROM conversations_v1_conversations
  WHERE user_id='$uid');
  DELETE FROM attachments_v1_files          WHERE user_id='$uid' OR conversation_id IN (SELECT conversation_id FROM conversations_v1_conversations
  WHERE user_id='$uid');
  DELETE FROM attachments_v1_temps          WHERE user_id='$uid';
  -- routines (fires before definitions)
  DELETE FROM routines_v1_fires WHERE conversation_id IN (SELECT conversation_id FROM conversations_v1_conversations WHERE user_id='$uid')
     OR (agent_id, path) IN (SELECT agent_id, path FROM routines_v1_definitions WHERE author_user_id='$uid');
  DELETE FROM routines_v1_definitions       WHERE author_user_id='$uid';
  -- runner session state (derive ids before removing the binding rows)
  DELETE FROM session_postgres_v1_inbox     WHERE session_id IN (SELECT session_id FROM session_postgres_v2_session_agent WHERE user_id='$uid');
  DELETE FROM session_postgres_v1_sessions  WHERE session_id IN (SELECT session_id FROM session_postgres_v2_session_agent WHERE user_id='$uid');
  DELETE FROM session_postgres_v2_session_agent WHERE user_id='$uid';
  -- owned data
  DELETE FROM connectors_v1_connectors      WHERE owner_user_id='$uid';
  DELETE FROM connectors_v1_authored        WHERE owner_user_id='$uid';
  DELETE FROM agents_v1_agents              WHERE owner_id='$uid';
  DELETE FROM conversations_v1_conversations WHERE user_id='$uid';
  -- auth (account + sessions, then the user row last)
  DELETE FROM auth_better_v1_sessions       WHERE user_id='$uid';
  DELETE FROM auth_better_v1_accounts       WHERE user_id='$uid';
  DELETE FROM auth_better_v1_users          WHERE id='$uid';
  COMMIT;
  "
  }

delete_ax_user $1
