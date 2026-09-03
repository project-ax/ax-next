import { describe, expect, it } from 'vitest';
import { userModelMessageSchema, type ModelMessage } from 'ai';
import { toUserModelMessage } from '../user-message.js';
import { toTurnBlocks } from '../turn-blocks.js';
import { composeInstructions } from '../main.js';

// ---------------------------------------------------------------------------
// The two translation edges between the host's vocabulary and the AI SDK's.
//
//   inbound  — Anthropic-shaped attachment blocks -> AI SDK content parts
//   outbound — AI SDK response messages -> the host's ContentBlock shape
//
// Both are pure functions, so both are cheap to pin exhaustively. The inbound
// direction is validated against the SDK's OWN schema rather than against a
// shape we believe it wants — that is the difference between testing the
// mapping and testing our belief about the mapping.
// ---------------------------------------------------------------------------

const B64 = Buffer.from('bytes').toString('base64');

describe('toUserModelMessage (inbound)', () => {
  it('passes a plain string turn straight through', () => {
    expect(toUserModelMessage('hello')).toEqual({ role: 'user', content: 'hello' });
  });

  it('maps text, image, and document blocks onto AI SDK parts', () => {
    const msg = toUserModelMessage([
      { type: 'text', text: 'look at these' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: B64 },
      },
    ]);

    expect(msg.content).toEqual([
      { type: 'text', text: 'look at these' },
      { type: 'image', image: B64, mediaType: 'image/png' },
      { type: 'file', data: B64, mediaType: 'application/pdf' },
    ]);
  });

  // The assertion that makes the mapping true rather than plausible: the SDK's
  // own parser has to accept what we produce.
  it('produces a message the AI SDK itself validates', () => {
    const msg = toUserModelMessage([
      { type: 'text', text: 'x' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: B64 },
      },
    ]);
    expect(userModelMessageSchema.safeParse(msg).success).toBe(true);
  });

  // Degrading to a text note mirrors the shell's own attachment pass: the model
  // seeing "there was a file I could not read" is recoverable; the model never
  // learning the file existed is not.
  it('degrades an unreadable image to a text note rather than dropping it', () => {
    const msg = toUserModelMessage([{ type: 'image', source: undefined }]);
    expect(msg.content).toEqual([
      { type: 'text', text: '[attachment: an image could not be read]' },
    ]);
  });

  it('keeps provenance for an unknown block kind', () => {
    const msg = toUserModelMessage([{ type: 'hologram' }]);
    expect(JSON.stringify(msg.content)).toContain('hologram');
    expect(userModelMessageSchema.safeParse(msg).success).toBe(true);
  });

  it('never produces an empty content array', () => {
    // Some providers reject a user message with zero parts.
    const msg = toUserModelMessage([]);
    expect(msg.content).toBe('');
    expect(userModelMessageSchema.safeParse(msg).success).toBe(true);
  });

  it('does not throw on a non-array, non-string payload', () => {
    expect(() => toUserModelMessage(undefined)).not.toThrow();
    expect(() => toUserModelMessage(42)).not.toThrow();
  });
});

