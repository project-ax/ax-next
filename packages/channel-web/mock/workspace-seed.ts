/**
 * Agent-workspace prototype — fixtures.
 *
 * Three scenarios, because the surface is only worth reviewing if the hard
 * cases are clickable rather than hypothetical:
 *
 *   - `attended`   — Dana is live in the Inbox thread. The held decision renders
 *                    in-thread; approving continues the conversation in place,
 *                    because the agent never died.
 *   - `unattended`  — overnight routine runs left two decisions in the queue.
 *                    One of them will FAIL its freshness guard on approval, so
 *                    the re-open path is reachable in two clicks.
 *   - `incident`   — Follow-ups halted itself after the mail server refused two
 *                    nudges, and its queue has not moved since.
 *
 * `world` is the mock's stand-in for reality: the current value of each
 * freshness predicate. Seeding a value that disagrees with what a decision
 * captured at hold-time is how the staleness demo works.
 */
import type {
  ActivityEvent,
  Decision,
  DemoScenario,
  MemoryDoc,
  PastConversation,
  PermissionRow,
  ThreadMessage,
  WorkspaceAgent,
  WorkspaceFile,
} from './workspace-types';

export interface WorkspaceState {
  scenario: DemoScenario;
  agents: WorkspaceAgent[];
  decisions: Decision[];
  activity: ActivityEvent[];
  threads: Record<string, ThreadMessage[]>;
  /** Current reality, keyed by predicate kind. */
  world: Record<string, string>;
  /** Human sentence per predicate kind, for when the guard trips. */
  changed: Record<string, string>;
  stoppedAll: boolean;
}

