import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The chat-visuals frame gets its two libraries as raw source strings
// (`import src from 'ax-vendor/...?raw'`) and inlines them into a sandboxed
// srcdoc — they never run in the app realm. We need the prebuilt UMD files for
// that, and neither package lets a bare import reach them: chart.js's `exports`
// map hides `dist/`, and html-to-image's `main` points at the CommonJS `lib/`.
// So both configs (vite + vitest) alias a fixed name to the exact file.
const require = createRequire(import.meta.url);

export const vendorAliases: Record<string, string> = {
  // require.resolve('chart.js') lands on dist/chart.cjs; the UMD sits beside it.
  'ax-vendor/chart.umd.min.js': join(dirname(require.resolve('chart.js')), 'chart.umd.min.js'),
  // require.resolve('html-to-image') lands on lib/index.js; the UMD is in dist/.
  'ax-vendor/html-to-image.js': join(
    dirname(require.resolve('html-to-image')),
    '..',
    'dist',
    'html-to-image.js',
  ),
};

// Vite's string aliases match only the exact id or `id/...`, so
// `ax-vendor/chart.umd.min.js?raw` would slip past an object-form alias. These
// regex entries match the name with or without a `?query` and keep the query on
// the resolved path so `?raw` still applies.
export const vendorAliasEntries: { find: RegExp; replacement: string }[] = Object.entries(
  vendorAliases,
).map(([name, file]) => ({
  find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?=\\?|$)`),
  replacement: file,
}));
