import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../cli.js';

describe('parseCliArgs — e2e mode flags (TASK-189)', () => {
  it('defaults to bench mode', () => {
    const a = parseCliArgs([]);
    expect(a.mode).toBe('bench');
    expect(a.full).toBe(false);
    expect(a.cap).toBeUndefined();
    expect(a.resume).toBeUndefined();
  });

  it('parses --mode e2e with cap, full, and resume', () => {
    const a = parseCliArgs(['--mode', 'e2e', '--cap', '10', '--full', '--resume', 'run-7']);
    expect(a.mode).toBe('e2e');
    expect(a.cap).toBe(10);
    expect(a.full).toBe(true);
    expect(a.resume).toBe('run-7');
  });

  it('keeps --sample working in e2e mode', () => {
    const a = parseCliArgs(['--mode', 'e2e', '--sample', '50']);
    expect(a.mode).toBe('e2e');
    expect(a.sample).toBe(50);
  });

  it('treats an unknown --mode value as bench (safe default)', () => {
    expect(parseCliArgs(['--mode', 'wat']).mode).toBe('bench');
  });

  it('parses --types and --ids as comma-separated lists', () => {
    const a = parseCliArgs([
      '--mode', 'e2e',
      '--types', 'single-session-assistant, multi-session',
      '--ids', 'q1,q2',
    ]);
    expect(a.types).toEqual(['single-session-assistant', 'multi-session']);
    expect(a.ids).toEqual(['q1', 'q2']);
  });

  it('leaves types/ids undefined when the flags are absent', () => {
    const a = parseCliArgs(['--mode', 'e2e']);
    expect(a.types).toBeUndefined();
    expect(a.ids).toBeUndefined();
  });
});

describe('parseCliArgs — --orchestrator-model (TASK-349)', () => {
  it('defaults to haiku', () => {
    expect(parseCliArgs([]).orchestratorModel).toBe('haiku');
  });

  it('selects the glm arm', () => {
    // Renamed from `grok` when `x-ai/grok-4.1-fast` turned out to have been
    // 404ing for months. The old spelling must NOT keep working: silently
    // accepting it would drop a run back to the default arm, which is how the
    // dead id went unnoticed in the first place.
    expect(parseCliArgs(['--orchestrator-model', 'glm']).orchestratorModel).toBe('glm');
  });

  it('REJECTS the retired `grok` spelling, naming why', () => {
    // Not a fallback. Quietly remapping it onto haiku would run a full paid
    // bench against a model nobody asked for and report success — the same
    // silent degradation that let the dead id survive four months.
    expect(() => parseCliArgs(['--orchestrator-model', 'grok'])).toThrow(/unknown arm "grok"/);
    expect(() => parseCliArgs(['--orchestrator-model', 'grok'])).toThrow(/404s on every call/);
  });

  it('REJECTS any other unknown arm rather than defaulting', () => {
    expect(() => parseCliArgs(['--orchestrator-model', 'wat'])).toThrow(
      /unknown arm "wat". Expected one of haiku, glm/,
    );
  });
});

describe('bench PRICING covers every selectable orchestrator arm (TASK-349)', () => {
  it('prices both arms, so a run cannot die on CostMeter mid-flight', async () => {
    // `CostMeter.record` THROWS on an unknown model key, and it is called deep
    // inside a paid run. A missing row is therefore not a config nit — it is
    // money spent and then discarded.
    const { PRICING } = await import('../cli.js');
    for (const key of ['claude-haiku-4-5-20251001', 'z-ai/glm-5.3-flash:nitro']) {
      expect(PRICING[key], `no PRICING row for ${key}`).toBeDefined();
    }
  });
});
