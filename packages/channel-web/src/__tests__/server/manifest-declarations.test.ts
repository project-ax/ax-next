// @vitest-environment node
/**
 * Every service hook the channel-web HOST calls is declared in its manifest.
 *
 * The manifest is the plugin's statement of what it reaches for: `calls` are
 * the hooks it cannot work without (verifyCalls refuses to boot a preset that
 * lacks one), `optionalCalls` are the ones it guards with `bus.hasService` and
 * degrades without. Both kinds are dependency edges the kernel orders init by,
 * and both are what a reader (or a reviewer doing boundary review) trusts to
 * answer "what does this plugin touch?".
 *
 * TASK-757 found the answer had drifted: a couple of dozen hooks the routes
 * reached for behind `hasService` gates were in neither list. Nothing failed,
 * because an undeclared call still works at runtime — which is exactly why the
 * drift is silent and why this guard exists (TASK-770).
 *
 * How it works: walk the host-reachable module graph (every module under
 * src/server plus every relative import they pull in, the same walk
 * server-import-extensions.test.ts does), parse each with the TypeScript
 * compiler, and collect the first argument of every `.call(...)` and
 * `.hasService(...)`. A literal is a hook name. A non-literal is refused
 * unless it is a known helper parameter, in which case the helper's own call
 * sites must pass literals — so a computed hook name cannot slip past.
 *
 * It also checks the other direction: a declared hook nothing calls is a stale
 * declaration (an edge the kernel orders init by for no reason, and a claim to
 * a reader that is false).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createChannelWebServerPlugin } from '../../server/plugin';

const SRC = resolve(import.meta.dirname, '..', '..');
const SERVER_DIR = join(SRC, 'server');

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

function resolveSource(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    base,
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile() && /\.tsx?$/.test(c)) return c;
  }
  return null;
}

function hostModules(): string[] {
  const queue = readdirSync(SERVER_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts'))
    .map((e) => join(SERVER_DIR, e.name));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, 'utf-8').matchAll(SPECIFIER)) {
      const spec = m[1]!;
      if (!spec.startsWith('.')) continue;
      const target = resolveSource(file, spec);
      if (target !== null && target.startsWith(SRC)) queue.push(target);
    }
  }
  return [...seen].sort();
}

/**
 * Helpers that take the hook name as a parameter and pass it straight to
 * `bus.hasService` / `bus.call`. Keyed `<file>#<function>`; the value is the
 * index of the hook-name argument at the helper's call sites, every one of
 * which must be a string literal. Adding a helper here is a deliberate act —
 * the alternative (a computed hook name) is refused outright.
 */
const HOOK_PARAM_HELPERS: Record<string, number> = {
  'server/routes-workspace.ts#idsFactsRoute': 2,
};

interface Scan {
  /** hook name → the `file` paths that call or probe it. */
  hooks: Map<string, Set<string>>;
  /** Non-literal hook arguments that no helper entry accounts for. */
  computed: string[];
  files: string[];
}

function enclosingFunctionName(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
      n.name !== undefined &&
      ts.isIdentifier(n.name)
    ) {
      return n.name.text;
    }
  }
  return null;
}

/**
 * `Object.prototype.hasOwnProperty.call(obj, key)` and friends — the JS
 * `Function.prototype.call`, not the bus. Recognised narrowly (the receiver is
 * itself a `<x>.prototype.<method>` access) so a bus held under any variable
 * name is still scanned. Shapes the scan cannot follow — a destructured
 * `call` / `hasService`, or `bus['call']` — are refused in scanHost, not
 * skipped. What it still cannot see: a method re-bound under a different
 * name (`const c = bus.call.bind(bus)`), and modules reached only through a
 * computed dynamic import.
 */
function isFunctionPrototypeCall(callee: ts.PropertyAccessExpression): boolean {
  if (callee.name.text !== 'call') return false;
  const recv = callee.expression;
  return (
    ts.isPropertyAccessExpression(recv) &&
    ts.isPropertyAccessExpression(recv.expression) &&
    recv.expression.name.text === 'prototype'
  );
}

