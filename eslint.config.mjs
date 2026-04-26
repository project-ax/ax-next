// AX v2 — flat ESLint config.
//
// The important rule here is `no-restricted-imports`, which enforces CLAUDE.md
// invariant 2: "plugins talk through the hook bus, not direct imports."
//
// Allowed @ax/* imports:
//   @ax/core              — the kernel, every plugin depends on it
//   @ax/test-harness      — test-only, not in plugin runtime paths
//   @ax/ipc-protocol      — pure-types wire-schema package; both host-side
//                           plugins and sandbox-side runners need it to
//                           speak the IPC contract. It has no runtime
//                           behavior, just Zod schemas + inferred types.
//   @ax/workspace-protocol — same shape as ipc-protocol but for the
//                            workspace HTTP transport. Pure schemas + codec
//                            helpers + per-action timeouts. Imported by
//                            both the host plugin and the pod-side server.
//   @ax/agent-runner-core — sandbox-side library that every runner binary
//                           builds on (IPC client, inbox loop, local tool
//                           dispatcher). It is NOT a hook-bus plugin; it's
//                           the one-way bridge from sandbox code back to
//                           the host-side listener.
//   @ax/ipc-core          — kernel-adjacent shared library: transport-agnostic
//                           IPC dispatcher, auth middleware, body reader,
//                           response/error helpers, and per-action handlers.
//                           Built on by transport-specific listener packages
//                           (@ax/ipc-server for unix sockets, @ax/ipc-http
//                           for TCP). It is NOT a hook-bus plugin — no init,
//                           no manifest — just a library of pure functions.
//
// These last four are shared-import expansions of the kernel-only allowlist
// and form the documented one-way boundary between host-side plugins and
// sandbox-side code.
//
// Path-scoped exceptions (rule turned off):
//   packages/cli/**                 — the CLI loads plugins per ax.config.ts
//   presets/**                      — meta-packages that reference plugins
//   packages/agent-*-runner/**      — runner binaries legitimately wire
//                                     sandbox-side tool-impl packages into
//                                     the local dispatcher; they live on
//                                     the sandbox side of the trust
//                                     boundary and aren't host-side plugins
//   packages/*/src/**/__tests__/**  — test files may reach into peer
//                                     plugins to drive realistic integration
//                                     scenarios. Glob covers nested test
//                                     dirs (e.g. workspace-git-http's
//                                     server/__tests__/).
//   packages/workspace-git/src/**           — wrapper over @ax/workspace-git-core;
//                                             the import is the wrapper's whole job.
//   packages/workspace-git-http/src/server/** — pod-side server wraps
//                                               @ax/workspace-git-core on its own
//                                               side of the HTTP boundary. Host
//                                               plugin (./src/, NOT ./src/server/)
//                                               must NOT import core.

import tseslint from 'typescript-eslint';

import noBareTenantTables from './eslint-rules/no-bare-tenant-tables.js';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      '**/coverage/**',
    ],
  },

  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@ax/*',
                '!@ax/core',
                '!@ax/test-harness',
                '!@ax/ipc-protocol',
                '!@ax/workspace-protocol',
                '!@ax/agent-runner-core',
                '!@ax/ipc-core',
              ],
              message:
                'Cross-plugin imports are forbidden. Plugins communicate through the hook bus only. See CLAUDE.md invariant 2. The only @ax/* imports allowed in plugin code are @ax/core, @ax/test-harness, @ax/ipc-protocol + @ax/workspace-protocol (wire schemas), @ax/agent-runner-core (sandbox-side library), and @ax/ipc-core (transport-agnostic IPC library).',
            },
          ],
        },
      ],
    },
  },

  // Local plugin: tenant-table query guard (invariant I7).
  // Forbids `db.selectFrom('agents_v1_*' | 'auth_v1_*' | 'teams_v1_*')`
  // outside `store.ts` / `scope.ts` / `__tests__/`. The rule's allow-list
  // is path-based and lives inside the rule itself; no per-file overrides
  // here. See `eslint-rules/no-bare-tenant-tables.js`.
  {
    plugins: {
      local: {
        rules: {
          'no-bare-tenant-tables': noBareTenantTables,
        },
      },
    },
    rules: {
      'local/no-bare-tenant-tables': 'error',
    },
  },

  {
    files: [
      'packages/cli/**',
      'presets/**',
      'packages/agent-*-runner/**',
      // Glob includes both `src/__tests__/**` and `src/**/__tests__/**` so
      // nested test dirs (e.g. workspace-git-http/src/server/__tests__/)
      // are covered.
      'packages/*/src/__tests__/**',
      'packages/*/src/**/__tests__/**',
      // The workspace-git wrapper's whole job is to delegate to
      // workspace-git-core; allow it explicitly.
      'packages/workspace-git/src/**',
      // The pod-side server in workspace-git-http wraps workspace-git-core
      // on its own side of the HTTP boundary. The HOST plugin (./src/, NOT
      // ./src/server/) is still subject to the rule and must NOT import
      // core — that's invariant I2 in this slice.
      'packages/workspace-git-http/src/server/**',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
