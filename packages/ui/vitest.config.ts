import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node by default; component tests opt into jsdom with a per-file `// @vitest-environment jsdom` pragma.
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    // Enforce expectTypeOf assertions and *.test-d.ts: tsconfig.json excludes tests, so typecheck uses its own config.
    typecheck: {
      enabled: true,
      include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test-d.ts'],
      tsconfig: './tsconfig.test.json',
    },
  },
});
