import { toWellFormedText, type Logger } from '@ax/core';
import { COPY } from './copy.js';
import { cleanStatusTitle, cutIndex, neutralizeSlackControls, splitForPost, undecidedTail } from './format.js';
import {
  FLUSH_INTERVAL_MS,
  POST_PART_LIMIT,
  REPLY_RATE_LIMIT_RETRIES,
  RETRY_AFTER_DEFAULT_MS,
  STREAM_MAX_AGE_MS,
  STREAM_TEXT_LIMIT,
} from './limits.js';
import { logCode } from './log-code.js';
import { SlackApiError, type SlackApi, type StreamChunkOut } from './slack-api.js';

/**
 * One agent reply, streamed into a Slack thread (design §5).
 *
 * The turn's chunks arrive through hook subscribers that are never awaited,
 * so `text`, `status` and `artifact` only buffer, synchronously, and arm a
 * flush. The reply's Slack work runs on one promise chain, so exactly one of
 * its calls is in flight and text goes out in the order it came in. 👀 has a
 * queue of its own (add, then remove) that the reply never waits on.
 *
 *   - Text goes as `markdown_text` chunks: Slack renders the Markdown itself.
 *     Model text never pings anyone (format.ts): every `<` before `!`, `@`,
 *     `#` or `&`, every `&` that starts a character reference that could
 *     spell one, and the `@` of `@here`, `@channel` or `@everyone`, whatever
 *     comes before it, gets a zero-width space. Each delta is judged with the
 *     text before it, so a split can't hide one: a `<` that ends a delta gets
 *     its mark at the start of the next, and an `@` or `&` that may start a
 *     broadcast word or a reference waits (at most 8 characters) until the
 *     next text or `finish` decides it, also past a status that arrives
 *     meanwhile, which goes out first. A Slack message's own edges are judged
 *     again as each part goes out, because the reply's text on the other side
 *     of an edge may not reach Slack with it: the start of a message (a new
 *     stream, each posted part), the start of each append (whether Slack
 *     reads a stream's appends as one text is unmeasured; only a `<` ending
 *     the last one carries over), the text after the status card, and where a
 *     full stream or a post is cut (`@channels` cut after `@channel` is a
 *     broadcast in the message it ends). A mark added at an edge can take a
 *     message past STREAM_TEXT_LIMIT or POST_PART_LIMIT by at most three
 *     characters; Slack's own cap (12,000) has room.
 *   - The status line is ONE `task_update` card (id `status`) per stream
 *     message, updated in place, `complete` (or `error`) when the message ends.
 *     `working()` puts 👀 on the owner's message instead (it leaves no trace
 *     in the reply), and shows the card as Working only if Slack refuses it
 *     and no text is out yet.
 *   - The first flush with something to show starts the stream, later ones
 *     append, at most one call per FLUSH_INTERVAL_MS.
 *   - Slack caps a stream at 12,000 characters and 10 minutes. Before a flush
 *     would take this stream past STREAM_TEXT_LIMIT, or once it is
 *     STREAM_MAX_AGE_MS old, we send what fits, stop it (its card `complete`),
 *     and start a new stream in the same thread with the rest, the card again
 *     if the turn is still working. Never `chat.update`.
 *   - `ratelimited`: the same text is sent again after Slack's Retry-After, up
 *     to REPLY_RATE_LIMIT_RETRIES times. Any other stream failure (or a rate
 *     limit that outlasts them) switches the reply to posting: no further
 *     stream call is made, and at `finish` everything Slack never confirmed is
 *     posted with `chat.postMessage` in parts of at most POST_PART_LIMIT. A
 *     stream call that timed out may have landed anyway, so that text can show
 *     twice; nothing is ever dropped.
 *   - `finish` adds the closing lines, in this order: the artifact link once,
 *     the held line once (a call waits for someone's approval; it says whose,
 *     and nothing about the call), the failure or busy line. Then it flushes
 *     and stops the stream. A reply with nothing at all to say, not even a
 *     closing line, posts COPY.emptyReply. It never rejects and runs once.
 *
 * Failures are logged as `slack_reply_failed` with a stage and a code, never
 * text, a token or Slack's words.
 */

export interface ReplyTarget {
  channel: string;
  threadTs: string;
  /** Slack's ids for the person the reply is for: chat.startStream wants them. */
  recipientUserId: string;
  recipientTeamId: string;
}

export type ReplyOutcome = 'complete' | 'error' | 'busy';

