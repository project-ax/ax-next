import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// Pages the transform is handed that end the HOST if they are let through (TASK-1082, third review, finding 1): an
// ASCII page under 4 MiB whose pass-1 output is three times as long, because parse5 gives every rebuilt formatting
// element the same attribute list and each copy writes it out again. The second pass tokenizes all of that, the
// attributes a character at a time, and the heap it needs (more than 400 MB, against a worker limit of 384) is not
// something V8 ends a worker for: it ends the PROCESS ("Reached heap limit", SIGABRT), every time the page is viewed.
//
// So these run the way the host runs them: through `createHtmlPreparer()` of the COMPILED package (a worker thread
// cannot be started from the TypeScript sources), in a child process, so a page that does end the process is an exit
// code to read and not the end of the test run. Each is run three times: the crash was 4 or 5 in 5.

const packageDir = fileURLToPath(new URL('../..', import.meta.url));
const distWorker = fileURLToPath(new URL('../../dist/prepare-worker.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/pool-shape.mjs', import.meta.url));

beforeAll(() => {
  // Under CI the pipeline has built every package already (`pnpm typecheck` is `tsc --build`). Anywhere else the build
  // runs, so that what is tested is the source as it is now and not a build from before an edit; it takes a second.
  if (process.env.CI === undefined || process.env.CI === '') {
    const built = spawnSync('pnpm', ['exec', 'tsc', '--build'], { cwd: packageDir, encoding: 'utf8' });
    if (built.status !== 0) throw new Error(`building @ax/frame-guard failed (exit ${built.status}):\n${built.stdout}${built.stderr}`);
  }
  if (!existsSync(distWorker)) {
    throw new Error(`${distWorker} does not exist. These tests run the compiled package; build it first: pnpm --filter @ax/frame-guard build`);
  }
}, 120_000);

interface Outcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  answer: { shape: string; ok: boolean; reason: string | null; bytes: number; ms: number; faults: string[] } | undefined;
}

function run(shape: string, heapMb?: number): Outcome {
  const child = spawnSync(process.execPath, [fixture, shape, ...(heapMb === undefined ? [] : [String(heapMb)])], {
    cwd: packageDir,
    encoding: 'utf8',
    timeout: 90_000,
  });
  const last = child.stdout.trim().split('\n').pop() ?? '';
  let answer: Outcome['answer'];
  try {
    answer = JSON.parse(last) as Outcome['answer'];
  } catch {
    answer = undefined;
  }
  return { status: child.status, signal: child.signal, stderr: child.stderr, answer };
}

/** What a failed run says, so the failure reads as what happened: "ended by SIGABRT: FATAL ERROR: Reached heap limit...". */
const how = (o: Outcome): string => `${o.signal ?? `exit ${o.status}`}: ${o.stderr.split('\n').find((l) => l.includes('FATAL')) ?? o.stderr.slice(-200)}`;

describe('pages that are written out as a multiple of themselves, through the compiled pool', () => {
  // The five the review found, the two it said were alike (more and fewer elements; the same page in two-byte
  // characters), and the ones in between: every one is refused as too large, none ends the process.
  it.each(['amp1', 'amp2', 'amp3', 'amp2_x10', 'amp2_x40', 'amp3_x50', 'amp3_twobyte'])(
    '%s is refused as too large, three times in three processes, and none of them ends',
    { timeout: 90_000 },
    (shape) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const outcome = run(shape);
        expect(outcome.status, `attempt ${attempt} was ended by ${how(outcome)}`).toBe(0);
        expect(outcome.answer, `attempt ${attempt}: ${outcome.stderr.slice(-200)}`).toMatchObject({ ok: false, reason: 'output_too_large', faults: [] });
        // Refused after the first parse and the weighing, not after a second parse of the whole of it.
        expect(outcome.answer!.ms, `attempt ${attempt}`).toBeLessThan(2000);
      }
    },
  );

  it('serves the most a page can be let through at (half a heavy script, half attributes written out once more: 1.5 times the page), 6.3 MB, and the process is fine', { timeout: 90_000 }, () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const outcome = run('mixed');
      expect(outcome.status, `attempt ${attempt} was ended by ${how(outcome)}`).toBe(0);
      expect(outcome.answer, `attempt ${attempt}`).toMatchObject({ ok: true, faults: [] });
      expect(outcome.answer!.bytes).toBeGreaterThan(6_000_000);
    }
  });
});

describe('the heap the heaviest pages need, against the one the worker is given (384 MB)', () => {
  // The transform reads each string flat as it arrives, so the joins parse5 makes while it builds a token go as the parse
  // goes: the heap it needs follows the biggest token, not the page. Measured, with that: the 1.5 times page needs under
  // 96 MB (256 to 288 before); a page of 4 MiB in tokens of 20 to 40 KB of any kind under 48; one token that is the
  // whole page (a 4 MiB script, a data URI, a tag with 200 long attributes, which is what the second pass sees of
  // 200 repeated <body> tags) about 160, which is the joins of that one token and cannot be less. These run with well
  // over those and well under the default, so a change that brings the old figures back is seen here and not by a
  // person with a host that has ended. (A limit far below the need ends the PROCESS, which is also why they are in a child.)
  it('serves the 1.5 times page with a third of the default heap (128 MB)', { timeout: 90_000 }, () => {
    const outcome = run('mixed', 128);
    expect(outcome.status, `was ended by ${how(outcome)}`).toBe(0);
    expect(outcome.answer).toMatchObject({ ok: true, faults: [] });
  });

  it.each(['texts4', 'comments4', 'names4', 'fostered4'])('serves 4 MiB in tokens of 20 to 40 KB (%s) with 96 MB', { timeout: 90_000 }, (shape) => {
    const outcome = run(shape, 96);
    expect(outcome.status, `was ended by ${how(outcome)}`).toBe(0);
    expect(outcome.answer).toMatchObject({ ok: true, faults: [] });
  });

  it.each(['script4', 'attr4', 'bodies4'])('serves 4 MiB in one token (%s) with 224 MB, well under the default', { timeout: 90_000 }, (shape) => {
    const outcome = run(shape, 224);
    expect(outcome.status, `was ended by ${how(outcome)}`).toBe(0);
    expect(outcome.answer).toMatchObject({ ok: true, faults: [] });
  });
});
