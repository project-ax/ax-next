import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // Enforce expectTypeOf assertions: tsconfig.json excludes tests, so typecheck uses its own config.
    typecheck: { enabled: true, include: ['src/**/__tests__/**/*.test.ts'], tsconfig: './tsconfig.test.json' },
  },
});
