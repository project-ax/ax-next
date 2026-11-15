import type { Logger } from '@ax/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPY } from '../copy.js';
import { cleanPromptSubject } from '../format.js';
import { PROMPT_SUBJECT_MAX, REPLY_RATE_LIMIT_RETRIES } from '../limits.js';
import { postPrompt } from '../prompt-post.js';
import { createPromptRegistry, type PromptContext, type PromptRegistry, type PromptSubject } from '../prompts.js';
import { systemClock } from '../reply-stream.js';
import { SlackApiError, type SlackApi } from '../slack-api.js';
import { fakeBotToken } from './fake-slack-tokens.js';

/*
  Posting an approval prompt (prompt-post.ts `postPrompt`): the prompt is
  opened in the registry, drawn (blocks.ts) and posted in the turn's thread.
  Posted, it is recorded as that message; not posted, nothing is left open,
  so its buttons can't be answered anywhere. Its subject is kept and drawn
  from one string, cut once. Failures are logged by code, and it never
  rejects: the caller ends the reply with the Today link instead.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const BOT_TOKEN = fakeBotToken('PROMPTPOSTTESTSECRET');
const TODAY = 'https://ax.example/workspace';
const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const MEL = 'U07MEL00001';
const SUPPORT = 'C07SUPPORT1';
const THREAD_TS = '1763121600.000100';
/** The ts Slack gives the prompt's message. */
const PROMPT_TS = '1763121660.000200';
/** Call 1 of randomBytes fills 16 bytes with 0x01 (base64url, spelled by hand: prompts.test.ts). */
const FIRST_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';

/** Mel's attended turn in #support that held a call. */
const MEL_SUPPORT: PromptContext = {
  installId: INSTALL_ID,
  teamId: 'T07ABCDEF12',
  channel: SUPPORT,
  threadTs: THREAD_TS,
  askerSlackId: MEL,
  userId: 'usr_mel',
  agentId: 'agt_support',
  conversationId: 'conv_mel_support',
  mode: 'attended',
};
const HELD: PromptSubject = { kind: 'decision', decisionId: 'dec_held' };
const SUMMARY = 'Wants to gain access to a new service or key';

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

type Answer = { ts: string } | Error;

/** A SlackApi whose postBlocks answers `answers` in turn (the last one over and over), recording each call. */
function fakeSlack(answers: Answer[] = [{ ts: PROMPT_TS }]) {
  const calls: Array<{ token: string; args: Record<string, unknown> }> = [];
  const notHere = async (): Promise<never> => {
    throw new Error('posting a prompt must not call this Slack method');
  };
  const api: SlackApi = {
    rotateConfigToken: notHere,
    createApp: notHere,
    deleteApp: notHere,
    setAppIcon: notHere,
    oauthAccess: notHere,
    usersInfo: notHere,
    postMessage: notHere,
    async postBlocks(token, a) {
      calls.push({ token, args: JSON.parse(JSON.stringify(a)) as Record<string, unknown> });
      const answer = answers[Math.min(calls.length, answers.length) - 1]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    updateMessage: notHere,
    postEphemeral: notHere,
    startStream: notHere,
    appendStream: notHere,
    stopStream: notHere,
    addReaction: notHere,
    removeReaction: notHere,
    conversationsInfo: notHere,
    conversationsList: notHere,
    conversationsJoin: notHere,
  };
  return { api, calls };
}

function world(o: { answers?: Answer[]; max?: number; logger?: Logger; todayLink?: string | null } = {}) {
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const recording: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => recording };
  let minted = 0;
  const prompts: PromptRegistry = createPromptRegistry({
    now: () => Date.parse('2026-11-14T12:00:00.000Z'),
    // Call n of randomBytes fills every byte with n.
    randomBytes: (size) => Buffer.alloc(size, ++minted),
    ttlMs: 86_400_000,
    max: o.max ?? 10,
  });
  const slack = fakeSlack(o.answers);
  const post = (c: PromptContext = MEL_SUPPORT, subject: PromptSubject = HELD, text = SUMMARY) =>
    postPrompt(
      {
        api: slack.api,
        botToken: BOT_TOKEN,
        prompts,
        logger: o.logger ?? recording,
        todayLink: o.todayLink === undefined ? TODAY : o.todayLink,
        clock: systemClock,
      },
      c,
      subject,
      text,
    );
  return { prompts, slack, lines, post };
}

