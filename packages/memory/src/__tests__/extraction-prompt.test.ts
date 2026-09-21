import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  EXTRACTION_MODEL_ID,
  EXTRACTION_PROMPT_FINGERPRINT,
  EXTRACTION_PROMPT_MODEL_FINGERPRINT,
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionPrompt,
  extractionFingerprint,
} from '../extraction-prompt.js';

/**
 * The prompt is the component measured worth ~57 points, and the design says
 * in as many words that it does not change. These tests are what turn a
 * reword into a CI failure instead of a silent re-measurement.
 *
 * Two independent pins, because they fail for different reasons:
 *
 * 1. The FINGERPRINT constants — any edit at all, here or in dem-memory.
 * 2. A byte comparison against `dem-memory/src/engine/retain.ts`, the source
 *    this file copies. The fingerprint alone would let the two DRIFT as long
 *    as somebody updated the constant; this one says they are the same text.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEM_RETAIN = `${REPO_ROOT}dem-memory/src/engine/retain.ts`;

describe('the pinned extraction prompt', () => {
  it('has the measured prompt-only fingerprint', () => {
    expect(extractionFingerprint()).toBe(EXTRACTION_PROMPT_FINGERPRINT);
  });

  it('has the measured prompt+model fingerprint — the extraction cache key', () => {
    expect(extractionFingerprint(EXTRACTION_MODEL_ID)).toBe(
      EXTRACTION_PROMPT_MODEL_FINGERPRINT,
    );
  });

  /**
   * ⚠ The design doc and the epic's cards both say the pinned fingerprint is
   * `f4752a79`. It is not, and this test states the measurement rather than
   * the claim: `f4752a79` names the generation BEFORE `confidence` was
   * removed from the prompt on 2026-09-17, a removal recorded in
   * `.claude/memory/` as having deliberately re-keyed the cache to
   * `06414f62`. See the header of `extraction-prompt.ts`.
   */
  it('is NOT f4752a79, and says why', () => {
    expect(extractionFingerprint()).not.toBe('f4752a79');
    expect(extractionFingerprint(EXTRACTION_MODEL_ID)).not.toBe('f4752a79');
    expect(EXTRACTION_SYSTEM_PROMPT).not.toContain('confidence');
  });

  it('is byte-identical to dem-memory, which is the source it is copied from', async () => {
    const source = await readFile(DEM_RETAIN, 'utf8');

    // Ends at the `]`, NOT at the `.join("\n")` that follows it: the `"\n"`
    // in the join is itself a double-quoted literal, and scanning past it
    // appended a stray newline to the reconstructed prompt.
    const system = extractBlock(
      source,
      'export const EXTRACTION_SYSTEM_PROMPT = [',
      '\n]',
    );
    const builder = extractBlock(source, 'export function buildExtractionPrompt', '\n  ].join(');

    // Compare the RENDERED prompt, not the source text: the copy is allowed
    // to differ in surrounding comments, and what has to match is the string
    // the model receives.
    const demSystem = evaluateStringArray(system);
    expect(EXTRACTION_SYSTEM_PROMPT).toBe(demSystem);

    // The user-prompt builder is short enough to compare structurally: every
    // literal line in dem's version must appear in ours, and the rendered
    // output must match for a representative input.
    for (const line of literalLines(builder)) {
      expect(buildExtractionPrompt('DIALOGUE', 'NOW')).toContain(line);
    }
    expect(buildExtractionPrompt('DIALOGUE', 'NOW')).toContain('Current time: NOW');
    expect(buildExtractionPrompt('DIALOGUE', 'NOW').endsWith('DIALOGUE')).toBe(true);
  });
});

/** The slice of `source` from the line starting `start` up to `end`. */
function extractBlock(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `dem-memory no longer contains ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  expect(to, `dem-memory no longer contains ${end}`).toBeGreaterThan(from);
  return source.slice(from, to + end.length);
}

/**
 * Render a `[ "line", ... ].join("\n")` block without executing it.
 *
 * `JSON.parse` per literal rather than `eval`: this reads a file off disk and
 * an `eval` in a test is a habit worth not having.
 */
function evaluateStringArray(block: string): string {
  return literalLines(block).join('\n');
}

/** Every double-quoted string literal in a block, in order, unescaped. */
function literalLines(block: string): string[] {
  const lines: string[] = [];
  // Matches a double-quoted JS string literal, including escaped quotes.
  const re = /"(?:[^"\\]|\\.)*"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) {
    lines.push(JSON.parse(match[0]) as string);
  }
  return lines;
}
