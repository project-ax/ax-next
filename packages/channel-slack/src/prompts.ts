import {
  AGENT_ID_MAX,
  EVENT_TEXT_MAX,
  PROMPT_HOST_MAX,
  PROMPT_ID_BYTES,
  PROMPT_REFUSALS_MAX,
  SLACK_ID_MAX,
} from './limits.js';

/**
 * The approval prompts open now (TASK-1095). When a DM or an attended
 * channel turn needs the person's OK, a prompt is posted in its thread with
 * Allow and Deny (blocks.ts). Both buttons carry only the prompt's id, an
 * opaque value minted here, and this registry maps it back to the turn that
 * asked: the install, channel and thread, the Slack user whose turn it was,
 * the AX user, agent and conversation the turn ran as, and what it asks
 * about. The click gate (answers.ts) decides who may answer from this
 * record, never from anything the clicked message says.
 *
 * A prompt's life:
 *   - `add` before it is posted, then `posted` with the message's ts, or
 *     `remove` when the post failed.
 *   - `claim` when a click on it is handled, one click at a time: another
 *     claim while one is being handled is `busy`, and an id that isn't open
 *     is `gone`. Only the asker's click takes it: anyone else's is
 *     `not-asker` and takes nothing, so a bystander's click can never make
 *     the asker's own click `busy`.
 *   - Then `settle` (answered, or it can't be answered here: gone for good)
 *     or `release` (a failure the asker can retry: open again).
 *
 * The rules it keeps:
 *   - Only a DM or an attended channel turn gets a prompt. `add` throws for
 *     any other mode, whatever the type says: an outsider's turn never has one.
 *   - Every context field is a string no longer than its cap (SLACK_ID_MAX
 *     for Slack's ids, AGENT_ID_MAX for AX's), and the ids that say who may
 *     answer and who the answer runs as (install, asker, user, agent,
 *     conversation) aren't empty. A subject is of a kind something here
 *     answers (a decision, a host, a skill), each of its fields a non-empty
 *     string no longer than its cap (AGENT_ID_MAX for AX's ids and a skill's,
 *     PROMPT_HOST_MAX for a host), and the subject text a string no longer
 *     than a Slack message (EVENT_TEXT_MAX). Else `add` throws. A cheap
 *     backstop: the caller bounds what it hands in, and this registry bounds
 *     how many prompts it keeps, not how big each one is. Whether a host is
 *     one the egress proxy would take is not checked here: the turn checks
 *     before it shows one, and the answer before it acts
 *     (permission-prompts.ts).
 *   - An id is PROMPT_ID_BYTES random bytes, base64url, and no two open
 *     prompts share one: `add` throws rather than hand out an id that is
 *     already open, or one the interactions route would refuse (PROMPT_ID_RE).
 *   - A prompt is a frozen copy of exactly the fields named here. A wider
 *     object handed to `add` leaves the rest behind (a token included), and
 *     nobody holding a prompt can change who may answer it.
 *   - A prompt expires `ttlMs` after it was added, and at most `max` are
 *     open: past that, the oldest one nobody is answering is forgotten. One
 *     being answered is never dropped under its answer by either rule, and
 *     when every open prompt is being answered, `add` throws rather than grow
 *     past `max`. But a taken prompt is held at most `ttlMs` past its
 *     expiry: an answer can outlive its click (answers.ts), and one that
 *     never settles must not keep its prompt, or a slot, forever. Expired prompts are swept on `add`, `claim` and `size`: no
 *     timers, so nothing to unref and nothing to leak.
 *   - What `add` throws is a PromptRegistryError, whose `code` is all a
 *     caller logs (log-code.ts). A caller treats it like a failed post: no
 *     prompt, and the turn's reply keeps its Today link.
 *
 * In memory, like the turn registry and the event dedupe: the chart pins one
 * replica. A restart forgets every open prompt, and a click on one is then
 * pointed at Today.
 */

/**
 * What a prompt asks about. A kind is added with the code that answers it
 * (answers.ts `answers`), never before.
 */
export type PromptSubject =
  // A call held for a person's OK (@ax/decisions).
  | { readonly kind: 'decision'; readonly decisionId: string }
  // A host the sandbox was refused: on Allow, let through for the turn's live session,
  // then kept on the agent's allowed sites for the asker (permission-prompts.ts).
  | { readonly kind: 'host'; readonly host: string; readonly sessionId: string }
  // A catalog skill the agent asked to use, attached for the asker on Allow (permission-prompts.ts).
  | { readonly kind: 'skill'; readonly skillId: string };

