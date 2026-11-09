/**
 * reply-groups — one reply, drawn in the order it happened.
 *
 * The thread arrives as one message per stored turn. A reply that used tools
 * is several of them: an assistant turn of words + tool calls ("Let me look
 * at the repo"), a tool turn carrying any artifact card or file it made, more
 * of the same, and finally the answer.
 *
 * So a run of consecutive agent messages (`agent` / `steps`, nothing from the
 * person or an approval between them) that ran at least one tool becomes ONE
 * reply whose `parts` alternate, the way Claude draws it:
 *
 *   * a step block: one stretch of tool calls, collapsed under its own title;
 *   * a message: what the agent said between them, as a normal chat message.
 *
 * Words are never folded into a panel: a message the agent wrote mid-reply is
 * drawn where it wrote it, and the next calls start a new block below it.
 * The deliverables (visuals, artifact cards, files) come from every message
 * in the run; artifact cards sit right after the last step block.
 *
 * A run with no steps is left exactly as it was.
 *
 * WHAT THE LIVE TURN GETS. The live wire has no turn boundaries, so the view
 * cuts the stream where a reload would (`lib/live-segments`): one message per
 * "text, then the calls after it". It groups exactly like a stored run, so
 * nothing moves when the turn ends.
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
  /**
   * `intent` marks the host's one-line summary of what a step set out to do,
   * drawn as plain text: it is a model's words about a model's reasoning, and
   * it never gets markdown (a link in it would be a link nobody wrote).
   */
  | { kind: 'note'; turnId: string; text: string; intent?: true }
  | { kind: 'step'; step: WorkspaceStep };

/** A reply that ran tools, folded out of its turns. */
/** One stretch of a reply: a block of steps, or something the agent said. */
export type ReplyPart =
  | { kind: 'activity'; entries: ActivityEntry[] }
  | { kind: 'text'; turnId: string; text: string };

export interface ReplyGroup {
  kind: 'reply';
  /** The answer's turn id when it has one, else the run's last. A React key. */
  id: string;
  /** Every turn folded in — so a source link to any of them still lands here. */
  turnIds: string[];
  /** The reply in order: step blocks and messages, alternating. */
  parts: ReplyPart[];
  /** Every step block's entries, flattened. */
  activity: ActivityEntry[];
  /** The last thing it said, when nothing came after it; else ''. */
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
  // In the order it happened: what the agent said is a chat message where it
  // said it, and each stretch of tool calls between two messages is its own
  // step block with its own title (Vinay, 2026-11-08, from Claude). A stored
  // `steps` message's words came BEFORE its calls, so they go first.
  const parts: ReplyPart[] = [];
  for (const m of run) {
    // Whitespace is not something it said: the stream can carry a bare "\n\n"
    // between two calls, and counting it split one block into several.
    if (m.text.trim().length > 0) parts.push({ kind: 'text', turnId: m.id, text: m.text });
    if (m.kind !== 'steps' || m.steps.length === 0) continue;
    let block = parts[parts.length - 1];
    if (block?.kind !== 'activity') {
      block = { kind: 'activity', entries: [] };
      parts.push(block);
    }
    for (const step of m.steps) {
      if (step.intent !== undefined) block.entries.push({ kind: 'note', turnId: m.id, text: step.intent, intent: true });
      block.entries.push({ kind: 'step', step });
    }
  }
  const lastPart = parts[parts.length - 1];
  const answer = lastPart?.kind === 'text' ? lastPart : undefined;
  const lastSaid = [...parts].reverse().find((p): p is Extract<ReplyPart, { kind: 'text' }> => p.kind === 'text');
  const activity = parts.flatMap((p) => (p.kind === 'activity' ? p.entries : []));

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

  const last = run[run.length - 1]!;
  return {
    kind: 'reply',
    // What it last SAID names the reply (a memory source points at words),
    // even when a silent step block came after them.
    id: lastSaid?.turnId ?? last.id,
    turnIds: run.map((m) => m.id),
    parts,
    activity,
    text: answer?.text ?? '',
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
