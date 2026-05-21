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
//   @ax/ipc-core          — kernel-adjacent shared library: transport-agnostic
//                           IPC dispatcher, auth middleware, body reader,
//                           response/error helpers, and per-action handlers.
//                           Built on by transport-specific listener packages
//                           (@ax/ipc-server for unix sockets, @ax/ipc-http
//                           for TCP). It is NOT a hook-bus plugin — no init,
//                           no manifest — just a library of pure functions.
//   @ax/agent-claude-sdk-runner-host
//                         — pure-function jsonl→Turn[] parser library used
//                           by the conversations plugin to source transcripts
//                           from the workspace's runner-native format. No
//                           manifest, no hooks, no kernel dependency — same
//                           library-not-plugin shape as the other allow-listed
//                           packages above.
//   @ax/validator-routine — pure-function routine frontmatter parser
//                           (parseRoutineFrontmatter/Bytes + durationToSeconds)
//                           shared between the validator plugin (workspace:
//                           pre-apply veto) and the @ax/routines plugin
//                           (spec_hash + initial next_run_at). The parser IS
//                           the boundary contract; the validator's plugin
//                           manifest is one consumer of that contract among
//                           several. Routines imports only the parser; no
//                           plugin runtime is reached.
//   @ax/skills-parser     — pure-function SKILL.md parser (parseSkillManifest,
//                           splitSkillMd) + capability types (CapabilitySlot,
//                           McpServerSpec, SkillCapabilities). No @ax/core
//                           dependency — shared between @ax/skills (host-side
//                           store) and @ax/agents (future scanner). No manifest,
//                           no hooks, no runtime behavior beyond parsing.
//
// These shared-import expansions of the kernel-only allowlist form the
// documented one-way boundary between host-side plugins and sandbox-side
// code.
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
      // channel-web ships TWO build outputs: dist/ (tsc, server-side) and
      // dist-web/ (vite, SPA bundle — the minified JS would otherwise drown
      // lint runs in thousands of unrelated errors). @ax/onboarding does the
      // same thing under dist-spa/ for its wizard bundle.
      '**/dist-web/**',
      '**/dist-spa/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      '**/coverage/**',
      // Local kind-dev mount; built JS bundles only, not source.
      '.dev-mount/**',
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
      // Use the @typescript-eslint variant so we can opt-in to
      // `allowTypeImports: true`. Type-only imports across plugins are
      // allowed because they're erased at compile time and don't create
      // runtime coupling — they're how plugins agree on a shared boundary
      // contract (e.g. `User` from auth-oidc, `HttpRequest` from http-server)
      // without one plugin depending on another's runtime. Runtime imports
      // across plugins remain forbidden everywhere; that's invariant I2.
      '@typescript-eslint/no-restricted-imports': [
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
                '!@ax/ipc-core',
                '!@ax/agent-claude-sdk-runner-host',
                '!@ax/validator-routine',
                '!@ax/skills-parser',
              ],
              allowTypeImports: true,
              message:
                'Cross-plugin runtime imports are forbidden. Plugins communicate through the hook bus only. See CLAUDE.md invariant 2. Type-only imports (`import type {...}` / `export type {...}`) are allowed — boundary types are how plugins agree on a shared contract without runtime coupling. The only @ax/* runtime imports allowed in plugin code are @ax/core, @ax/test-harness, @ax/ipc-protocol + @ax/workspace-protocol (wire schemas), @ax/ipc-core (transport-agnostic IPC library), @ax/agent-claude-sdk-runner-host (pure-function jsonl→Turn[] parser), @ax/validator-routine (pure-function routine frontmatter parser shared between the validator and the routines plugin), and @ax/skills-parser (pure-function SKILL.md parser + capability types shared between @ax/skills and @ax/agents)',
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
    // .cjs files are CommonJS by design (e.g. NODE_OPTIONS=--require
    // bootstraps that must load synchronously) and need require().
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
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
      // @ax/test-harness is test infrastructure — its production source
      // (e.g. signInAsAdmin) needs to import workspace plugin packages
      // (http-server's signCookieValue, etc.) so test code can drive the
      // bus surface without re-implementing crypto. Not subject to I2.
      'packages/test-harness/src/**',
      // The workspace-git wrapper's whole job is to delegate to
      // workspace-git-core; allow it explicitly.
      'packages/workspace-git/src/**',
      // The pod-side server in workspace-git-http wraps workspace-git-core
      // on its own side of the HTTP boundary. The HOST plugin (./src/, NOT
      // ./src/server/) is still subject to the rule and must NOT import
      // core — that's invariant I2 in this slice.
      'packages/workspace-git-http/src/server/**',
      // The Strata Phase 3 eval harness lives under test/bench/ and must
      // instantiate @ax/memory-strata-index-sqlite directly to drive Config A
      // (BM25 baseline) through the genuine production hook surface. Re-implementing
      // FTS5 locally would defeat the spike's whole point. Not subject to I2.
      // See docs/plans/2026-05-12-memory-strata-phase-3-design.md § D1.
      'packages/memory-strata/test/bench/**',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
    },
  },
);