/** The turn a prompt belongs to: who may answer it, and who the answer runs as. */
export interface PromptContext {
  readonly installId: string;
  readonly teamId: string;
  readonly channel: string;
  /** The thread the prompt is posted in, where the agent carries on after Allow. */
  readonly threadTs: string;
  /** The Slack user whose turn it was: the only person who may answer. */
  readonly askerSlackId: string;
  /** The AX user the turn ran as: the asker's own account. */
  readonly userId: string;
  readonly agentId: string;
  readonly conversationId: string;
  /** Never 'external': an outsider's turn has no prompts. */
  readonly mode: 'dm' | 'attended';
}

export interface Prompt extends PromptContext {
  readonly id: string;
  readonly subject: PromptSubject;
  /**
   * The subject line exactly as it was handed to `promptBlocks`, so an
   * answer can redraw it with `outcomeBlocks`. Raw, never a cleaned copy:
   * both builders clean it, and cleaned text cleaned again reads differently
   * (blocks.ts).
   */
  readonly subjectText: string;
  /** The prompt message's ts, once `posted` has said it. */
  readonly messageTs: string | null;
  /** Epoch milliseconds. From then on the prompt can't be answered here. */
  readonly expiresAt: number;
}

export type Claim =
  | { ok: true; prompt: Prompt }
  | { ok: false; reason: 'gone' | 'busy' }
  // The clicker isn't the asker. Nothing was taken, so there is nothing to
  // release; the prompt comes back so the gate can check it is this
  // install's and this channel's before it says anything (`firstRefusal`).
  | { ok: false; reason: 'not-asker'; prompt: Prompt };

export interface PromptRegistry {
  /** Open a prompt for the turn `c` describes. Throws a PromptRegistryError when it can't. */
  add(c: PromptContext, subject: PromptSubject, subjectText: string): Prompt;
  /** The prompt was posted as `messageTs`. */
  posted(id: string, messageTs: string): void;
  /** Forget a prompt: its post failed. */
  remove(id: string): void;
  /** Take an open prompt to answer `slackUserId`'s click on it. Only its asker can take it. */
  claim(id: string, slackUserId: string): Claim;
  /** The claimed prompt is answered, or can't be answered here: gone for good. */
  settle(id: string): void;
  /** The claimed prompt wasn't answered: open again. */
  release(id: string): void;
  /** True the first time `slackUserId` is refused on this prompt (one ephemeral each). */
  firstRefusal(id: string, slackUserId: string): boolean;
  /** Prompts open now. */
  size(): number;
}

/** A prompt id, as `add` mints them and both buttons' `value` carries it: 22 base64url characters. */
export const PROMPT_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Why `add` refused. */
export type PromptRefusal =
  | 'prompt-mode-refused'
  | 'prompt-context-unusable'
  | 'prompt-subject-unknown'
  | 'prompt-subject-unusable'
  | 'prompt-text-unusable'
  | 'prompt-id-unusable'
  | 'prompts-full';

export class PromptRegistryError extends Error {
  readonly code: PromptRefusal;
  constructor(code: PromptRefusal) {
    super(`channel-slack prompts: ${code}`);
    this.name = 'PromptRegistryError';
    this.code = code;
  }
}

interface Entry {
  prompt: Prompt;
  /** A click on it is being handled: claimed, and not yet settled or released. */
  busy: boolean;
  /** The Slack users already told it isn't theirs to answer. */
  readonly refused: Set<string>;
}

/** `v`, when it is a string of at least `min` and at most `max` code units. */
function bounded(v: unknown, max: number, code: PromptRefusal, min = 0): string {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw new PromptRegistryError(code);
  return v;
}

/**
 * A copy of exactly the context's fields, once its mode is one a prompt may
 * have and each field is a bounded string. Each field is read once: what is
 * checked is what is kept, whatever a getter would say the second time.
 */
function contextOf(c: PromptContext): PromptContext {
  const mode: unknown = c.mode;
  // The type already says so. A cast mustn't get an outsider's turn past it.
  if (mode !== 'dm' && mode !== 'attended') throw new PromptRegistryError('prompt-mode-refused');
  const field = (v: unknown, max: number) => bounded(v, max, 'prompt-context-unusable');
  // Who may answer, and who the answer runs as: never empty.
  const id = (v: unknown, max: number) => bounded(v, max, 'prompt-context-unusable', 1);
  return {
    installId: id(c.installId, AGENT_ID_MAX),
    teamId: field(c.teamId, SLACK_ID_MAX),
    channel: field(c.channel, SLACK_ID_MAX),
    threadTs: field(c.threadTs, SLACK_ID_MAX),
    askerSlackId: id(c.askerSlackId, SLACK_ID_MAX),
    userId: id(c.userId, AGENT_ID_MAX),
    agentId: id(c.agentId, AGENT_ID_MAX),
    conversationId: id(c.conversationId, AGENT_ID_MAX),
    mode,
  };
}