const HOUR = 3600_000;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function agents(scenario: DemoScenario): WorkspaceAgent[] {
  const stopped = scenario === 'incident';
  return [
    {
      id: 'inbox',
      name: 'Inbox',
      role: 'Reads your email, replies to the easy ones, brings you the rest',
      icon: 'mail',
      state: 'working',
      channel: scenario === 'attended' ? 'web' : 'routine',
      now: 'Reading this morning’s email',
      counter: { done: 29, total: 41, unit: 'messages' },
      startedAt: iso(-6 * 60_000),
      stoppedReason: null,
      paused: false,
      footer:
        'Inbox has been running for 41 days. You have corrected it 3 times.',
    },
    {
      id: 'slack',
      name: 'Slack Digest',
      role: 'Watches 14 channels and summarises what involves you',
      icon: 'hash',
      state: 'working',
      channel: 'routine',
      now: 'Summarising #go-to-market',
      counter: { done: 6, total: 13, unit: 'threads' },
      startedAt: iso(-3 * 60_000),
      stoppedReason: null,
      paused: false,
      footer:
        'Slack Digest has run 612 times. It has asked you for help twice.',
    },
    {
      id: 'scheduler',
      name: 'Scheduler',
      role: 'Guards your calendar and fixes clashes before they bite',
      icon: 'calendar-days',
      state: 'waiting',
      channel: 'routine',
      now: 'Waiting on your decision',
      counter: null,
      startedAt: null,
      stoppedReason: null,
      paused: false,
      footer: 'Scheduler has protected 38 hours of focus time this month.',
    },
    {
      id: 'followups',
      name: 'Follow-ups',
      role: 'Chases the answers other people owe you',
      icon: 'corner-up-left',
      state: stopped ? 'stopped' : 'working',
      channel: 'routine',
      now: stopped
        ? 'Stopped — the mail server refused two nudges'
        : 'Checking who owes you a reply',
      counter: stopped ? null : { done: 4, total: 9, unit: 'threads' },
      startedAt: stopped ? null : iso(-1 * 60_000),
      stoppedReason: stopped
        ? 'Two nudges were rejected by the mail server at 9:12. Nothing in its queue has run since.'
        : null,
      paused: false,
      footer: 'Follow-ups has closed 24 loops for you this quarter.',
    },
    {
      id: 'travel',
      name: 'Travel',
      role: 'Books trips and files the expenses afterwards',
      icon: 'plane',
      state: 'resting',
      channel: 'routine',
      now: 'Resting until a trip appears',
      counter: null,
      startedAt: null,
      stoppedReason: null,
      paused: false,
      footer: 'Travel last ran 9 days ago, for the Boston trip.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

function decisions(scenario: DemoScenario): Decision[] {
  const attended = scenario === 'attended';

  const priya: Decision = {
    id: 'd-priya',
    agentId: 'inbox',
    conversationId: 'conv-inbox-current',
    kind: 'action',
    attendance: attended ? 'attended' : 'unattended',
    status: 'pending',
    call: {
      id: 'call-gmail-1',
      name: 'gmail__send',
      input: {
        to: 'priya@northwind.co',
        subject: 'Re: Contract call',
        body: 'Hi Priya — Friday works well. Dana has 2:00 or 4:00 open; either is fine on our side. I’ll send an invite as soon as you pick one.',
      },
    },
    freshness: {
      kind: 'thread-head',
      value: 'msg-8841',
      label: 'Priya’s thread, unchanged since 8:41 AM',
    },
    summary: 'A reply to Priya at Northwind is ready',
    detail:
      'She asked to move the contract call to Friday. I have drafted a yes and offered 2:00 or 4:00 — nothing goes out until you say so.',
    preview: {
      meta: 'To: priya@northwind.co · Re: Contract call',
      body: 'Hi Priya — Friday works well. Dana has 2:00 or 4:00 open; either is fine on our side. I’ll send an invite as soon as you pick one.',
    },
    primaryLabel: 'Send it',
    secondaryLabel: 'Edit first',
    ghostLabel: 'I’ll handle it',
    approvedText: 'Inbox sent your reply to Priya Raman',
    dismissedText:
      'You took the Priya reply over from Inbox — the draft was kept, nothing was sent',
    createdAt: iso(-2 * HOUR),
    expiresAt: iso(46 * HOUR),
    resolvedAt: null,
    staleReason: null,
  };

  const marcus: Decision = {
    id: 'd-marcus',
    agentId: 'scheduler',
    conversationId: 'conv-scheduler-current',
    kind: 'action',
    attendance: 'unattended',
    status: 'pending',
    call: {
      id: 'call-cal-1',
      name: 'calendar__move_event',
      input: {
        eventId: 'evt-1on1-marcus',
        newStart: '2026-08-21T09:30:00-04:00',
        durationMinutes: 45,
      },
    },
    freshness: {
      kind: 'slot-etag',
      value: 'etag-thu-0930-free',
      label: 'Thursday 9:30 still free for both of you',
    },
    summary: 'Move your 1:1 with Marcus to Thursday 9:30?',
    detail:
      'It clashes with the board prep that appeared yesterday. Marcus has already agreed to the new time, and your afternoon block is untouched.',
    preview: {
      meta: 'Marcus Lee · 45 minutes · both free at the time I checked',
      body: 'Board prep stays where it is. The 1:1 moves from Thursday 2:00 to Thursday 9:30.',
    },
    primaryLabel: 'Move it',
    secondaryLabel: 'Pick another time',
    ghostLabel: 'Leave it',
    approvedText: 'Scheduler moved your 1:1 with Marcus to Thursday 9:30',
    dismissedText:
      'You left the Marcus 1:1 where it was — Scheduler will stop asking about this clash',
    createdAt: iso(-3 * HOUR),
    expiresAt: iso(21 * HOUR),
    resolvedAt: null,
    staleReason: null,
  };

  const pricing: Decision = {
    id: 'd-pricing',
    agentId: 'slack',
    conversationId: 'conv-slack-current',
    kind: 'grant',
    attendance: 'unattended',
    status: 'pending',
    call: {
      id: 'call-slack-1',
      name: 'slack__watch_channel',
      input: { channel: '#pricing-2027' },
    },
    freshness: null,
    summary: 'Does #pricing-2027 concern you?',
    detail:
      'It is a new channel running at about 40 messages a day. Tell me once and I will remember for good.',
    preview: null,
    primaryLabel: 'Watch it',
    secondaryLabel: 'Show me a sample',
    ghostLabel: 'Leave it alone',
    approvedText: 'Slack Digest started watching #pricing-2027',
    dismissedText:
      'Slack Digest will leave #pricing-2027 alone and will not ask again',
    createdAt: iso(-2 * HOUR),
    expiresAt: iso(70 * HOUR),
    resolvedAt: null,
    staleReason: null,
  };

  if (scenario === 'attended') return [priya, pricing];
  return [priya, marcus, pricing];
}

/**
 * Current reality. In `unattended`, the calendar slot has been taken since
 * Scheduler drafted the move — so approving Marcus trips the guard and the
 * decision re-opens instead of silently double-booking Dana.
 */
function world(scenario: DemoScenario): {
  world: Record<string, string>;
  changed: Record<string, string>;
} {
  if (scenario === 'unattended') {
    return {
      world: {
        'thread-head': 'msg-8841',
        'slot-etag': 'etag-thu-0930-taken',
      },
      changed: {
        'slot-etag':
          'Thursday 9:30 was booked by someone else at 11:04, after Scheduler drafted this.',
      },
    };
  }
  return {
    world: { 'thread-head': 'msg-8841', 'slot-etag': 'etag-thu-0930-free' },
    changed: {},
  };
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

function threads(scenario: DemoScenario): Record<string, ThreadMessage[]> {
  const inbox: ThreadMessage[] = [
    {
      kind: 'fold',
      id: 'f1',
      text: 'Earlier turns were summarised into memory · 34 messages folded',
    },
    {
      kind: 'agent',
      id: 'm1',
      text: 'Good morning. 214 emails came in overnight. I answered nine — all scheduling, nothing you would have written differently — filed 187 as reading, and kept two for you.',
      time: '7:15 AM',
    },
    { kind: 'user', id: 'm2', text: 'What are the two?' },
    {
      kind: 'steps',
      id: 'm3',
      text: 'Priya wants to move the contract call, and Legal sent the redlines you asked for. Priya’s is the one that needs you. Here is how I got there:',
      time: '7:16 AM · used Gmail, Calendar',
      stepsLabel: '3 steps · 12 seconds',
      steps: [
        'Read 214 new messages',
        'Checked your Friday against the calendar — 2 slots free',
        'Drafted one reply and held it for your approval',
      ],
    },
    { kind: 'approval', id: 'm4', decisionId: 'd-priya' },
  ];

  if (scenario === 'attended') {
    inbox.push({
      kind: 'status',
      id: 'm5',
      text: 'Waiting for you — I will pick straight back up when you decide',
    });
  } else {
    inbox.push({
      kind: 'status',
      id: 'm5',
      text: 'Turn ended while this was held. It is waiting in Today.',
    });
  }

  return {
    inbox,
    slack: [
      {
        kind: 'agent',
        id: 's1',
        text: 'Morning. Six threads mentioned you overnight. The one worth your time is the launch date — Sam floated pushing to 14 October and your name came up twice as the decider.',
        time: '8:31 AM',
      },
      { kind: 'user', id: 's2', text: 'Who disagreed?' },
      {
        kind: 'agent',
        id: 's3',
        text: 'Nobody disagreed. Two people agreed, and Priya asked what it means for the Northwind contract — which is why I flagged it rather than filing it.',
        time: '8:32 AM',
      },
      { kind: 'approval', id: 's4', decisionId: 'd-pricing' },
    ],
    scheduler: [
      {
        kind: 'agent',
        id: 'c1',
        text: 'Your Thursday is double-booked: the board prep landed on top of your 1:1 with Marcus. I found one slot that works for both of you but I will not move anything without your say-so.',
        time: '6:44 AM',
      },
      ...(scenario === 'attended'
        ? []
        : [{ kind: 'approval' as const, id: 'c2', decisionId: 'd-marcus' }]),
      { kind: 'status', id: 'c3', text: 'Watching for new invites' },
    ],
    followups:
      scenario === 'incident'
        ? [
            {
              kind: 'agent',
              id: 'u1',
              text: 'Four people owe you an answer. I nudged Sam and Priya this morning — politely, and only because it has been four days.',
              time: '9:00 AM',
            },
            {
              kind: 'agent',
              id: 'u2',
              text: 'I tried both nudges twice. The mail server returned "relay denied" each time, so I stopped rather than keep retrying. Nothing else in my queue has run since.',
              time: '9:14 AM',
            },
          ]
        : [
            {
              kind: 'agent',
              id: 'u1',
              text: 'Four people owe you an answer. I nudged Sam and Priya this morning — politely, and only because it has been four days.',
              time: '9:00 AM',
            },
            { kind: 'user', id: 'u2', text: 'Don’t chase Sam again this week' },
            {
              kind: 'agent',
              id: 'u3',
              text: 'Noted, and written down. I will leave Sam alone until Monday and keep the other three on the normal rhythm.',
              time: '9:02 AM',
            },
            {
              kind: 'status',
              id: 'u4',
              text: 'Checking who still owes you a reply',
            },
          ],
    travel: [
      {
        kind: 'agent',
        id: 't1',
        text: 'Nothing booked at the moment. I will wake up as soon as a trip appears on your calendar, and I will bring you options rather than booking anything myself.',
        time: '11 Aug',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function activity(scenario: DemoScenario): ActivityEvent[] {
  const base: ActivityEvent[] = [
    ['a1', 'slack', 'Today', 'Summarised six threads you were mentioned in', '8:31 AM', 'done'],
    ['a2', 'inbox', 'Today', 'Answered nine emails for you — all scheduling', '7:15 AM', 'done'],
    ['a3', 'followups', 'Today', 'Nudged Sam and Priya about the contract redlines', '7:02 AM', 'done'],
    ['a4', 'scheduler', 'Today', 'Declined an invite that arrived with no agenda', '6:48 AM', 'done'],
    ['a7', 'inbox', 'Today', 'Reading the 41 emails that arrived this morning', 'now', 'working'],
    ['a8', 'followups', 'Yesterday', 'Closed the loop with Legal on the redlines', '4:20 PM', 'done'],
    ['a9', 'scheduler', 'Yesterday', 'Held 90 minutes on Friday for board reading', '3:04 PM', 'done'],
    ['a11', 'slack', 'Yesterday', 'Muted #general during your focus block', '9:12 AM', 'done'],
  ].map(([id, agentId, day, text, time, kind]) => ({
    id: id as string,
    agentId: agentId as string,
    day: day as string,
    text: text as string,
    time: time as string,
    kind: kind as ActivityEvent['kind'],
    tag: null,
    decisionId: null,
  }));

  const held: ActivityEvent[] = [
    {
      id: 'a5',
      agentId: 'inbox',
      day: 'Today',
      text: 'Held a reply to Priya Raman for your approval',
      time: '8:52 AM',
      kind: 'held',
      tag: 'Waiting on you',
      decisionId: 'd-priya',
    },
    {
      id: 'a6',
      agentId: 'scheduler',
      day: 'Today',
      text: 'Flagged the clash between your 1:1 and board prep',
      time: '9:04 AM',
      kind: 'held',
      tag: 'Waiting on you',
      decisionId: 'd-marcus',
    },
    {
      id: 'a10',
      agentId: 'travel',
      day: 'Yesterday',
      text: 'Asked whether to hold flights for October — you said not yet',
      time: '8:50 AM',
      kind: 'dismissed',
      tag: 'You declined',
      decisionId: null,
    },
  ];

  const incident: ActivityEvent[] =
    scenario === 'incident'
      ? [
          {
            id: 'a0',
            agentId: 'followups',
            day: 'Today',
            text: 'Stopped after the mail server rejected two nudges',
            time: '9:12 AM',
            kind: 'stopped',
            tag: 'Stopped',
            decisionId: null,
          },
        ]
      : [];

  return [...incident, ...held, ...base];
}

// ---------------------------------------------------------------------------
// Per-agent detail (static across scenarios)
// ---------------------------------------------------------------------------

/**
 * Every row carries the rule that produced it. A row with `source: null` is
 * rendered as an explicit gap rather than dropped — an omitted capability
 * reads to the user as "it cannot do that", which is the dangerous direction
 * to be wrong in.
 */
export const PERMISSIONS: Record<string, PermissionRow[]> = {
  inbox: [
    { verdict: 'allow', sentence: 'Read and sort your mail', source: 'gmail.read' },
    { verdict: 'allow', sentence: 'Reply to scheduling requests on its own', source: 'gmail.send · intent=scheduling' },
    { verdict: 'hold', sentence: 'Anything to a customer — holds for you', source: 'gmail.send · recipient=external' },
    { verdict: 'deny', sentence: 'Never deletes anything', source: 'gmail.delete' },
    { verdict: 'allow', sentence: 'Reads your calendar to check availability', source: null },
  ],
  slack: [
    { verdict: 'allow', sentence: 'Read the channels on the watch list', source: 'slack.history · scope=watchlist' },
    { verdict: 'allow', sentence: 'Write the daily digest', source: 'workspace.write · path=digests/' },
    { verdict: 'hold', sentence: 'Adding a new channel — holds for you', source: 'slack.watch_channel' },
    { verdict: 'deny', sentence: 'Never posts as you', source: 'slack.post' },
  ],
  scheduler: [
    { verdict: 'allow', sentence: 'Decline invites that arrive with no agenda', source: 'calendar.respond · agenda=absent' },
    { verdict: 'allow', sentence: 'Protect your focus blocks', source: 'calendar.create · kind=hold' },
    { verdict: 'hold', sentence: 'Moving anything with another person in it', source: 'calendar.move_event · attendees>1' },
    { verdict: 'deny', sentence: 'Never books travel', source: 'travel.*' },
  ],
  followups: [
    { verdict: 'allow', sentence: 'Send one polite nudge', source: 'gmail.send · template=nudge' },
    { verdict: 'hold', sentence: 'Escalating to someone’s manager', source: 'gmail.send · recipient=manager' },
    { verdict: 'deny', sentence: 'Never chases the same person twice in a week', source: 'rate.nudge · window=7d' },
  ],
  travel: [
    { verdict: 'allow', sentence: 'Search flights and hotels', source: 'travel.search' },
    { verdict: 'hold', sentence: 'Anything that costs money', source: 'payment.*' },
    { verdict: 'deny', sentence: 'Never books without you', source: 'travel.book' },
  ],
};

export const STATS: Record<string, Array<{ label: string; value: string }>> = {
  inbox: [
    { label: 'Handled on its own', value: '64' },
    { label: 'Brought to you', value: '9' },
    { label: 'You overruled it', value: '1' },
  ],
  slack: [
    { label: 'Threads summarised', value: '38' },
    { label: 'Brought to you', value: '2' },
    { label: 'You overruled it', value: '0' },
  ],
  scheduler: [
    { label: 'Clashes fixed alone', value: '9' },
    { label: 'Brought to you', value: '2' },
    { label: 'Focus hours saved', value: '38' },
  ],
  followups: [
    { label: 'Nudges sent', value: '11' },
    { label: 'Loops closed', value: '7' },
    { label: 'Brought to you', value: '1' },
  ],
  travel: [
    { label: 'Trips booked', value: '0' },
    { label: 'Expenses filed', value: '3' },
    { label: 'Brought to you', value: '0' },
  ],
};

export const PAST: Record<string, PastConversation[]> = {
  inbox: [
    {
      id: 'p-i1',
      title: 'Rivera complaint escalation and the handoff to Legal',
      meta: 'Closed 18 Aug · 12 messages',
      folded: 8,
      msgs: [
        { kind: 'user', id: 'pi1', text: 'How should we handle the Rivera complaint?' },
        { kind: 'agent', id: 'pi2', text: 'I would send it to Legal rather than answer it myself — it names a specific nurse. I drafted a short handoff note with the thread attached.', time: '18 Aug, 2:14 PM' },
        { kind: 'user', id: 'pi3', text: 'Do that, and don’t reply to her directly' },
        { kind: 'agent', id: 'pi4', text: 'Sent to Legal and written down: I never reply to complaints that name staff. Closing this out.', time: '18 Aug, 2:20 PM' },
      ],
    },
    {
      id: 'p-i2',
      title: 'Overnight filing rules',
      meta: 'Closed 12 Aug · 8 messages',
      folded: 6,
      msgs: [
        { kind: 'user', id: 'pi5', text: 'Stop filing anything from the board into reading' },
        { kind: 'agent', id: 'pi6', text: 'Understood. Board mail now comes to you unfiled, at any hour. Everything else keeps the current rhythm.', time: '12 Aug, 8:05 AM' },
      ],
    },
  ],
  slack: [
    {
      id: 'p-s1',
      title: 'Which channels matter',
      meta: 'Closed 15 Aug · 9 messages',
      folded: 7,
      msgs: [
        { kind: 'user', id: 'ps1', text: 'I don’t need #general summarised' },
        { kind: 'agent', id: 'ps2', text: 'Dropped. I am watching 14 channels now, and I will ask before adding a new one.', time: '15 Aug, 11:40 AM' },
      ],
    },
  ],
  scheduler: [
    {
      id: 'p-c1',
      title: 'Friday focus block',
      meta: 'Closed 19 Aug · 6 messages',
      folded: 4,
      msgs: [
        { kind: 'user', id: 'pc1', text: 'Keep Friday mornings clear' },
        { kind: 'agent', id: 'pc2', text: 'Holding 9–11 every Friday. I will decline anything that lands there unless it is the board.', time: '19 Aug, 4:02 PM' },
      ],
    },
  ],
  followups: [
    {
      id: 'p-f1',
      title: 'Adler Health SOW chase',
      meta: 'Closed 20 Aug · 14 messages',
      folded: 10,
      msgs: [
        { kind: 'user', id: 'pf1', text: 'How many times have we chased Adler?' },
        { kind: 'agent', id: 'pf2', text: 'Twice. Once on the 14th, once on the 18th. Their procurement lead read both.', time: '20 Aug, 9:30 AM' },
        { kind: 'user', id: 'pf3', text: 'Leave it with me from here' },
        { kind: 'agent', id: 'pf4', text: 'Stopping the chase and noting that Adler is yours. Closing this out.', time: '20 Aug, 9:31 AM' },
      ],
    },
  ],
  travel: [
    {
      id: 'p-t1',
      title: 'October trip options',
      meta: 'Closed 20 Aug · 7 messages',
      folded: 5,
      msgs: [
        { kind: 'user', id: 'pt1', text: 'Not yet on the October flights' },
        { kind: 'agent', id: 'pt2', text: 'Holding off. I will ask again in September rather than watch fares silently.', time: '20 Aug, 8:50 AM' },
      ],
    },
  ],
};

export const FILES: Record<string, WorkspaceFile[]> = {
  inbox: [
    {
      name: '2026-08-20-morning.md',
      meta: '8:31 AM today · 3.4 KB',
      title: 'Morning digest — 20 August',
      blocks: [
        ['p', 'Three things moved overnight. The launch date is the one worth your attention.'],
        ['h', '#go-to-market'],
        ['p', 'Sam floated pushing the launch to 14 October. Two people agreed, nobody disagreed, and your name came up twice as the decider.'],
        ['h', 'Email'],
        ['p', 'Legal sent the redlines. I have filed them and flagged clause 8, which changed since the version you read.'],
      ],
    },
    {
      name: 'sent-2026-08-20.md',
      meta: '7:15 AM today · 1.1 KB',
      title: 'Sent on your behalf — 20 August',
      blocks: [
        ['p', 'Nine replies, all scheduling. Each one confirmed a time you already had free.'],
        ['mono', 'j.alvarez@ · t.okafor@ · m.lee@ · s.reeve@ · 5 more'],
        ['p', 'None of these needed a decision, so none were held for approval.'],
      ],
    },
  ],
  slack: [
    {
      name: '2026-w34-digest.md',
      meta: '8:31 AM today · 2.8 KB',
      title: 'Week 34 digest',
      blocks: [
        ['p', 'Launch date is the live question. Everything else is noise you can skip.'],
        ['h', 'Threads with your name in them'],
        ['mono', '#go-to-market · 6 messages\n#northwind · 2 messages'],
      ],
    },
  ],
  scheduler: [
    {
      name: 'clashes-august.md',
      meta: '6:44 AM today · 0.9 KB',
      title: 'Clashes — August',
      blocks: [
        ['p', 'Eleven clashes this month. Nine I fixed alone; two involved another person, so I asked you first.'],
      ],
    },
  ],
  followups: [
    {
      name: 'open-loops.md',
      meta: '9:00 AM today · 1.4 KB',
      title: 'Open loops',
      blocks: [
        ['p', 'Four people owe you an answer.'],
        ['mono', 'Sam — redlines — 4 days\nPriya — call time — 1 day\nT. Okafor — headcount — 6 days\nLegal — clause 8 — today'],
      ],
    },
  ],
  travel: [
    {
      name: 'boston-expenses.md',
      meta: '11 Aug · 0.7 KB',
      title: 'Boston — expenses',
      blocks: [['p', 'Filed and approved. Nothing outstanding.']],
    },
  ],
};

export const MEMORY: Record<string, MemoryDoc[]> = {
  inbox: [
    {
      name: 'how-i-work.md',
      scope: 'rules',
      body: '# Rules you gave me\n\n- Never send anything to a customer without asking.\n- Scheduling replies are fine to send on my own.\n- Recruiter email goes to Reading. Never reply.\n\n## Working hours\nYou read email at 7am and after 6pm. Do not nudge you in between\nunless something is on fire.\n',
    },
    {
      name: 'people.md',
      scope: 'rules',
      body: '# People\n\n- Priya Raman (Northwind) — customer. Warm, direct, replies fast.\n- Marcus Lee — your report. Handles Northgate after 10pm.\n- Legal (shared inbox) — always escalate, never answer.\n',
    },
    {
      name: 'what-i-learned.md',
      scope: 'learned',
      body: '# What I learned\n\n- Mail sent between 6 and 7am gets answered same day.\n- Anything with "quick question" in the subject is never quick.\n',
    },
  ],
  slack: [
    { name: 'how-i-work.md', scope: 'rules', body: '# Rules you gave me\n\n- Summarise once at 8:30, not continuously.\n- Only channels on the watch list. Ask before adding a new one.\n- Never post as you.\n' },
    { name: 'channels.md', scope: 'learned', body: '# Channels\n\nWatching: #go-to-market, #northwind, #incidents\nIgnoring: #random, #food, #pets\n' },
  ],
  scheduler: [
    { name: 'how-i-work.md', scope: 'rules', body: '# Rules you gave me\n\n- Decline invites with no agenda.\n- Never move anything that has another person in it without asking.\n- Protect 9-11am Tuesdays and Thursdays for focus.\n' },
    { name: 'people.md', scope: 'learned', body: '# People\n\n- Marcus Lee — flexible, prefers mornings.\n- Board — never move, never shorten.\n' },
  ],
  followups: [
    { name: 'how-i-work.md', scope: 'rules', body: '# Rules you gave me\n\n- Nudge after 4 days, once. Then ask me.\n- Never chase the same person twice in a week.\n- Do not chase Sam again this week.\n' },
    { name: 'what-i-learned.md', scope: 'learned', body: '# What I learned\n\n- Priya answers within a day; no nudge needed.\n- Legal never answers email. Use the shared channel.\n' },
  ],
  travel: [
    { name: 'how-i-work.md', scope: 'rules', body: '# Rules you gave me\n\n- Bring options, never book.\n- Aisle seat, no red-eyes.\n- File expenses within 3 days of return.\n' },
  ],
};

export const SUGGESTIONS: Record<string, string[]> = {
  inbox: ['What did you file as reading?', 'Never reply to recruiters', 'Summarise Legal’s redlines'],
  slack: ['Who mentioned me yesterday?', 'Digest at 7am instead', 'Skip #pricing for now'],
  scheduler: ['Keep Thursdays clear', 'What does my Friday look like?', 'Never book over lunch'],
  followups: ['Chase Legal today', 'Stop nudging on Fridays', 'Who is slowest to reply?'],
  travel: ['Plan the October trip', 'Aisle seats only', 'What did Boston cost?'],
};

export function seedWorkspace(scenario: DemoScenario): WorkspaceState {
  const w = world(scenario);
  return {
    scenario,
    agents: agents(scenario),
    decisions: decisions(scenario),
    activity: activity(scenario),
    threads: threads(scenario),
    world: w.world,
    changed: w.changed,
    stoppedAll: false,
  };
}
