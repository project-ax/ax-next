import { describe, expect, it } from 'vitest';
import { buildInstructionFilesEnv } from '../instruction-files-env.js';

describe('buildInstructionFilesEnv', () => {
  it("turns off the CLI's CLAUDE.md, rules/*.md and auto-memory MEMORY.md loading", () => {
    // TASK-1217: measured on CLI 2.1.119, the CLI reads these from
    // $CLAUDE_CONFIG_DIR at session start and again after compaction, and
    // frames them as the user's own instructions. The agent's shell can write
    // all of them. Dropping the key lets an agent-written line come back after
    // compaction as "the user's private global instructions".
    expect(buildInstructionFilesEnv()).toEqual({
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    });
  });

  it('returns a fresh object each call', () => {
    const a = buildInstructionFilesEnv();
    const b = buildInstructionFilesEnv();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
