// Unit tests for the `no-bare-tenant-tables` ESLint rule. Uses ESLint's
// built-in RuleTester; runs under vitest as a plain assertion harness —
// RuleTester does its own work in `describe` / `it`-shaped callbacks that
// vitest picks up via the global `describe`/`it`.
//
// The rule is documented in ../no-bare-tenant-tables.js.

import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from '../no-bare-tenant-tables.js';

// RuleTester needs a test runner. Wire vitest's globals in.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

tester.run('no-bare-tenant-tables', rule, {
  valid: [
    // Non-tenant tables are unrestricted.
    { code: "db.selectFrom('something_else').execute()" },
    { code: "db.selectFrom('sessions_v1_messages').execute()" },

    // Tenant tables are fine inside the allowed files.
    {
      code: "db.selectFrom('agents_v1_agents').execute()",
      filename: '/foo/bar/store.ts',
    },
    {
      code: "db.selectFrom('agents_v1_agents').execute()",
      filename: '/foo/bar/scope.ts',
    },
    {
      code: "db.selectFrom('auth_v1_users').execute()",
      filename: '/pkg/auth/src/__tests__/migrations.test.ts',
    },
    // The conversations_v1_ prefix is exempt inside its plugin's store.ts
    // — same shape as agents_v1_ above. Asserts the prefix is wired into
    // TENANT_TABLE_PREFIXES; a regression that drops it would still
    // flag this case as valid (no error fires) AND would surface in the
    // matching invalid case below.
    {
      code: "db.selectFrom('conversations_v1_conversations').execute()",
      filename: '/foo/packages/conversations/src/store.ts',
    },

    // Non-`selectFrom` calls are out of scope (insertInto / updateTable
    // are write paths handled by the plugin's CRUD methods).
    { code: "db.insertInto('agents_v1_agents').values(x).execute()" },

    // Non-string first argument (Kysely also accepts subqueries).
    { code: 'db.selectFrom(somethingDynamic).execute()' },
  ],
  invalid: [
    {
      code: "db.selectFrom('agents_v1_agents').execute()",
      errors: [{ messageId: 'bareQuery', data: { table: 'agents_v1_agents' } }],
    },
    {
      code: "db.selectFrom('auth_v1_users').execute()",
      errors: [{ messageId: 'bareQuery', data: { table: 'auth_v1_users' } }],
    },
    {
      code: "db.selectFrom('auth_v1_sessions').execute()",
      errors: [{ messageId: 'bareQuery', data: { table: 'auth_v1_sessions' } }],
    },
    {
      code: "db.selectFrom('teams_v1_memberships').execute()",
      errors: [
        { messageId: 'bareQuery', data: { table: 'teams_v1_memberships' } },
      ],
    },
    // conversations_v1_* — both tables in the plugin's schema. Without
    // these cases, dropping the prefix from TENANT_TABLE_PREFIXES would
    // leave every other test green.
    {
      code: "db.selectFrom('conversations_v1_conversations').execute()",
      errors: [
        {
          messageId: 'bareQuery',
          data: { table: 'conversations_v1_conversations' },
        },
      ],
    },
    {
      code: "db.selectFrom('conversations_v1_turns').execute()",
      errors: [
        { messageId: 'bareQuery', data: { table: 'conversations_v1_turns' } },
      ],
    },
    // Aliased reference still gets flagged.
    {
      code: "db.selectFrom('auth_v1_sessions as s').execute()",
      errors: [
        { messageId: 'bareQuery', data: { table: 'auth_v1_sessions' } },
      ],
    },
    // A leaf file in the wrong location.
    {
      code: "db.selectFrom('agents_v1_agents').execute()",
      filename: '/pkg/agents/src/plugin.ts',
      errors: [{ messageId: 'bareQuery' }],
    },
  ],
});
