/**
 * live-segments — the streaming reply, cut where a reload would cut it.
 *
 * The wire sends text chunks and tool calls interleaved but carries no turn
 * boundaries, so the live reply used to be ONE message holding all of its
 * prose. Everything the agent said between tool calls ("Let me sketch the
 * frame first") streamed in as the reply body, then jumped into the activity
 * panel when the turn ended and the re-read brought the stored turns back.
 *
 * A segment is what the stored thread calls a turn: some text, then the calls
 * that followed it. Text arriving after a call opens the next segment. Shaped
 * into messages, the live reply groups exactly like the reloaded one: what the
 * agent said before a call is narration (a note, and the live title), and
 * only what it is saying after its last call is the reply.
 */
import type { ConnectorNames } from './connector-tool-label.js';
import type { ThreadMessage } from './workspace-types.js';
import { shapeSteps, type WorkspaceToolCall } from './workspace-steps.js';

export interface LiveSegment {
  text: string;
  callIds: readonly string[];
}

/** A text chunk joins the open segment, or opens one after a call. */
export function appendLiveText(segments: readonly LiveSegment[], chunk: string): LiveSegment[] {
  const last = segments[segments.length - 1];
  if (last === undefined || last.callIds.length > 0) return [...segments, { text: chunk, callIds: [] }];
  return [...segments.slice(0, -1), { ...last, text: last.text + chunk }];
}

/** A call closes the open segment's text. A replayed call is already placed. */
export function appendLiveCall(segments: readonly LiveSegment[], callId: string): LiveSegment[] {
  if (segments.some((s) => s.callIds.includes(callId))) return [...segments];
  const last = segments[segments.length - 1];
  if (last === undefined) return [{ text: '', callIds: [callId] }];
  return [...segments.slice(0, -1), { ...last, callIds: [...last.callIds, callId] }];
}

/**
 * The live reply as thread messages: one per segment, `steps` when its calls
 * shaped into rows, `agent` otherwise. The last keeps the id `pending-agent`.
 * A call no segment placed (it cannot happen on the wire; a guard) goes with
 * the last segment rather than vanishing.
 */
export function liveReplyMessages(
  segments: readonly LiveSegment[],
  calls: readonly WorkspaceToolCall[],
  connectors?: ConnectorNames,
): ThreadMessage[] {
  const placed = new Set(segments.flatMap((s) => s.callIds));
  const orphans = calls.filter((c) => !placed.has(c.id)).map((c) => c.id);
  const segs: LiveSegment[] =
    orphans.length === 0
      ? [...segments]
      : segments.length === 0
        ? [{ text: '', callIds: orphans }]
        : [
            ...segments.slice(0, -1),
            { ...segments[segments.length - 1]!, callIds: [...segments[segments.length - 1]!.callIds, ...orphans] },
          ];
  const out: ThreadMessage[] = [];
  segs.forEach((seg, i) => {
    const id = i === segs.length - 1 ? 'pending-agent' : `pending-agent-${i}`;
    const ids = new Set(seg.callIds);
    const panel = shapeSteps(
      calls.filter((c) => ids.has(c.id)),
      connectors,
    );
    if (panel !== null) {
      out.push({ kind: 'steps', id, text: seg.text, at: '', stepsLabel: panel.label, steps: panel.steps });
    } else if (seg.text.length > 0) {
      out.push({ kind: 'agent', id, text: seg.text, at: '' });
    }
  });
  return out;
}
