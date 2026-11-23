import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stripClaudeCodeEnv } from './real-sdk-env.js';
import {
  HAVE_BINARY,
  bashSchemaProps,
  lastUserBlockText,
  makeSandboxDirs,
  mainFloors,
  openSession,
  removeTree,
  sleep,
  startScriptedServer,
  toolResultsIn,
  waitUntil,
  type Call,
  type ScriptedServer,
  type Step,
} from './scripted-model.js';

// ---------------------------------------------------------------------------
// TASK-1217 item 4 — background tasks, on the REAL claude binary.
//
// Measured on CLI 2.1.119 (plan M7). Two things start work the model did not
// ask a person for, and both end in a `<task-notification>` that wakes the
// model for a turn no person or routine asked for, while the runner is warm:
//   (a) Bash `run_in_background: true`;
//   (b) ANY Bash command that outlives its `timeout` is moved to the
//       background by the CLI itself (no `run_in_background` needed).
// `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (buildBackgroundTasksEnv) removes
// `run_in_background` from the Bash schema, rejects a call that sends it
// anyway, and kills a command at its timeout (exit 143).
//
// "Unprompted" = an agent-loop call that arrives AFTER a turn's `result` while
// the prompt stream sits on its gate with nothing queued.
//
//   CONTROL  without the floor, (a) and (b) each lead to an unprompted call
//            whose last user block holds `<task-notification>`; the time from
//            the turn's result to that call is recorded, like the cron e2e's
//            `controlFirstFireMs`.
//   FIX      configured like main.ts: the Bash schema has no
//            `run_in_background`; (a) is refused (is_error), (b) ends with
//            `Exit code 143`; and no unprompted call arrives over
//            max(5s, 3x CONTROL's time-to-first-call), capped.
//
// Skips itself when the platform's native binary is not installed.
// ---------------------------------------------------------------------------

const MIN_IDLE_WINDOW_MS = 5_000;
const CONTROL_WAIT_MS = 20_000;
/** Largest of CONTROL's measured result-to-unprompted-call times; undefined when CONTROL did not run. */
let controlFirstCallMs: number | undefined;

let server: ScriptedServer;
let tmp: string;
let files: string;
let cfg: string;

beforeEach(async () => {
  ({ tmp, files, cfg } = await makeSandboxDirs('ax-t1217-bg-'));
  server = await startScriptedServer();
});

afterEach(async () => {
  await server.close();
  await removeTree(tmp);
});

const CASES: Record<'a' | 'b', { label: string; step: Step }> = {
  a: {
    label: 'run_in_background',
    step: { tool: 'Bash', input: { command: 'sleep 1; echo BG-T1217', run_in_background: true, description: 'bg' } },
  },
  b: {
    label: 'a command that outlives its timeout',
    step: { tool: 'Bash', input: { command: "bash -c 'sleep 3; echo LATE-T1217'", timeout: 1000, description: 'slow' } },
  },
};

const unpromptedAfter = (at: number): Call[] => server.agentCalls().filter((c) => c.t > at);

/** One turn that runs the case's Bash call, then `idleMs` of watching with the stream gated. */
async function run(
  which: 'a' | 'b',
  backgroundTasks: boolean,
  watch: (turnEndedAt: number) => Promise<void>,
): Promise<{ turnEndedAt: number }> {
  server.setScript([CASES[which].step, { text: 'done' }, {}, {}, {}, {}]);
  const s = await openSession({ server, cfg, files, env: { ...stripClaudeCodeEnv(), ...mainFloors({ backgroundTasks }) } });
  try {
    const { at } = await s.send('go');
    await watch(at);
    return { turnEndedAt: at };
  } finally {
    await s.close();
  }
}

describe.skipIf(!HAVE_BINARY)('background tasks on the real claude-sdk binary (TASK-1217)', () => {
  for (const which of ['a', 'b'] as const) {
    it(`CONTROL (${which}): without the floor, ${CASES[which].label} wakes the model with a task notification`, async () => {
      let firstAt: number | undefined;
      const { turnEndedAt } = await run(which, false, async (at) => {
        const got = await waitUntil(
          () => unpromptedAfter(at).some((c) => lastUserBlockText(c.body).includes('<task-notification>')),
          CONTROL_WAIT_MS,
        );
        firstAt = unpromptedAfter(at).find((c) => lastUserBlockText(c.body).includes('<task-notification>'))?.t;
        expect(got, 'no unprompted <task-notification> call; the FIX case would prove nothing').toBe(true);
      });
      if (which === 'b') {
        // The CLI said so itself in the tool_result.
        const withResult = server.agentCalls().find((c) => toolResultsIn(c.body).length > 0);
        expect(toolResultsIn(withResult?.body ?? '{}').map((r) => r.text).join('\n')).toContain('running in background');
      }
      const ms = Math.max(0, (firstAt ?? turnEndedAt) - turnEndedAt);
      controlFirstCallMs = Math.max(controlFirstCallMs ?? 0, ms);
      console.info(`[TASK-1217] CONTROL (${which}): first unprompted call ${ms}ms after the turn's result`);
    }, 60_000);
  }

  for (const which of ['a', 'b'] as const) {
    it(`FIX (${which}): configured like main.ts, ${CASES[which].label} cannot start background work`, async () => {
      const idleWindowMs =
        controlFirstCallMs === undefined
          ? CONTROL_WAIT_MS
          : Math.min(CONTROL_WAIT_MS, Math.max(MIN_IDLE_WINDOW_MS, 3 * controlFirstCallMs));
      const { turnEndedAt } = await run(which, true, async (at) => {
        await sleep(idleWindowMs);
        expect(
          unpromptedAfter(at).map((c) => lastUserBlockText(c.body).slice(0, 200)),
          `the CLI called the model with no user message (idle ${idleWindowMs}ms)`,
        ).toEqual([]);
      });
      expect(turnEndedAt).toBeGreaterThan(0);
      const loop = server.agentCalls();
      expect(bashSchemaProps(loop[0]?.body ?? '{}'), 'Bash still offers run_in_background').not.toContain('run_in_background');
      expect(bashSchemaProps(loop[0]?.body ?? '{}'), 'the Bash schema was not read').toContain('command');
      const results = toolResultsIn(loop[1]?.body ?? '{}');
      expect(results, 'the Bash call never answered').toHaveLength(1);
      if (which === 'a') {
        expect(results[0]?.isError).toBe(true);
        expect(results[0]?.text).toContain('run_in_background');
      } else {
        expect(results[0]?.text).toContain('Exit code 143');
      }
    }, 90_000);
  }
});
