// AX v2 — flat ESLint config.
//
// The important rule here is `no-restricted-imports`, which enforces CLAUDE.md
// invariant 2: "plugins talk through the hook bus, not direct imports."
//
// Allowed @ax/* imports:
//   @ax/core          — the kernel, every plugin depends on it
//   @ax/test-harness  — test-only, not in plugin runtime paths
//
// Exceptions (rule turned off):
//   packages/cli/**   — the CLI loads plugins per ax.config.ts
//   presets/**        — presets are meta-packages that reference plugins

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
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@ax/*', '!@ax/core', '!@ax/test-harness'],
              message:
                'Cross-plugin imports are forbidden. Plugins communicate through the hook bus only. See CLAUDE.md invariant 2. The only @ax/* imports allowed in plugin code are @ax/core and @ax/test-harness.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['packages/cli/**', 'presets/**'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
