-- TASK-1116. Change one account's email. Runbook: deploy/GKE.md, "4i. Change an account's email
-- (sign-in recovery)".
--
-- The way back for someone the identity gate (identity-gate.ts) turns away because their Google
-- or GitHub address changed since they linked it: the provider no longer vouches for the
-- account's own email (`email_mismatch` in the host log).
--
--   dry run (the default; shows the account before and after, then rolls back):
--     psql -X -v ON_ERROR_STOP=1 -v old_email=<its email now> -v new_email=<new email> -f change-account-email.sql
--   apply (once the dry run shows the right account):
--     the same, plus -v apply=1
--
-- THIS CHANGES WHO CAN SIGN IN TO THE ACCOUNT. Afterwards whoever holds the new address at Google
-- or GitHub can sign in to it, and whoever holds the old one can't. Confirm the person through a
-- channel you already trust before running it (the runbook says how).
--
-- `old_email` must match the account's email exactly, as stored (the audit prints it). It stops,
-- with nothing written and psql exiting 3, when no account has exactly that email, when the new
-- email isn't all lowercase plain ASCII with one @ (the only kind the gate and better-auth's own
-- lookup can both match), or when another account already has the new email in any case.
--
-- It changes the email and updated_at of that one row, nothing else: not email_verified, not its
-- sign-in methods, not its sessions. It prints the account's id, name, email, role, email_verified,
-- sign-in methods and live sessions (never a password hash, a token or a secret). That still names
-- a person, so keep the output out of tickets and chat.

\set ON_ERROR_STOP on
\if :{?old_email}
\if :{?new_email}
\set ready true
\endif
\endif
\if :{?ready}
\else
\echo 'Usage: psql -v old_email=<its email now> -v new_email=<new email> [-v apply=1] -f change-account-email.sql'
\quit
\endif
\if :{?apply}
\else
\set apply false
\endif

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

BEGIN;
SET LOCAL lock_timeout = '5s';

-- The account as it is, by the email you named. Nothing is locked or changed yet.
\echo '== The account now'
SELECT u.id, u.name, u.email, u.role, u.email_verified, u.created_at,
       coalesce((SELECT string_agg(a.provider_id, ',' ORDER BY a.created_at, a.provider_id)
                   FROM auth_better_v1_accounts a WHERE a.user_id = u.id), '(none)') AS sign_in_methods,
       (SELECT count(*) FROM auth_better_v1_sessions s
         WHERE s.user_id = u.id AND s.expires_at > now()) AS live_sessions
  FROM auth_better_v1_users u
 WHERE u.email = :'old_email';

SELECT EXISTS (SELECT 1 FROM auth_better_v1_users WHERE email = :'old_email') AS found \gset
-- Printable ASCII (0x21-0x7E) other than @, then one @, then the same again, and no capital letter.
SELECT :'new_email' ~ '^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+$'
       AND :'new_email' !~ '[A-Z]' AS plain \gset
SELECT EXISTS (SELECT 1 FROM auth_better_v1_users
                WHERE lower(email) = lower(:'new_email') AND email <> :'old_email') AS taken \gset

-- Each stop raises inside the open transaction on purpose: an aborted transaction can't write,
-- ON_ERROR_STOP makes psql exit 3, and the server rolls back when psql disconnects.
\if :found
\else
\echo 'Stopped: no account has exactly that email. Nothing was changed.'
DO $stop$ BEGIN RAISE EXCEPTION 'stopped: nothing was changed'; END $stop$;
\endif
\if :plain
\else
\echo 'Stopped: the new email must be all lowercase plain ASCII with one @. Nothing was changed.'
DO $stop$ BEGIN RAISE EXCEPTION 'stopped: nothing was changed'; END $stop$;
\endif
\if :taken
\echo 'Stopped: another account already has that email. Nothing was changed. Ask a developer.'
DO $stop$ BEGIN RAISE EXCEPTION 'stopped: nothing was changed'; END $stop$;
\endif

UPDATE auth_better_v1_users SET email = :'new_email', updated_at = now()
 WHERE email = :'old_email';

\echo '== The account after the change'
SELECT u.id, u.name, u.email, u.role, u.email_verified, u.created_at,
       coalesce((SELECT string_agg(a.provider_id, ',' ORDER BY a.created_at, a.provider_id)
                   FROM auth_better_v1_accounts a WHERE a.user_id = u.id), '(none)') AS sign_in_methods,
       (SELECT count(*) FROM auth_better_v1_sessions s
         WHERE s.user_id = u.id AND s.expires_at > now()) AS live_sessions
  FROM auth_better_v1_users u
 WHERE u.email = :'new_email';

\if :apply
COMMIT;
\else
\echo 'Dry run: nothing was changed. Run again with -v apply=1 to change it.'
ROLLBACK;
\endif
