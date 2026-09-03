import { describe, expect, it, beforeEach } from 'vitest';
import {
  MAX_TOOL_PHRASES,
  clearToolPhrases,
  rememberToolPhrase,
  toolDisplayName,
} from '../lib/tool-phrase';

describe('tool-phrase display map (TASK-271)', () => {
  beforeEach(() => {
    clearToolPhrases();
  });

  it('resolves a remembered phrase over the tool name', () => {
    rememberToolPhrase('c1', 'Searching memory');
    expect(toolDisplayName('c1', 'memory_search')).toBe('Searching memory');
  });

  it('falls back to the tool name for unknown call ids', () => {
    expect(toolDisplayName('unknown', 'request_capability')).toBe(
      'request_capability',
    );
  });

  it('ignores missing and blank phrases (fallback survives)', () => {
    rememberToolPhrase('c1', undefined);
    rememberToolPhrase('c2', '   ');
    expect(toolDisplayName('c1', 'Bash')).toBe('Bash');
    expect(toolDisplayName('c2', 'Bash')).toBe('Bash');
  });

  it('evicts the oldest entries past the cap (degrades to fallback)', () => {
    for (let i = 0; i < MAX_TOOL_PHRASES + 5; i++) {
      rememberToolPhrase(`c${i}`, `phrase ${i}`);
    }
    // The first five were evicted; the rest resolve.
    expect(toolDisplayName('c0', 'tool_a')).toBe('tool_a');
    expect(toolDisplayName('c4', 'tool_a')).toBe('tool_a');
    expect(toolDisplayName(`c${MAX_TOOL_PHRASES + 4}`, 'tool_b')).toBe(
      `phrase ${MAX_TOOL_PHRASES + 4}`,
    );
  });
});
