import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Dependency-skew guard.
//
// This repo has been badly bitten once by exactly this class of bug
// (`.claude/memory/mistakes.md`, 2026-06-29): a floating range plus an
// unbounded override silently floated `undici` across a MAJOR, and the two
// copies then disagreed about a handler interface at runtime. It cost ~12 days
// of a red `main` because per-package CI stayed green.
//
// This package raises the same shape twice over:
//
//   1. `ai` now exists in the workspace at TWO majors — `packages/channel-web`
//      is on v6 (assistant-ui, in the browser) and this runner is on v7 (Node,
//      in the sandbox). That is fine ONLY because the two never interoperate:
//      different processes, no shared global, no object passed between them.
//      What would break it is someone adding a workspace-wide `ai` override to
//      "clean up the duplicate" — which would drag one side across a major.
//   2. `createProxyFetch` hands an undici `ProxyAgent` to a `fetch`. The 2026
//      incident was precisely a standalone-undici dispatcher handed to the
//      GLOBAL (bundled-undici) `fetch`. Both must come from the same import.
//
// These are cheap assertions against a failure mode that is very expensive to
// find at runtime.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..', '..');
const repoRoot = path.resolve(pkgDir, '..', '..');
const requireFromPkg = createRequire(path.join(pkgDir, 'index.js'));

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

const ourPkg = readJson(path.join(pkgDir, 'package.json'));
const rootPkg = readJson(path.join(repoRoot, 'package.json'));
const deps = (ourPkg.dependencies ?? {}) as Record<string, string>;

describe('AI SDK dependency pinning', () => {
  // The repo already pins the OTHER runner's agent SDK exactly
  // (`@anthropic-ai/claude-agent-sdk: "0.2.119"`). The model client is the one
  // dependency where an unattended minor bump changes agent behaviour, so it
  // gets the same treatment here.
  it.each(['ai', '@ai-sdk/anthropic', '@ai-sdk/openai-compatible'])(
    'pins %s to an exact version',
    (name) => {
      const range = deps[name];
      expect(range, `${name} must be a direct dependency`).toBeDefined();
      expect(range).toMatch(/^\d+\.\d+\.\d+$/);
    },
  );

  // Supply chain: the OpenRouter provider is a Vercel-maintained package that
  // resolves the same `@ai-sdk/provider*` tree `@ai-sdk/anthropic` already
  // pulls. Assert the INSTALLED version is the pinned one — a pin that the
  // lockfile silently disagrees with buys nothing.
  it('resolves @ai-sdk/openai-compatible at exactly the pinned version', () => {
    const pinned = deps['@ai-sdk/openai-compatible']!;
    const resolved = requireFromPkg('@ai-sdk/openai-compatible/package.json')
      .version as string;
    expect(resolved).toBe(pinned);
  });

  it('is on ai v7 (the major that ships ToolLoopAgent)', () => {
    expect(deps['ai']!.startsWith('7.')).toBe(true);
    expect(requireFromPkg('ai/package.json').version.startsWith('7.')).toBe(true);
  });

  it('exposes ToolLoopAgent and pruneMessages from the resolved ai package', () => {
    // Pins the two APIs the design picked this major FOR. If a future bump
    // moved or renamed them, this fails here rather than at the first turn.
    const ai = requireFromPkg('ai') as Record<string, unknown>;
    expect(typeof ai['ToolLoopAgent']).toBe('function');
    expect(typeof ai['pruneMessages']).toBe('function');
    expect(typeof ai['jsonSchema']).toBe('function');
  });

  // The guard that protects the deliberate v6/v7 coexistence.
  it('has no workspace-wide `ai` override that could drag a major', () => {
    const overrides = ((rootPkg['pnpm'] as Record<string, unknown> | undefined)
      ?.['overrides'] ?? {}) as Record<string, string>;
    const aiOverrides = Object.keys(overrides).filter(
      (k) => k === 'ai' || k.startsWith('ai@'),
    );
    expect(
      aiOverrides,
      'channel-web is on ai@6 and this runner on ai@7 on purpose — they never ' +
        'interoperate. A workspace-wide `ai` override would force one across a ' +
        'major. If you are adding one, read the module comment first.',
    ).toEqual([]);
  });
});

describe('undici single-copy discipline in the proxy fetch', () => {
  // The 2026-06-29 incident in one sentence: a dispatcher from a standalone
  // undici was handed to a fetch backed by a DIFFERENT undici, and the two
  // disagreed about the request-handler interface. Our proxy fetch must take
  // both from the same import.
  it('takes ProxyAgent and fetch from the same undici import', () => {
    const src = readFileSync(path.join(pkgDir, 'src', 'provider.ts'), 'utf8');
    // Every value imported from an undici specifier, across all its imports.
    const imported = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'undici'/g)]
      .flatMap((m) => m[1]!.split(','))
      .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
      .filter((s) => s.length > 0);

    expect(imported).toContain('ProxyAgent');
    // The fetch the dispatcher is handed to must come from that same module —
    // NOT the global `fetch`, which is backed by Node's bundled undici.
    expect(
      imported.some((n) => n === 'fetch'),
      'provider.ts must import fetch from undici alongside ProxyAgent, not use ' +
        'the global fetch — a dispatcher from one undici copy handed to another ' +
        "copy's fetch is the 2026-06-29 incident.",
    ).toBe(true);
  });

  it('resolves undici below the major the AI SDK pulls for itself', () => {
    // Both copies exist in the tree on purpose. This asserts ours is the one
    // our own code compiled against, so the ProxyAgent options we pass
    // (`token`, `requestTls`) are the ones that version accepts.
    const ours = requireFromPkg('undici/package.json').version as string;
    expect(ours.startsWith('6.')).toBe(true);
  });
});
