import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@ax/ipc-protocol';
import { buildPrompt } from '../prompt.js';
import type { Turn, TurnRole } from '../types.js';

const SYSTEM_PROMPT_VERBATIM =
  'You generate short, descriptive titles for conversations between a user ' +
  'and an AI assistant. Output ONLY the title — no quotes, no preamble, no ' +
  'trailing period. Maximum 8 words. Use Title Case. If the conversation ' +
  'is empty or unclear, output exactly: Untitled';

let turnCounter = 0;
function turn(role: TurnRole, contentBlocks: ContentBlock[]): Turn {
  turnCounter += 1;
  return {
    turnId: `t${turnCounter}`,
    turnIndex: turnCounter,
    role,
    contentBlocks,
    createdAt: '2026-05-03T00:00:00.000Z',
  };
}

describe('buildPrompt', () => {
  it('returns the canonical system prompt verbatim and an empty user transcript when no turns', () => {
    const out = buildPrompt([]);
    expect(out.system).toBe(SYSTEM_PROMPT_VERBATIM);
    expect(out.user).toBe('Summarize this conversation in ≤8 words:\n\n');
  });

  it('labels a single user turn as "User: ..."', () => {
    const out = buildPrompt([turn('user', [{ type: 'text', text: 'Hello' }])]);
    expect(out.user).toBe('Summarize this conversation in ≤8 words:\n\nUser: Hello');
  });

  it('labels assistant turns as "Assistant: ..." and joins lines with \\n', () => {
    const out = buildPrompt([
      turn('user', [{ type: 'text', text: 'Hi' }]),
      turn('assistant', [{ type: 'text', text: 'Hello' }]),
    ]);
    expect(out.user).toBe(
      'Summarize this conversation in ≤8 words:\n\nUser: Hi\nAssistant: Hello',
    );
  });

  it('renders tool_use blocks as a [tool: <name>] marker', () => {
    const out = buildPrompt([
      turn('assistant', [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'read_file',
          input: { path: '/etc/passwd' },
        },
      ]),
    ]);
    expect(out.user).toBe(
      'Summarize this conversation in ≤8 words:\n\nAssistant: [tool: read_file]',
    );
  });

  it('renders tool_result blocks as a [result] marker', () => {
    const out = buildPrompt([
      turn('tool', [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: 'some output bytes',
        },
      ]),
    ]);
    expect(out.user).toBe(
      'Summarize this conversation in ≤8 words:\n\nTool: [result]',
    );
  });

  it('drops thinking and redacted_thinking blocks from the flattened text', () => {
    const out = buildPrompt([
      turn('assistant', [
        { type: 'thinking', thinking: 'should be dropped' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'text', text: 'visible' },
      ]),
    ]);
    expect(out.user).toBe(
      'Summarize this conversation in ≤8 words:\n\nAssistant: visible',
    );
  });

  it('drops a turn whose blocks all flatten to empty (no "User: " line)', () => {
    const out = buildPrompt([
      turn('user', [{ type: 'thinking', thinking: 'nothing user-visible here' }]),
      turn('assistant', [{ type: 'text', text: 'real reply' }]),
    ]);
    expect(out.user).toBe(
      'Summarize this conversation in ≤8 words:\n\nAssistant: real reply',
    );
  });

  it('respects the 4000-char transcript budget by dropping trailing turns', () => {
    // Five turns of ~2000 chars each: first 2 fit (2 × ~2006 ~= 4012 — actually
    // the second one pushes us OVER the budget, so only the first turn lands).
    // We size each text to 2000 chars exactly so the math is predictable.
    const big = 'a'.repeat(2000);
    const turns = [
      turn('user', [{ type: 'text', text: big }]),
      turn('assistant', [{ type: 'text', text: big }]),
      turn('user', [{ type: 'text', text: big }]),
      turn('assistant', [{ type: 'text', text: big }]),
      turn('user', [{ type: 'text', text: big }]),
    ];
    const out = buildPrompt(turns);
    // First line is 'User: ' (6 chars) + 2000 = 2006 chars. Fits (used=2006).
    // Second line would be 'Assistant: ' (11) + 2000 = 2011, used+2011 = 4017
    // > 4000 budget — break. Only one line.
    const lines = out.user
      .replace('Summarize this conversation in ≤8 words:\n\n', '')
      .split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`User: ${big}`);
  });
});
