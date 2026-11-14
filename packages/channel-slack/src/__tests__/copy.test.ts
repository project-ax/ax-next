import { describe, expect, it } from 'vitest';
import { COPY } from '../copy.js';

const ORIGIN = 'https://canopyworks.ai';
const LINK = 'https://canopyworks.ai/workspace/agents/agt_123';
/** Today in the web app. */
const TODAY = 'https://canopyworks.ai/workspace';
/** A name from outside (an agent's, a channel's) that tries to ping, link and break the escaping. */
const HOSTILE = '<!channel> & <@U1> @here';

/**
 * The arguments every line that takes some is called with. A line missing
 * here fails `everyLine`, so a new one can't skip the checks below.
 */
const ARGS: Record<string, unknown[][]> = {
  notMapped: [[ORIGIN]],
  noAgent: [[ORIGIN]],
  artifactLink: [[LINK]],
  heldForSender: [[TODAY]],
  slashNotMapped: [[ORIGIN]],
  slashConnected: [[HOSTILE, HOSTILE]],
  slashReconnected: [[HOSTILE]],
  slashChannelNotAllowed: [['not-public'], ['archived'], ['shared'], ['workspace-policy']],
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
        'emptyReply',
        'filesUnsupported',
        'heldForOwner',
        'heldForSender',
        'mentionRefusal',
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
        'slashChannelNotAllowed',
        'slashNeedsReconnect',
        'slashWorking',
        'slashFailed',
      ].sort(),
    );
  });

  it('never names the product: the deployment is white-labeled through Branding', () => {
    for (const [key, line] of everyLine()) expect(line, key).not.toMatch(/\bAX\b/);
  });

  it('never pings anyone or a channel: no <!, <@ or <# anywhere, even around a hostile name', () => {
    for (const [key, line] of everyLine()) expect(line, key).not.toMatch(/<[!@#]/);
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

describe('COPY: the /ax replies (mrkdwn)', () => {
  const slash = (): Array<[string, string]> => everyLine().filter(([key]) => key.startsWith('slash'));

  it('hold no < or > of their own: mrkdwn would read one as the start of a link', () => {
    const lines = slash();
    expect(lines.length).toBeGreaterThanOrEqual(16);
    for (const [key, line] of lines) expect(line, key).not.toMatch(/[<>]/);
  });

  it('show a name as typed, escaped: never a link, a mention or a broadcast', () => {
    for (const line of [COPY.slashConnected(HOSTILE, HOSTILE), COPY.slashReconnected(HOSTILE)]) {
      expect(line).toContain('&lt;!channel&gt; &amp; &lt;@U1&gt;');
      expect(line).not.toContain('<!channel>');
    }
    expect(COPY.slashConnected('<b>R&D</b>', 'support')).toContain('&lt;b&gt;R&amp;D&lt;/b&gt;');
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

  it('"working on it" promises no follow-up: the late private reply fails where the bot is not a member', () => {
    expect(COPY.slashWorking).not.toMatch(/\bI'll\b|\bI will\b|\btell you\b|\blet you know\b/i);
    // It says where to look instead.
    expect(COPY.slashWorking).toMatch(/Slack settings in the web app/);
  });
});