export interface ReplyStream {
  text(delta: string): void;
  status(title: string): void;
  /**
   * Show that the agent is on it, before it says anything (a cold start can
   * take seconds): 👀 on the owner's message, taken off once the reply first
   * shows (text, a status card, or the failure line), on a queue the reply
   * never waits on. If Slack refuses the 👀 before any text is out, the
   * Working card instead. Neither replaces the agent's own status, nor counts
   * as something to say.
   */
  working(): void;
  /** The turn made an artifact or a visual: the reply ends with a link to the agent. */
  artifact(): void;
  /**
   * A call of the turn is held until someone approves it, and the reply ends
   * saying who: `'sender'`, the person the reply is for (it waits in their
   * Today, linked), or `'owner'`, someone the reader can't reach (the agent's
   * owner was asked; no link). Said once, however many calls are held (the
   * first hold decides whose), and it counts as something to say.
   */
  held(who: 'owner' | 'sender'): void;
  finish(outcome: ReplyOutcome): Promise<void>;
}

export interface ReplyClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * The real clock. Its timers don't hold the process open: a reply cut short
 * by a shutdown is finalized by Slack itself (decisions: running turns
 * aren't awaited).
 */
export const systemClock: ReplyClock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface ReplyStreamDeps {
  api: SlackApi;
  botToken: string;
  target: ReplyTarget;
  /** The owner's message: 👀 goes on it while the agent works (`working()`). */
  messageTs: string;
  /** Where the artifact line points: the agent's page in the web app. Host-built. */
  agentLink: string;
  /** Where the sender's held line points: Today in the web app. Host-built. */
  todayLink: string;
  logger: Logger;
  clock: ReplyClock;
}

/** The card's one id: the whole status line is one card per message. */
const STATUS_ID = 'status';

type Op = { kind: 'text'; text: string } | { kind: 'status' };

interface OpenStream {
  ts: string;
  startedAt: number;
  /** Markdown characters this stream has been sent. */
  sent: number;
  /** The status card is in this message. */
  card: boolean;
  /**
   * What this message's next text follows: its last character, '' after the
   * card. The next append carries it only if it is a `<` (buildBatch).
   */
  tail: string;
}

/** What one stream call would carry, taken from the front of the buffer. */
interface Batch {
  chunks: StreamChunkOut[];
  /** Ops taken whole from the front. */
  ops: number;
  /** Characters taken from the op after them. */
  chars: number;
  /** Markdown characters in `chunks`. */
  textLength: number;
  card: boolean;
  /** Text was left behind because this stream has no room for it. */
  overflow: boolean;
  /** The message's `tail` once this batch is in it. */
  tail: string;
}

type Stage = 'start' | 'append' | 'stop' | 'post' | 'react' | 'unreact';

/** 👀: "seen it, on it". */
const SEEN_REACTION = 'eyes';

/**
 * Codes where the call may still have been done: our client gave up, or Slack
 * said "it's possible some aspect of the operation succeeded". A remove that
 * finds nothing gets `no_reaction`, which is silent, so erring wide is free;
 * only a refusal for good (`missing_scope`, say) must stay out.
 */
const OUTCOME_UNKNOWN =
  /^(timeout|network|bad-response|http-5\d\d|internal_error|fatal_error|service_unavailable|request_timeout)$/;

function isSlackCode(err: unknown, code: string): boolean {
  return err instanceof SlackApiError && err.code === code;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isRateLimited(err: unknown): err is SlackApiError {
  return err instanceof SlackApiError && err.code === 'ratelimited';
}

export function createReplyStream(d: ReplyStreamDeps): ReplyStream {
  const { api, botToken, target, clock } = d;

  /** Not yet confirmed by Slack, oldest first. Only ever trimmed from the front. */
  const pending: Op[] = [];
  /** The card's latest title. Null until the turn reports any status. */
  let title: string | null = null;
  let artifactSeen = false;
  /** Whose approval a held call waits for. Null until a call is held. */
  let heldBy: 'owner' | 'sender' | null = null;
  let anyText = false;
  /** The agent sent a status of its own (working() alone doesn't count). */
  let agentStatus = false;
  /**
   * Model text not yet decided (`undecidedTail`): an `@` that may start a
   * broadcast word and what followed it, whatever came before the `@`, or an
   * `&` that may start a character reference that spells a mention (`&#`,
   * `&excl`: a `;` may still come). Not in the buffer, so no flush sends it;
   * the next text() or `finish` decides it.
   */
  let waitingText = '';
  /** The reply's decided text, its last character: what the next delta is judged against. */
  let textTail = '';
  let open: OpenStream | null = null;
  let streamsStarted = 0;
  let mode: 'stream' | 'post' = 'stream';
  /** Slack confirmed some text or a card of this reply. */
  let confirmed = false;
  let finished = false;
  let finishing: Promise<void> | null = null;
  let flushTimer: unknown = null;
  let ageTimer: unknown = null;
  let chain: Promise<void> = Promise.resolve();
  /** 👀's own queue: add, then remove, strictly in order. The reply never awaits it. */
  let eyesChain: Promise<void> = Promise.resolve();
  /** 👀 may be on the owner's message: the add succeeded, or its outcome is unknown. */
  let reacted = false;
  /** Taking 👀 off was asked for (it is asked once). */
  let offAsked = false;

  const log = (stage: Stage | 'internal', err: unknown): void => {
    try {
      d.logger.warn('slack_reply_failed', { stage, code: logCode(err) });
    } catch {
      // A log line never changes the reply.
    }
  };

  /** Run `job` after every job before it. Never rejects. */
  const enqueue = (job: () => Promise<void>): Promise<void> => {
    const run = chain.then(job).catch((err: unknown) => log('internal', err));
    chain = run;
    return run;
  };

  const eyes = { channel: target.channel, ts: d.messageTs, name: SEEN_REACTION };

  const onEyes = (job: () => Promise<void>): void => {
    eyesChain = eyesChain.then(job).catch((err: unknown) => log('internal', err));
  };

  /**
   * Take 👀 off: asked once, when the reply has first shown (its stream
   * started or its first post landed) and again at the end, in case nothing
   * could be shown. It goes on 👀's own queue, after the add, so the reply
   * never waits on it. One try: a failure (a rate limit included) is only
   * logged, and `no_reaction` (already gone) isn't one.
   */
  function unreact(): void {
    if (offAsked) return;
    offAsked = true;
    onEyes(async () => {
      // Runs at most once (`offAsked`), after the add has settled.
      if (!reacted) return;
      try {
        await api.removeReaction(botToken, eyes);
      } catch (err) {
        if (!isSlackCode(err, 'no_reaction')) log('unreact', err);
      }
    });
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      clock.setTimeout(resolve, ms);
    });

  const card = (status: 'in_progress' | 'complete' | 'error'): StreamChunkOut => ({
    type: 'task_update',
    id: STATUS_ID,
    title: title ?? COPY.statusDefault,
    status,
  });

  const aged = (): boolean => open !== null && clock.now() - open.startedAt >= STREAM_MAX_AGE_MS;

  function armFlush(): void {
    if (finished || mode !== 'stream' || flushTimer !== null) return;
    flushTimer = clock.setTimeout(() => {
      flushTimer = null;
      void enqueue(() => flush(false));
    }, FLUSH_INTERVAL_MS);
  }

  function armAge(startedAt: number): void {
    disarmAge();
    const wait = Math.max(0, startedAt + STREAM_MAX_AGE_MS - clock.now());
    ageTimer = clock.setTimeout(() => {
      ageTimer = null;
      if (!finished && mode === 'stream') void enqueue(() => flush(false));
    }, wait);
  }

  function disarmAge(): void {
    if (ageTimer !== null) clock.clearTimeout(ageTimer);
    ageTimer = null;
  }

  /**
   * The next call's chunks: what is buffered, in arrival order, with adjacent
   * text merged and every status op in it shown as one card holding the
   * latest title. Text stops where this stream runs out of room. While the
   * reply isn't finished, a trailing high surrogate waits for its other half.
   *
   * Each text chunk is judged again against this message alone (`tail`): a
   * new stream's first text, the text after the card, the text before a
   * full stream's cut and an append's first text are edges where the reply's
   * text around them may not reach Slack with them, so a word the reply
   * judged a name there (`@channels` cut after `@channel`) gets its mark.
   * Anywhere else the text is already decided and nothing changes.
   */
  function buildBatch(final: boolean): Batch {
    let budget = open === null ? STREAM_TEXT_LIMIT : Math.max(0, STREAM_TEXT_LIMIT - open.sent);
    const chunks: StreamChunkOut[] = [];
    let text = '';
    let textLength = 0;
    let hasCard = false;
    let ops = 0;
    let chars = 0;
    let overflow = false;
    // Across an append, only a `<` that ended the last one is carried, so a
    // `!` starting this one gets its mark. That is defense in depth: text()
    // already marked it against the reply's own text, so the carry adds
    // nothing today. Whether Slack reads a stream's appends as one text is
    // unmeasured, so each is an edge, and nothing else before one decides
    // anything at its start (a broadcast word is marked whatever comes
    // before its `@`).
    let tail = open === null ? '' : open.tail.endsWith('<') ? '<' : '';
    const flushText = (): void => {
      if (text.length === 0) return;
      const out = neutralizeSlackControls(text, tail);
      chunks.push({ type: 'markdown_text', text: toWellFormedText(out) });
      textLength += out.length;
      tail = (tail + out).slice(-1);
      text = '';
    };
    const addCard = (): void => {
      chunks.push(card('in_progress'));
      hasCard = true;
      tail = '';
    };
    // A message that continues a reply still being worked on opens with its card.
    if (open === null && streamsStarted > 0 && title !== null) addCard();
    for (let i = 0; i < pending.length; i += 1) {
      const op = pending[i]!;
      if (op.kind === 'status') {
        if (!hasCard) {
          flushText();
          addCard();
        }
        ops = i + 1;
        continue;
      }
      let take = op.text.length;
      if (!final && i === pending.length - 1 && isHighSurrogate(op.text.charCodeAt(take - 1))) take -= 1;
      if (take > budget) {
        take = cutIndex(op.text, budget);
        overflow = true;
      }
      text += op.text.slice(0, take);
      budget -= take;
      if (take < op.text.length) {
        chars = take;
        break;
      }
      ops = i + 1;
    }
    flushText();
    return { chunks, ops, chars, textLength, card: hasCard, overflow, tail };
  }

  /** Slack confirmed `b`: drop it from the front of the buffer. */
  function consume(b: Batch): void {
    pending.splice(0, b.ops);
    const next = pending[0];
    if (b.chars > 0 && next?.kind === 'text') next.text = next.text.slice(b.chars);
    if (b.textLength > 0 || b.card) confirmed = true;
  }

  function toPostMode(stage: Stage, err: unknown): void {
    log(stage, err);
    mode = 'post';
    if (flushTimer !== null) clock.clearTimeout(flushTimer);
    flushTimer = null;
    disarmAge();
  }

  /**
   * One stream call (start or append), sent again after a rate limit with
   * whatever the buffer holds by then. Null when the reply fell back to
   * posting; otherwise the batch Slack confirmed.
   */
  async function send(kind: 'start' | 'append', final: boolean): Promise<Batch | null> {
    for (let attempt = 0; ; attempt += 1) {
      const b = buildBatch(final);
      if (b.chunks.length === 0) return b;
      try {
        if (kind === 'start') {
          const startedAt = clock.now();
          const { ts } = await api.startStream(botToken, { ...target, chunks: b.chunks });
          open = { ts, startedAt, sent: b.textLength, card: b.card, tail: b.tail };
          unreact();
          streamsStarted += 1;
          if (!finished) armAge(startedAt);
        } else {
          const s = open!;
          await api.appendStream(botToken, { channel: target.channel, ts: s.ts, chunks: b.chunks });
          s.sent += b.textLength;
          if (b.card) s.card = true;
          s.tail = b.tail;
        }
        consume(b);
        return b;
      } catch (err) {
        if (isRateLimited(err) && attempt < REPLY_RATE_LIMIT_RETRIES) {
          await sleep(err.retryAfterMs ?? RETRY_AFTER_DEFAULT_MS);
          continue;
        }
        toPostMode(kind, err);
        return null;
      }
    }
  }

  /** Stop the open stream, its card (if it has one) marked `state`. False when it failed. */
  async function stop(state: 'complete' | 'error'): Promise<boolean> {
    const s = open!;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await api.stopStream(botToken, {
          channel: target.channel,
          ts: s.ts,
          ...(s.card ? { chunks: [card(state)] } : {}),
        });
        open = null;
        disarmAge();
        return true;
      } catch (err) {
        if (isRateLimited(err) && attempt < REPLY_RATE_LIMIT_RETRIES) {
          await sleep(err.retryAfterMs ?? RETRY_AFTER_DEFAULT_MS);
          continue;
        }
        toPostMode('stop', err);
        return false;
      }
    }
  }

  /**
   * Send what the buffer holds. A stream that is full or too old is stopped
   * after taking what fits, and the rest starts a new one. `final` sends
   * everything (the reply takes no more text).
   */
  async function flush(final: boolean): Promise<void> {
    while (mode === 'stream') {
      if (open === null) {
        const started = await send('start', final);
        if (started === null || !started.overflow) return;
        continue;
      }
      const rotate = aged();
      const appended = await send('append', final);
      if (appended === null) return;
      if (!appended.overflow) {
        // Room for everything. An old stream still rotates, unless this is
        // the last flush and nothing is left: `finish` stops it right after.
        if (!rotate || (final && pending.length === 0)) return;
      }
      if (!(await stop('complete'))) return;
      // A full stream continues in a new one now. An old one with nothing
      // left to say continues when there is something (or at once with the
      // card, while the turn is still working).
    }
  }

  async function post(markdownText: string): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await api.postMessage(botToken, { channel: target.channel, threadTs: target.threadTs, markdownText });
        unreact();
        return true;
      } catch (err) {
        if (isRateLimited(err) && attempt < REPLY_RATE_LIMIT_RETRIES) {
          await sleep(err.retryAfterMs ?? RETRY_AFTER_DEFAULT_MS);
          continue;
        }
        log('post', err);
        return false;
      }
    }
  }

  /**
   * Posting mode's finish: everything Slack never confirmed, in parts. Each
   * part is a message of its own, so it is judged again alone: a cut (or the
   * stream that went before) can't leave a broadcast word at its edge.
   */
  async function postRest(): Promise<void> {
    const rest = pending.map((op) => (op.kind === 'text' ? op.text : '')).join('');
    pending.length = 0;
    const parts = splitForPost(toWellFormedText(rest), POST_PART_LIMIT)
      .filter((p) => p.trim().length > 0)
      .map((p) => neutralizeSlackControls(p));
    if (parts.length === 0 && !confirmed) parts.push(COPY.emptyReply);
    for (const part of parts) {
      // A failed post (a revoked token, a deleted channel) fails the rest too.
      if (!(await post(part))) return;
    }
  }

  return {
    text(delta) {
      if (finished || typeof delta !== 'string' || delta.length === 0) return;
      anyText = true;
      const text = waitingText + delta;
      const wait = undecidedTail(text);
      waitingText = text.slice(text.length - wait);
      const ready = text.slice(0, text.length - wait);
      if (ready.length === 0) return;
      pending.push({ kind: 'text', text: neutralizeSlackControls(ready, textTail) });
      textTail = (textTail + ready).slice(-1);
      armFlush();
    },

    status(raw) {
      if (finished || typeof raw !== 'string') return;
      agentStatus = true;
      const next = cleanStatusTitle(raw) || COPY.statusDefault;
      if (next === title) return;
      title = next;
      pending.push({ kind: 'status' });
      armFlush();
    },

    working() {
      if (finished) return;
      onEyes(async () => {
        if (offAsked) return;
        try {
          await api.addReaction(botToken, eyes);
          reacted = true;
        } catch (err) {
          // Already there (from this bot): it is on, and comes off as usual.
          if (isSlackCode(err, 'already_reacted')) {
            reacted = true;
            return;
          }
          // We gave up, but Slack may have added it: take it off later anyway.
          if (err instanceof SlackApiError && OUTCOME_UNKNOWN.test(err.code)) reacted = true;
          log('react', err);
          // No 👀: the Working card covers the wait, unless the reply is already showing.
          if (finished || title !== null || anyText) return;
          title = COPY.statusDefault;
          pending.push({ kind: 'status' });
          armFlush();
        }
      });
    },

    artifact() {
      if (finished) return;
      artifactSeen = true;
    },

    held(who) {
      if (finished || heldBy !== null) return;
      heldBy = who;
    },

    finish(outcome) {
      if (finishing !== null) return finishing;
      finished = true;
      if (flushTimer !== null) clock.clearTimeout(flushTimer);
      flushTimer = null;
      // Text that waited for what came next: nothing comes, so the reply's end decides it.
      if (waitingText.length > 0) {
        pending.push({ kind: 'text', text: neutralizeSlackControls(waitingText, textTail) });
        waitingText = '';
      }
      const lines: string[] = [];
      if (artifactSeen) lines.push(COPY.artifactLink(d.agentLink));
      // Only a sender's line links Today: anything else reads as the owner's.
      if (heldBy !== null) lines.push(heldBy === 'sender' ? COPY.heldForSender(d.todayLink) : COPY.heldForOwner);
      if (outcome === 'error') lines.push(COPY.turnFailed);
      if (outcome === 'busy') lines.push(COPY.busy);
      // Only the Working card was shown: say so in that message, not a second one.
      if (!anyText && !agentStatus && title !== null && lines.length === 0) lines.push(COPY.emptyReply);
      if (lines.length > 0) pending.push({ kind: 'text', text: (anyText ? '\n\n' : '') + lines.join('\n\n') });
      const nothing = !anyText && title === null && lines.length === 0;
      finishing = enqueue(async () => {
        try {
          if (nothing) {
            await post(COPY.emptyReply);
            return;
          }
          await flush(true);
          if (mode === 'stream' && open !== null) await stop(outcome === 'complete' ? 'complete' : 'error');
          if (mode === 'post') await postRest();
        } finally {
          disarmAge();
          // Whatever could be shown has been: 👀 comes off (if it isn't already).
          unreact();
        }
      });
      return finishing;
    },
  };
}