/** The `value` of each button in a posted prompt. */
function buttonValues(args: Record<string, unknown>): unknown[] {
  const blocks = args['blocks'] as Array<{ type: string; elements?: Array<Record<string, unknown>> }>;
  return blocks.filter((b) => b.type === 'actions').flatMap((b) => (b.elements ?? []).map((e) => e['value']));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── The tests ───────────────────────────────────────────────────────────────

describe("postPrompt: an approval prompt in the turn's thread", () => {
  it('posted: Slack gets the prompt in the thread, and the registry records it as that message', async () => {
    const w = world();
    expect(await w.post()).toBe(true);

    expect(w.slack.calls).toEqual([
      {
        token: BOT_TOKEN,
        args: {
          channel: SUPPORT,
          threadTs: THREAD_TS,
          text: COPY.heldAsked,
          blocks: [
            { type: 'section', text: { type: 'plain_text', text: SUMMARY, emoji: false } },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: COPY.promptAllow, emoji: false },
                  style: 'primary',
                  action_id: 'ax_prompt_allow',
                  value: FIRST_ID,
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: COPY.promptDeny, emoji: false },
                  action_id: 'ax_prompt_deny',
                  value: FIRST_ID,
                },
              ],
            },
            {
              type: 'context',
              elements: [
                { type: 'mrkdwn', text: COPY.promptOnlyAsker },
                { type: 'mrkdwn', text: COPY.promptToday(TODAY) },
              ],
            },
          ],
        },
      },
    ]);

    // The id both buttons carry is an open prompt, Mel's, for this decision, recorded as the posted message.
    const claim = w.prompts.claim(FIRST_ID, MEL);
    expect(claim).toEqual({
      ok: true,
      prompt: {
        ...MEL_SUPPORT,
        id: FIRST_ID,
        subject: HELD,
        subjectText: SUMMARY,
        messageTs: PROMPT_TS,
        expiresAt: Date.parse('2026-11-15T12:00:00.000Z'),
      },
    });
    expect(w.lines).toEqual([]);
  });

  it("a prompt about something that doesn't wait in Today (a blocked host) links nowhere: only who may answer", async () => {
    const w = world({ todayLink: null });
    const host: PromptSubject = { kind: 'host', host: 'api.example.com', sessionId: 'sess_live' };
    expect(await w.post(MEL_SUPPORT, host, 'Wants to connect to api.example.com')).toBe(true);
    const blocks = w.slack.calls[0]!.args['blocks'] as unknown[];
    expect(blocks.at(-1)).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: COPY.promptOnlyAsker }] });
    expect(JSON.stringify(w.slack.calls)).not.toMatch(/https?:/);
    const claim = w.prompts.claim(FIRST_ID, MEL);
    expect(claim.ok && claim.prompt.subject).toEqual(host);
  });

  it('a subject past PROMPT_SUBJECT_MAX is cut once, before it is kept: the registry and the prompt get the same text', async () => {
    const w = world();
    // 908 characters; the first 300 end inside a word ('Wants to ' x 33, then 'Wan').
    const long = `${'Wants to '.repeat(100)}and more`;
    expect(await w.post(MEL_SUPPORT, HELD, long)).toBe(true);
    const cut = `${'Wants to '.repeat(33)}Wan`;
    expect(cut).toHaveLength(PROMPT_SUBJECT_MAX);

    // Kept raw, but cut: the registry holds no more than a prompt can show.
    const claim = w.prompts.claim(FIRST_ID, MEL);
    expect(claim.ok && claim.prompt.subjectText).toBe(cut);
    // What the prompt shows is that same text (cleaning leaves this one as it is).
    const blocks = w.slack.calls[0]!.args['blocks'] as Array<{ type: string; text?: { text: string } }>;
    expect(blocks[0]!.text!.text).toBe(cut);
  });

  it('a subject cleaning would change is kept raw, and drawn cleaned: the registry never holds the cleaned form', async () => {
    const w = world();
    const zeroWidth = String.fromCharCode(0x200b);
    const raw = `Wants to ping <!channel> &amp; more  ${zeroWidth}things`;
    // Cleaning really does change it, and cleaning twice changes it again (format.ts), which is why it is kept raw.
    expect(cleanPromptSubject(raw)).not.toBe(raw);
    expect(cleanPromptSubject(cleanPromptSubject(raw))).not.toBe(cleanPromptSubject(raw));
    expect(await w.post(MEL_SUPPORT, HELD, raw)).toBe(true);

    const claim = w.prompts.claim(FIRST_ID, MEL);
    expect(claim.ok && claim.prompt.subjectText).toBe(raw);
    const blocks = w.slack.calls[0]!.args['blocks'] as Array<{ type: string; text?: { text: string } }>;
    expect(blocks[0]!.text!.text).toBe(cleanPromptSubject(raw));
  });

  it('Slack refuses the post: no prompt is left open, and the failure is logged by its code', async () => {
    const w = world({ answers: [new SlackApiError('chat.postMessage', 'channel_not_found')] });
    expect(await w.post()).toBe(false);
    expect(w.slack.calls).toHaveLength(1);
    // Nothing anyone could click is open: the id the buttons would have carried is gone.
    expect(w.prompts.size()).toBe(0);
    expect(w.prompts.claim(FIRST_ID, MEL)).toEqual({ ok: false, reason: 'gone' });
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_reply_failed', fields: { installId: INSTALL_ID, stage: 'prompt', code: 'channel_not_found' } },
    ]);
  });

  it('a post that failed with anything else (not a Slack error) is the same: nothing open, logged by code', async () => {
    const w = world({ answers: [new Error(`socket closed carrying ${BOT_TOKEN}`)] });
    expect(await w.post()).toBe(false);
    expect(w.prompts.size()).toBe(0);
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_reply_failed', fields: { installId: INSTALL_ID, stage: 'prompt', code: 'unknown' } },
    ]);
    expect(JSON.stringify(w.lines)).not.toContain(BOT_TOKEN);
  });

  it("rate limited, then posted: sent again after Slack's Retry-After, one prompt open", async () => {
    const w = world({ answers: [new SlackApiError('chat.postMessage', 'ratelimited', 3_000), { ts: PROMPT_TS }] });
    let result: boolean | null = null;
    void w.post().then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(w.slack.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.slack.calls).toHaveLength(2);
    expect(result).toBe(true);
    // The second try carries the same prompt: one id, one open prompt, recorded as the posted message.
    expect(w.slack.calls.map((c) => buttonValues(c.args))).toEqual([
      [FIRST_ID, FIRST_ID],
      [FIRST_ID, FIRST_ID],
    ]);
    expect(w.prompts.size()).toBe(1);
    const claim = w.prompts.claim(FIRST_ID, MEL);
    expect(claim.ok && claim.prompt.messageTs).toBe(PROMPT_TS);
    expect(w.lines).toEqual([]);
  });

  it('rate limited every time: tried REPLY_RATE_LIMIT_RETRIES more times, then given up, with nothing open', async () => {
    const w = world({ answers: [new SlackApiError('chat.postMessage', 'ratelimited', 1_000)] });
    const done = w.post();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await done).toBe(false);
    expect(w.slack.calls).toHaveLength(1 + REPLY_RATE_LIMIT_RETRIES);
    expect(w.prompts.size()).toBe(0);
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_reply_failed', fields: { installId: INSTALL_ID, stage: 'prompt', code: 'ratelimited' } },
    ]);
  });

  it.each([
    // An outsider's turn never gets a prompt: the registry refuses the mode, whatever the type said.
    ['an outsider turn', { ...MEL_SUPPORT, mode: 'external' } as unknown as PromptContext, HELD, 'prompt-mode-refused'],
    ['no asker', { ...MEL_SUPPORT, askerSlackId: '' }, HELD, 'prompt-context-unusable'],
    ['no decision id', MEL_SUPPORT, { kind: 'decision', decisionId: '' } as PromptSubject, 'prompt-subject-unusable'],
  ])('the registry refuses the prompt (%s): nothing is posted, and the refusal is logged by its code', async (_name, c, subject, code) => {
    const w = world();
    expect(await w.post(c, subject)).toBe(false);
    expect(w.slack.calls).toEqual([]);
    expect(w.prompts.size()).toBe(0);
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_reply_failed', fields: { installId: INSTALL_ID, stage: 'prompt', code } },
    ]);
  });

  it('every open prompt is being answered and the registry is full: nothing is posted, logged by code', async () => {
    const w = world({ max: 1 });
    expect(await w.post()).toBe(true);
    // Mel is answering the one open prompt right now, so it can't make room.
    expect(w.prompts.claim(FIRST_ID, MEL).ok).toBe(true);
    expect(await w.post()).toBe(false);
    expect(w.slack.calls).toHaveLength(1);
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_reply_failed', fields: { installId: INSTALL_ID, stage: 'prompt', code: 'prompts-full' } },
    ]);
  });

  it('never rejects: a refused post with a logger that throws is still false, and nothing is left open', async () => {
    const fail = (): never => {
      throw new Error('log down');
    };
    const throwing: Logger = { debug: fail, info: fail, warn: fail, error: fail, child: () => throwing };
    const w = world({ answers: [new SlackApiError('chat.postMessage', 'invalid_blocks')], logger: throwing });
    await expect(w.post()).resolves.toBe(false);
    expect(w.prompts.size()).toBe(0);
  });
});
