import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runE2EMode } from '../e2e-cli.js';
import { parseAnswerEffort } from '../cli.js';

describe('runE2EMode (TASK-189)', () => {
  it('fixture mode writes a labelled representative report end-to-end (no keys, no network)', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'e2e-cli-repo-'));
    mkdirSync(join(repoRoot, 'docs', 'plans'), { recursive: true });
    try {
      const code = await runE2EMode({ repoRoot, sample: 100, cap: 25, fixture: true });
      expect(code).toBe(0);

      // The report lands at docs/plans/<date>-memory-strata-e2e-report.md.
      const date = new Date().toISOString().slice(0, 10);
      const reportPath = join(repoRoot, 'docs', 'plans', `${date}-memory-strata-e2e-report.md`);
      expect(existsSync(reportPath)).toBe(true);
      const md = readFileSync(reportPath, 'utf8');
      // It ran the REAL pipeline over the fixture: an accuracy + abstention split,
      // the named models, and the fixture-mode label.
      expect(md).toContain('end-to-end accuracy');
      expect(md).toContain('Abstention');
      expect(md).toContain('claude-sonnet-4-6');
      expect(md).toContain('x-ai/grok-4.3');
      expect(md).toContain('fixture mode');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('honors --out: writes the report to the given path, not the date-stamped default (TASK-395)', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'e2e-cli-repo-'));
    mkdirSync(join(repoRoot, 'docs', 'plans'), { recursive: true });
    const customDir = mkdtempSync(join(tmpdir(), 'e2e-cli-out-'));
    const customOut = join(customDir, 'my-e2e-report.md');
    try {
      const code = await runE2EMode({ repoRoot, sample: 100, cap: 25, fixture: true, out: customOut });
      expect(code).toBe(0);

      expect(existsSync(customOut)).toBe(true);
      const md = readFileSync(customOut, 'utf8');
      expect(md).toContain('end-to-end accuracy');

      // The date-stamped default location must NOT have been written to.
      const date = new Date().toISOString().slice(0, 10);
      const defaultPath = join(repoRoot, 'docs', 'plans', `${date}-memory-strata-e2e-report.md`);
      expect(existsSync(defaultPath)).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  it('a bad --out path (unwritable directory) surfaces an error rather than being swallowed (TASK-395)', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'e2e-cli-repo-'));
    mkdirSync(join(repoRoot, 'docs', 'plans'), { recursive: true });
    const badOut = join(repoRoot, 'does', 'not', 'exist', 'report.md');
    try {
      await expect(
        runE2EMode({ repoRoot, sample: 100, cap: 25, fixture: true, out: badOut }),
      ).rejects.toThrow();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('returns exit code 2 with no API keys and no --fixture (does not throw)', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'e2e-cli-repo-'));
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    const prevOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const code = await runE2EMode({ repoRoot, sample: 100, cap: 25 });
      expect(code).toBe(2);
    } finally {
      if (prevAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = prevAnthropic;
      if (prevOpenRouter !== undefined) process.env.OPENROUTER_API_KEY = prevOpenRouter;
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('e2e planner arms are priced (TASK: e2e orchestrator arm)', () => {
  it('prices every selectable planner, so a metered run cannot die mid-flight', async () => {
    // e2e never metered the planner before this change: its tokens were spent
    // and dropped, so every e2e cost figure understated the orchestrator path.
    // Now that `meter.record` sees them, an unpriced arm throws — and it throws
    // deep inside a run that has already spent real money.
    const { PRICING, E2E_HAIKU_MODEL, E2E_GLM_MODEL } = await import('../e2e-cli.js');
    for (const key of [E2E_HAIKU_MODEL, E2E_GLM_MODEL]) {
      expect(PRICING[key], `no PRICING row for ${key}`).toBeDefined();
    }
  });
});

describe('--answer-effort parsing', () => {
  it('accepts the four levels claude-sonnet-4-6 supports', () => {
    for (const lvl of ['low', 'medium', 'high', 'max'] as const) {
      expect(parseAnswerEffort(lvl)).toBe(lvl);
    }
  });

  it('THROWS on xhigh — Sonnet 4.6 does not accept it, and a silently ignored spend flag is only visible after the run is paid for', () => {
    expect(() => parseAnswerEffort('xhigh')).toThrow(/xhigh/);
  });

  it('throws on an unknown level rather than falling back to a default', () => {
    expect(() => parseAnswerEffort('turbo')).toThrow(/unknown level/);
  });
});
