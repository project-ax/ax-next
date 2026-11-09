/**
 * reply-groups — one reply, drawn as "what it did" ABOVE "what it said".
 *
 * The thread arrives as one message per stored turn. A reply that used tools
 * is several of them: an assistant turn of narration + tool calls ("Let me
 * look at the repo"), a tool turn carrying any artifact card or file it made,
 * more of the same, and finally the answer. Drawn one by one, that put a step
 * panel under each chunk of prose and the panels of later turns BELOW the
 * artifact card they produced — the work after the result.
 *
 * So a run of consecutive agent messages (`agent` / `steps`, nothing from the
 * person or an approval between them) that ran at least one tool becomes ONE
 * reply:
 *
 *   * `activity` — every step of the run in order, with the narration that
 *     came between them as `note`s. The panel above the reply holds it.
 *   * `text` — the answer: the last thing the agent said in the run. Usually
 *     that comes after its last tool call; when it went quiet after (it
 *     answered, then saved a note to memory), its last words still are.
 *   * the deliverables — visuals, artifact cards, files — from every message
 *     in the run, under the answer.
 *
 * A run with no steps is left exactly as it was.
 *
 * WHAT THE LIVE TURN GETS. The live wire has no turn boundaries, so the
 * view cuts the stream where a reload would (`lib/live-segments`): one message
 * per "text, then the calls after it". It groups like any other run, with one
 * difference: while it streams, only text after the last call is the answer.
 */
import type {
  MemoryUsed,
  ThreadArtifact,
  ThreadAttachment,
  ThreadMessage,
  ThreadVisual,
} from './workspace-types';
import type { WorkspaceStep } from './workspace-steps';

/** One line of a reply's activity, in the order it happened. */
export type ActivityEntry =
  | { kind: 'note'; turnId: string; text: string }
  | { kind: 'step'; step: WorkspaceStep };

/** A reply that ran tools, folded out of its turns. */
export interface ReplyGroup {
  kind: 'reply';
  /** The answer's turn id when it has one, else the run's last. A React key. */
  id: string;
  /** Every turn folded in — so a source link to any of them still lands here. */
  turnIds: string[];
  activity: ActivityEntry[];
  text: string;
  /** The last message's instant — `''` while the reply is still streaming. */
  at: string;
  visuals: ThreadVisual[];
  artifacts: ThreadArtifact[];
  attachments: ThreadAttachment[];
  memoryUsed?: MemoryUsed;
}

export type ThreadItem = { kind: 'message'; message: ThreadMessage } | ReplyGroup;

type AgentLike = Extract<ThreadMessage, { kind: 'agent' } | { kind: 'steps' }>;

function isAgentLike(m: ThreadMessage): m is AgentLike {
  return m.kind === 'agent' || m.kind === 'steps';
}

function fold(run: AgentLike[]): ReplyGroup {
  // The answer is the last thing the agent SAID in the reply. Usually that is
  // the turn after its last tool call; when it went quiet after (narrated,
  // published, stopped — or answered, then saved a note to memory), it is the
  // last words it did write. Everything said before that is narration.
  //
  // Not while it streams. Live, words followed by a call are narration the
  // moment the call lands, so the reply is only what it is saying after its
  // LAST call — the trailing `agent` segment, if it has started one.
  const last = run[run.length - 1]!;
  let answerAt = -1;
  if (last.at === '') {
    // After the last `steps` message: the trailing words, if any. A live
    // card or visual rides on a text-less `agent` message after them.
    let lastSteps = -1;
    run.forEach((m, i) => {
      if (m.kind === 'steps') lastSteps = i;
    });
    run.forEach((m, i) => {
      if (i > lastSteps && m.kind === 'agent' && m.text.length > 0) answerAt = i;
    });
  } else {
    run.forEach((m, i) => {
      if (m.text.length > 0) answerAt = i;
    });
  }
  const text = answerAt === -1 ? '' : run[answerAt]!.text;

  const activity: ActivityEntry[] = [];
  run.forEach((m, i) => {
    if (m.text.length > 0 && i !== answerAt) activity.push({ kind: 'note', turnId: m.id, text: m.text });
    if (m.kind === 'steps') for (const step of m.steps) activity.push({ kind: 'step', step });
  });

  const visuals = new Map<string, ThreadVisual>();
  const artifacts = new Map<string, ThreadArtifact>();
  const attachments: ThreadAttachment[] = [];
  let memoryUsed: MemoryUsed | undefined;
  for (const m of run) {
    if (m.kind === 'agent') {
      for (const v of m.visuals ?? []) visuals.set(v.artifactId, v);
      // Highest version wins when a reply republished the same artifact.
      for (const a of m.artifacts ?? []) {
        const prev = artifacts.get(a.artifactId);
        if (prev === undefined || a.version >= prev.version) artifacts.set(a.artifactId, a);
      }
    }
    attachments.push(...(m.attachments ?? []));
    if (m.memoryUsed !== undefined && m.memoryUsed.statements.length > 0) memoryUsed = m.memoryUsed;
  }

  return {
    kind: 'reply',
    id: (answerAt === -1 ? last : run[answerAt]!).id,
    turnIds: run.map((m) => m.id),
    activity,
    text,
    at: last.at,
    visuals: [...visuals.values()],
    artifacts: [...artifacts.values()],
    attachments,
    ...(memoryUsed !== undefined ? { memoryUsed } : {}),
  };
}

/** The thread as the conversation draws it. See the header. */
export function groupReplies(thread: readonly ThreadMessage[]): ThreadItem[] {
  const out: ThreadItem[] = [];
  let run: AgentLike[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.some((m) => m.kind === 'steps')) out.push(fold(run));
    else for (const message of run) out.push({ kind: 'message', message });
    run = [];
  };
  for (const m of thread) {
    if (isAgentLike(m)) {
      run.push(m);
      continue;
    }
    flush();
    out.push({ kind: 'message', message: m });
  }
  flush();
  return out;
}

/**
 * What the agent last SAID it was doing, as the live title: "Working out the
 * leg motion with a script." The first line of its latest note, without the
 * markdown. It stands for the steps that follow it, but not forever: after a
 * few more steps with no new words, the step itself says more than a sentence
 * written several calls ago.
 */
const NOTE_HOLDS_FOR_STEPS = 3;

export function liveNote(entries: readonly ActivityEntry[]): string | undefined {
  let stepsSince = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === 'step') {
      stepsSince += 1;
      if (stepsSince > NOTE_HOLDS_FOR_STEPS) return undefined;
      continue;
    }
    const line = e.text
      .split('\n')
      .map((l) => l.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '').replace(/[*_`]/g, '').trim())
      .find((l) => l.length > 0);
    if (line !== undefined) return line.length > 200 ? `${line.slice(0, 199)}…` : line;
  }
  return undefined;
}
