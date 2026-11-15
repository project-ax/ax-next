import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HookBus, PluginError, makeAgentContext, type AgentContext, type Logger } from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Answer } from '../answers.js';
import type { PromptAction } from '../blocks.js';
import { COPY } from '../copy.js';
import { PROMPT_MAX, PROMPT_TTL_MS } from '../limits.js';
import {
  HOST_RE,
  createHostAnswer,
  createSkillAnswer,
  hostSubject,
  skillPromptFor,
} from '../permission-prompts.js';
import { createPromptRegistry, type Prompt, type PromptContext, type PromptSubject } from '../prompts.js';
import type { InstallRow } from '../store.js';
import type { PermissionIn } from '../turn-registry.js';
import { fakeBotToken } from './fake-slack-tokens.js';

/*
  A host the sandbox was refused (the egress wall's card), asked about in
  Slack (permission-prompts.ts). The host is whatever the sandbox tried to
  reach: untrusted. It is shown, and acted on, only once it passes the egress
  proxy's own HOST_RE. Allow widens the turn's LIVE session only, as the
  prompt's own user (`proxy:add-host`, which re-checks that the user owns the
  session); Deny calls nothing. Every answer is a COPY line, and settles.

  And a catalog skill the agent asked to use (request_capability's card).
  Only a card that needs nothing but a yes gets Allow and Deny; one that
  needs a key goes to the web app. Allow does what the web app's
  `/api/chat/permission-decision` does, as the prompt's own user: it reads
  the conversation back (`conversations:get`, which owns it to that user and
  re-checks the agent) and checks it is the prompt's agent's, BEFORE
  `agent:apply-capability-grant`, which checks nothing itself.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const BOT_TOKEN = fakeBotToken('PERMISSIONPROMPTSTESTSECRET');
const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const INSTALL: InstallRow = {
  installId: INSTALL_ID,
  status: 'active',
  appId: 'A07QF9ZK2MN',
  clientId: '7512345678901.7598765432109',
  botName: 'canopy-works',
  teamId: 'T07ABCDEF12',
  teamName: 'Canopy Works',
  botUserId: 'U07BOTUSER1',
  connectedByUserId: 'usr_admin',
  createdAt: new Date('2026-11-13T10:00:00Z'),
  installedAt: new Date('2026-11-13T10:05:00Z'),
};
const PROMPT_TS = '1763121660.000200';

/** Mel's DM turn, whose sandbox was refused a host. */
const MEL_DM: PromptContext = {
  installId: INSTALL_ID,
  teamId: 'T07ABCDEF12',
  channel: 'D07DMMEL001',
  threadTs: '1763121600.000100',
  askerSlackId: 'U07MEL00001',
  userId: 'usr_mel',
  agentId: 'agt_mel',
  conversationId: 'conv_mel_dm',
  mode: 'dm',
};

/** The turn's live sandbox session, as the egress proxy named it on the card. */
const SESSION = 'sess_live_0001';
const HOST = 'api.example.com';
const HOST_PROMPT: PromptSubject = { kind: 'host', host: HOST, sessionId: SESSION };

/** The longest name HOST_RE takes: 253 characters, in labels of at most 63. */
const LONGEST = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;

/**
 * Hosts the egress proxy would never let through, so never shown: an
 * attempted broadcast, a space, uppercase (the proxy compares exactly), one
 * character past DNS's 253, a port, a trailing dot, a scheme, a path, a
 * wildcard, a label too long or badly edged, an empty one, an underscore.
 */
const REFUSED = [
  '',
  '<!channel>',
  '@here',
  'a b',
  'EXAMPLE.com',
  'Api.example.com',
  `${LONGEST}d`,
  'api.example.com:443',
  'api.example.com.',
  '.example.com',
  'https://api.example.com',
  'api.example.com/path',
  '*.example.com',
  `${'a'.repeat(64)}.com`,
  '-a.example.com',
  'a-.example.com',
  'a..example.com',
  'exa_mple.com',
];

/**
 * credential-proxy's own HOST_RE, as its source spells it: read from the
 * file, never imported (invariant 2). The twin this package keeps must match
 * it exactly, or a host shown here could be one the proxy refuses (or the
 * reverse).
 */
