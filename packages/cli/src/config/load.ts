import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { AxConfigSchema, type AxConfig } from './schema.js';

/**
 * Load `ax.config.{ts,js,mjs}` from the given cwd.
 *
 * Node's native ESM loader doesn't transpile TypeScript, so `ax.config.ts`
 * only loads when the CLI is run under a loader that understands TS (e.g.
 * `tsx`). For users running the built CLI via plain `node`, shipping a
 * built `ax.config.js` or `ax.config.mjs` works. We probe candidates in
 * that order and use the first that exists. Missing config → defaults.
 */
export async function loadAxConfig(cwd: string): Promise<AxConfig> {
  const candidates = ['ax.config.ts', 'ax.config.js', 'ax.config.mjs'];
  for (const name of candidates) {
    const candidatePath = resolve(cwd, name);
    const exists = await access(candidatePath).then(
      () => true,
      () => false,
    );
    if (!exists) continue;
    const mod = await import(pathToFileURL(candidatePath).href);
    const raw = (mod as { default?: unknown }).default ?? mod;
    const parsed = AxConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`invalid ${name}: ${parsed.error.message}`);
    }
    return parsed.data;
  }
  return AxConfigSchema.parse({});
}
