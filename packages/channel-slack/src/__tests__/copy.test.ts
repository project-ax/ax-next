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
  agentsShared: [[ORIGIN]],
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
  moreSkillsInToday: [[1, TODAY], [2, TODAY]],
  // A bot request's DMs (TASK-1170). The subject is plain_text: benign args only (its hostile case is in blocks.test.ts).
  botRequestSubject: [
    [{ requester: 'Sam', botName: 'Support Bot', agentName: 'Support' }],
    [{ requester: 'Sam', botName: 'Support Bot', agentName: null }],
  ],
  botRequestApproved: [['Sam'], [HOSTILE]],
  botRequestDeclined: [['Sam'], [HOSTILE]],
  botLiveForOwner: [
    [{ botName: 'Support Bot', handle: 'supportbot' }, [], 0],
    [{ botName: 'Support Bot', handle: null }, ['support', 'ops'], 0],
    [{ botName: HOSTILE, handle: HOSTILE }, [HOSTILE], 0],
    [{ botName: HOSTILE, handle: HOSTILE }, [HOSTILE], 3],
    [{ botName: HOSTILE, handle: null }, [HOSTILE, 'a', 'b'], 3],
    [{ botName: 'Ops', handle: 'here' }, ['a'], 0],
    [{ botName: 'Ops', handle: 'channel' }, ['a'], 0],
    [{ botName: 'Ops', handle: 'everyone' }, ['a'], 0],
  ],
  botDeclinedForOwner: [['Support Bot'], [HOSTILE], ['here'], ['channel']],
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
        'sharedBotInChannel',
        'channelNoLongerAllowed',
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
        'hostAllowedForNow',
        'hostEnded',
        'hostAllowedListFull',
        'hostEndedListFull',
        'hostDenied',
        'skillSubject',
        'skillAllowed',
        'skillDenied',
        'skillNeedsWeb',
        'skillFailed',
        'moreSkillsInToday',
        'noAgent',
        'agentsShared',
        'notMapped',
        'queueFull',
        'statusDefault',
        'turnFailed',
        'botUnavailable',
        'botRequestAsked',
        'botRequestSubject',
        'botRequestApprove',
        'botRequestDecline',
        'botRequestHow',
        'botRequestApproved',
        'botRequestDeclined',
        'botRequestOnlyAdmin',
        'botRequestHandled',
        'botRequestRequesterFallback',
        'botRequestAdminFallback',
        'botLiveForOwner',
        'botDeclinedForOwner',
        'memoryNotice',
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
    expect(COPY.agentsShared(ORIGIN)).toContain(`](${ORIGIN})`);
    expect(COPY.artifactLink(LINK)).toContain(`](${LINK})`);
  });

  it("a DM from someone whose own agents are all shared (TASK-1248): why none answers, and where they can talk to one", () => {
    expect(COPY.agentsShared(ORIGIN)).toBe(
      "Your agents are shared with other people, so they don't answer direct messages. " +
        `Mention one in a channel it's in, or talk to it in [the web app](${ORIGIN}).`,
    );
    // Not the line for someone with no agent at all: they have agents.
    expect(COPY.agentsShared(ORIGIN)).not.toBe(COPY.noAgent(ORIGIN));
    expect(COPY.agentsShared(ORIGIN)).not.toMatch(/\bteam\b/i);
  });

  it("a held call's lines: the sender's links Today, where it waits for them; the owner's links nothing", () => {
    expect(COPY.heldForSender(TODAY)).toContain(`](${TODAY})`);
    // Whoever reads the owner's line can't approve the call: no link to send them anywhere.
    expect(COPY.heldForOwner).not.toMatch(/\]\(|https?:/);
    expect(COPY.heldForOwner).not.toBe(COPY.heldForSender(TODAY));
  });

  it("the line for skills past the cap links Today as Markdown, as heldForSender does, and names only a count (TASK-1155)", () => {
    expect(COPY.moreSkillsInToday(1, TODAY)).toContain(`[Today](${TODAY})`);
    expect(COPY.moreSkillsInToday(2, TODAY)).toContain(`[Today](${TODAY})`);
    expect(COPY.moreSkillsInToday(2, TODAY)).toContain('2 more skills');
    expect(COPY.moreSkillsInToday(1, TODAY)).not.toBe(COPY.moreSkillsInToday(2, TODAY));
    expect(COPY.moreSkillsInToday).toHaveLength(2);
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
    ['hostAllowedForNow', COPY.hostAllowedForNow],
    ['hostEnded', COPY.hostEnded],
    ['hostAllowedListFull', COPY.hostAllowedListFull],
    ['hostEndedListFull', COPY.hostEndedListFull],
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

  it('a host prompt: its subject says the Allow lasts, Allow says from now on, the fallback says for now, and nothing links anywhere', () => {
    // Said before the click: an Allow keeps the host on the agent's allowed sites (TASK-1208).
    expect(COPY.hostSubject('api.example.com')).toBe('Wants to connect to api.example.com. Once allowed, it stays allowed.');
    expect(COPY.hostAllowed).toBe("Allowed from now on. Ask me again and I'll try it.");
    // Let through for the live session, but not kept (no allowed sites, the list full, an answer it can't read).
    expect(COPY.hostAllowedForNow).toBe("Allowed for now. Ask me again and I'll try it.");
    // Not the chat: the session ends when it idles (or a skill's Allow retires it) while the chat goes on.
    for (const line of [COPY.hostAllowed, COPY.hostAllowedForNow, COPY.hostEnded, COPY.hostAllowedListFull, COPY.hostEndedListFull]) {
      expect(line).not.toMatch(/\bchat\b/i);
    }
    // The list is full (TASK-1212): the line says why it wasn't kept, and never "from now on".
    expect(COPY.hostAllowedListFull).toBe(
      "Allowed for now, but my list of allowed sites is full, so I can't keep it. Ask me again and I'll try it.",
    );
    expect(COPY.hostEndedListFull).toBe("I couldn't keep it: my list of allowed sites is full. If I need it again, I'll ask.");
    for (const line of [COPY.hostAllowedListFull, COPY.hostEndedListFull]) {
      expect(line).not.toMatch(/from now on/i);
      expect(line).toMatch(/full/);
    }
    // A blocked host never waits in Today, so none of its lines points there.
    for (const line of [
      COPY.hostSubject('api.example.com'),
      COPY.hostAllowed,
      COPY.hostAllowedForNow,
      COPY.hostEnded,
      COPY.hostAllowedListFull,
      COPY.hostEndedListFull,
      COPY.hostDenied,
    ]) {
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
    expect(outcomes).toHaveLength(20);
    expect(new Set(outcomes.map(([, line]) => line)).size).toBe(outcomes.length);
  });
});

describe('COPY: what a channel mention can get privately, in place of its turn or before it (mrkdwn)', () => {
  /** Every line router.ts sends a channel mention's sender as an ephemeral. */
  const PRIVATE = [
    'sharedBotInChannel',
    'channelNoLongerAllowed',
    'botUnavailable',
    'channelBusy',
    'queueFull',
    'turnFailed',
  ] as const;

  it('is plain mrkdwn text: no < or >, no Markdown link, no broadcast, no product name, nothing a lenient reader takes for a mention', () => {
    for (const key of PRIVATE) {
      const line = COPY[key];
      expect(typeof line, key).toBe('string');
      expect(line, key).not.toMatch(/[<>]/);
      expect(line, key).not.toMatch(/\]\(/);
      expect(line, key).not.toMatch(BROADCAST);
      expect(line, key).not.toMatch(/\bAX\b/);
      expect(spellsMention(decodeSlackEntities(line)), key).toBe(false);
    }
  });

  it('each reads differently, so the sender can tell what happened', () => {
    expect(new Set(PRIVATE.map((key) => COPY[key])).size).toBe(PRIVATE.length);
  });

  it("the shared bot in a channel (TASK-1186): it doesn't answer there; your own agent is a DM away, a team agent comes in as its own bot", () => {
    expect(COPY.sharedBotInChannel).toBe(
      "I don't answer in channels. To talk to your own agent, send me a direct message. " +
        'To bring a team agent into this channel, invite its own bot with /invite.',
    );
    // The retired way in is never offered: no slash command of the shared app's, no connecting.
    expect(COPY.sharedBotInChannel).not.toContain('/ax');
    expect(COPY.sharedBotInChannel).not.toMatch(/connect/i);
  });

  it('busy says try again soon', () => {
    expect(COPY.channelBusy).toMatch(/try again/i);
  });

  it('a channel Slack no longer allows: says it stopped and why, in a line of its own', () => {
    expect(COPY.channelNoLongerAllowed).toMatch(/stopped answering/);
    expect(COPY.channelNoLongerAllowed).toMatch(/another organization/);
    // A private channel is answered in now (TASK-1188): the line never says the bot answers public channels only.
    expect(COPY.channelNoLongerAllowed).not.toMatch(/public channels/);
    expect(COPY.channelNoLongerAllowed).toMatch(/set me up again/);
  });

  it("an outsider whose bot's requester can no longer vouch for them is told politely, and told nothing else (TASK-1167)", () => {
    expect(COPY.botUnavailable).toBe(
      "I can't answer you here right now. A team admin needs to check my settings in the web app.",
    );
  });
});

describe("COPY: a channel's memory notice (TASK-1203; design §4c)", () => {
  it('says anyone who talks to the bot can hear it back, and names no team (TASK-1209)', () => {
    expect(COPY.memoryNotice).toBe(
      'Heads up: what I hear in this channel is shared with anyone who talks to me, and I may bring it up elsewhere.',
    );
  });

  it('is plain mrkdwn of its own: no < or >, no Markdown link, no link at all', () => {
    expect(COPY.memoryNotice).not.toMatch(/[<>]/);
    expect(COPY.memoryNotice).not.toMatch(/\]\(|https?:/);
  });
});

describe('COPY: a name from outside in a mrkdwn line (`shown`)', () => {
  // `shown` neutralizes, THEN escapes (copy.ts): the other way round, mrkdwn's
  // own `&lt;` would reach the neutralizer as an entity and be marked, and the
  // reader would see `&lt;` where the name has a `<`. botRequestApproved shows
  // a person's name through it.
  it("a name spelling a broadcast in entities shows as typed and decodes to nothing; mrkdwn's own escapes stay whole", () => {
    const line = COPY.botRequestApproved('a<b &#64;channel &commat;here');
    // The escape of the `<` is intact, so the reader sees `a<b`, not `a&lt;b`...
    expect(line).toContain('a&lt;b ');
    // ...and the name's own entities can't decode: each `&` is escaped, and marked right after its escape.
    expect(line).toContain(`a&lt;b &amp;${ZWSP}#64;channel &amp;${ZWSP}commat;here`);
    // Slack undoes mrkdwn's escapes; a lenient decoder after it finds no mention, though unmarked it would.
    expect(spellsMention(decodeSlackEntities(line))).toBe(false);
    expect(spellsMention(decodeSlackEntities(line.split(ZWSP).join('')))).toBe(true);
    // An `&` is escaped exactly once.
    expect(COPY.botRequestApproved('<b>R&D</b>')).toContain('&lt;b&gt;R&amp;D&lt;/b&gt;');
  });
});

describe("COPY: a bot request's DMs (TASK-1170)", () => {
  it("a bot request's DM lines: no <, > or Markdown link of their own, and none names the product (TASK-1170)", () => {
    const lines = everyLine().filter(([k]) => /^(botRequest|botLive|botDeclined)/.test(k));
    expect(lines.length).toBeGreaterThan(11);
    for (const [key, line] of lines) {
      const bare = line.split('&lt;').join('').split('&gt;').join('');
      expect(bare, key).not.toMatch(/[<>]/);
      expect(line, key).not.toMatch(/\]\(/);
      expect(line, key).not.toMatch(/\bAX\b/);
    }
  });

  it('a hostile name shows escaped and marked in the answered lines (TASK-1170)', () => {
    for (const line of [COPY.botRequestApproved(HOSTILE), COPY.botRequestDeclined(HOSTILE)]) {
      expect(line.split(ZWSP).join('')).toContain('&lt;!channel&gt; &amp; &lt;@U1&gt; @here');
      expect(line).toContain(ZWSP);
    }
    expect(COPY.botRequestApproved('Sam')).toBe('Sam approved this.');
    expect(COPY.botRequestDeclined('Sam')).toBe('Sam declined this.');
  });

  it('the live line names the @handle, or the bot without one, and names no channel (TASK-1170)', () => {
    expect(COPY.botLiveForOwner({ botName: 'Support Bot', handle: 'supportbot' })).toBe(
      '@supportbot is live. Invite it to a channel with /invite @supportbot.',
    );
    expect(COPY.botLiveForOwner({ botName: 'Support Bot', handle: null })).toBe(
      'Support Bot is live. Invite it to a channel with /invite.',
    );
    // After the line's own `@`, a broadcast word gets its mark.
    expect(COPY.botLiveForOwner({ botName: 'Ops', handle: 'here' })).toContain(`@${ZWSP}here is live`);
    expect(COPY.botLiveForOwner({ botName: HOSTILE, handle: null }).split(ZWSP).join('')).toContain(
      '&lt;!channel&gt; &amp; &lt;@U1&gt; @here is live',
    );
  });

  it('the declined line says how to ask again (TASK-1170)', () => {
    expect(COPY.botDeclinedForOwner('Support Bot')).toBe(
      "An admin declined your request for @Support Bot. You can ask again from the agent's Slack settings in the web app.",
    );
    expect(COPY.botDeclinedForOwner('here')).toContain(`@${ZWSP}here.`);
  });

  it('the subject has a variant with the agent and one without; the notification names nobody (TASK-1170)', () => {
    expect(COPY.botRequestSubject({ requester: 'Sam', botName: 'Support Bot', agentName: 'Support' })).toBe(
      'Sam wants to add @Support Bot (Support agent).',
    );
    expect(COPY.botRequestSubject({ requester: 'A team admin', botName: 'Support Bot', agentName: null })).toBe(
      'A team admin wants to add @Support Bot for a team agent.',
    );
    expect(COPY.botRequestAsked).toBe('A team asked for its own Slack bot.');
  });

  it('a person with no display name is named by their role, never an email, and the role names no product (TASK-1170)', () => {
    // The requester in an admin's DM subject, and who approved or declined in its redraw.
    expect(COPY.botRequestRequesterFallback).toBe('A team admin');
    expect(COPY.botRequestAdminFallback).toBe('An admin');
    expect(COPY.botRequestDeclined(COPY.botRequestAdminFallback)).toBe('An admin declined this.');
    expect(COPY.botRequestSubject({ requester: COPY.botRequestRequesterFallback, botName: 'B', agentName: null })).toBe(
      'A team admin wants to add @B for a team agent.',
    );
  });
});

describe("COPY: a bot's @handle is its display name, shown as people type it (TASK-1185)", () => {
  // A display name keeps its hyphen, upper case and space (bots.ts handleFrom),
  // and every line that names the bot by its handle shows it after `@` unchanged.
  it.each(['fern-walk', 'Fern Walk'])('%s', (handle) => {
    const bot = { botName: 'Fern', handle };
    expect(COPY.botLiveForOwner(bot)).toBe(`@${handle} is live. Invite it to a channel with /invite @${handle}.`);
  });

  // New with display names: upper case and spaces. A display name that starts
  // with a broadcast word, in any case, still gets its mark after the line's `@`.
  it.each(['Here Now', 'channel x', 'EVERYONE-else'])('%s is marked after the @', (handle) => {
    const bot = { botName: 'Fern', handle };
    const line = COPY.botLiveForOwner(bot);
    expect(line).toContain(`@${ZWSP}${handle}`);
    expect(line).not.toContain(`@${handle}`);
  });
});
