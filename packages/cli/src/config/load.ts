import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AxConfigSchema, type AxConfig } from './schema.js';

const CANDIDATES = ['ax.config.ts', 'ax.config.js', 'ax.config.mjs'];

export interface LoadOptions {
  /** Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * If set, only this path (resolved against `cwd`) is attempted. No
   * candidate-walk, no silent fallback to defaults.
   */
  explicitPath?: string;
}

/**
 * Discover and load `ax.config.*` from the given cwd. Returns schema defaults
 * if no config file is present. Throws on validation failure or malformed
 * module shape (no default export).
 *
 * Note: loading `ax.config.ts` via dynamic `import()` requires the host to
 * have a TS loader registered (e.g. `node --import tsx/esm`). The built CLI
 * binary doesn't currently register one; `.js` / `.mjs` configs work
 * out-of-the-box. Library-mode callers should prefer `configOverride` over
 * file discovery.
 */
export async function loadAxConfig(opts: LoadOptions = {}): Promise<AxConfig> {
  const cwd = opts.cwd ?? process.cwd();

  if (opts.explicitPath) {
    return await loadFromFile(path.resolve(cwd, opts.explicitPath));
  }

  for (const candidate of CANDIDATES) {
    const abs = path.resolve(cwd, candidate);
    let exists = true;
    try {
      await fs.access(abs);
    } catch {
      exists = false;
    }
    if (exists) {
      // Loader errors (bad validation, no default export) MUST propagate —
      // not get swallowed and quietly fall back to defaults.
      return await loadFromFile(abs);
    }
  }
  // Nothing found: use schema defaults.
  return AxConfigSchema.parse({});
}

async function loadFromFile(abs: string): Promise<AxConfig> {
  // Always go through pathToFileURL — handing a bare path string to import()
  // is an ESM loader error on some Node versions and a Windows footgun on
  // all of them. We're POSIX for now, but the fix costs nothing.
  const url = pathToFileURL(abs).href;
  const mod = await import(url);
  const candidate = (mod as { default?: unknown }).default;
  if (candidate === undefined) {
    throw new Error(`ax.config file at ${abs} has no default export`);
  }
  const parsed = AxConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `ax.config at ${abs} failed validation:\n${parsed.error.message}`,
    );
  }
  return parsed.data;
}
