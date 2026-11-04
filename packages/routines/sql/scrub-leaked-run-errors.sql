-- TASK-1036. One-off scrub of old run errors. Runbook: deploy/GKE.md, "4g. Scrub old run errors".
--
-- Before TASK-1031 (#1116), a run that failed for a host reason stored the failure's own
-- text (a hook's or a database's message) in routines_v1_fires.error and, as the routine's
-- last error, in routines_v1_definitions.last_error. Owners and team members read both,
-- and agents read the last error. This rewrites that text to the sentence runFailedText
-- (fire.ts) gives a host failure with no code.
--
-- It keeps every text the current writers record (the keep-list below); anything else on a
-- failed run is old internal text. It prints counts, never a row's text.
--
--   dry run (the default; counts, then rolls back):  psql -X -v ON_ERROR_STOP=1 -f scrub-leaked-run-errors.sql
--   apply (after a backup):                         psql -X -v ON_ERROR_STOP=1 -v apply=1 -f scrub-leaked-run-errors.sql
--
-- Safe to re-run: a second apply rewrites nothing. A one-off for the TASK-1036 release:
-- before reusing it, re-check the keep-list against every writer of these two columns.
--
-- A guard for a release that adds a sentence the keep-list doesn't know (ax_host_sentence below).
-- A text reads like one of ours when, ignoring case, its first word is This, The, We, Your, You,
-- It, A or An, or one of those with a contraction (We’re, It’s, You've), followed by a space, and
-- the text then either ends in . ! or ?, or is nothing but letters, spaces and apostrophes (fire.ts's
-- `the run finished without reporting a result` has no full stop). So `unknown: service hook …`,
-- `PRIVATE bare database message` and `Error: …` don't match. An old message can match by chance
-- (Node's `This operation was aborted`): then a developer looks, and decides.
-- Both modes count the old rows that match. Apply writes only when that count is 0. Otherwise it
-- raises an error inside the transaction, so nothing is written and psql exits 3. The UPDATEs
-- skip a matching row too: each statement reads its own snapshot (READ COMMITTED), so a run that
-- finishes after the count can still commit one.
--
-- Locks: routines first, then run history, the order purgeAgent (store.ts) takes them in, so a
-- concurrent agent delete and the scrub no longer wait on each other across the two tables. Both
-- still lock several routines rows in no set order, so a deadlock with a purge is rare but
-- possible: Postgres then fails one of them, and the side that fails writes nothing. If that is
-- the scrub, run it again. If it is the purge, the agents:deleted handler logs it and doesn't retry;
-- the tick removes that agent's routines when one of them next comes due (plugin.ts, fire.ts).
-- A row that stays locked for 5 seconds (lock_timeout) is an error: psql exits 3, nothing is
-- written, and it is safe to run again. Both rewrite counts print after both UPDATEs, run history
-- first.
--
-- `terminated: …` rows are kept on purpose: a runner's failure reason can be its own error
-- text, and what owners should see for it is a separate card (TASK-1036 decisions).

\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply false
\endif

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ax_kept_run_error(e text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $kept$
  SELECT e IN (
      'The routine run closed before it could start.',            -- RUN_CLOSED, store.ts
      'The routine run was interrupted by a host restart.',       -- RUN_INTERRUPTED, store.ts (getDispatchOutcome keys on it)
      'This app update could not run.',                            -- fire.ts, store.ts finishDispatch
      'This app update could not run. Try a new delivery.',        -- repeat-runtime.ts
      'This app update was cancelled because the job changed.',   -- repeat-deliveries.ts
      'the run finished without reporting a result',              -- fire.ts
      'We couldn’t confirm this task’s instructions loaded, so this check-in is marked as failed.', -- BRIEF_UNCONFIRMED, brief.ts
      'This routine is disabled.'                                  -- an older host sentence (e4f327190)
    )
    OR e LIKE 'This task’s instructions %'                         -- BRIEF_DIDNT_LOAD, BRIEF_TOO_LONG and its older wordings, brief.ts
    OR e ~ '^This run failed because of a problem on our side( \(code: [A-Za-z0-9][A-Za-z0-9_-]{0,39}\))?\.$'  -- runFailedText, fire.ts
    OR e LIKE 'terminated: %'                                      -- fire.ts; see the header
$kept$;

-- The guard (see the header). `~*` ignores case, in the letters and in [a-z].
CREATE FUNCTION pg_temp.ax_host_sentence(e text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $guard$
  SELECT e ~* '^(this|the|we|your|you|it|a|an)([''’][a-z]+)? (.*[.!?]|[a-z''’ ]*)$'
$guard$;

SELECT count(*) AS fires FROM routines_v1_fires
 WHERE status = 'error' AND error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(error) \gset
SELECT count(*) AS routines FROM routines_v1_definitions
 WHERE last_status = 'error' AND last_error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(last_error) \gset
-- The guard (see the header): of the rows the UPDATEs below rewrite, in both tables, those that read like a host sentence.
SELECT count(*) AS host_sentences, count(*) > 0 AS unknown_sentences FROM (
  SELECT error AS e FROM routines_v1_fires
   WHERE status = 'error' AND error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(error)
  UNION ALL
  SELECT last_error FROM routines_v1_definitions
   WHERE last_status = 'error' AND last_error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(last_error)
) AS candidates WHERE pg_temp.ax_host_sentence(e) \gset
\echo 'run-history rows with old error text:' :fires
\echo 'routines with old error text:' :routines
\echo 'old rows that look like a host sentence:' :host_sentences

\if :apply
\if :unknown_sentences
\echo 'Stopped: some rows look like a sentence this script does not know. A developer should look at them: they may be our own sentences missing from its keep-list, or old messages that only look like sentences.'
-- Inside the open transaction on purpose: an aborted transaction can't write, ON_ERROR_STOP makes
-- psql exit 3, and the server rolls the transaction back when psql disconnects.
DO $stop$ BEGIN RAISE EXCEPTION 'the scrub stopped: nothing was written'; END $stop$;
\endif
-- `AND NOT pg_temp.ax_host_sentence(…)`: see the header. With the guard at 0 it skips only rows committed since.
UPDATE routines_v1_definitions SET last_error = 'This run failed because of a problem on our side.'
 WHERE last_status = 'error' AND last_error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(last_error)
   AND NOT pg_temp.ax_host_sentence(last_error);
\set routines_rewritten :ROW_COUNT
UPDATE routines_v1_fires SET error = 'This run failed because of a problem on our side.'
 WHERE status = 'error' AND error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(error)
   AND NOT pg_temp.ax_host_sentence(error);
\set fires_rewritten :ROW_COUNT
\echo 'run-history rows rewritten:' :fires_rewritten
\echo 'routines rewritten:' :routines_rewritten
COMMIT;
\else
\echo 'Dry run: nothing was changed. Run again with -v apply=1 to rewrite them.'
ROLLBACK;
\endif