function scanHost(): Scan {
  const files = hostModules();
  const hooks = new Map<string, Set<string>>();
  const computed: string[] = [];
  const add = (hook: string, rel: string): void => {
    if (!hooks.has(hook)) hooks.set(hook, new Set());
    hooks.get(hook)!.add(rel);
  };
  const helperNames = new Map<string, number>(
    Object.entries(HOOK_PARAM_HELPERS).map(([k, idx]) => [k.split('#')[1]!, idx]),
  );

  for (const file of files) {
    const rel = file.slice(SRC.length + 1);
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          (callee.name.text === 'call' || callee.name.text === 'hasService') &&
          !isFunctionPrototypeCall(callee)
        ) {
          const arg = node.arguments[0];
          if (arg !== undefined && ts.isStringLiteralLike(arg)) {
            add(arg.text, rel);
          } else {
            const fn = enclosingFunctionName(node);
            const key = `${rel}#${fn ?? '<anonymous>'}`;
            const text = arg === undefined ? '<no argument>' : arg.getText(sf);
            if (
              !(key in HOOK_PARAM_HELPERS) ||
              arg === undefined ||
              !ts.isIdentifier(arg)
            ) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              computed.push(`${rel}:${line + 1} ${callee.name.text}(${text})`);
            }
          }
        } else if (
          (ts.isIdentifier(callee) &&
            (callee.text === 'call' || callee.text === 'hasService')) ||
          (ts.isElementAccessExpression(callee) &&
            ts.isStringLiteralLike(callee.argumentExpression) &&
            (callee.argumentExpression.text === 'call' ||
              callee.argumentExpression.text === 'hasService'))
        ) {
          // A destructured `const { call } = bus` or a `bus['call']` would
          // hide its hook from the property-access branch above. Refuse the
          // shape rather than miss the hook.
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          computed.push(`${rel}:${line + 1} ${callee.getText(sf)}(…) — unscannable call shape`);
        } else if (ts.isIdentifier(callee) && helperNames.has(callee.text)) {
          const arg = node.arguments[helperNames.get(callee.text)!];
          if (arg !== undefined && ts.isStringLiteralLike(arg)) {
            add(arg.text, rel);
          } else {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            computed.push(
              `${rel}:${line + 1} ${callee.text}(…, ${arg?.getText(sf) ?? '<missing>'})`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { hooks, computed, files: files.map((f) => f.slice(SRC.length + 1)) };
}

function declared(): { calls: string[]; optional: string[] } {
  const { manifest } = createChannelWebServerPlugin();
  return {
    calls: [...manifest.calls],
    optional: (manifest.optionalCalls ?? []).map((o) => o.hook),
  };
}

describe('channel-web manifest declarations (TASK-770)', () => {
  it('scans enough of the host to mean something', () => {
    // A scan that found nothing would pass forever. Anchor it on hooks that
    // live in different modules, one of them reached only through a helper.
    const scan = scanHost();
    expect(scan.files).toContain('server/routes-workspace.ts');
    expect(scan.files).toContain('server/grant-declines.ts');
    const found = [...scan.hooks.keys()];
    expect(found).toContain('http:register-route'); // generic-heavy call site
    expect(found).toContain('storage:delete'); // grant-declines.ts
    expect(found).toContain('memory:unforget'); // only via idsFactsRoute
    expect(found.length).toBeGreaterThan(60);
  });

  it('passes every hook name as a literal (or through a listed helper)', () => {
    expect(
      scanHost().computed,
      'A hook name computed at the call site cannot be checked against the ' +
        'manifest. Pass a string literal, or — for a helper that takes the ' +
        'hook as a parameter — add it to HOOK_PARAM_HELPERS so its call sites ' +
        'are checked instead.',
    ).toEqual([]);
  });

  it('declares every hook the host calls or probes in calls or optionalCalls', () => {
    const { calls, optional } = declared();
    const all = new Set([...calls, ...optional]);
    const missing = [...scanHost().hooks]
      .filter(([hook]) => !all.has(hook))
      .map(([hook, where]) => `${hook}  (${[...where].join(', ')})`)
      .sort();
    expect(
      missing,
      'Declare each of these in the channel-web manifest: in `calls` if the ' +
        'route cannot work without it, in `optionalCalls` (with a degradation) ' +
        'if it is reached behind a bus.hasService gate.',
    ).toEqual([]);
  });

  it('declares nothing the host never calls', () => {
    const { calls, optional } = declared();
    const used = scanHost().hooks;
    const stale = [...calls, ...optional].filter((h) => !used.has(h)).sort();
    expect(
      stale,
      'These manifest entries name a hook no host module calls. Remove the ' +
        'declaration, or — if the call moved behind a computed name — fix the ' +
        'call site so this guard can see it.',
    ).toEqual([]);
  });
});