function proxyHostPattern(): string {
  const file = fileURLToPath(new URL('../../../credential-proxy/src/plugin.ts', import.meta.url));
  const found = /const HOST_RE =\s*\/(.+)\/;/.exec(readFileSync(file, 'utf8'));
  if (found === null) throw new Error('credential-proxy/src/plugin.ts no longer spells HOST_RE the way this test reads it');
  return found[1]!;
}

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface ProxyOptions {
  /** Who owns the live session, by the proxy's own record. Default: Mel. */
  owner?: string;
  /** The session has ended: the proxy no longer knows it. */
  ended?: boolean;
  /** Instead of the proxy's rules: this answer, or this throw. */
  answer?: () => unknown;
  /** The bus's deadline for the call, as a registration would set it. */
  timeoutMs?: number;
  /** The call answers only once this settles. */
  until?: Promise<void>;
}

/** A host answer on a bus whose `proxy:add-host` answers as credential-proxy's does, unless told otherwise. */
function world(proxy: ProxyOptions | 'absent' = {}) {
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields: { ...fields } });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };

  const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
  const calls: Array<{ ctx: AgentContext; input: unknown }> = [];
  /** The live session's allowlist: what the proxy now lets the sandbox reach. */
  const allowlist = new Set<string>();
  if (proxy !== 'absent') {
    const pattern = new RegExp(proxyHostPattern());
    bus.registerService(
      'proxy:add-host',
      'fake-credential-proxy',
      async (ctx, input) => {
        calls.push({ ctx, input: JSON.parse(JSON.stringify(input)) as unknown });
        if (proxy.until !== undefined) await proxy.until;
        if (proxy.answer !== undefined) return proxy.answer();
        // In credential-proxy's order (plugin.ts `proxy:add-host`): the host, then the session, then its owner.
        const { sessionId, host } = input as { sessionId: string; host: string };
        if (typeof host !== 'string' || !pattern.test(host)) {
          throw new PluginError({ code: 'invalid-host', plugin: 'fake-credential-proxy', message: `invalid host: ${host}` });
        }
        if (proxy.ended === true || sessionId !== SESSION) return { added: false };
        if (ctx.userId !== (proxy.owner ?? 'usr_mel')) {
          throw new PluginError({ code: 'forbidden', plugin: 'fake-credential-proxy', message: 'caller is not the session owner' });
        }
        allowlist.add(host);
        return { added: true, agentId: 'agt_mel' };
      },
      proxy.timeoutMs !== undefined ? { timeoutMs: proxy.timeoutMs } : {},
    );
  }

  let minted = 0;
  const prompts = createPromptRegistry({
    now: () => Date.parse('2026-11-14T12:00:00.000Z'),
    randomBytes: (size) => Buffer.alloc(size, ++minted),
    ttlMs: PROMPT_TTL_MS,
    max: PROMPT_MAX,
  });
  const answer = createHostAnswer({ bus });

  return {
    calls,
    allowlist,
    lines,
    /** A prompt as the turn opens one: a host card's subject and its ask. */
    open(subject: PromptSubject = HOST_PROMPT, c: PromptContext = MEL_DM): Prompt {
      const text = subject.kind === 'host' ? COPY.hostSubject(subject.host) : 'Wants to gain access to a new service or key';
      const prompt = prompts.add(c, subject, text);
      prompts.posted(prompt.id, PROMPT_TS);
      return prompt;
    },
    /** The asker's click, once the gate has proved it is theirs: run as the prompt's user, agent and conversation (answers.ts step 9). */
    click(prompt: Prompt, action: PromptAction = 'allow'): Promise<Answer> {
      const ctx = makeAgentContext({
        sessionId: 'channel-slack',
        agentId: prompt.agentId,
        userId: prompt.userId,
        conversationId: prompt.conversationId,
        logger,
      });
      return answer(ctx, prompt, action, { install: INSTALL, botToken: BOT_TOKEN, messageTs: PROMPT_TS });
    },
    logged(msg: string): Array<Record<string, unknown>> {
      return lines.filter((l) => l.msg === msg).map((l) => l.fields);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ── The tests ───────────────────────────────────────────────────────────────

describe("HOST_RE: the egress proxy's own host pattern", () => {
  it("is credential-proxy's, character for character (read from its source, not imported)", () => {
    expect(HOST_RE.source).toBe(proxyHostPattern());
    expect(HOST_RE.flags).toBe('');
  });

  it('takes a lowercase DNS name of up to 253 characters, and nothing else', () => {
    for (const host of ['api.example.com', 'a', 'xn--bcher-kva.example', `${'a'.repeat(63)}.com`, LONGEST]) {
      expect(HOST_RE.test(host), host).toBe(true);
    }
    expect(LONGEST).toHaveLength(253);
    for (const host of REFUSED) expect(HOST_RE.test(host), host).toBe(false);
  });
});

describe('hostSubject: what a host prompt asks', () => {
  it('a host the proxy would take: the ask, naming it exactly as the sandbox asked for it', () => {
    expect(hostSubject(HOST)).toBe(COPY.hostSubject(HOST));
    expect(hostSubject(HOST)).toBe('Wants to connect to api.example.com');
    expect(hostSubject(LONGEST)).toBe(COPY.hostSubject(LONGEST));
  });

  it('anything else is null: never shown, never asked about', () => {
    for (const host of REFUSED) expect(hostSubject(host), host).toBeNull();
    for (const notText of [undefined, null, 42, [HOST], { toString: () => HOST }]) {
      expect(hostSubject(notText as unknown as string), String(notText)).toBeNull();
    }
  });
});

describe('createHostAnswer: Allow and Deny on a host prompt', () => {
  it("Allow: proxy:add-host once, as the prompt's user, for exactly the session and host the card named; the host is let through for that session", async () => {
    const w = world();
    const prompt = w.open();

    expect(await w.click(prompt)).toEqual({ line: COPY.hostAllowed, settle: true });

    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.input).toEqual({ sessionId: SESSION, host: HOST });
    const ctx = w.calls[0]!.ctx;
    expect({ userId: ctx.userId, agentId: ctx.agentId, conversationId: ctx.conversationId }).toEqual({
      userId: 'usr_mel',
      agentId: 'agt_mel',
      conversationId: 'conv_mel_dm',
    });
    expect(w.allowlist).toEqual(new Set([HOST]));
    expect(w.lines).toEqual([]);
  });

  it('Allow once the chat has ended: the proxy changes nothing, and the prompt says so', async () => {
    const w = world({ ended: true });
    expect(await w.click(w.open())).toEqual({ line: COPY.hostEnded, settle: true });
    expect(w.calls).toHaveLength(1);
    expect(w.allowlist.size).toBe(0);
    expect(w.lines).toEqual([]);
  });

  it("Allow by a user the proxy says doesn't own the session: the prompt closes, nothing is let through, logged by code", async () => {
    const w = world({ owner: 'usr_ada' });
    expect(await w.click(w.open())).toEqual({ line: COPY.promptClosed, settle: true });
    expect(w.calls).toHaveLength(1);
    expect(w.allowlist.size).toBe(0);
    expect(w.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'host', stage: 'add-host', code: 'forbidden' },
    ]);
  });

  it('a host the proxy refuses (invalid-host): the prompt closes, logged by code', async () => {
    const w = world({
      answer: () => {
        throw new PluginError({ code: 'invalid-host', plugin: 'fake-credential-proxy', message: 'invalid host' });
      },
    });
    expect(await w.click(w.open())).toEqual({ line: COPY.promptClosed, settle: true });
    expect(w.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'host', stage: 'add-host', code: 'invalid-host' },
    ]);
  });

  it("any other failure is the gate's, thrown as it is: the asker can try again (adding a host twice changes nothing)", async () => {
    const down = new PluginError({ code: 'store-unavailable', plugin: 'fake-credential-proxy', message: 'proxy down' });
    const w = world({
      answer: () => {
        throw down;
      },
    });
    await expect(w.click(w.open())).rejects.toBe(down);
    expect(w.calls).toHaveLength(1);
  });

  it("past the bus's deadline, it fails only once the proxy's call has settled: nothing it started still runs when the gate lets the prompt go", async () => {
    vi.useFakeTimers();
    const proxyAnswers = deferred();
    const w = world({ timeoutMs: 1_000, until: proxyAnswers.promise });
    let settled = false;
    const outcome = w
      .click(w.open())
      .finally(() => {
        settled = true;
      })
      .then(
        () => 'answered',
        (err: unknown) => err,
      );

    // Well past the bus's deadline, the proxy is still working on it: so is the answer.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    proxyAnswers.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toMatchObject({ name: 'PluginError', code: 'timeout' });
    expect(w.calls).toHaveLength(1);
  });

  it("an answer it can't read: the prompt closes (it may have acted), logged by code", async () => {
    for (const unreadable of [undefined, null, 'added', [], {}, { added: 'yes' }, { added: 1 }]) {
      const w = world({ answer: () => unreadable });
      expect(await w.click(w.open()), JSON.stringify(unreadable)).toEqual({ line: COPY.promptClosed, settle: true });
      expect(w.logged('slack_prompt_failed'), JSON.stringify(unreadable)).toEqual([
        { installId: INSTALL_ID, kind: 'host', stage: 'add-host', code: 'bad-response' },
      ]);
    }
  });

  it('no proxy:add-host on the bus: the prompt closes, and nothing is called', async () => {
    const w = world('absent');
    expect(await w.click(w.open())).toEqual({ line: COPY.promptClosed, settle: true });
    expect(w.calls).toEqual([]);
  });

  it('Deny: nothing is called, and the prompt says so', async () => {
    const w = world();
    expect(await w.click(w.open(), 'deny')).toEqual({ line: COPY.hostDenied, settle: true });
    expect(w.calls).toEqual([]);
    expect(w.allowlist.size).toBe(0);
    expect(w.lines).toEqual([]);
  });

  it('a host past HOST_RE never reaches the proxy, whatever the prompt holds: the prompt closes, logged by code', async () => {
    // The registry bounds a host's length only; the answer checks the host again before it acts.
    for (const host of ['<!channel>', 'a b', 'EXAMPLE.com', 'api.example.com:443']) {
      const w = world();
      expect(await w.click(w.open({ kind: 'host', host, sessionId: SESSION })), host).toEqual({
        line: COPY.promptClosed,
        settle: true,
      });
      expect(w.calls, host).toEqual([]);
      expect(w.logged('slack_prompt_failed'), host).toEqual([
        { installId: INSTALL_ID, kind: 'host', stage: 'add-host', code: 'invalid-host' },
      ]);
    }
  });

  it("a prompt about anything else is not this answer's: it closes, and nothing is called", async () => {
    const w = world();
    const held = w.open({ kind: 'decision', decisionId: 'dec_0001' });
    expect(await w.click(held)).toEqual({ line: COPY.promptClosed, settle: true });
    expect(await w.click(held, 'deny')).toEqual({ line: COPY.promptClosed, settle: true });
    expect(w.calls).toEqual([]);
  });

  it("an action this build doesn't know does nothing", async () => {
    const w = world();
    expect(await w.click(w.open(), 'maybe' as PromptAction)).toEqual({ line: COPY.promptClosed, settle: true });
    expect(w.calls).toEqual([]);
  });

  it('every answer is one of its COPY lines, and settles: the redraw is mrkdwn, so nothing else may reach it', async () => {
    const outs: Answer[] = [];
    const allowed = world();
    outs.push(await allowed.click(allowed.open()));
    const ended = world({ ended: true });
    outs.push(await ended.click(ended.open()));
    const notOwner = world({ owner: 'usr_ada' });
    outs.push(await notOwner.click(notOwner.open()));
    const unreadable = world({ answer: () => null });
    outs.push(await unreadable.click(unreadable.open()));
    const absent = world('absent');
    outs.push(await absent.click(absent.open()));
    const denied = world();
    outs.push(await denied.click(denied.open(), 'deny'));
    const hostile = world();
    outs.push(await hostile.click(hostile.open({ kind: 'host', host: '<!channel>', sessionId: SESSION })));

    const lines = new Set([COPY.hostAllowed, COPY.hostEnded, COPY.hostDenied, COPY.promptClosed]);
    for (const out of outs) {
      expect(lines.has(out.line), out.line).toBe(true);
      expect(out.settle).toBe(true);
    }
    expect(new Set(outs.map((o) => o.line))).toEqual(lines);
  });

  it('logs name the install, the kind, a stage and a code: never the host, the session, an id, a user or a token', async () => {
    const lines: Line[] = [];
    const notOwner = world({ owner: 'usr_ada' });
    const prompt = notOwner.open();
    await notOwner.click(prompt);
    lines.push(...notOwner.lines);
    const unreadable = world({ answer: () => ({ added: HOST }) });
    await unreadable.click(unreadable.open());
    lines.push(...unreadable.lines);
    const hostile = world();
    await hostile.click(hostile.open({ kind: 'host', host: '<!channel>', sessionId: SESSION }));
    lines.push(...hostile.lines);

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.msg).toBe('slack_prompt_failed');
      expect(Object.keys(line.fields).sort()).toEqual(['code', 'installId', 'kind', 'stage']);
    }
    const all = JSON.stringify(lines);
    for (const leak of [HOST, '<!channel>', SESSION, 'usr_mel', 'usr_ada', 'agt_mel', 'conv_mel_dm', BOT_TOKEN, prompt.id]) {
      expect(all, leak).not.toContain(leak);
    }
  });
});

