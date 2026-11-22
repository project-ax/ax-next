import { describe, expect, it } from 'vitest';
import { build } from 'vite';

describe('browser safety', () => {
  // The public entry is imported by the channel-web SPA, so it must bundle with
  // no Node built-ins and no other @ax package.
  it('bundles for browsers with no node: or @ax/ imports', async () => {
    const result = await build({ configFile: false, logLevel: 'silent', build: { write: false, lib: { entry: new URL('../index.ts', import.meta.url).pathname, formats: ['es'] } } });
    const outputs = Array.isArray(result) ? result : [result];
    let chunks = 0;
    for (const output of outputs) {
      if (!('output' in output)) continue;
      for (const item of output.output) {
        if (item.type !== 'chunk') continue;
        chunks += 1;
        expect(item.code).not.toMatch(/(?:node:|@ax\/|__vite-browser-external)/);
      }
    }
    expect(chunks).toBeGreaterThan(0);
  }, 30_000);
});
