# Preserve a new stream while retiring an old host session

- Final GKE restart testing returned an immediate SSE 404 even while host logs
  showed the replacement Pod becoming ready. The early channel request binding
  still pointed at the old session; `session:terminate` caused conversations to
  clear both active session and request before the fresh sandbox finished opening.
- Move the conversation to the new host-authored session/request with the
  existing `conversations:bind-session` hook before retiring a stale session.
  The old termination subscriber's session comparison then preserves the new
  request throughout startup. No hook signatures or tenant authority changed.
- A regression models the actual conversations subscriber and checks the
  binding during termination and sandbox opening. It failed before the fix;
  all 280 orchestrator tests, the build, and targeted lint now pass. GKE final
  acceptance is recorded separately; retries alone do not prove stream continuity.
