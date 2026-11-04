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

SELECT count(*) AS fires FROM routines_v1_fires
 WHERE status = 'error' AND error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(error) \gset
SELECT count(*) AS routines FROM routines_v1_definitions
 WHERE last_status = 'error' AND last_error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(last_error) \gset
\echo 'run-history rows with old error text:' :fires
\echo 'routines with old error text:' :routines

\if :apply
UPDATE routines_v1_fires SET error = 'This run failed because of a problem on our side.'
 WHERE status = 'error' AND error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(error);
\echo 'run-history rows rewritten:' :ROW_COUNT
UPDATE routines_v1_definitions SET last_error = 'This run failed because of a problem on our side.'
 WHERE last_status = 'error' AND last_error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(last_error);
\echo 'routines rewritten:' :ROW_COUNT
COMMIT;
\else
\echo 'Dry run: nothing was changed. Run again with -v apply=1 to rewrite them.'
ROLLBACK;
\endif
