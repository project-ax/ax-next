// AX v2 — flat ESLint config.
//
// The important rule here is `no-restricted-imports`, which enforces CLAUDE.md
// invariant 2: "plugins talk through the hook bus, not direct imports."
//
// Allowed @ax/* imports:
//   @ax/core             — the kernel, every plugin depends on it
//   @ax/test-harness     — test-only, not in plugin runtime paths
//   @ax/ipc-protocol     — pure-types wire-schema package; both host-side
//                          plugins and sandbox-side runners need it to
//                          speak the IPC contract. It has no runtime
//                          behavior, just Zod schemas + inferred types.
//   @ax/agent-runner-core — sandbox-side library that every runner binary
//                          builds on (IPC client, inbox loop, local tool
//                          dispatcher). It is NOT a hook-bus plugin; it's
//                          the one-way bridge from sandbox code back to
//                          the host-side listener.
//
// These last two are shared-import expansions of the kernel-only allowlist
// and form the documented one-way boundary between host-side plugins and
// sandbox-side code.
//
// Exceptions (rule turned off):
//   packages/cli/**                 — the CLI loads plugins per ax.config.ts
//   presets/**                      — meta-packages that reference plugins
//   packages/agent-*-runner/**      — runner binaries legitimately wire
//                                     sandbox-side tool-impl packages into
//                                     the local dispatcher; they live on
//                                     the sandbox side of the trust
//                                     boundary and aren't host-side plugins
//   packages/*/src/__tests__/**     — test files may reach into peer
//                                     plugins to drive realistic integration
//                                     scenarios (e.g. the ipc-server tests
//                                     use session-inmemory to mint tokens)

import tseslint from 'typescript-eslint';

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
                '!@ax/agent-runner-core',
              ],
              message:
                'Cross-plugin imports are forbidden. Plugins communicate through the hook bus only. See CLAUDE.md invariant 2. The only @ax/* imports allowed in plugin code are @ax/core, @ax/test-harness, @ax/ipc-protocol (wire schemas), and @ax/agent-runner-core (sandbox-side library).',
            },
          ],
        },
      ],
    },
  },

  {
    files: [
      'packages/cli/**',
      'presets/**',
      'packages/agent-*-runner/**',
      'packages/*/src/__tests__/**',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
