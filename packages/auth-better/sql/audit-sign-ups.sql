-- TASK-1116. Read-only audit of who got in while sign-up was open. Runbook: deploy/GKE.md,
-- "4h. Audit accounts after TASK-1116 (sign-up gate)".
--
-- Until TASK-1116, anyone could sign up with any email and a password (POST /auth/sign-up/email),
-- a client could post a Google ID token to sign in, and the Google domain check never ran. A
-- password account made before the real owner's first Google/GitHub sign-in was then linked to
-- that owner (account pre-takeover). This lists the accounts each hole could have made.
--
--   psql -X -v ON_ERROR_STOP=1 -v domain=canopyworks.com -f audit-sign-ups.sql
--
-- `domain` is the allowed email domain, or a comma-separated list (`-v domain=a.com,b.org`).
-- Matching ignores case and spaces, and is exact: a subdomain (eng.canopyworks.com) is outside
-- unless it is listed, as the sign-in gate itself treats it.
--
-- It CHANGES NOTHING. The whole session is read-only (default_transaction_read_only), and the
-- queries run in one READ ONLY transaction that is rolled back. Any write, here or in a later
-- statement of the same session, fails with "cannot execute ... in a read-only transaction".
--
-- It prints ids, emails, roles, timestamps, provider names and counts: never a password hash, a
-- token, a session token, a verification value or a provider secret. Its output still names
-- people, so keep it out of tickets and chat (record the counts only).
--
-- Columns of sections 1-4: sign_in_methods is the account's provider ids, oldest first
-- ('credential' is a password); live_sessions counts sessions not yet expired.

\if :{?domain}
\else
\echo 'Usage: psql -v domain=example.com -f audit-sign-ups.sql'
\quit
\endif

SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== 0. Sign-in providers'
SELECT kind, enabled, coalesce(nullif(trim(allowed_domains), ''), '(any domain)') AS allowed_domains
  FROM auth_providers
 ORDER BY kind;

\echo '== 1. Accounts outside the allowed domain'
WITH allowed AS (
  SELECT lower(trim(d)) AS d FROM regexp_split_to_table(:'domain', ',') AS d WHERE trim(d) <> ''
), u AS (
  SELECT u.id, u.email, u.role, u.email_verified, u.created_at,
         lower(substring(u.email from '@([^@]*)$')) AS email_domain,
         coalesce((SELECT string_agg(a.provider_id, ',' ORDER BY a.created_at, a.provider_id)
                     FROM auth_better_v1_accounts a WHERE a.user_id = u.id), '(none)') AS sign_in_methods,
         (SELECT count(*) FROM auth_better_v1_sessions s
           WHERE s.user_id = u.id AND s.expires_at > now()) AS live_sessions
    FROM auth_better_v1_users u
)
SELECT id, email, role, email_verified, created_at, sign_in_methods, live_sessions
  FROM u
 WHERE email_domain IS NULL OR email_domain NOT IN (SELECT d FROM allowed)
 ORDER BY created_at, email;

\echo '== 2. Accounts with a password (ax never sets one)'
WITH u AS (
  SELECT u.id, u.email, u.role, u.email_verified, u.created_at,
         coalesce((SELECT string_agg(a.provider_id, ',' ORDER BY a.created_at, a.provider_id)
                     FROM auth_better_v1_accounts a WHERE a.user_id = u.id), '(none)') AS sign_in_methods,
         (SELECT count(*) FROM auth_better_v1_sessions s
           WHERE s.user_id = u.id AND s.expires_at > now()) AS live_sessions,
         (SELECT min(a.created_at) FROM auth_better_v1_accounts a
           WHERE a.user_id = u.id AND a.provider_id = 'credential') AS password_set,
         (SELECT min(a.created_at) FROM auth_better_v1_accounts a
           WHERE a.user_id = u.id AND a.provider_id <> 'credential') AS first_provider_link
    FROM auth_better_v1_users u
)
SELECT id, email, role, email_verified, created_at, sign_in_methods, live_sessions,
       password_set, first_provider_link,
       CASE
         WHEN first_provider_link IS NULL THEN 'password only'
         WHEN first_provider_link >= password_set THEN 'LINKED AFTER PASSWORD - treat as taken over'
         ELSE 'password added after a provider sign-in - ask a developer'
       END AS verdict
  FROM u
 WHERE password_set IS NOT NULL
 ORDER BY created_at, email;

