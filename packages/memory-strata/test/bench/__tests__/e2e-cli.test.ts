import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runE2EMode } from '../e2e-cli.js';

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
