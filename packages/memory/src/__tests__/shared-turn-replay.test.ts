import Database from 'better-sqlite3';
import type { AgentContext, LlmCallInput, LlmCallOutput } from '@ax/core';
import { afterEach, describe, expect, it } from 'vitest';

import { MEMORY_RECALL_TOOL_HOOK } from '../recall-tool.js';
import { ALICE, answerSpeakerNames, BOB, makeMemoryHarness, type MemoryHarness } from './harness.js';

/**
 * TASK-1198: walk TASK-1192's shared Slack turns, replayed.
 *
 * The turns are the walk's own transcripts (kind, 2026-11-22, Fern in
 * #walk-two-bots). The extractor replies are what the REAL pinned extractor
 * (`z-ai/glm-5.3-flash:nitro`) returned for those turns on 2026-11-22 (5
 * trials per turn; one representative reply each), with `network`,
 * `validStart` and `invalidatesPrevious` filled in by the stub. The bot turn's
 * is the walk's own stored row instead (the replay wrote
 * `lacks_slack_messaging_capability`, pinned in `self-report.test.ts`). The
 * suite never calls a model, so the replies are pinned here.
 *
 * What the replay measured:
 *
 * - The standup turn. The extractor files "our team standup is at 9:30 every
 *   weekday" under the speaker's label name, `vinay`, in 5 of 5 trials. Before
 *   TASK-1204 the speaker rule dropped it (the walk's log for that session:
 *   `skipped`, `only-speaker-facts`, `speakerFacts: 1`; the walk's "recorded 1"
 *   was a different session's echo). Under TASK-1204 a team agent's member
 *   turn files it under the member's own key, and every member's turn reads
 *   it, and since TASK-1209 so does an outsider's.
 * - The echo turns. "reply with exactly: hello <!channel>, testing" came back
 *   as `assistant | replied_with | hello <!channel>, testing` in 4 of 5 trials
 *   (and `replied_with` in 2 of 5 for "alpha beta gamma"). The act of replying
 *   is now narration, dropped like the rest (`self-report.ts`).
 *
 * TASK-1210 replayed the walk again (2026-11-23, same extractor, 5 trials per
 * thread, from kind's transcripts) and pinned more of what it wrote about the
 * turn itself, all dropped now: the agent's memory misses ("has no record of
 * his favorite color", and `vinay | team_standup_time | no team standup time
 * is on record for vinay's team`, filed under the real standup time's very
 * predicate), its request to its admin (`requested_admin_capability`), and
 * the speaker's request narration (`requested_exact_reply`,
 * `instructed_assistant | … reply with exactly …`, `slack_user_id`). The
 * standup question's reply comes from a replay of its full thread; the
 * walk's thread had a second exchange ("check your memory") that isn't
 * replayed here.
 */

let harness: MemoryHarness | undefined;
afterEach(async () => {
  unmatched.length = 0;
  await harness?.teardown();
  harness = undefined;
});

/** Vinay is the member talking; Bob is a teammate. */
const VINAY = ALICE;
const VINAY_LABEL = ['vinay', 'UHTE83XE1'];
const AUGMENT_HOOK = 'system-prompt:augment:optional:memory';
const WHEN = '2026-11-22T10:35:51.000Z';

const STANDUP_TURN = [
  {
    role: 'user',
    content: '[Slack · #walk-two-bots · vinay (UHTE83XE1)]: @[Fern (you)] our team standup is at 9:30 every weekday',
  },
  {
    role: 'assistant',
    content:
      "Thanks for the heads up, vinay! Good to know your team standup is at 9:30 every weekday.\n\nIs there something specific you'd like me to do with that? For example:\n- **Set up a daily reminder** before the standup (e.g. at 9:15 or 9:25)?\n- **Help you prep** a standup summary each morning?\n- Just keeping it in mind as context for future requests?",
  },
];
const ECHO_TURN = [
  {
    role: 'user',
    content: '[Slack · #walk-two-bots · vinay (UHTE83XE1)]: @[Fern (you)] reply with exactly these lines: hello <!channel>, testing',
  },
  { role: 'assistant', content: 'hello <!channel>, testing' },
];
const ALPHA_TURN = [
  {
    role: 'user',
    content:
      '[Slack · #walk-two-bots · vinay (UHTE83XE1)]: @[Fern (you)] reply with exactly these three words and nothing else: alpha beta gamma.',
  },
  { role: 'assistant', content: 'alpha beta gamma.' },
];
const COLOR_QUESTION_TURN = [
  { role: 'user', content: '[Slack · #walk-two-bots · vinay (UHTE83XE1)]: @[Fern (you)] what’s my favorite color?' },
  {
    role: 'assistant',
    content:
      "I don't have any record of your favorite color — it hasn't come up in our conversations before! What is it? I'll make a note for the future.",
  },
];
const STANDUP_QUESTION_TURN = [
  { role: 'user', content: '[Slack · #walk-two-bots · vinay (UHTE83XE1)]: @[Fern (you)] when is our team standup?' },
  {
    role: 'assistant',
    content:
      "I don't have your team standup time on file — I don't have access to your calendar yet, so I can't look it up directly.\n\nA couple of ways I can help:\n\n1. **Tell me now** — let me know the time and I'll remember it for future questions.\n2. **Connect your calendar** — if you'd like me to check your Google Calendar or Outlook, I can request that access. Just say the word and I'll get it set up.",
  },
];
const BOT_TURN = [
  {
    role: 'user',
    content: '[Slack · #walk-two-bots · vinay (UHTE83XE1)]: @[Fern (you)] ask @[moss] what its favorite color is',
  },
  {
    role: 'assistant',
    content:
      "I still don't have the ability to send Slack messages, so I can't ping @[moss] directly. I asked my admin to add that capability in a previous conversation.",
  },
];