\echo '== 3. Unverified accounts (not counting a setup admin waiting for its first sign-in)'
WITH u AS (
  SELECT u.id, u.email, u.role, u.email_verified, u.created_at,
         coalesce((SELECT string_agg(a.provider_id, ',' ORDER BY a.created_at, a.provider_id)
                     FROM auth_better_v1_accounts a WHERE a.user_id = u.id), '(none)') AS sign_in_methods,
         (SELECT count(*) FROM auth_better_v1_sessions s
           WHERE s.user_id = u.id AND s.expires_at > now()) AS live_sessions
    FROM auth_better_v1_users u
)
SELECT id, email, role, email_verified, created_at, sign_in_methods, live_sessions
  FROM u
 WHERE NOT email_verified
   AND NOT (role = 'admin' AND sign_in_methods = '(none)')
 ORDER BY created_at, email;

-- A Google account made by a client-posted ID token (POST /auth/sign-in/social with idToken)
-- has no OAuth scope on file. The redirect sign-in stores the token endpoint's scopes (Google
-- always returns some), and the ID-token path stores none. So a NULL scope marks an ID-token
-- sign-up or link. False positives: only a row someone inserted by hand. False negatives: on
-- better-auth 1.6.x (before 2026-10-27) a later redirect sign-in rewrote the scope, so an
-- ID-token account whose owner also signed in the normal way back then no longer shows here.
\echo '== 4. Google sign-ins made with a client-posted ID token (no OAuth scope on file)'
WITH u AS (
  SELECT u.id, u.email, u.role, u.email_verified, u.created_at,
         coalesce((SELECT string_agg(a.provider_id, ',' ORDER BY a.created_at, a.provider_id)
                     FROM auth_better_v1_accounts a WHERE a.user_id = u.id), '(none)') AS sign_in_methods,
         (SELECT count(*) FROM auth_better_v1_sessions s
           WHERE s.user_id = u.id AND s.expires_at > now()) AS live_sessions,
         (SELECT min(a.created_at) FROM auth_better_v1_accounts a
           WHERE a.user_id = u.id AND a.provider_id = 'google' AND a.scope IS NULL) AS id_token_link
    FROM auth_better_v1_users u
)
SELECT id, email, role, email_verified, created_at, sign_in_methods, live_sessions, id_token_link
  FROM u
 WHERE id_token_link IS NOT NULL
 ORDER BY created_at, email;

\echo '== 5. Counts'
WITH allowed AS (
  SELECT lower(trim(d)) AS d FROM regexp_split_to_table(:'domain', ',') AS d WHERE trim(d) <> ''
), u AS (
  SELECT u.email_verified, u.role,
         lower(substring(u.email from '@([^@]*)$')) AS email_domain,
         EXISTS (SELECT 1 FROM auth_better_v1_accounts a WHERE a.user_id = u.id) AS has_accounts,
         (SELECT min(a.created_at) FROM auth_better_v1_accounts a
           WHERE a.user_id = u.id AND a.provider_id = 'credential') AS password_set,
         (SELECT min(a.created_at) FROM auth_better_v1_accounts a
           WHERE a.user_id = u.id AND a.provider_id <> 'credential') AS first_provider_link,
         EXISTS (SELECT 1 FROM auth_better_v1_accounts a
                  WHERE a.user_id = u.id AND a.provider_id = 'google' AND a.scope IS NULL) AS id_token_sign_in
    FROM auth_better_v1_users u
)
SELECT count(*) FILTER (WHERE email_domain IS NULL OR email_domain NOT IN (SELECT d FROM allowed)) AS outside_domain,
       count(*) FILTER (WHERE password_set IS NOT NULL) AS with_password,
       count(*) FILTER (WHERE first_provider_link >= password_set) AS taken_over,
       count(*) FILTER (WHERE NOT email_verified AND NOT (role = 'admin' AND NOT has_accounts)) AS unverified,
       count(*) FILTER (WHERE id_token_sign_in) AS id_token_sign_in
  FROM u;

ROLLBACK;
