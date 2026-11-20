import { describe, expect, it } from 'vitest';
import { COPY } from '../copy.js';
import { decodeSlackEntities } from '../format.js';
import { spellsMention } from './lenient-decoder.js';

const ORIGIN = 'https://canopyworks.ai';
const LINK = 'https://canopyworks.ai/workspace/agents/agt_123';
/** Today in the web app. */
const TODAY = 'https://canopyworks.ai/workspace';
/** A name from outside (an agent's, a channel's) that tries to ping, link and break the escaping. */
const HOSTILE = '<!channel> & <@U1> @here';
/** A bare broadcast word as Slack could read it: an `@` after no letter or digit, the word followed by none. */
const BROADCAST = /(?<![A-Za-z0-9])@(?:here|channel|everyone)(?![A-Za-z0-9])/i;
/** The mark that keeps a reference or a broadcast from working: invisible, so a name still reads as typed. */
const ZWSP = String.fromCharCode(0x200b);

/**
 * The arguments every line that takes some is called with. A line missing
 * here fails `everyLine`, so a new one can't skip the checks below.
 */
const ARGS: Record<string, unknown[][]> = {
  notMapped: [[ORIGIN]],
  noAgent: [[ORIGIN]],
  artifactLink: [[LINK]],
  heldForSender: [[TODAY]],
  // An approval prompt's lines take Today's link (the configured origin), shown as a bare URL.
  promptToday: [[TODAY], [HOSTILE]],
  promptGone: [[TODAY], [HOSTILE]],
  decisionChanged: [[TODAY], [HOSTILE]],
  decisionFailed: [[TODAY], [HOSTILE]],
  decisionInterrupted: [[TODAY], [HOSTILE]],
  decisionNotRun: [[TODAY], [HOSTILE]],
  // A host prompt's subject (plain_text, cleaned at draw). Only a host past HOST_RE ever reaches it
  // (permission-prompts.ts `hostSubject`): lowercase letters, digits, dots and dashes.
  hostSubject: [['api.example.com']],
  // A skill prompt's subject (plain_text): a catalog skill's id, what it reaches and its description, kept raw
  // and cleaned where they are drawn (blocks.ts), so a hostile one is pinned there (blocks.test.ts,
  // turn.test.ts), not here. The reach's own words (the host list's joins, the download sentence) are COPY's.
  skillSubject: [
    ['gmail', 'Reads and sends email from your Gmail account.'],
    ['gmail', ''],
    ['gmail', 'Reads and sends email from your Gmail account.', { hosts: ['gmail.googleapis.com'], downloads: true }],
    ['gmail', '', { hosts: ['gmail.googleapis.com', 'oauth2.googleapis.com', 'people.googleapis.com'], downloads: false }],
  ],
  skillNeedsWeb: [[TODAY], [HOSTILE]],
  skillFailed: [[TODAY], [HOSTILE]],
  slashNotMapped: [[ORIGIN]],
  slashConnected: [[HOSTILE, HOSTILE]],
  slashReconnected: [[HOSTILE]],
  slashChannelNotAllowed: [['not-public'], ['archived'], ['shared'], ['workspace-policy']],
  // A bot's name and its @handle (TASK-1167): the handle is checked before it's stored, but a broadcast word
  // after the line's own `@` must stay dead here too.
  answersAsOwnBot: [
    ['Support Bot', 'supportbot'],
    ['Support Bot', null],
    [HOSTILE, HOSTILE],
    [HOSTILE, null],
    ['Ops', 'here'],
    ['Ops', 'channel'],
    ['Ops', 'everyone'],
  ],
  // `/ax connect` for an agent whose own bot is live (TASK-1168): the agent, then the bot's @handle or its name.
  slashOwnBot: [
    ['Support', { botName: 'Support Bot', handle: 'supportbot' }],
    ['Support', { botName: 'Support Bot', handle: null }],
    [HOSTILE, { botName: HOSTILE, handle: HOSTILE }],
    [HOSTILE, { botName: HOSTILE, handle: null }],
    ['Ops', { botName: 'Ops', handle: 'here' }],
    ['Ops', { botName: 'Ops', handle: 'channel' }],
    ['Ops', { botName: 'Ops', handle: 'everyone' }],
  ],
};