/**
 * The extractor's replies: subject, predicate and object as it wrote them.
 * Each marker is in its own thread's prompt alone.
 */
const REPLIES: Array<[marker: string, facts: Array<Record<string, string>>]> = [
  [
    'our team standup is at',
    [{ subject: 'vinay', predicate: 'team_standup_time', object: 'Team standup is at 9:30 every weekday' }],
  ],
  [
    'hello <!channel>',
    [
      {
        subject: 'vinay',
        predicate: 'requested_exact_reply',
        object: 'In Slack #walk-two-bots, vinay (UHTE83XE1) asked Fern to reply with exactly these lines: hello <!channel>, testing',
      },
      { subject: 'assistant', predicate: 'replied_with', object: 'hello <!channel>, testing' },
      // TASK-1210 replay.
      {
        subject: 'vinay',
        predicate: 'slack_user_id',
        object: 'UHTE83XE1 (Slack user ID, interacts with Fern bot in Slack)',
      },
    ],
  ],
  [
    'alpha beta gamma',
    [
      {
        subject: 'assistant',
        predicate: 'replied_with',
        object: 'Replied with exactly the three words "alpha beta gamma" as requested by vinay in Slack channel #walk-two-bots',
      },
      // TASK-1210 replay: 3 of 5 trials.
      {
        subject: 'vinay',
        predicate: 'instructed_assistant',
        object:
          'In Slack #walk-two-bots, vinay (UHTE83XE1) instructed Fern to reply with exactly these three words and nothing else: alpha beta gamma.',
      },
    ],
  ],
  [
    // TASK-1210 replay: the memory miss, 5 of 5 trials.
    'my favorite color?',
    [
      {
        subject: 'assistant',
        predicate: 'stated_no_record',
        object:
          'Assistant told vinay it has no record of his favorite color, as it had not come up in their conversations before',
      },
      {
        subject: 'assistant',
        predicate: 'stated',
        object:
          "No record of vinay's favorite color exists in prior conversations; assistant asked vinay to share it so it could be noted for the future.",
      },
      { subject: 'vinay', predicate: 'slack_identity', object: 'Slack user ID UHTE83XE1, messaging in the #walk-two-bots channel' },
    ],
  ],
  [
    // TASK-1210 replay: the memory miss, under the speaker or the assistant.
    'when is our team standup',
    [
      { subject: 'vinay', predicate: 'team_standup_time', object: "no team standup time is on record for vinay's team" },
      {
        subject: 'assistant',
        predicate: 'stated',
        object: 'No team standup time is on record for vinay, and the assistant has no calendar access to look it up',
      },
    ],
  ],
  [
    'ask @[moss]',
    [
      // The walk's own row, from this turn (kind, 10:33:47).
      {
        subject: 'assistant',
        predicate: 'lacks_capability',
        object: 'Cannot send Slack messages or ping other users/bots (e.g. @moss) directly; capability request submitted to admin',
      },
      // TASK-1210 replay: 2 of 5 trials, and `requested_capability` once.
      {
        subject: 'assistant',
        predicate: 'requested_admin_capability',
        object:
          'The assistant asked its admin in a previous conversation to add the capability to send Slack messages, pending approval',
      },
    ],
  ],
];

/** Extraction prompts no pinned reply matched, for `replayWalk` to refuse. */
const unmatched: string[] = [];

