import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  TRANSCRIPT_RUNNER,
  TRANSCRIPT_VERSION,
  decodeTranscript,
  encodeTranscript,
  headerLine,
} from '../transcript-codec.js';
import { createMemoryTranscriptSource } from '../memory-transcript-source.js';

const USER: ModelMessage = { role: 'user', content: 'hello' };
const ASSISTANT: ModelMessage = {
  role: 'assistant',
  content: [
    { type: 'text', text: 'looking' },
    { type: 'tool-call', toolCallId: 'c1', toolName: 'Bash', input: { command: 'ls' } },
  ],
};
const TOOL: ModelMessage = {
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolCallId: 'c1',
      toolName: 'Bash',
      output: { type: 'text', value: 'file1\nfile2' },
    },
  ],
};

function seq(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe('transcript codec', () => {
  it('writes a version+runner header as the first line', () => {
    const bytes = encodeTranscript([
      { uuid: 'u1', role: 'user', message: USER },
    ]);
    const first = bytes.toString('utf8').split('\n')[0]!;
    expect(JSON.parse(first)).toEqual({
      v: TRANSCRIPT_VERSION,
      runner: TRANSCRIPT_RUNNER,
    });
  });

  it('round-trips messages through encode → decode', () => {
    const entries = [
      { uuid: 'u1', role: 'user' as const, message: USER },
      { uuid: 'u2', role: 'assistant' as const, message: ASSISTANT },
      { uuid: 'u3', role: 'tool' as const, message: TOOL },
    ];
    const decoded = decodeTranscript(encodeTranscript(entries));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.entries.map((e) => e.uuid)).toEqual(['u1', 'u2', 'u3']);
    expect(decoded.entries.map((e) => e.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    expect(decoded.entries[1]!.message).toEqual(ASSISTANT);
    expect(decoded.entries[2]!.message).toEqual(TOOL);
  });

  // The delta protocol advances `sentOffset` to complete-line boundaries, so a
  // message that serialized across two lines would corrupt every subsequent
  // ship. A tool result carrying real newlines is the case that would bite.
  it('serializes every entry to exactly one line, even with embedded newlines', () => {
    const bytes = encodeTranscript([
      { uuid: 'u1', role: 'tool', message: TOOL },
      { uuid: 'u2', role: 'user', message: { role: 'user', content: 'a\nb\nc' } },
    ]);
    const text = bytes.toString('utf8');
    expect(text.endsWith('\n')).toBe(true);
    // header + 2 entries + the trailing empty segment
    expect(text.split('\n')).toHaveLength(4);
  });

  // Each line carries an explicit `role` so the host's generic transcript
  // readers (roleOfJsonlLine / dropTurnFromJsonl in @ax/conversations) can see
  // the display role and the turn id without knowing our message shape.
  it('exposes role and uuid at the top level of every line for host readers', () => {
    const bytes = encodeTranscript([
      { uuid: 'turn-7', role: 'assistant', message: ASSISTANT },
    ]);
    const line = JSON.parse(bytes.toString('utf8').split('\n')[1]!) as {
      role: string;
      uuid: string;
      message: unknown;
    };
    expect(line.role).toBe('assistant');
    expect(line.uuid).toBe('turn-7');
    expect(line.message).toEqual(ASSISTANT);
  });

  describe('rejects, without throwing', () => {
    it('a transcript written by the other runner (the cross-runner demotion)', () => {
      // A real claude-sdk jsonl line: no header, SDK-shaped entry.
      const sdkJsonl = Buffer.from(
        '{"type":"user","uuid":"x","message":{"role":"user","content":"hi"}}\n',
        'utf8',
      );
      const res = decodeTranscript(sdkJsonl);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      // An SDK line parses as JSON fine and simply has no `runner` key, so the
      // message must not read as "runner 'undefined'" — whoever finds this in
      // the runner log would go hunting for a misconfigured runner id.
      expect(res.reason).toContain('no \'aisdk\' header line');
      expect(res.reason).not.toContain('undefined');
    });

    it('a header naming a different runner explicitly', () => {
      const bytes = Buffer.from(
        JSON.stringify({ v: 1, runner: 'claude-sdk' }) + '\n',
        'utf8',
      );
      const res = decodeTranscript(bytes);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toContain('claude-sdk');
    });

    it('a future version', () => {
      const bytes = Buffer.from(
        JSON.stringify({ v: 99, runner: TRANSCRIPT_RUNNER }) + '\n',
        'utf8',
      );
      const res = decodeTranscript(bytes);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toContain('99');
    });

    it('empty bytes', () => {
      expect(decodeTranscript(Buffer.from('')).ok).toBe(false);
    });

    // All-or-nothing: a truncated transcript can end mid-tool-call, and a
    // dangling tool-call makes the provider reject the next request.
    it('the WHOLE transcript when any line is malformed', () => {
      const good = encodeTranscript([
        { uuid: 'u1', role: 'user', message: USER },
      ]).toString('utf8');
      const res = decodeTranscript(Buffer.from(good + '{not json\n', 'utf8'));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toMatch(/line 3/);
    });

    it('a line whose message is not a valid ModelMessage', () => {
      const bad =
        headerLine() +
        '\n' +
        JSON.stringify({ role: 'user', uuid: 'u1', message: { role: 'nope' } }) +
        '\n';
      const res = decodeTranscript(Buffer.from(bad, 'utf8'));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toMatch(/ModelMessage/);
    });

    it('a line with no uuid', () => {
      const bad =
        headerLine() + '\n' + JSON.stringify({ role: 'user', message: USER }) + '\n';
      const res = decodeTranscript(Buffer.from(bad, 'utf8'));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toMatch(/uuid/);
    });

    it('adversarial bytes without throwing', () => {
      for (const junk of ['\0\0\0', '[]', 'null', '{"v":1}', '   ', '\n\n\n']) {
        expect(() => decodeTranscript(Buffer.from(junk, 'utf8'))).not.toThrow();
        expect(decodeTranscript(Buffer.from(junk, 'utf8')).ok).toBe(false);
      }
    });
  });
});

describe('memory transcript source', () => {
  it('read() is null before any message exists', async () => {
    const src = createMemoryTranscriptSource({ idGen: seq() });
    await expect(src.read('s1')).resolves.toBeNull();
  });

  it('append() makes messages readable and shippable', async () => {
    const src = createMemoryTranscriptSource({ idGen: seq() });
    src.append([USER, ASSISTANT]);

    expect(src.messages()).toEqual([USER, ASSISTANT]);
    const bytes = await src.read('s1');
    expect(bytes).not.toBeNull();
    const decoded = decodeTranscript(bytes!);
    expect(decoded.ok && decoded.entries).toHaveLength(2);
  });

  it('lastUuidOfRole backs the turn-end turnId without touching disk', () => {
    const src = createMemoryTranscriptSource({ idGen: seq() });
    src.append([USER, ASSISTANT, TOOL, { role: 'assistant', content: 'done' }]);

    expect(src.lastUuidOfRole('user')).toBe('id-1');
    expect(src.lastUuidOfRole('tool')).toBe('id-3');
    // The LAST assistant entry, not the first.
    expect(src.lastUuidOfRole('assistant')).toBe('id-4');
  });

  it('write() seeds the array on resume and reports accepted', async () => {
    const donor = createMemoryTranscriptSource({ idGen: seq() });
    donor.append([USER, ASSISTANT, TOOL]);
    const stored = (await donor.read('s1'))!;

    const src = createMemoryTranscriptSource({ idGen: seq() });
    await expect(src.write('s1', stored)).resolves.toBe('accepted');
    expect(src.messages()).toEqual([USER, ASSISTANT, TOOL]);
    expect(src.size()).toBe(3);
  });

  // This is what keeps the resume cheap: `modelMessageSchema` STRIPS unknown
  // keys (verified against ai@7.0.70), so re-serializing the parsed messages
  // would silently drop any provider field we don't model, change the bytes,
  // and force a whole-file resync on EVERY resume. The fixture below carries
  // exactly such a field, so this assertion can actually fail.
  it('re-emits restored bytes verbatim so the shipped prefix stays stable', async () => {
    const storedText =
      headerLine() +
      '\n' +
      JSON.stringify({
        role: 'assistant',
        uuid: 'u1',
        message: {
          role: 'assistant',
          // `futureProviderField` is not in ModelMessage; zod strips it on
          // parse. Only verbatim re-emission survives it.
          content: [{ type: 'text', text: 'hi', futureProviderField: 'keep me' }],
        },
      }) +
      '\n';
    const stored = Buffer.from(storedText, 'utf8');

    const src = createMemoryTranscriptSource({ idGen: seq() });
    await expect(src.write('s1', stored)).resolves.toBe('accepted');
    const reread = (await src.read('s1'))!;

    expect(reread.equals(stored)).toBe(true);
    // The parsed view the model sees is the stripped one — that is fine and
    // expected; only the BYTES we ship must be verbatim.
    expect(src.messages()[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  it('appends after a resume without disturbing the restored prefix', async () => {
    const donor = createMemoryTranscriptSource({ idGen: seq() });
    donor.append([USER, ASSISTANT]);
    const stored = (await donor.read('s1'))!;

    const src = createMemoryTranscriptSource({ idGen: seq() });
    await src.write('s1', stored);
    src.append([{ role: 'user', content: 'and now?' }]);

    const bytes = (await src.read('s1'))!;
    // Byte-for-byte prefix stability is what the host's prefixHash check reads.
    expect(bytes.subarray(0, stored.length).equals(stored)).toBe(true);
    expect(src.messages()).toHaveLength(3);
  });

  it("answers 'unusable' for the other runner's transcript and says why", async () => {
    const warn = vi.fn();
    const src = createMemoryTranscriptSource({ idGen: seq(), warn });
    const sdkJsonl = Buffer.from(
      '{"type":"user","uuid":"x","message":{"role":"user","content":"hi"}}\n',
      'utf8',
    );

    await expect(src.write('s1', sdkJsonl)).resolves.toBe('unusable');
    // Nothing adopted — a demoted session must start genuinely empty.
    expect(src.messages()).toEqual([]);
    expect(await src.read('s1')).toBeNull();
    // A user whose history vanished deserves a line explaining why.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('starting fresh'));
  });

  it('leaves an already-populated transcript untouched when a write is rejected', async () => {
    const src = createMemoryTranscriptSource({ idGen: seq(), warn: vi.fn() });
    src.append([USER]);
    await expect(src.write('s1', Buffer.from('garbage\n'))).resolves.toBe(
      'unusable',
    );
    expect(src.messages()).toEqual([USER]);
  });
});

// ---------------------------------------------------------------------------
// Cross-runner history reconstruction (design:
// docs/plans/2026-08-21-cross-runner-history-reconstruction.md).
//
// When `write` answers 'unusable' the shell asks the host for the display log
// and hands it here. Without this the agent starts blank while the user still
// has the whole conversation on screen — measured on kind, 2026-08-21: after a
// runner switch it answered NO-HISTORY about its own first turn.
// ---------------------------------------------------------------------------
describe('seedFromHistory', () => {
  const history = [
    { role: 'user' as const, content: 'what did we call the token?' },
    { role: 'assistant' as const, content: 'WALK-WS-TOKEN-7719' },
  ];

  it('rebuilds prior turns as messages, preserving each role', () => {
    const src = createMemoryTranscriptSource({ idGen: seq() });
    void src.seedFromHistory!({ sessionId: 's1', messages: history, truncated: false });

    const msgs = src.messages();
    // A leading note, then the history verbatim, in order.
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.role).toBe('user');
    expect(JSON.stringify(msgs[0])).toContain('different agent runner');
    expect(msgs[1]!.role).toBe('user');
    expect(JSON.stringify(msgs[1])).toContain('what did we call the token?');
    // The assistant turn stays an ASSISTANT turn — remapping authorship inside
    // the model's own context would be a lie it then reasons from.
    expect(msgs[2]!.role).toBe('assistant');
    expect(JSON.stringify(msgs[2])).toContain('WALK-WS-TOKEN-7719');
  });

  it('tells the model the tool detail is gone, so its gaps are explained', () => {
    const src = createMemoryTranscriptSource({ idGen: seq() });
    void src.seedFromHistory!({ sessionId: 's1', messages: history, truncated: false });
    const note = JSON.stringify(src.messages()[0]);
    expect(note).toContain('tool calls and their results');
  });

  it('says so when the host had to trim older turns', () => {
    const src = createMemoryTranscriptSource({ idGen: seq() });
    void src.seedFromHistory!({ sessionId: 's1', messages: history, truncated: true });
    expect(JSON.stringify(src.messages()[0])).toContain('trimmed');
  });

  it('does nothing at all for an empty history', () => {
    // No history is not the same as "explain the missing history" — a brand new
    // conversation must not open with a note about turns that never existed.
    const src = createMemoryTranscriptSource({ idGen: seq() });
    void src.seedFromHistory!({ sessionId: 's1', messages: [], truncated: false });
    expect(src.messages()).toEqual([]);
    expect(src.size()).toBe(0);
  });

  it('leaves the seeded turns shippable as this runner\'s own transcript', async () => {
    // They are context, not a prefix the host already holds: the source must
    // serialize them in THIS runner's format so the normal delta ship sends
    // them as its own.
    const src = createMemoryTranscriptSource({ idGen: seq() });
    void src.seedFromHistory!({ sessionId: 's1', messages: history, truncated: false });
    const bytes = await src.read('s1');
    expect(bytes).not.toBeNull();
    const firstLine = bytes!.toString('utf8').split('\n')[0]!;
    expect(JSON.parse(firstLine)).toEqual({ v: 1, runner: 'aisdk' });
  });
});