// ── A catalog skill the agent asked to use (request_capability's card) ─────

const PUBLIC_ORIGIN = 'https://ax.example';
/** Today in the web app, where the same request waits (channel-web keeps skill cards there). */
const TODAY = 'https://ax.example/workspace';
const SKILL_ID = 'gmail-sender';
const SKILL_PROMPT: PromptSubject = { kind: 'skill', skillId: SKILL_ID };
/** The catalog skill's description: the card's, as the catalog's author wrote it. */
const DESCRIPTION = 'Reads and sends email from your Gmail account.';
const GRANT = 'agent:apply-capability-grant';
const CONVERSATION_GET = 'conversations:get';

type SkillCard = Extract<PermissionIn, { kind: 'skill' }>;

/** A bus with exactly these services on it, each answering nothing in particular. */
function busWith(...hooks: string[]): HookBus {
  const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
  for (const hook of hooks) bus.registerService(hook, 'fake', async () => ({}));
  return bus;
}

interface SkillOptions {
  /** conversations:get's answer, instead of the conversations plugin's own: this, or this throw. */
  conversation?: () => unknown;
  /** agent:apply-capability-grant's answer, instead of `{ attached: true }`: this, or this throw. */
  grant?: () => unknown;
  /** The grant's bus deadline, as a registration would set it. */
  grantTimeoutMs?: number;
  /** The grant answers only once this settles. */
  grantUntil?: Promise<void>;
  /** One of the two services is not on the bus. */
  absent?: typeof GRANT | typeof CONVERSATION_GET;
}