/** A frozen copy of exactly the fields of the subject's kind, each a non-empty bounded string. */
function subjectOf(s: PromptSubject): PromptSubject {
  const field = (v: unknown, max: number) => bounded(v, max, 'prompt-subject-unusable', 1);
  switch (s.kind) {
    case 'decision':
      return Object.freeze({ kind: 'decision', decisionId: field(s.decisionId, AGENT_ID_MAX) });
    case 'host':
      return Object.freeze({
        kind: 'host',
        host: field(s.host, PROMPT_HOST_MAX),
        sessionId: field(s.sessionId, AGENT_ID_MAX),
      });
    case 'skill':
      return Object.freeze({ kind: 'skill', skillId: field(s.skillId, AGENT_ID_MAX) });
    default:
      // The type names every kind. A cast mustn't get one nothing here answers past it.
      throw new PromptRegistryError('prompt-subject-unknown');
  }
}

export function createPromptRegistry(o: {
  /** Epoch milliseconds. */
  now: () => number;
  randomBytes: (size: number) => Buffer;
  ttlMs: number;
  max: number;
}): PromptRegistry {
  if (!Number.isSafeInteger(o.ttlMs) || o.ttlMs <= 0 || !Number.isSafeInteger(o.max) || o.max <= 0) {
    throw new RangeError('createPromptRegistry: ttlMs and max must be positive integers');
  }
  const { now, randomBytes, ttlMs, max } = o;
  /** id -> its prompt. Insertion order is age. */
  const entries = new Map<string, Entry>();

  /**
   * Drop every expired prompt nobody is answering: every one, not just the
   * oldest, as the clock can step back. One being answered stays under its
   * answer, but not forever: a whole TTL past its expiry, it goes too.
   */
  function sweep(nowMs: number): void {
    for (const [id, entry] of entries) {
      const expiresAt = entry.prompt.expiresAt;
      if (nowMs >= (entry.busy ? expiresAt + ttlMs : expiresAt)) entries.delete(id);
    }
  }

  /** The oldest prompt nobody is answering. */
  function oldestIdle(): string | undefined {
    for (const [id, entry] of entries) {
      if (!entry.busy) return id;
    }
    return undefined;
  }

  function forget(id: string): void {
    entries.delete(id);
  }

  return {
    add(c, subject, subjectText) {
      const context = contextOf(c);
      const kept = subjectOf(subject);
      // Kept raw: both draws clean it themselves (blocks.ts).
      const text = bounded(subjectText, EVENT_TEXT_MAX, 'prompt-text-unusable');
      const nowMs = now();
      sweep(nowMs);
      const id = randomBytes(PROMPT_ID_BYTES).toString('base64url');
      if (!PROMPT_ID_RE.test(id) || entries.has(id)) throw new PromptRegistryError('prompt-id-unusable');
      while (entries.size >= max) {
        const oldest = oldestIdle();
        if (oldest === undefined) throw new PromptRegistryError('prompts-full');
        entries.delete(oldest);
      }
      const prompt: Prompt = Object.freeze({
        ...context,
        id,
        subject: kept,
        subjectText: text,
        messageTs: null,
        expiresAt: nowMs + ttlMs,
      });
      entries.set(id, { prompt, busy: false, refused: new Set() });
      return prompt;
    },

    posted(id, messageTs) {
      const entry = entries.get(id);
      if (entry !== undefined) entry.prompt = Object.freeze({ ...entry.prompt, messageTs });
    },

    remove: forget,

    claim(id, slackUserId) {
      sweep(now());
      const entry = entries.get(id);
      if (entry === undefined) return { ok: false, reason: 'gone' };
      // Before the lock: only the asker may ever hold it.
      if (slackUserId !== entry.prompt.askerSlackId) return { ok: false, reason: 'not-asker', prompt: entry.prompt };
      if (entry.busy) return { ok: false, reason: 'busy' };
      entry.busy = true;
      return { ok: true, prompt: entry.prompt };
    },

    settle: forget,

    release(id) {
      const entry = entries.get(id);
      if (entry !== undefined) entry.busy = false;
    },

    firstRefusal(id, slackUserId) {
      const entry = entries.get(id);
      if (entry === undefined || entry.refused.has(slackUserId) || entry.refused.size >= PROMPT_REFUSALS_MAX) {
        return false;
      }
      entry.refused.add(slackUserId);
      return true;
    },

    size() {
      sweep(now());
      return entries.size;
    },
  };
}