function extractor(input: LlmCallInput): LlmCallOutput {
  const prompt = String(input.messages[0]?.content ?? '');
  const facts = REPLIES.find(([marker]) => prompt.includes(marker))?.[1];
  // A turn no reply matches would extract nothing, and every "not stored"
  // assertion below would pass for nothing. Counted rather than thrown: the
  // observer catches a throw and logs it, which would pass for nothing too.
  if (facts === undefined) unmatched.push(prompt.slice(-200));
  return {
    text: JSON.stringify({
      facts: (facts ?? []).map((f) => ({ network: 'world', validStart: WHEN, invalidatesPrevious: false, ...f })),
    }),
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

/** A member's turn in the team agent's channel: it runs as them, and the room reads the reply. */
function channelTurn(h: MemoryHarness, userId: string, conversationId: string): AgentContext {
  return h.ctx({ userId, conversationId, source: 'user', audience: 'shared' });
}

async function observeTurn(h: MemoryHarness, ctx: AgentContext, messages: unknown[]): Promise<void> {
  await h.bus.fire('chat:end', ctx, { outcome: { kind: 'complete', messages } });
  await h.settleObserver();
}

function storedRows(h: MemoryHarness): Array<{ about: string; relation: string; value: string; audience: string }> {
  const db = new Database(h.databasePath, { readonly: true });
  try {
    return db.prepare('SELECT about, relation, value, audience FROM memory_facts_v1 ORDER BY rowid').all() as never;
  } finally {
    db.close();
  }
}

async function augment(h: MemoryHarness, ctx: AgentContext): Promise<string> {
  const out = await h.bus.call<Record<string, never>, { recall?: string }>(AUGMENT_HOOK, ctx, {});
  return out.recall ?? '';
}

function recallTool(h: MemoryHarness, ctx: AgentContext, query: string): Promise<string> {
  return h.bus.call<{ input: unknown }, string>(MEMORY_RECALL_TOOL_HOOK, ctx, { input: { query } });
}

/** The walk: four channel threads, each its own conversation, all Vinay's. */
async function replayWalk(): Promise<MemoryHarness> {
  const h = await makeMemoryHarness({}, { agent: { visibility: 'team' }, llm: extractor });
  harness = h;
  const threads: Array<[string, unknown[]]> = [
    ['conv-bot', BOT_TURN],
    ['conv-standup', STANDUP_TURN],
    ['conv-alpha', ALPHA_TURN],
    ['conv-echo', ECHO_TURN],
    ['conv-color-question', COLOR_QUESTION_TURN],
    ['conv-standup-question', STANDUP_QUESTION_TURN],
  ];
  for (const [conversationId] of threads) answerSpeakerNames(h.bus, VINAY_LABEL, conversationId);
  for (const [conversationId, turn] of threads) await observeTurn(h, channelTurn(h, VINAY, conversationId), turn);
  // One extraction per thread, and each one matched its pinned reply.
  expect(h.llmCalls).toHaveLength(threads.length);
  expect(unmatched).toEqual([]);
  return h;
}

describe('walk TASK-1192 replayed: a team fact said in a channel is kept, the agent\'s own replies are not (TASK-1198)', () => {
  it('keeps the standup, filed under the member who said it, stamped with the channel turn', async () => {
    const h = await replayWalk();
    expect(storedRows(h).filter((r) => r.value.includes('9:30'))).toEqual([
      {
        about: `user:${VINAY}`,
        relation: 'team_standup_time',
        value: 'Team standup is at 9:30 every weekday',
        audience: 'shared',
      },
    ]);
  });

  it('records no "assistant replied_with" statement, and no "assistant lacks_capability" one', async () => {
    const h = await replayWalk();
    const rows = storedRows(h);
    expect(rows.filter((r) => r.about === 'assistant')).toEqual([]);
    expect(rows.map((r) => r.relation)).not.toContain('replied_with');
    expect(rows.map((r) => r.relation)).not.toContain('lacks_capability');
  });

  // TASK-1210: each new filter, on the walk's own text.
  it("records none of the turn's narration: memory misses, the admin request, the speaker's echo requests and Slack id", async () => {
    const h = await replayWalk();
    // Exactly the standup: every other pinned row is narration.
    expect(storedRows(h).map((r) => `${r.about} | ${r.relation} | ${r.value}`)).toEqual([
      `user:${VINAY} | team_standup_time | Team standup is at 9:30 every weekday`,
    ]);
  });

  it('a later channel thread recalls the standup: in the instructions, and through the recall tool, for any member', async () => {
    const h = await replayWalk();
    // "@Fern when is our team standup?" in a new thread: a new conversation.
    const vinayAsks = channelTurn(h, VINAY, 'conv-question');
    const block = await augment(h, vinayAsks);
    expect(block).toContain('9:30 every weekday');
    // The walk's three rows about the agent itself; none now, and since
    // TASK-1210 none of the replay's narration either.
    expect(block).not.toContain('replied_with');
    expect(block).not.toMatch(/on record|no record|reply with exactly|UHTE83XE1|admin/i);
    expect(block).not.toContain('lacks_capability');
    expect(block).not.toMatch(/— assistant /);
    expect(await recallTool(h, vinayAsks, 'team standup')).toContain('9:30 every weekday');

    // A teammate asking in the channel reads the team's memory too.
    const bobAsks = channelTurn(h, BOB, 'conv-question-b');
    expect(await recallTool(h, bobAsks, 'team standup')).toContain('9:30 every weekday');
  });

  // TASK-1209: a team agent's memory is shared with anyone who talks to it.
  it("an outsider's turn in the channel recalls it too", async () => {
    const h = await replayWalk();
    const outsider = h.ctx({ conversationId: 'conv-ext', source: 'external', audience: 'shared' });
    expect(await recallTool(h, outsider, 'team standup')).toContain('9:30');
  });
});