/**
 * A skill answer on a bus whose `conversations:get` answers as @ax/conversations
 * does (Mel's own DM conversation, with her personal agent; anyone else's is
 * `not-found`) and whose `agent:apply-capability-grant` attaches the skill,
 * unless told otherwise. Both record each call, in order.
 */
function skillWorld(o: SkillOptions = {}) {
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields: { ...fields } });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };

  const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
  const calls: Array<{ hook: string; ctx: AgentContext; input: unknown }> = [];
  const record = (hook: string, ctx: AgentContext, input: unknown): void => {
    calls.push({ hook, ctx, input: JSON.parse(JSON.stringify(input)) as unknown });
  };
  if (o.absent !== CONVERSATION_GET) {
    bus.registerService(CONVERSATION_GET, 'fake-conversations', async (ctx, input) => {
      record(CONVERSATION_GET, ctx, input);
      if (o.conversation !== undefined) return o.conversation();
      // As @ax/conversations answers it: only its owner's own conversation, with its frozen agent.
      const { conversationId, userId } = input as { conversationId: string; userId: string };
      if (conversationId !== 'conv_mel_dm' || userId !== 'usr_mel') {
        throw new PluginError({ code: 'not-found', plugin: 'fake-conversations', message: `conversation '${conversationId}' not found` });
      }
      return { conversation: { conversationId, userId, agentId: 'agt_mel', title: null }, turns: [] };
    });
  }
  if (o.absent !== GRANT) {
    bus.registerService(
      GRANT,
      'fake-chat-orchestrator',
      async (ctx, input) => {
        record(GRANT, ctx, input);
        if (o.grantUntil !== undefined) await o.grantUntil;
        if (o.grant !== undefined) return o.grant();
        return { attached: true };
      },
      o.grantTimeoutMs !== undefined ? { timeoutMs: o.grantTimeoutMs } : {},
    );
  }

  let minted = 0;
  const prompts = createPromptRegistry({
    now: () => Date.parse('2026-11-14T12:00:00.000Z'),
    randomBytes: (size) => Buffer.alloc(size, ++minted),
    ttlMs: PROMPT_TTL_MS,
    max: PROMPT_MAX,
  });
  const answer = createSkillAnswer({ bus, publicOrigin: PUBLIC_ORIGIN });

  return {
    calls,
    lines,
    /** The hooks called, in order. */
    hooks: (): string[] => calls.map((c) => c.hook),
    /** A prompt as the turn opens one: a skill card's subject and its ask. */
    open(subject: PromptSubject = SKILL_PROMPT, c: PromptContext = MEL_DM): Prompt {
      const prompt = prompts.add(c, subject, COPY.skillSubject(SKILL_ID, DESCRIPTION));
      prompts.posted(prompt.id, PROMPT_TS);
      return prompt;
    },
    /** The asker's click, once the gate has proved it is theirs: run as the prompt's user, agent and conversation (answers.ts step 9). */
    click(prompt: Prompt, action: PromptAction = 'allow'): Promise<Answer> {
      const ctx = makeAgentContext({
        sessionId: 'channel-slack',
        agentId: prompt.agentId,
        userId: prompt.userId,
        conversationId: prompt.conversationId,
        logger,
      });
      return answer(ctx, prompt, action, { install: INSTALL, botToken: BOT_TOKEN, messageTs: PROMPT_TS });
    },
    logged(msg: string): Array<Record<string, unknown>> {
      return lines.filter((l) => l.msg === msg).map((l) => l.fields);
    },
  };
}

