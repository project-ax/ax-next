import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { DISPATCHER_DEPENDENCIES, DISPATCHER_PATHS } from '../index.js';

// ---------------------------------------------------------------------------
// Dependency-sync test — keeps DISPATCHER_DEPENDENCIES honest against the
// dispatcher's actual handler source.
//
// The drift ARCH-2 fixes is a handler that grows a `bus.call('some:hook')`
// while the transport manifests keep declaring the old, smaller set. A static
// equality test (assert the const equals a hardcoded list) would be a
// tautology — it wouldn't fail when a handler adds a new service call.
//
// So this test SCANS the source: it reads every dispatcher handler + auth.ts,
// extracts every service-hook string passed to `bus.call(...)` /
// `bus.hasService(...)`, and asserts each extracted hook is covered by
// requiredCalls ∪ optionalCalls, OR matches a dynamicCallPatterns prefix. A
// new undeclared service call fails here, pointing at the source file.
//
// `bus.fire(...)` calls (subscriber hooks like tool:pre-call, chat:turn-end)
// are intentionally NOT scanned: subscriber hooks don't need a registered
// producer and aren't part of the `calls` / `optionalCalls` contract.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');

// Files the dispatcher routes into. handlers/types.ts is types-only; the
// dispatcher itself only does bus.fire (events) so it has no scanned calls,
// but we include it for completeness. auth.ts runs on every request.
async function collectSourceFiles(): Promise<string[]> {
  const files: string[] = [path.join(srcRoot, 'auth.ts')];
  const handlersDir = path.join(srcRoot, 'handlers');
  const entries = await fsp.readdir(handlersDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.ts')) {
      files.push(path.join(handlersDir, e.name));
    }
  }
  return files;
}

// Matches a hook string literal passed as the FIRST argument to bus.call or
// bus.hasService, tolerating the multi-line `bus.call<T, U>(\n  'hook',` shape
// the handlers use. We capture the first single-quoted literal after the
// opening paren of a `.call` / `.hasService` invocation.
const CALL_RE = /\b(?:call|hasService)\s*(?:<[^(]*>)?\s*\(\s*'([^']+)'/g;
// Dynamic hook names are built via a template literal — e.g.
// `const hookName = `tool:execute:${call.name}`;` — and then passed to
// bus.call/hasService as a variable, so they don't appear inline at the call
// site. We scan for any template literal that starts with a literal prefix
// then immediately interpolates (`<prefix>${...}`).
const TEMPLATE_RE = /`([^`$]+)\$\{/g;
// …then keep only the prefixes that LOOK like a hook name (the
// `namespace:action:` convention: lowercase colon-segmented, no spaces, no
// dots), so error-message template literals (`tool.list: ${...}`,
// `conversation '${...}`) don't masquerade as dynamic hooks.
const HOOK_PREFIX_RE = /^[a-z][a-z0-9-]*(?::[a-z0-9-]*)+$/;

describe('dispatcher dependency metadata stays in sync with the handler source', () => {
  let staticHooks: Set<string>;
  let dynamicHooks: string[];

  beforeAll(async () => {
    staticHooks = new Set<string>();
    dynamicHooks = [];
    const files = await collectSourceFiles();
    for (const file of files) {
      const text = await fsp.readFile(file, 'utf8');
      for (const m of text.matchAll(CALL_RE)) {
        staticHooks.add(m[1]!);
      }
      for (const m of text.matchAll(TEMPLATE_RE)) {
        const prefix = m[1]!;
        if (HOOK_PREFIX_RE.test(prefix)) dynamicHooks.push(prefix);
      }
    }
  });

  it('extracts at least the known service calls (the scanner actually works)', () => {
    // Guard against a scanner that silently matches nothing (e.g. a regex
    // typo) — which would make the coverage assertions vacuously pass.
    expect(staticHooks.has('session:resolve-token')).toBe(true);
    expect(staticHooks.has('workspace:read')).toBe(true);
    expect(staticHooks.has('workspace:export-baseline-bundle')).toBe(true);
    expect(staticHooks.size).toBeGreaterThanOrEqual(
      DISPATCHER_DEPENDENCIES.requiredCalls.length,
    );
    // The dynamic tool:execute route is built from a template literal.
    expect(dynamicHooks.some((h) => h.startsWith('tool:execute:'))).toBe(true);
  });

  it('every service call in the handler source is declared (required ∪ optional ∪ dynamic)', () => {
    const declared = new Set<string>([
      ...DISPATCHER_DEPENDENCIES.requiredCalls,
      ...DISPATCHER_DEPENDENCIES.optionalCalls.map((oc) => oc.hook),
    ]);
    const patterns = DISPATCHER_DEPENDENCIES.dynamicCallPatterns;

    const isCovered = (hook: string): boolean =>
      declared.has(hook) || patterns.some((p) => hook.startsWith(p));

    const undeclared = [...staticHooks].filter((h) => !isCovered(h));
    // If this fails, a handler grew a bus.call(...) that DISPATCHER_DEPENDENCIES
    // doesn't cover. Add the hook to requiredCalls (unconditional, producer
    // always present) or optionalCalls (guarded/conditional) in
    // packages/ipc-core/src/dependencies.ts.
    expect(undeclared).toEqual([]);
  });

  it('every dynamic (template-literal) hook matches a declared dynamic pattern', () => {
    const patterns = DISPATCHER_DEPENDENCIES.dynamicCallPatterns;
    const unmatched = dynamicHooks.filter(
      (h) => !patterns.some((p) => h.startsWith(p)),
    );
    expect(unmatched).toEqual([]);
  });

  it('no DECLARED required/optional hook is dead — each appears in the source', () => {
    // The reverse direction: a hook declared in the metadata but no longer
    // called by any handler is stale. Keep the const lean.
    const declared = [
      ...DISPATCHER_DEPENDENCIES.requiredCalls,
      ...DISPATCHER_DEPENDENCIES.optionalCalls.map((oc) => oc.hook),
    ];
    const dead = declared.filter((h) => !staticHooks.has(h));
    expect(dead).toEqual([]);
  });

  it('routes a non-empty action/event table the metadata was derived from', () => {
    expect(DISPATCHER_PATHS.get.length).toBeGreaterThan(0);
    expect(DISPATCHER_PATHS.actions.length).toBeGreaterThan(0);
    expect(DISPATCHER_PATHS.events.length).toBeGreaterThan(0);
    for (const p of [
      ...DISPATCHER_PATHS.get,
      ...DISPATCHER_PATHS.actions,
      ...DISPATCHER_PATHS.events,
    ]) {
      expect(p.startsWith('/')).toBe(true);
    }
  });
});
