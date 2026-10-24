import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// GHSA-mrhx-c7xc-m3w5: a zod collection schema builds one issue object per
// failing element, so one big untrusted payload can run the process out of
// memory. zod 4.6.6 (upstream a0ebf970) only stops early for collections that
// declare .max(), .length() or .size(); an unbounded z.array() still builds an
// issue per element there. zod 3 has no fixed release at all. So
// patches/zod@3.25.76.patch (TASK-938) caps every issue list at 100 in BOTH
// engines that zod 3.25.76 ships: the v3 API our packages import as `zod`, and
// the zod 4 core under `zod/v4`, which @modelcontextprotocol/sdk uses to parse
// what remote MCP servers send. It also backports 4.6.6's size short-circuit to
// the v3 API. pnpm audit cannot see a local patch, so the advisory stays in
// pnpm.auditConfig.ignoreGhsas; these tests are what make that safe. They run
// against the installed copy, they fail on an unpatched 3.25.76, and CI runs
// this suite on every PR. zod-audit-exception.test.js proves the tree holds one
// zod 3 copy and that the patch is registered.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// MAX_ISSUES in patches/zod@3.25.76.patch.
const CAP = 100;
// 200 times the cap. The memory claim rides on the 1,000,000-element children
// at the bottom; these only have to be far past the cap, and stay fast.
const N = 20_000;
const BAD = Array(N).fill(0);
const BAD_OBJECT = Object.fromEntries(Array.from({ length: N / 4 }, (_, i) => [`k${i}`, 0]));

// Each consumer sits on a trust boundary from the TASK-938 inventory: HTTP
// request bodies, sandbox-to-host IPC, and remote MCP server responses.
const CONSUMERS = ['packages/http-server', 'packages/ipc-protocol', 'packages/mcp-client'];

