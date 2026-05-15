import { describe, expect, it } from 'vitest';
import { applySilenceLogic } from '../silence.js';

function blocks(text: string) {
  return [{ type: 'text', text }];
}

describe('applySilenceLogic', () => {
  it('returns silenced=false when no silenceToken is set', () => {
    const r = applySilenceLogic(blocks('hello world'), { silenceToken: null, silenceMaxChars: 300 });
    expect(r.silenced).toBe(false);
  });

  it('returns silenced=true when text == token', () => {
    const r = applySilenceLogic(blocks('HEARTBEAT_OK'), { silenceToken: 'HEARTBEAT_OK', silenceMaxChars: 300 });
    expect(r.silenced).toBe(true);
  });

  it('returns silenced=true when text starts with token and remainder ≤ max', () => {
    const r = applySilenceLogic(
      blocks('HEARTBEAT_OK\nshort follow-up'),
      { silenceToken: 'HEARTBEAT_OK', silenceMaxChars: 300 },
    );
    expect(r.silenced).toBe(true);
  });

  it('returns silenced=true when text ends with token', () => {
    const r = applySilenceLogic(
      blocks('nothing to do here\nHEARTBEAT_OK'),
      { silenceToken: 'HEARTBEAT_OK', silenceMaxChars: 300 },
    );
    expect(r.silenced).toBe(true);
  });

  it('returns silenced=false when remainder exceeds max', () => {
    const remainder = 'x'.repeat(400);
    const r = applySilenceLogic(
      blocks(`HEARTBEAT_OK\n${remainder}`),
      { silenceToken: 'HEARTBEAT_OK', silenceMaxChars: 300 },
    );
    expect(r.silenced).toBe(false);
  });

  it('returns silenced=false when token is in the middle but not at boundary', () => {
    const r = applySilenceLogic(
      blocks('here is HEARTBEAT_OK something else and a longer message body'),
      { silenceToken: 'HEARTBEAT_OK', silenceMaxChars: 300 },
    );
    expect(r.silenced).toBe(false);
  });

  it('treats empty contentBlocks (runner heartbeat) as non-silenced', () => {
    const r = applySilenceLogic([], { silenceToken: 'HEARTBEAT_OK', silenceMaxChars: 300 });
    expect(r.silenced).toBe(false);
  });

  it('escapes regex metachars in the token', () => {
    const r = applySilenceLogic(
      blocks('[SILENT]'),
      { silenceToken: '[SILENT]', silenceMaxChars: 300 },
    );
    expect(r.silenced).toBe(true);
  });
});
