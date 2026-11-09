import { describe, expect, it } from 'vitest';
import { appendLiveCall, appendLiveText, liveReplyMessages, type LiveSegment } from '../live-segments';
import type { WorkspaceToolCall } from '../workspace-steps';

const call = (id: string, name = 'Bash'): WorkspaceToolCall => ({ id, name, status: 'done' });

describe('live segments', () => {
  it('cuts the stream where a call lands, the way a reload does', () => {
    let s: LiveSegment[] = [];
    s = appendLiveText(s, 'Sketching ');
    s = appendLiveText(s, 'first.');
    s = appendLiveCall(s, 'a');
    s = appendLiveCall(s, 'b');
    s = appendLiveText(s, 'Done.');
    expect(s).toEqual([
      { text: 'Sketching first.', callIds: ['a', 'b'] },
      { text: 'Done.', callIds: [] },
    ]);
  });

  it('places a replayed call once', () => {
    let s = appendLiveCall([], 'a');
    s = appendLiveText(s, 'More.');
    s = appendLiveCall(s, 'a');
    expect(s).toEqual([
      { text: '', callIds: ['a'] },
      { text: 'More.', callIds: [] },
    ]);
  });

  it('shapes one message per segment, the last one pending-agent', () => {
    const msgs = liveReplyMessages(
      [
        { text: 'Sketching first.', callIds: ['a'] },
        { text: 'Here it is.', callIds: [] },
      ],
      [call('a')],
    );
    expect(msgs.map((m) => [m.kind, m.id, 'text' in m ? m.text : null])).toEqual([
      ['steps', 'pending-agent-0', 'Sketching first.'],
      ['agent', 'pending-agent', 'Here it is.'],
    ]);
  });

  it('keeps a call no segment placed, on the last segment', () => {
    const msgs = liveReplyMessages([{ text: 'Hi.', callIds: [] }], [call('x')]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.kind).toBe('steps');
  });

  it('draws nothing before anything arrived', () => {
    expect(liveReplyMessages([], [])).toEqual([]);
  });
});
