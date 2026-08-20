import { describe, expect, it } from 'vitest';
import { dropTurnFromJsonl, roleOfJsonlLine } from '../store.js';

// ---------------------------------------------------------------------------
// The host reads stored transcript lines generically in two places —
// `roleOfJsonlLine` (the B3 display/resume divergence detector) and
// `dropTurnFromJsonl` (which backs `conversations:drop-turn`, the hook
// @ax/routines uses to drop a silenced turn). Both originally understood ONE
// shape: the Claude Agent SDK's private jsonl (`{type,uuid,message}`).
//
// With a second runner (`@ax/agent-aisdk-runner`) writing its own
// serialization, a line may instead DECLARE its display role
// (`{role,uuid,message}`). Without that branch, drop-turn matched nothing on
// an aisdk transcript and silently no-op'd — a silenced routine turn would
// survive on resume — and the divergence detector went blind.
//
// These are pure functions, so this suite needs no database (unlike the
// store's testcontainer-backed suites).
// ---------------------------------------------------------------------------

const NL = String.fromCharCode(10);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null): string | null =>
  b === null ? null : new TextDecoder().decode(b);
const doc = (lines: string[]): Uint8Array => enc(lines.join(NL) + NL);

const AISDK_HEADER = '{"v":1,"runner":"aisdk"}';

/** A line in the declared-role shape (`@ax/agent-aisdk-runner`). */
function declared(role: string, uuid: string, text = 'hi'): string {
  return JSON.stringify({
    role,
    uuid,
    message: { role, content: [{ type: 'text', text }] },
  });
}

/** A line in the Claude Agent SDK's jsonl shape. */
function sdk(
  type: string,
  uuid: string,
  content: unknown = [{ type: 'text', text: 'hi' }],
): string {
  return JSON.stringify({
    type,
    uuid,
    message: { id: 'm1', role: type, content },
  });
}

describe('roleOfJsonlLine', () => {
  it('reads a declared role', () => {
    expect(roleOfJsonlLine(declared('assistant', 'a1'))).toBe('assistant');
    expect(roleOfJsonlLine(declared('user', 'u1'))).toBe('user');
    expect(roleOfJsonlLine(declared('tool', 't1'))).toBe('tool');
  });

  it('treats a declared `system` role as a non-display line', () => {
    expect(roleOfJsonlLine(declared('system', 's1'))).toBeNull();
  });

  it('ignores the aisdk header line', () => {
    expect(roleOfJsonlLine(AISDK_HEADER)).toBeNull();
  });

  // The legacy branch must keep working — the claude-sdk runner is not going
  // anywhere, and its transcripts predate the declared-role shape.
  it('still sniffs the Claude SDK jsonl shape', () => {
    expect(roleOfJsonlLine(sdk('assistant', 'a1'))).toBe('assistant');
    expect(roleOfJsonlLine(sdk('user', 'u1'))).toBe('user');
    expect(
      roleOfJsonlLine(
        sdk('user', 'u2', [
          { type: 'tool_result', tool_use_id: 'x', content: 'out' },
        ]),
      ),
    ).toBe('tool');
  });

  it('never throws on untrusted input', () => {
    for (const junk of ['', '   ', 'not json', 'null', '[]', '{"role":"nope"}']) {
      expect(() => roleOfJsonlLine(junk)).not.toThrow();
      expect(roleOfJsonlLine(junk)).toBeNull();
    }
  });
});

describe('dropTurnFromJsonl', () => {
  it('drops a declared-role line by uuid', () => {
    const out = dec(
      dropTurnFromJsonl(
        doc([
          AISDK_HEADER,
          declared('user', 'u1'),
          declared('assistant', 'a1'),
          declared('user', 'u2'),
        ]),
        'a1',
      ),
    );
    expect(out).not.toBeNull();
    expect(out).not.toContain('"uuid":"a1"');
    // Everything else survives, header included.
    expect(out).toContain('"runner":"aisdk"');
    expect(out).toContain('"uuid":"u1"');
    expect(out).toContain('"uuid":"u2"');
  });

  it('drops the most recent declared turn when turnId is empty', () => {
    const out = dec(
      dropTurnFromJsonl(
        doc([AISDK_HEADER, declared('user', 'u1'), declared('assistant', 'a1')]),
        '',
      ),
    );
    expect(out).toContain('"uuid":"u1"');
    expect(out).not.toContain('"uuid":"a1"');
  });

  // A tool line is addressable by an EXPLICIT uuid...
  it('drops a declared tool line by uuid', () => {
    const out = dec(
      dropTurnFromJsonl(
        doc([AISDK_HEADER, declared('assistant', 'a1'), declared('tool', 't1')]),
        't1',
      ),
    );
    expect(out).toContain('"uuid":"a1"');
    expect(out).not.toContain('"uuid":"t1"');
  });

  // ...but it is NOT "the most recent turn". A turn can end on a tool result,
  // and dropping that line alone would strand the preceding assistant message
  // holding a tool-call with no matching result — which the provider rejects on
  // the next request. The empty-turnId scan must skip past it to the assistant.
  it('skips a trailing tool line when dropping the most recent turn', () => {
    const out = dec(
      dropTurnFromJsonl(
        doc([
          AISDK_HEADER,
          declared('user', 'u1'),
          declared('assistant', 'a1'),
          declared('tool', 't1'),
        ]),
        '',
      ),
    );
    // The assistant turn went; the tool line and the user turn stayed.
    expect(out).not.toContain('"uuid":"a1"');
    expect(out).toContain('"uuid":"t1"');
    expect(out).toContain('"uuid":"u1"');
  });

  it('still drops SDK-shaped lines and their coalesced message.id siblings', () => {
    const out = dec(
      dropTurnFromJsonl(
        doc([sdk('user', 'u1'), sdk('assistant', 'a1'), sdk('assistant', 'a2')]),
        'a1',
      ),
    );
    expect(out).toContain('"uuid":"u1"');
    // a2 shares message.id 'm1' with the dropped a1, so it goes too.
    expect(out).not.toContain('"uuid":"a1"');
    expect(out).not.toContain('"uuid":"a2"');
  });

  it('returns null when no line matches (caller skips the rewrite)', () => {
    expect(
      dropTurnFromJsonl(doc([AISDK_HEADER, declared('user', 'u1')]), 'nope'),
    ).toBeNull();
  });

  it('returns null when the transcript holds no turn-bearing line', () => {
    expect(dropTurnFromJsonl(doc([AISDK_HEADER]), '')).toBeNull();
  });
});