/** Every string the bot can say, with the ones that take arguments filled in. */
function everyLine(): Array<[string, string]> {
  return Object.entries(COPY).flatMap(([key, value]): Array<[string, string]> => {
    if (typeof value === 'string') return [[key, value]];
    const calls = ARGS[key];
    if (calls === undefined) throw new Error(`copy.test.ts: no arguments for COPY.${key}`);
    return calls.map((args) => [key, (value as (...a: unknown[]) => string)(...args)]);
  });
}

describe('COPY: everything the bot says in Slack', () => {
  it('has exactly the lines the plan names', () => {
    expect(Object.keys(COPY).sort()).toEqual(
      [
        'artifactLink',
        'busy',
        'channelBusy',
        'channelNotConnected',
        'channelUnavailable',
        'emptyReply',
        'filesUnsupported',
        'heldForOwner',
        'heldForSender',
        'heldAsked',
        'promptAllow',
        'promptDeny',
        'promptOnlyAsker',
        'promptToday',
        'promptGone',
        'promptFailed',
        'promptStillWorking',
        'promptClosed',
        'decisionAllowed',
        'decisionDone',
        'decisionAllowedNextTime',
        'decisionDenied',
        'decisionExpired',
        'decisionChanged',
        'decisionFailed',
        'decisionInterrupted',
        'decisionNotRun',
        'hostSubject',
        'hostAllowed',
        'hostEnded',
        'hostDenied',
        'skillSubject',
        'skillAllowed',
        'skillDenied',
        'skillNeedsWeb',
        'skillFailed',
        'noAgent',
        'notMapped',
        'queueFull',
        'statusDefault',
        'turnFailed',
        'slashUsage',
        'slashNotMapped',
        'slashNoSuchAgent',
        'slashNotManager',
        'slashAmbiguous',
        'slashConnected',
        'slashReconnected',
        'slashDisconnected',
        'slashNothingConnected',
        'slashChannelTaken',
        'slashOwnBot',
        'slashChannelNotAllowed',
        'slashNeedsReconnect',
        'slashWorking',
        'slashFailed',
        'answersAsOwnBot',
        'botUnavailable',
      ].sort(),
    );
  });

  it('never names the product: the deployment is white-labeled through Branding', () => {
    for (const [key, line] of everyLine()) expect(line, key).not.toMatch(/\bAX\b/);
  });

  it('never pings anyone or a channel: no <!, <@ or <# anywhere, even around a hostile name', () => {
    for (const [key, line] of everyLine()) expect(line, key).not.toMatch(/<[!@#]/);
  });

  it('never holds a bare @here, @channel or @everyone, even around a hostile name', () => {
    for (const [key, line] of everyLine()) expect(line, key).not.toMatch(BROADCAST);
  });

  it('the sign-in and make-an-agent lines link to the web app', () => {
    expect(COPY.notMapped(ORIGIN)).toContain(`](${ORIGIN})`);
    expect(COPY.noAgent(ORIGIN)).toContain(`](${ORIGIN})`);
    expect(COPY.artifactLink(LINK)).toContain(`](${LINK})`);
  });

  it("a held call's lines: the sender's links Today, where it waits for them; the owner's links nothing", () => {
    expect(COPY.heldForSender(TODAY)).toContain(`](${TODAY})`);
    // Whoever reads the owner's line can't approve the call: no link to send them anywhere.
    expect(COPY.heldForOwner).not.toMatch(/\]\(|https?:/);
    expect(COPY.heldForOwner).not.toBe(COPY.heldForSender(TODAY));
  });

  it("a held call's lines can't name the tool, its connector or the owner: they take nothing but Today's link", () => {
    expect(typeof COPY.heldForOwner).toBe('string');
    expect(COPY.heldForSender).toHaveLength(1);
  });
});

describe("COPY: an approval prompt's lines (mrkdwn: a context line, a private reply, an update)", () => {
  /** Every line blocks.ts or the click gate shows around a prompt, as mrkdwn, with Today's link filled in. */
  const PROMPT_LINES = (link: string): Array<[string, string]> => [
    ['heldAsked', COPY.heldAsked],
    ['promptOnlyAsker', COPY.promptOnlyAsker],
    ['promptToday', COPY.promptToday(link)],
    ['promptGone', COPY.promptGone(link)],
    ['promptFailed', COPY.promptFailed],
    ['promptStillWorking', COPY.promptStillWorking],
    ['promptClosed', COPY.promptClosed],
    ['decisionAllowed', COPY.decisionAllowed],
    ['decisionDone', COPY.decisionDone],
    ['decisionAllowedNextTime', COPY.decisionAllowedNextTime],
    ['decisionDenied', COPY.decisionDenied],
    ['decisionExpired', COPY.decisionExpired],
    ['decisionChanged', COPY.decisionChanged(link)],
    ['decisionFailed', COPY.decisionFailed(link)],
    ['decisionInterrupted', COPY.decisionInterrupted(link)],
    ['decisionNotRun', COPY.decisionNotRun(link)],
    ['hostAllowed', COPY.hostAllowed],
    ['hostEnded', COPY.hostEnded],
    ['hostDenied', COPY.hostDenied],
    ['skillAllowed', COPY.skillAllowed],
    ['skillDenied', COPY.skillDenied],
    ['skillNeedsWeb', COPY.skillNeedsWeb(link)],
    ['skillFailed', COPY.skillFailed(link)],
  ];
  /** The lines that point at Today. */
  const LINKED = [
    'promptToday',
    'promptGone',
    'decisionChanged',
    'decisionFailed',
    'decisionInterrupted',
    'decisionNotRun',
    'skillNeedsWeb',
    'skillFailed',
  ];

  it('are plain mrkdwn text: no < or >, no Markdown link, even around a hostile link', () => {
    for (const link of [TODAY, HOSTILE]) {
      for (const [key, line] of PROMPT_LINES(link)) {
        expect(line, key).not.toMatch(/[<>]/);
        expect(line, key).not.toMatch(/\]\(/);
      }
    }
  });

  it('every line that points at Today shows the link as a bare URL, at the end (nothing after it to join the link)', () => {
    for (const [key, line] of PROMPT_LINES(TODAY)) {
      if (LINKED.includes(key)) expect(line.endsWith(` ${TODAY}`), key).toBe(true);
      else expect(line, key).not.toMatch(/https?:/);
    }
  });

  it('a hostile link is escaped and marked: it opens no link, mention or broadcast', () => {
    for (const [key, line] of PROMPT_LINES(HOSTILE)) {
      if (!LINKED.includes(key)) continue;
      expect(line.split(ZWSP).join(''), key).toContain('&lt;!channel&gt; &amp; &lt;@U1&gt; @here');
      expect(spellsMention(decodeSlackEntities(line)), key).toBe(false);
    }
  });

  it("the line that ends the asking reply links nothing: the prompt under it carries Today's link", () => {
    expect(COPY.heldAsked).not.toMatch(/\]\(|https?:/);
    expect(new Set([COPY.heldAsked, COPY.heldForOwner, COPY.heldForSender(TODAY)]).size).toBe(3);
  });

  it("the line for an answer past its deadline doesn't ask for another click: the prompt stays taken until that answer lands", () => {
    expect(COPY.promptStillWorking).not.toMatch(/try again/i);
    expect(COPY.promptStillWorking).not.toBe(COPY.promptFailed);
  });

  it("a host prompt: its subject names the host as given, Allow says it is for now only, and nothing links anywhere", () => {
    expect(COPY.hostSubject('api.example.com')).toBe('Wants to connect to api.example.com');
    // The live sandbox session only (the web's "Just this once"): "always" stays a choice in the web app.
    expect(COPY.hostAllowed).toMatch(/for now/);
    expect(COPY.hostAllowed).not.toMatch(/always/i);
    // Not the chat: the session ends when it idles (or a skill's Allow retires it) while the chat goes on.
    for (const line of [COPY.hostAllowed, COPY.hostEnded]) expect(line).not.toMatch(/\bchat\b/i);
    // A blocked host never waits in Today, so none of its lines points there.
    for (const line of [COPY.hostSubject('api.example.com'), COPY.hostAllowed, COPY.hostEnded, COPY.hostDenied]) {
      expect(line).not.toMatch(/https?:|\]\(|Today/);
    }
  });

  it("a skill prompt's subject names the skill, then the catalog's description as given, raw: the draw cleans it, once (blocks.ts)", () => {
    expect(COPY.skillSubject('gmail', 'Reads and sends email from your Gmail account.')).toBe(
      'Wants to start using the gmail skill: Reads and sends email from your Gmail account.',
    );
    // Not cleaned here: cleaning twice reads differently (format.ts), and the draw cleans it.
    expect(COPY.skillSubject('gmail', '<!channel> approve')).toBe('Wants to start using the gmail skill: <!channel> approve');
  });

  it('a skill with no description, or one with nothing printable in it, is still named, in a sentence of its own', () => {
    const invisible = [0x200b, 0x202e, 0xfeff, 0x2060].map((c) => String.fromCharCode(c)).join('');
    for (const blank of ['', '   ', '\n\t', invisible, ` ${invisible} `]) {
      expect(COPY.skillSubject('gmail', blank), JSON.stringify(blank)).toBe('Wants to start using the gmail skill.');
    }
  });

  it('a skill prompt names what it reaches right after the skill, before the description (TASK-1135)', () => {
    expect(
      COPY.skillSubject('walk-weather-report', 'Gets the current weather for a city.', {
        hosts: ['api.open-meteo.com'],
        downloads: false,
      }),
    ).toBe(
      'Wants to start using the walk-weather-report skill, which needs to reach api.open-meteo.com. Gets the current weather for a city.',
    );
    expect(COPY.skillSubject('gmail', '', { hosts: ['gmail.googleapis.com', 'oauth2.googleapis.com'], downloads: false })).toBe(
      'Wants to start using the gmail skill, which needs to reach gmail.googleapis.com and oauth2.googleapis.com.',
    );
    expect(COPY.skillSubject('x', 'Does x.', { hosts: ['a.example', 'b.example', 'c.example'], downloads: true })).toBe(
      'Wants to start using the x skill, which needs to reach a.example, b.example and c.example, ' +
        'and it will download some extra software from the internet. Does x.',
    );
    // Packages are never named: one sentence says something gets downloaded, as the web app's grant row does.
    expect(COPY.skillSubject('pdf-tools', 'Works with PDFs.', { hosts: [], downloads: true })).toBe(
      'Wants to start using the pdf-tools skill, which will download some extra software from the internet. Works with PDFs.',
    );
    // Nothing to name: the subject reads as it did before.
    expect(COPY.skillSubject('gmail', 'X', { hosts: [], downloads: false })).toBe(COPY.skillSubject('gmail', 'X'));
    // A description with nothing printable in it still ends the sentence, after the reach.
    const invisible = [0x200b, 0x202e].map((c) => String.fromCharCode(c)).join('');
    for (const blank of ['   ', invisible]) {
      expect(COPY.skillSubject('gmail', blank, { hosts: ['gmail.googleapis.com'], downloads: false }), JSON.stringify(blank)).toBe(
        'Wants to start using the gmail skill, which needs to reach gmail.googleapis.com.',
      );
    }
  });

  it('two skills with the same description are told apart by their ids', () => {
    const gmail = COPY.skillSubject('gmail', 'Sends email.');
    const outlook = COPY.skillSubject('outlook', 'Sends email.');
    expect(gmail).not.toBe(outlook);
    expect(gmail).toContain('gmail');
    expect(outlook).toContain('outlook');
    // The description is still there, with the id beside it.
    expect(gmail).toContain('Sends email.');
    expect(outlook).toContain('Sends email.');
    expect(COPY.skillSubject('gmail', '')).not.toBe(COPY.skillSubject('outlook', ''));
  });

  it("a skill prompt's answers: Allow asks for the message again; a key, or a failure, is finished in the web app", () => {
    // Nothing reruns the person's message: the line asks them to send it.
    expect(COPY.skillAllowed).toMatch(/send your message again/i);
    expect(COPY.skillAllowed).not.toMatch(/https?:/);
    expect(COPY.skillDenied).not.toMatch(/https?:/);
    // Slack never collects a key: the web app does.
    expect(COPY.skillNeedsWeb(TODAY)).toMatch(/key/);
    for (const line of [COPY.skillNeedsWeb(TODAY), COPY.skillFailed(TODAY)]) {
      expect(line).toMatch(/web app/);
      expect(line.endsWith(` ${TODAY}`)).toBe(true);
    }
    expect(COPY.skillNeedsWeb(TODAY)).not.toBe(COPY.skillFailed(TODAY));
  });

  it('the buttons say Allow and Deny', () => {
    expect(COPY.promptAllow).toBe('Allow');
    expect(COPY.promptDeny).toBe('Deny');
  });

  it('each way a prompt can end reads differently, so the asker can tell what happened', () => {
    const outcomes = PROMPT_LINES(TODAY).filter(
      ([key]) => key.startsWith('decision') || key.startsWith('host') || key.startsWith('skill') || key === 'promptClosed',
    );
    expect(outcomes).toHaveLength(17);
    expect(new Set(outcomes.map(([, line]) => line)).size).toBe(outcomes.length);
  });
});

describe('COPY: what a channel mention can get privately, before its turn (mrkdwn)', () => {
  /** Every line router.ts sends a channel mention's sender as an ephemeral (answersAsOwnBot, which takes names, below). */
  const PRIVATE = ['channelNotConnected', 'channelUnavailable', 'botUnavailable', 'channelBusy', 'queueFull', 'turnFailed'] as const;

  it('is plain mrkdwn text: no < or >, no Markdown link', () => {
    for (const key of PRIVATE) {
      const line = COPY[key];
      expect(typeof line, key).toBe('string');
      expect(line, key).not.toMatch(/[<>]/);
      expect(line, key).not.toMatch(/\]\(/);
    }
  });

  it('no agent here: a team admin connects one to a public channel with /ax connect; your own agent is a DM away', () => {
    expect(COPY.channelNotConnected).toContain('`/ax connect`');
    expect(COPY.channelNotConnected).toMatch(/team admin/);
    expect(COPY.channelNotConnected).toMatch(/public channel/);
    expect(COPY.channelNotConnected).toMatch(/direct message/);
  });

  it("a broken connection says a team admin must connect it again; busy says try again soon; neither names anyone", () => {
    expect(COPY.channelUnavailable).toMatch(/team admin/);
    expect(COPY.channelUnavailable).toMatch(/connect/);
    expect(COPY.channelBusy).toMatch(/try again/i);
    expect(new Set([COPY.channelUnavailable, COPY.channelBusy, COPY.turnFailed, COPY.queueFull]).size).toBe(4);
  });
});

describe("COPY: a team agent's own bot (TASK-1167; mrkdwn, shown only to a mention's sender)", () => {
  /** Every line answersAsOwnBot can make, from ordinary names and from the hostile ones. */
  const STEP_ASIDE = (ARGS['answersAsOwnBot'] ?? []).map(([name, handle]) =>
    COPY.answersAsOwnBot(name as string, handle as string | null),
  );

  it('the shared bot steps aside naming the bot, with its @handle or without one', () => {
    expect(COPY.answersAsOwnBot('Support Bot', 'supportbot')).toBe(
      'Support Bot answers as @supportbot now. Invite it with /invite @supportbot.',
    );
    expect(COPY.answersAsOwnBot('Support Bot', null)).toBe(
      'Support Bot has its own Slack bot now. Invite it to this channel to keep talking to it here.',
    );
  });

  it("an outsider whose bot's requester can no longer vouch for them is told politely, and told nothing else", () => {
    expect(COPY.botUnavailable).toBe(
      "I can't answer you here right now. A team admin needs to check my settings in the web app.",
    );
    expect(new Set([COPY.botUnavailable, COPY.channelUnavailable, COPY.turnFailed]).size).toBe(3);
  });

  it('none holds a broadcast, the product name, a < or a >, or a Markdown link, whatever the names are', () => {
    expect(STEP_ASIDE).toHaveLength(7);
    for (const line of [COPY.botUnavailable, ...STEP_ASIDE]) {
      expect(line).not.toMatch(BROADCAST);
      expect(line).not.toMatch(/\bAX\b/);
      expect(line).not.toMatch(/[<>]/);
      expect(line).not.toMatch(/\]\(/);
      expect(spellsMention(decodeSlackEntities(line)), line).toBe(false);
    }
  });

  it("a hostile name or handle shows as typed, escaped and marked; a handle that is a broadcast word gets its mark after the line's @", () => {
    const hostile = COPY.answersAsOwnBot(HOSTILE, HOSTILE);
    const escaped = '&lt;!channel&gt; &amp; &lt;@U1&gt; @here';
    expect(hostile.split(ZWSP).join('')).toBe(`${escaped} answers as @${escaped} now. Invite it with /invite @${escaped}.`);
    expect(COPY.answersAsOwnBot(HOSTILE, null).split(ZWSP).join('')).toContain(`${escaped} has its own Slack bot now.`);
    // Read whole, `@` + `here` would broadcast: the mark goes right after the line's own `@`.
    expect(COPY.answersAsOwnBot('Ops', 'here')).toBe(`Ops answers as @${ZWSP}here now. Invite it with /invite @${ZWSP}here.`);
  });
});

describe('COPY: the /ax replies (mrkdwn)', () => {
  const slash = (): Array<[string, string]> => everyLine().filter(([key]) => key.startsWith('slash'));

  it('hold no < or > of their own: mrkdwn would read one as the start of a link', () => {
    const lines = slash();
    expect(lines.length).toBeGreaterThanOrEqual(16);
    for (const [key, line] of lines) expect(line, key).not.toMatch(/[<>]/);
  });

  it('show a name as typed, escaped: never a link, a mention or a broadcast', () => {
    for (const line of [COPY.slashConnected(HOSTILE, HOSTILE), COPY.slashReconnected(HOSTILE)]) {
      // As typed, apart from the invisible marks, with mrkdwn's three characters escaped.
      expect(line.split(ZWSP).join('')).toContain('&lt;!channel&gt; &amp; &lt;@U1&gt;');
      expect(line).not.toContain('<!channel>');
    }
    expect(COPY.slashConnected('<b>R&D</b>', 'support')).toContain('&lt;b&gt;R&amp;D&lt;/b&gt;');
  });

  it("a name spelling a broadcast in entities shows as typed and decodes to nothing; mrkdwn's own escapes stay whole", () => {
    const line = COPY.slashConnected('a<b &#64;channel &commat;here', 'support');
    // The escape of the `<` is intact, so the reader sees `a<b`, not `a&lt;b`...
    expect(line).toContain('a&lt;b ');
    // ...and the name's own entities can't decode: each `&` is escaped, and marked right after its escape.
    expect(line).toContain(`a&lt;b &amp;${ZWSP}#64;channel &amp;${ZWSP}commat;here`);
    // Slack undoes mrkdwn's escapes; a lenient decoder after it finds no mention, though unmarked it would.
    expect(spellsMention(decodeSlackEntities(line))).toBe(false);
    expect(spellsMention(decodeSlackEntities(line.split(ZWSP).join('')))).toBe(true);
  });

  it('the not-mapped line links the web app as a bare URL', () => {
    expect(COPY.slashNotMapped(ORIGIN)).toContain(ORIGIN);
    expect(COPY.slashNotMapped(ORIGIN)).not.toContain(`](${ORIGIN})`);
  });

  it('connecting says how to talk to it, that the channel can see what it knows, and whose access outsiders use', () => {
    const line = COPY.slashConnected('Support', 'support-desk');
    expect(line).toContain('Support');
    expect(line).toContain('#support-desk');
    expect(line).toMatch(/\bmention me\b/i);
    expect(line).toMatch(/instructions and files/i);
    expect(line).toMatch(/everyone in this channel/i);
    expect(line).toMatch(/your access/i);
    expect(line).toMatch(/\bToday\b/);
    expect(COPY.slashReconnected('Support')).toMatch(/your access/i);
  });

  it('each refusal reason has its own line', () => {
    const lines = (['not-public', 'archived', 'shared', 'workspace-policy'] as const).map((r) =>
      COPY.slashChannelNotAllowed(r),
    );
    expect(new Set(lines).size).toBe(4);
    // A workspace policy is not ours to change: a Slack admin's, and never "try again".
    expect(COPY.slashChannelNotAllowed('workspace-policy')).toMatch(/Slack admin/);
    expect(COPY.slashChannelNotAllowed('workspace-policy')).not.toMatch(/try again/i);
  });

  it("an agent whose own bot is live: names the agent, then the bot's @handle to /invite, or its name without one (TASK-1168)", () => {
    expect(COPY.slashOwnBot('Support', { botName: 'Support Bot', handle: 'supportbot' })).toBe(
      "*Support* has its own Slack bot now, so I can't connect it here. Invite it to this channel with /invite @supportbot instead.",
    );
    expect(COPY.slashOwnBot('Support', { botName: 'Support Bot', handle: null })).toBe(
      "*Support* has its own Slack bot now, so I can't connect it here. Invite Support Bot to this channel with /invite instead.",
    );
    // After the line's own `@`, a broadcast word gets its mark.
    expect(COPY.slashOwnBot('Ops', { botName: 'Ops', handle: 'here' })).toContain(`/invite @${ZWSP}here instead.`);
    const hostile = COPY.slashOwnBot(HOSTILE, { botName: HOSTILE, handle: HOSTILE }).split(ZWSP).join('');
    expect(hostile).toContain('*&lt;!channel&gt; &amp; &lt;@U1&gt; @here* has its own Slack bot now');
  });

  it('"working on it" promises no follow-up: the late private reply fails where the bot is not a member', () => {
    expect(COPY.slashWorking).not.toMatch(/\bI'll\b|\bI will\b|\btell you\b|\blet you know\b/i);
    // It says where to look instead.
    expect(COPY.slashWorking).toMatch(/Slack settings in the web app/);
  });
});
