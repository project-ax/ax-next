// Per-run resume store (TASK-189). The existing BenchCache only caches the
// dataset DOWNLOAD, not run progress. The e2e run calls real LLMs per question,
// so it must be resumable: a per-run JSONL keyed by questionId. A resumed run
// loads the file, skips questions already present, and appends new rows as they
// complete — so a crash or a cap-abort mid-run never re-pays for finished work.

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { E2EReportRow } from './e2e-report.js';

/** A persisted per-question row (the report row plus its token/cost accounting). */
export interface E2EResumeRow extends E2EReportRow {
  question: string;
  goldAnswer: string;
  agentAnswer: string;
}

/**
 * Load already-completed rows from a resume JSONL. Returns an empty array when
 * the file doesn't exist (a fresh run). Malformed trailing lines (a crash
 * mid-append) are skipped rather than aborting the whole resume.
 */
export function loadResume(path: string): E2EResumeRow[] {
  if (!existsSync(path)) return [];
  const out: E2EResumeRow[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as E2EResumeRow);
    } catch {
      // Skip a partial final line from an interrupted append.
    }
  }
  return out;
}

/** Append one completed row as a single JSONL line (creates parent dirs). */
export function appendResume(path: string, row: E2EResumeRow): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + '\n', 'utf8');
}
