// ---------------------------------------------------------------------------
// The runner runs on a DIFFERENT Node than the one that tests it.
//
// This repo's `engines.node` is `>=24`, and every in-process suite runs on the
// developer's Node. The runner binary, though, executes inside the sandbox pod
// built from `container/agent/Dockerfile` — pinned to a Node 20 base image. So
// a Node 22+ API compiles, type-checks, unit-tests and e2e-tests green, then
// dies in the pod as a module-load `SyntaxError` before it can report anything.
// The host sees `sandbox-terminated` and the user sees a failed turn with no
// explanation of why.
//
// That is exactly what happened with `glob` from `node:fs/promises` (Node 22+,
// used by the Glob/Grep built-ins): 220+ green tests, and the runner could not
// boot in the cluster AT ALL. Nothing in-process could see it, because nothing
// in-process runs on the container's Node.
//
// So: pin the floor here, read from the Dockerfile itself, and refuse any
// import of an API that landed after it. Bump the base image and the offending
// entries simply drop out of the deny-list — the guard follows the Dockerfile
// rather than a number somebody has to remember to update.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = new URL('..', import.meta.url).pathname;
const DOCKERFILE = new URL(
  '../../../../container/agent/Dockerfile',
  import.meta.url,
).pathname;

const SOURCE_EXTENSIONS = ['.ts', '.js', '.cjs', '.mjs'];

/**
 * Node APIs the runner must not reach for, keyed by the major that introduced
 * them. Each entry is a real import/call site pattern, not a prose match, so a
 * comment naming the API (this file, for one) does not self-trip.
 *
 * Deliberately short: it covers the APIs a runner is actually tempted by, not
 * every addition to Node. Add a row when one bites — that is what happened to
 * `fs/promises.glob`.
 */
const POST_20_APIS: ReadonlyArray<{
  major: number;
  api: string;
  pattern: RegExp;
  instead: string;
}> = [
  {
    major: 22,
    api: 'glob / globSync from node:fs',
    // A named `glob` import off fs/promises or fs, or an `fs.glob(` call.
    pattern:
      /import\s*\{[^}]*\bglob(?:Sync)?\b[^}]*\}\s*from\s*['"]node:fs(?:\/promises)?['"]|\bfs\.glob(?:Sync)?\s*\(/,
    instead: 'the hand-rolled walker in tools/builtins.ts (`walkGlob`)',
  },
  {
    major: 22,
    api: 'Promise.withResolvers',
    pattern: /\bPromise\s*\.\s*withResolvers\s*\(/,
    instead: 'a plain `new Promise` with captured resolve/reject',
  },
  {
    major: 22,
    api: 'Array.fromAsync',
    pattern: /\bArray\s*\.\s*fromAsync\s*\(/,
    instead: 'a `for await` loop pushing into an array',
  },
  {
    major: 22,
    api: 'node:sqlite',
    pattern: /(?:from|require\()\s*['"]node:sqlite['"]/,
    instead: 'nothing — the runner holds no local database',
  },
  {
    major: 22,
    api: 'process.getBuiltinModule',
    pattern: /\bprocess\s*\.\s*getBuiltinModule\s*\(/,
    instead: 'a static import',
  },
];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // `__tests__` is excluded on purpose: test code runs on the DEVELOPER's
    // Node, never inside the pod, so it is free to use whatever it likes.
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    if (entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** The Node major the runner actually executes on, read from the image spec. */
async function containerNodeMajor(): Promise<number> {
  const dockerfile = await readFile(DOCKERFILE, 'utf8');
  const runtime = /^FROM\s+node:(\d+)-/m.exec(dockerfile);
  expect(
    runtime,
    'container/agent/Dockerfile no longer starts its stages FROM node:<major>- — ' +
      'update this guard to read the pinned Node major from wherever it moved.',
  ).not.toBeNull();
  return Number((runtime as RegExpExecArray)[1]);
}

describe('@ax/agent-aisdk-runner Node floor', () => {
  it('the container pins a Node major this guard knows about', async () => {
    const major = await containerNodeMajor();
    expect(Number.isInteger(major)).toBe(true);
    expect(major).toBeGreaterThanOrEqual(20);
  });

  it('never imports a Node API newer than the container it runs in', async () => {
    const major = await containerNodeMajor();
    const banned = POST_20_APIS.filter((entry) => entry.major > major);
    const offenders: string[] = [];

    for (const file of await sourceFiles(SRC)) {
      const body = await readFile(file, 'utf8');
      for (const entry of banned) {
        if (entry.pattern.test(body)) {
          offenders.push(
            `${file.slice(SRC.length)}: ${entry.api} needs Node >=${entry.major}, ` +
              `container/agent/Dockerfile pins Node ${major}. Use ${entry.instead}.`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the guard actually fires (it is not matching nothing by accident)', async () => {
    // A canary: the deny-list patterns must match the code shape they claim to.
    // Without this, a typo in a RegExp turns the guard above into a no-op that
    // passes forever — the failure mode a static scanner is most prone to.
    const globEntry = POST_20_APIS.find((e) => e.api.startsWith('glob'));
    expect(globEntry).toBeDefined();
    expect(
      globEntry?.pattern.test(
        "import { glob, mkdir } from 'node:fs/promises';",
      ),
    ).toBe(true);
    expect(
      globEntry?.pattern.test("import { mkdir } from 'node:fs/promises';"),
    ).toBe(false);
  });
});