describe('toTurnBlocks (outbound)', () => {
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking about it' },
        { type: 'text', text: 'let me check' },
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'Bash',
          input: { command: 'ls' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'Bash',
          output: { type: 'text', value: 'file1' },
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];

  it('maps assistant parts onto the host ContentBlock vocabulary', () => {
    const { contentBlocks } = toTurnBlocks(messages);
    expect(contentBlocks).toEqual([
      { type: 'thinking', thinking: 'thinking about it' },
      { type: 'text', text: 'let me check' },
      { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } },
      { type: 'text', text: 'done' },
    ]);
  });

  it('attaches the catalog activityPhrase where present, omits otherwise (TASK-271)', () => {
    const phraseByName = new Map([['memory_search', 'Searching memory']]);
    const { contentBlocks } = toTurnBlocks(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'memory_search',
              input: { query: 'x' },
            },
            {
              type: 'tool-call',
              toolCallId: 'c2',
              toolName: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
      ],
      phraseByName,
    );
    expect(contentBlocks).toEqual([
      {
        type: 'tool_use',
        id: 'c1',
        name: 'memory_search',
        input: { query: 'x' },
        activityPhrase: 'Searching memory',
      },
      { type: 'tool_use', id: 'c2', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('maps tool results onto tool_result blocks', () => {
    const { toolResultBlocks } = toTurnBlocks(messages);
    expect(toolResultBlocks).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'file1' },
    ]);
  });

  // A thrown executor surfaces as `error-text`, and that is exactly the case
  // that must set is_error so the UI renders a failed tool rather than a
  // successful one whose output happens to read like an error.
  it('marks an error-text output as is_error', () => {
    const { toolResultBlocks } = toTurnBlocks([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c9',
            toolName: 'Read',
            output: { type: 'error-text', value: 'ENOENT: no such file' },
          },
        ],
      },
    ]);
    expect(toolResultBlocks).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'c9',
        content: 'ENOENT: no such file',
        is_error: true,
      },
    ]);
  });

  it('collects the turn assistant text for the chat-end history', () => {
    expect(toTurnBlocks(messages).assistantText).toBe('let me check\ndone');
  });

  it('handles a string-content assistant message', () => {
    const { contentBlocks, assistantText } = toTurnBlocks([
      { role: 'assistant', content: 'plain' },
    ]);
    expect(contentBlocks).toEqual([{ type: 'text', text: 'plain' }]);
    expect(assistantText).toBe('plain');
  });

  it('drops part kinds with no ContentBlock counterpart instead of guessing', () => {
    const { contentBlocks } = toTurnBlocks([
      {
        role: 'assistant',
        content: [
          { type: 'file', data: B64, mediaType: 'image/png' },
          { type: 'text', text: 'kept' },
        ],
      },
    ]);
    expect(contentBlocks).toEqual([{ type: 'text', text: 'kept' }]);
  });

  it('ignores user and system messages', () => {
    const { contentBlocks, toolResultBlocks } = toTurnBlocks([
      { role: 'user', content: 'q' },
      { role: 'system', content: 's' },
    ]);
    expect(contentBlocks).toEqual([]);
    expect(toolResultBlocks).toEqual([]);
  });
});

describe('composeInstructions', () => {
  // buildSystemPrompt ends mid-sentence with no trailing newline, and the
  // skills section starts with `## Available skills`. A bare `+` produces
  // `...reasonably can.## Available skills`, which the model reads as prose —
  // silently defeating the section.
  it('separates the prompt and the skills section with a blank line', () => {
    expect(composeInstructions('be helpful.', '## Available skills\n\n- a — b')).toBe(
      'be helpful.\n\n## Available skills\n\n- a — b',
    );
  });

  it('does not double up when the prompt already ends in whitespace', () => {
    expect(composeInstructions('be helpful.\n\n', '## Available skills')).toBe(
      'be helpful.\n\n## Available skills',
    );
  });

  it('adds no trailing separator when there is no section', () => {
    expect(composeInstructions('be helpful.', '')).toBe('be helpful.');
  });

  // The composed prompt carries agent-authored `.ax/` files, so it is
  // uncontrolled input. The first version of this used `/\s+$/`, which CodeQL
  // correctly flagged as polynomial-ReDoS (js/polynomial-redos): quadratic on a
  // string of many repeated whitespace chars. `trimEnd()` is linear. This
  // asserts the pathological input stays fast rather than merely correct.
  it('handles a pathological whitespace prompt in linear time', () => {
    // The shape that actually triggers the blow-up is a long whitespace RUN
    // FOLLOWED BY a non-whitespace char: `$` never matches, so the engine
    // retries from every position. (A prompt that is *entirely* whitespace is
    // fast — my first attempt at this test used that and could not have
    // failed.) Measured on this input: the regex took ~1.8s, trimEnd ~0ms.
    //
    // Reachable in practice: the composed prompt concatenates agent-authored
    // `.ax/` files, so an agent can put 60k tabs in its own SOUL.md and stall
    // its own turn.
    const evil = '\t'.repeat(60_000) + 'x';
    const started = Date.now();
    const out = composeInstructions(evil, '## Available skills');
    expect(out).toBe(`${evil}\n\n## Available skills`);
    // Generous bound so a slow CI box does not flake it, but far under the
    // ~1.8s the regex version took.
    expect(Date.now() - started).toBeLessThan(500);
  });
});
