import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadResume, appendResume, type E2EResumeRow } from '../e2e-resume.js';

function mkRow(id: string): E2EResumeRow {
  return {
    questionId: id,
    questionType: 'single-session-user',
    unanswerable: false,
    verdict: 'correct',
    judgeReason: 'ok',
    sessionsIngested: 5,
    toolCalls: 1,
    dollars: 0.02,
    question: 'q?',
    goldAnswer: 'a',
    agentAnswer: 'a',
  };
}

describe('e2e resume store (TASK-189)', () => {
  it('round-trips appended rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-resume-'));
    try {
      const path = join(dir, 'nested', 'run.jsonl'); // parent dir doesn't exist yet
      expect(loadResume(path)).toEqual([]);
      appendResume(path, mkRow('q1'));
      appendResume(path, mkRow('q2'));
      const loaded = loadResume(path);
      expect(loaded.map((r) => r.questionId)).toEqual(['q1', 'q2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a malformed trailing line from an interrupted append', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-resume-'));
    try {
      const path = join(dir, 'run.jsonl');
      writeFileSync(path, JSON.stringify(mkRow('q1')) + '\n' + '{"questionId":"q2",partial', 'utf8');
      const loaded = loadResume(path);
      expect(loaded.map((r) => r.questionId)).toEqual(['q1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