const skillFailed = (code: string, stage = 'ownership') => ({ installId: INSTALL_ID, kind: 'skill', stage, code });

describe('skillPromptFor: how a skill card is asked about in Slack', () => {
  const card = (over: Partial<SkillCard> = {}): SkillCard => ({
    kind: 'skill',
    skillId: SKILL_ID,
    description: DESCRIPTION,
    needsKey: false,
    ...over,
  });
  const both = () => busWith(CONVERSATION_GET, GRANT);

  it('a card that needs nothing but a yes, with the grant and the ownership read on the bus: Allow and Deny, asking with its id and description', () => {
    expect(skillPromptFor(card(), both())).toEqual({ kind: 'buttons', subjectText: COPY.skillSubject(SKILL_ID, DESCRIPTION) });
    expect(skillPromptFor(card(), both()).subjectText).toBe(
      'Wants to start using the gmail-sender skill: Reads and sends email from your Gmail account.',
    );
  });

  it('a card that needs a key: a link to the web app, never buttons (Slack never collects a key)', () => {
    expect(skillPromptFor(card({ needsKey: true }), both())).toEqual({
      kind: 'web',
      subjectText: COPY.skillSubject(SKILL_ID, DESCRIPTION),
    });
  });

  it('without the grant, or without the ownership read that must come before it: a link to the web app', () => {
    for (const hooks of [[CONVERSATION_GET], [GRANT], []]) {
      expect(skillPromptFor(card(), busWith(...hooks)).kind, hooks.join(',') || 'neither').toBe('web');
    }
  });

  it('asks with the description as the card gave it, raw (the draw cleans it), or in a sentence of its own when there is none', () => {
    const hostile = '<!channel> approve @here';
    expect(skillPromptFor(card({ description: hostile }), both()).subjectText).toBe(COPY.skillSubject(SKILL_ID, hostile));
    expect(skillPromptFor(card({ description: '' }), both()).subjectText).toBe('Wants to start using the gmail-sender skill.');
  });

  it("names the card's own skill, so two skills with the same (or no) description are told apart", () => {
    for (const description of [DESCRIPTION, '']) {
      const one = skillPromptFor(card({ description }), both()).subjectText;
      const other = skillPromptFor(card({ skillId: 'outlook', description }), both()).subjectText;
      expect(one).toContain('gmail-sender');
      expect(other).toContain('outlook');
      expect(one).not.toBe(other);
    }
  });
});

