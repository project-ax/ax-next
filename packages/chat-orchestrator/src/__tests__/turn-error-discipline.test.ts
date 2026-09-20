/**
 * Every terminated turn surfaces itself (TASK-498).
 *
 * WHY THIS IS A SOURCE SCAN, WHICH IS NOT THIS REPO'S HABIT AND NEEDS AN
 * ARGUMENT. `runAgentInvoke` has fifteen places where it builds a `terminated`
 * outcome and fires `chat:end`, one per way a turn can fail before or during
 * the run. Each is supposed to call `fireTurnError` first, because `chat:end`
 * is the AUDIT record and `chat:turn-error` is the only thing the browser ever
 * sees — without it the person gets "Thinking…" until the keepalives give up,
 * which is the entire subject of this card.
 *
 * That discipline used to have a backstop. `agent:invoke` ran on the HookBus
 * default timeout, so a turn that ended without surfacing itself at least
 * rejected the caller's `bus.call` eventually. TASK-498 removed that clock —
 * it was measuring the wrong thing and killing healthy long turns — and in
 * doing so made these fifteen calls the SOLE surfacing mechanism. A reviewer
 * asked for the mutant that proves the invariant is tested rather than merely
 * observed: deleting `fireTurnError` from the `user-attachments-failed` early
 * return. It SURVIVED the whole orchestrator suite. Every one of these paths
 * needs its own harness to reach behaviourally, and a battery of fifteen
 * setup-specific fixtures would be a lot of machinery to assert one sentence
 * about shape.
 *
 * So this asserts the shape directly, and it is deliberately coarse: it does
 * not claim the fire is CORRECT (the behavioural tests in `orchestrator.test.ts`
 * do that for the paths they cover), only that no exit is silent. If a refactor
 * moves this code somewhere a regex cannot follow, the honest response is to
 * rewrite the scan — not to delete it, and not to loosen it until it passes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../orchestrator.ts', import.meta.url), 'utf8');

/**
 * Each `chat:end` fire, paired with the outcome literal it reports and whether
 * a `fireTurnError` sits between the two.
 *
 * The literal is found by walking BACKWARDS from the fire, which is what makes
 * this robust to the bodies in between (logging, cleanup, a `kill()`): the
 * question is only whether the surfacing call is on the path from building the
 * outcome to reporting it.
 */
function exits(): Array<{ line: number; terminated: boolean; surfaced: boolean }> {
  const lines = SOURCE.split('\n');
  const out: Array<{ line: number; terminated: boolean; surfaced: boolean }> = [];
  lines.forEach((line, i) => {
    if (!line.includes("bus.fire('chat:end', ctx, { outcome })")) return;
    let literal = -1;
    for (let j = i; j >= Math.max(0, i - 40); j--) {
      if (/AgentOutcome = \{|\boutcome\s*=\s*\{/.test(lines[j]!)) {
        literal = j;
        break;
      }
    }
    // A fire whose outcome was built more than 40 lines up, or assigned rather
    // than declared, is not something this scan can read. It counts as a
    // FAILURE to be legible rather than a pass — see the count assertion.
    if (literal < 0) {
      out.push({ line: i + 1, terminated: true, surfaced: false });
      return;
    }
    const between = lines.slice(literal, i).join('\n');
    out.push({
      line: i + 1,
      terminated: between.includes("kind: 'terminated'"),
      surfaced: between.includes('fireTurnError('),
    });
  });
  return out;
}

describe('terminated turns surface themselves', () => {
  it('fires chat:turn-error on every terminated exit, without exception', () => {
    const silent = exits()
      .filter((e) => e.terminated && !e.surfaced)
      .map((e) => e.line);
    /*
      The failure message names LINES rather than counting, because the useful
      thing to know when this breaks is which exit went quiet. A new exit that
      forgets the call lands here, and what it costs in production is a browser
      spinning forever on a turn the host already gave up on.
    */
    expect(silent).toEqual([]);
  });

  it('still finds the exits it is meant to be watching', () => {
    /*
      THE SCAN'S OWN SAFETY CATCH. A regex that stops matching passes the
      assertion above vacuously — zero exits found, zero silent — which is the
      way a test like this rots into decoration. So the count is pinned too.
      It is EXPECTED to need updating when a real exit is added or removed;
      that edit is the moment to check the new one surfaces itself, which is
      the whole point.
    */
    const all = exits();
    expect(all.length).toBe(15);
    expect(all.every((e) => e.terminated)).toBe(true);
  });
});
