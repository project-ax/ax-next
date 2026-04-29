import { describe, it, expect } from 'vitest';
import {
  StubRunnerScriptSchema,
  encodeScript,
  decodeScript,
  type StubRunnerScript,
} from '../script-schema.js';

describe('StubRunnerScriptSchema', () => {
  it('accepts a minimal finish-only script', () => {
    const script = {
      entries: [{ kind: 'finish', reason: 'end_turn' }],
    };
    const parsed = StubRunnerScriptSchema.parse(script);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toEqual({ kind: 'finish', reason: 'end_turn' });
  });

  it('accepts a tool-call entry with executesIn=host', () => {
    const script: StubRunnerScript = {
      entries: [
        {
          kind: 'tool-call',
          name: 'fs.read',
          input: { path: '/tmp/x' },
          executesIn: 'host',
          expectPostCall: true,
        },
        { kind: 'finish', reason: 'tool_use' },
      ],
    };
    const parsed = StubRunnerScriptSchema.parse(script);
    expect(parsed.entries[0]).toMatchObject({
      kind: 'tool-call',
      name: 'fs.read',
      executesIn: 'host',
      expectPostCall: true,
    });
  });

  it('rejects an unknown entry kind', () => {
    const result = StubRunnerScriptSchema.safeParse({
      entries: [{ kind: 'mystery', payload: 'nope' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a tool-call without name', () => {
    const result = StubRunnerScriptSchema.safeParse({
      entries: [
        {
          kind: 'tool-call',
          input: {},
          executesIn: 'sandbox',
          expectPostCall: false,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('round-trips a script through encodeScript/decodeScript', () => {
    const script: StubRunnerScript = {
      entries: [
        { kind: 'assistant-text', content: 'hello world' },
        {
          kind: 'tool-call',
          name: 'shell.exec',
          input: { cmd: 'ls', args: ['-la'] },
          executesIn: 'sandbox',
          expectPostCall: false,
        },
        { kind: 'finish', reason: 'end_turn' },
      ],
    };
    const encoded = encodeScript(script);
    expect(typeof encoded).toBe('string');
    const decoded = decodeScript(encoded);
    expect(decoded).toEqual(script);
  });

  it('encodeScript produces a string under 64 KiB for a 50-entry script', () => {
    const entries: StubRunnerScript['entries'] = [];
    for (let i = 0; i < 49; i++) {
      entries.push({
        kind: 'tool-call',
        name: `tool.${i}`,
        input: { iteration: i, label: `step-${i}` },
        executesIn: i % 2 === 0 ? 'host' : 'sandbox',
        expectPostCall: true,
      });
    }
    entries.push({ kind: 'finish', reason: 'end_turn' });
    const encoded = encodeScript({ entries });
    expect(encoded.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('decodeScript throws on invalid base64-encoded JSON', () => {
    const bogus = Buffer.from('{"entries":[{"kind":"nope"}]}', 'utf8').toString(
      'base64',
    );
    expect(() => decodeScript(bogus)).toThrow();
  });
});
