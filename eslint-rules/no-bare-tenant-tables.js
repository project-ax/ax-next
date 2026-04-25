// Custom ESLint rule: no-bare-tenant-tables
//
// Enforces invariant I7 from the Week 9.5 multi-tenant slice: tenant-scoped
// tables (`agents_v1_*`, `auth_v1_*`, `teams_v1_*`) must only be queried
// from the plugin's own `store.ts` or `scope.ts` (or from tests). Anywhere
// else, callers are expected to go through `scopedAgents()` / a store API
// so ACL filtering happens in one place per plugin.
//
// Detects: a CallExpression of the form `<anything>.selectFrom(<literal>)`
// where the literal starts with one of the prefixes listed below. This is
// intentionally narrow — Kysely's `selectFrom` is the only entry point we
// care about, and the regression we're guarding against is forgetting to
// scope a query, not other forms of DB access.
//
// Allowed locations (rule is bypassed via `allowedFile()`):
//   - any file named `store.ts` or `scope.ts`
//   - any file under a `__tests__/` directory
//
// Plugin/rule wiring lives in `eslint.config.mjs`.

const TENANT_TABLE_PREFIXES = ['agents_v1_', 'auth_v1_', 'teams_v1_'];

function isTenantTable(name) {
  if (typeof name !== 'string') return false;
  return TENANT_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function allowedFile(filename) {
  if (!filename) return false;
  // Normalise Windows paths just in case.
  const normalised = filename.replaceAll('\\', '/');
  if (normalised.endsWith('/store.ts') || normalised.endsWith('/scope.ts')) {
    return true;
  }
  // Also allow bare `store.ts` / `scope.ts` (e.g., in RuleTester where
  // there's no leading directory).
  if (normalised === 'store.ts' || normalised === 'scope.ts') return true;
  if (normalised.includes('/__tests__/')) return true;
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid bare Kysely selectFrom() against tenant-scoped tables outside store.ts / scope.ts.',
    },
    schema: [],
    messages: {
      bareQuery:
        'do not query {{table}} outside store.ts/scope.ts; use scopedAgents() or the store API',
    },
  },

  create(context) {
    if (allowedFile(context.filename)) {
      return {};
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          !callee ||
          callee.type !== 'MemberExpression' ||
          !callee.property ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'selectFrom'
        ) {
          return;
        }

        const firstArg = node.arguments[0];
        if (!firstArg || firstArg.type !== 'Literal') return;
        if (typeof firstArg.value !== 'string') return;

        // Strip a Kysely table alias like `auth_v1_sessions as s`.
        const tableName = firstArg.value.split(/\s+as\s+/i)[0];

        if (!isTenantTable(tableName)) return;

        context.report({
          node: firstArg,
          messageId: 'bareQuery',
          data: { table: tableName },
        });
      },
    };
  },
};

export default rule;