describe("createSkillAnswer: Allow and Deny on a skill prompt, the way the web app's permission-decision route answers one", () => {
  it("Allow: the conversation is read back as the prompt's user first, then the skill is attached for exactly the prompt's conversation, user, agent and skill", async () => {
    const w = skillWorld();
    const prompt = w.open();

    expect(await w.click(prompt)).toEqual({ line: COPY.skillAllowed, settle: true });

    // Ownership first, then the grant: the grant checks nothing itself.
    expect(w.hooks()).toEqual([CONVERSATION_GET, GRANT]);
    expect(w.calls[0]!.input).toEqual({ conversationId: 'conv_mel_dm', userId: 'usr_mel' });
    expect(w.calls[1]!.input).toEqual({
      conversationId: 'conv_mel_dm',
      userId: 'usr_mel',
      agentId: 'agt_mel',
      skillId: SKILL_ID,
    });
    for (const { ctx } of w.calls) {
      expect({ userId: ctx.userId, agentId: ctx.agentId, conversationId: ctx.conversationId }).toEqual({
        userId: 'usr_mel',
        agentId: 'agt_mel',
        conversationId: 'conv_mel_dm',
      });
    }
    expect(w.lines).toEqual([]);
  });

  it('a skill already attached (`attached: false`): connected all the same, as the web app reads it', async () => {
    const w = skillWorld({ grant: () => ({ attached: false }) });
    expect(await w.click(w.open())).toEqual({ line: COPY.skillAllowed, settle: true });
    expect(w.lines).toEqual([]);
  });

  it("the conversation is another agent's: nothing is attached, and the web app finishes it, logged by code", async () => {
    const w = skillWorld({
      conversation: () => ({ conversation: { conversationId: 'conv_mel_dm', userId: 'usr_mel', agentId: 'agt_other' }, turns: [] }),
    });
    expect(await w.click(w.open())).toEqual({ line: COPY.skillFailed(TODAY), settle: true });
    expect(w.hooks()).toEqual([CONVERSATION_GET]);
    expect(w.logged('slack_prompt_failed')).toEqual([skillFailed('other-agent')]);
  });

  it("the conversation isn't the prompt's user's: refused as the web route refuses it, nothing attached", async () => {
    // A prompt whose recorded user doesn't own the conversation: @ax/conversations says not-found.
    const w = skillWorld();
    const notMel = w.open(SKILL_PROMPT, { ...MEL_DM, userId: 'usr_ada' });
    expect(await w.click(notMel)).toEqual({ line: COPY.skillFailed(TODAY), settle: true });
    expect(w.calls.map((c) => c.input)).toEqual([{ conversationId: 'conv_mel_dm', userId: 'usr_ada' }]);
    expect(w.logged('slack_prompt_failed')).toEqual([skillFailed('not-found')]);
  });

  it.each(['not-found', 'forbidden'])(
    'the read refuses (%s: gone, not theirs, or the agent is out of their reach): nothing is attached, the web app finishes it',
    async (code) => {
      const w = skillWorld({
        conversation: () => {
          throw new PluginError({ code, plugin: 'fake-conversations', message: 'refused' });
        },
      });
      expect(await w.click(w.open())).toEqual({ line: COPY.skillFailed(TODAY), settle: true });
      expect(w.hooks()).toEqual([CONVERSATION_GET]);
      expect(w.logged('slack_prompt_failed')).toEqual([skillFailed(code)]);
    },
  );

  it("an answer from the read it can't use: nothing is attached, the web app finishes it, logged by code", async () => {
    for (const unreadable of [undefined, null, 'conv_mel_dm', [], {}, { conversation: null }, { conversation: [] }]) {
      const w = skillWorld({ conversation: () => unreadable });
      expect(await w.click(w.open()), JSON.stringify(unreadable)).toEqual({ line: COPY.skillFailed(TODAY), settle: true });
      expect(w.hooks(), JSON.stringify(unreadable)).toEqual([CONVERSATION_GET]);
      expect(w.logged('slack_prompt_failed'), JSON.stringify(unreadable)).toEqual([skillFailed('bad-response')]);
    }
    // A conversation that names no agent, or another kind of value, is not the prompt's agent's.
    for (const agentId of [undefined, null, 7, '']) {
      const w = skillWorld({ conversation: () => ({ conversation: { conversationId: 'conv_mel_dm', userId: 'usr_mel', agentId } }) });
      expect(await w.click(w.open()), String(agentId)).toEqual({ line: COPY.skillFailed(TODAY), settle: true });
      expect(w.hooks(), String(agentId)).toEqual([CONVERSATION_GET]);
      expect(w.logged('slack_prompt_failed'), String(agentId)).toEqual([skillFailed('other-agent')]);
    }
  });

  it("any other failure of the read is the gate's, thrown as it is (the asker can try again): nothing is attached", async () => {
    const down = new PluginError({ code: 'store-unavailable', plugin: 'fake-conversations', message: 'database down' });
    const w = skillWorld({
      conversation: () => {
        throw down;
      },
    });
    await expect(w.click(w.open())).rejects.toBe(down);
    expect(w.hooks()).toEqual([CONVERSATION_GET]);
  });

  it('the grant refuses the skill (skill-not-found: gone from the catalog since it was asked for): the web app, logged by code', async () => {
    const w = skillWorld({
      grant: () => {
        throw new PluginError({ code: 'skill-not-found', plugin: 'fake-skills', message: `skill '${SKILL_ID}' is not installed` });
      },
    });
    expect(await w.click(w.open())).toEqual({ line: COPY.skillFailed(TODAY), settle: true });
    expect(w.logged('slack_prompt_failed')).toEqual([skillFailed('skill-not-found', 'grant')]);
  });

  it("any other failure of the grant is the gate's, thrown as it is: the asker can try again (attaching twice changes nothing)", async () => {
    const down = new PluginError({ code: 'unknown', plugin: 'fake-chat-orchestrator', message: 'attach failed' });
    const w = skillWorld({
      grant: () => {
        throw down;
      },
    });
    await expect(w.click(w.open())).rejects.toBe(down);
    expect(w.hooks()).toEqual([CONVERSATION_GET, GRANT]);
  });

  it("an answer from the grant it can't read: it may have attached, so not 'try again': the web app, logged by code", async () => {
    for (const unreadable of [undefined, null, 'attached', [], {}, { attached: 'yes' }, { attached: 1 }]) {
      const w = skillWorld({ grant: () => unreadable });
      expect(await w.click(w.open()), JSON.stringify(unreadable)).toEqual({ line: COPY.skillFailed(TODAY), settle: true });
      expect(w.logged('slack_prompt_failed'), JSON.stringify(unreadable)).toEqual([skillFailed('bad-response', 'grant')]);
    }
  });

  it("past the bus's deadline, the grant fails only once it has settled: nothing it started still runs when the gate lets the prompt go", async () => {
    vi.useFakeTimers();
    const grantAnswers = deferred();
    const w = skillWorld({ grantTimeoutMs: 1_000, grantUntil: grantAnswers.promise });
    let settled = false;
    const outcome = w
      .click(w.open())
      .finally(() => {
        settled = true;
      })
      .then(
        () => 'answered',
        (err: unknown) => err,
      );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    grantAnswers.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toMatchObject({ name: 'PluginError', code: 'timeout' });
    expect(w.hooks()).toEqual([CONVERSATION_GET, GRANT]);
  });

  it.each([GRANT, CONVERSATION_GET] as const)(
    'without %s on the bus: nothing is called, and the web app finishes it',
    async (absent) => {
      const w = skillWorld({ absent });
      expect(await w.click(w.open())).toEqual({ line: COPY.skillFailed(TODAY), settle: true });
      expect(w.calls).toEqual([]);
      expect(w.logged('slack_prompt_failed')).toEqual([skillFailed('unavailable', 'grant')]);
    },
  );

  it('Deny: nothing is called, and the prompt says so', async () => {
    const w = skillWorld();
    expect(await w.click(w.open(), 'deny')).toEqual({ line: COPY.skillDenied, settle: true });
    expect(w.calls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it("a prompt about anything else is not this answer's: it closes, and nothing is called", async () => {
    const w = skillWorld();
    for (const subject of [
      { kind: 'decision', decisionId: 'dec_0001' },
      { kind: 'host', host: 'api.example.com', sessionId: SESSION },
    ] as PromptSubject[]) {
      const other = w.open(subject);
      expect(await w.click(other), subject.kind).toEqual({ line: COPY.promptClosed, settle: true });
      expect(await w.click(other, 'deny'), subject.kind).toEqual({ line: COPY.promptClosed, settle: true });
    }
    expect(w.calls).toEqual([]);
  });

  it("an action this build doesn't know does nothing", async () => {
    const w = skillWorld();
    expect(await w.click(w.open(), 'maybe' as PromptAction)).toEqual({ line: COPY.promptClosed, settle: true });
    expect(w.calls).toEqual([]);
  });

  it('every answer is one of its COPY lines, and settles: the redraw is mrkdwn, so nothing else may reach it', async () => {
    const outs: Answer[] = [];
    const allowed = skillWorld();
    outs.push(await allowed.click(allowed.open()));
    const otherAgent = skillWorld({ conversation: () => ({ conversation: { agentId: 'agt_other' } }) });
    outs.push(await otherAgent.click(otherAgent.open()));
    const unreadable = skillWorld({ grant: () => null });
    outs.push(await unreadable.click(unreadable.open()));
    const absent = skillWorld({ absent: GRANT });
    outs.push(await absent.click(absent.open()));
    const denied = skillWorld();
    outs.push(await denied.click(denied.open(), 'deny'));
    const unknown = skillWorld();
    outs.push(await unknown.click(unknown.open(), 'maybe' as PromptAction));

    const lines = new Set([COPY.skillAllowed, COPY.skillFailed(TODAY), COPY.skillDenied, COPY.promptClosed]);
    for (const out of outs) {
      expect(lines.has(out.line), out.line).toBe(true);
      expect(out.settle).toBe(true);
    }
    expect(new Set(outs.map((o) => o.line))).toEqual(lines);
  });

  it('logs name the install, the kind, a stage and a code: never the skill, its description, an id, a user or a token', async () => {
    const lines: Line[] = [];
    const otherAgent = skillWorld({ conversation: () => ({ conversation: { agentId: 'agt_other' } }) });
    const prompt = otherAgent.open();
    await otherAgent.click(prompt);
    lines.push(...otherAgent.lines);
    const gone = skillWorld({
      grant: () => {
        throw new PluginError({ code: 'skill-not-found', plugin: 'fake-skills', message: `skill '${SKILL_ID}' is not installed` });
      },
    });
    await gone.click(gone.open());
    lines.push(...gone.lines);
    const unreadable = skillWorld({ grant: () => ({ attached: SKILL_ID }) });
    await unreadable.click(unreadable.open());
    lines.push(...unreadable.lines);

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.msg).toBe('slack_prompt_failed');
      expect(Object.keys(line.fields).sort()).toEqual(['code', 'installId', 'kind', 'stage']);
    }
    const all = JSON.stringify(lines);
    for (const leak of [SKILL_ID, DESCRIPTION, 'usr_mel', 'agt_mel', 'agt_other', 'conv_mel_dm', BOT_TOKEN, prompt.id]) {
      expect(all, leak).not.toContain(leak);
    }
  });
});