async function loadZod(consumer) {
  const require = createRequire(join(ROOT, consumer, 'package.json'));
  const manifestPath = require.resolve('zod/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const esm = async (subpath) =>
    (await import(pathToFileURL(join(dirname(manifestPath), manifest.exports[subpath].import)).href)).z;
  return {
    version: manifest.version,
    flavors: [
      ['zod, ESM', await esm('.'), 'v3'],
      ['zod, CJS', require('zod').z, 'v3'],
      ['zod/v4, ESM', await esm('./v4'), 'v4'],
      ['zod/v4, CJS', require('zod/v4').z, 'v4'],
    ],
  };
}

const loaded = await Promise.all(CONSUMERS.map(async (consumer) => [consumer, await loadZod(consumer)]));

for (const [consumer, { version, flavors }] of loaded) {
  describe(`${consumer}: zod stops collecting issues at ${CAP}`, () => {
    it('resolves zod 3.25.76, the version the patch is registered for', () => {
      expect(version).toBe('3.25.76');
    });

    for (const [flavor, z, engine] of flavors) {
      describe(flavor, () => {
        it(`fails ${N} bad array elements with the first ${CAP} issues`, () => {
          const r = z.array(z.string()).safeParse(BAD);
          expect(r.success).toBe(false);
          expect(r.error).toBeInstanceOf(z.ZodError);
          expect(r.error.issues).toHaveLength(CAP);
          expect(r.error.issues[0].path).toEqual([0]);
          expect(r.error.issues[CAP - 1].path).toEqual([CAP - 1]);
        });

        it('caps a record (bad values or bad keys) and an object catchall the same way', () => {
          expect(z.record(z.string(), z.string()).safeParse(BAD_OBJECT).error.issues).toHaveLength(CAP);
          expect(z.record(z.string().regex(/^x/), z.number()).safeParse(BAD_OBJECT).error.issues).toHaveLength(CAP);
          expect(z.object({}).catchall(z.string()).safeParse(BAD_OBJECT).error.issues).toHaveLength(CAP);
        });

        it('caps a tuple rest, a map (bad values or bad keys) and a set the same way', () => {
          const tuple = engine === 'v3' ? z.tuple([z.string()]).rest(z.string()) : z.tuple([z.string()], z.string());
          expect(tuple.safeParse(BAD).error.issues).toHaveLength(CAP);
          const entries = Array.from({ length: N / 4 }, (_, i) => [`k${i}`, i]);
          expect(z.map(z.string(), z.string()).safeParse(new Map(entries)).error.issues).toHaveLength(CAP);
          const badKeys = new Map(entries.map(([key, value]) => [value, key]));
          expect(z.map(z.string(), z.string()).safeParse(badKeys).error.issues).toHaveLength(CAP);
          expect(z.set(z.string()).safeParse(new Set(BAD.map((_, i) => i))).error.issues).toHaveLength(CAP);
        });

        it('caps an array of unions, including one that keeps a near-miss option', () => {
          expect(z.array(z.union([z.string(), z.null()])).safeParse(BAD).error.issues).toHaveLength(CAP);
          const nearMiss = z.array(z.union([z.string().min(5), z.number()]));
          expect(nearMiss.safeParse(Array(N).fill('ab')).error.issues).toHaveLength(CAP);
        });

        it('caps the async parse path, including elements whose check is async', async () => {
          const r = await z.array(z.string()).safeParseAsync(BAD);
          expect(r.success).toBe(false);
          expect(r.error.issues).toHaveLength(CAP);
          const rejectLater = z.string().refine(async () => false);
          expect((await z.array(rejectLater).safeParseAsync(Array(N).fill('x'))).error.issues).toHaveLength(CAP);
          const strings = Object.fromEntries(Object.keys(BAD_OBJECT).map((key) => [key, 'x']));
          expect((await z.record(z.string(), rejectLater).safeParseAsync(strings)).error.issues).toHaveLength(CAP);
          const nearMiss = z.array(z.union([z.string().min(5), z.number()]));
          expect((await nearMiss.safeParseAsync(Array(N).fill('ab'))).error.issues).toHaveLength(CAP);
        });

        it('still reports every issue of a small input, and still accepts a good one', () => {
          const r = z.array(z.string()).safeParse([1, 'a', 2]);
          expect(r.error.issues.map((issue) => issue.path)).toEqual([[0], [2]]);
          expect(z.array(z.string()).safeParse(['a', 'b'])).toEqual({ success: true, data: ['a', 'b'] });
          expect(() => z.array(z.string()).parse([1])).toThrow(z.ZodError);
        });

        it('accepts a large good array whole, and still reports a failure that comes last', () => {
          const good = z.array(z.string()).safeParse(Array(N).fill('x'));
          expect(good.success).toBe(true);
          expect(good.data).toHaveLength(N);
          const late = z.array(z.string()).safeParse([...Array(N).fill('x'), 0]);
          expect(late.error.issues.map((issue) => issue.path)).toEqual([[N]]);
        });

        it('lets every .catch() element recover, however many fail', () => {
          const r = z.array(z.string().catch('fallback')).safeParse(BAD);
          expect(r.success).toBe(true);
          expect(r.data).toHaveLength(N);
          expect(new Set(r.data)).toEqual(new Set(['fallback']));
        });

        it('fails a union whose option filled its own issue list with one invalid_union, not a throw', () => {
          const r = z.union([z.array(z.string()), z.number()]).safeParse(BAD);
          expect(r.success).toBe(false);
          expect(r.error.issues).toHaveLength(1);
          expect(r.error.issues[0].code).toBe('invalid_union');
          const optionIssues = engine === 'v3' ? r.error.issues[0].unionErrors[0].issues : r.error.issues[0].errors[0];
          expect(optionIssues).toHaveLength(CAP);
        });

        it('keeps the error message small (ipc-core echoes it into its 400 body)', () => {
          expect(z.array(z.string()).safeParse(BAD).error.message.length).toBeLessThan(32 * 1024);
        });

        if (engine === 'v3') {
          it('reports only the size issue for an array or set over its .max() or .length()', () => {
            for (const schema of [z.array(z.string()).max(10), z.array(z.string()).length(10)]) {
              const { issues } = schema.safeParse(BAD).error;
              expect(issues).toHaveLength(1);
              expect(issues[0].code).toBe('too_big');
            }
            const set = new Set(Array.from({ length: 10_000 }, (_, i) => i));
            expect(z.set(z.string()).max(10).safeParse(set).error.issues).toHaveLength(1);
          });
        }
      });
    }
  });
}

// Bounded issues have to mean bounded memory. Each child gets a 96 MB heap: the
// patched parse peaks near 35 MB, an unpatched one needs about 250 MB (v3) or
// about 950 MB (the MCP SDK's tools/list schema) and dies with "heap out of
// memory" in well under a second.
function parseInSmallHeap(consumer, code) {
  const stdout = execFileSync(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', code], {
    cwd: join(ROOT, consumer),
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
    timeout: 20_000,
  });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

describe('a 1,000,000-element bad payload parses inside a 96 MB heap', () => {
  it('an HTTP or IPC body validated with zod (packages/http-server)', () => {
    const out = parseInSmallHeap(
      'packages/http-server',
      `import { z } from 'zod';
       const r = z.array(z.string()).safeParse(Array(1_000_000).fill(0));
       console.log(JSON.stringify({ success: r.success, issues: r.error?.issues.length }));`,
    );
    expect(out).toEqual({ success: false, issues: CAP });
  });

  it("a remote MCP server's tools/list result (the host's connector inventory, packages/mcp-client)", () => {
    const out = parseInSmallHeap(
      'packages/mcp-client',
      `const { ListToolsResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
       const r = ListToolsResultSchema.safeParse({ tools: Array(1_000_000).fill(0) });
       console.log(JSON.stringify({ success: r.success, issues: r.error?.issues.length }));`,
    );
    expect(out).toEqual({ success: false, issues: CAP });
  });
});
