import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HookBus, PluginError, makeAgentContext, type AgentContext, type Logger } from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Answer } from '../answers.js';
import type { PromptAction } from '../blocks.js';
import { COPY } from '../copy.js';
import { PROMPT_MAX, PROMPT_TTL_MS } from '../limits.js';
import { HOST_RE, createHostAnswer, hostSubject } from '../permission-prompts.js';
import { createPromptRegistry, type Prompt, type PromptContext, type PromptSubject } from '../prompts.js';
import type { InstallRow } from '../store.js';
import { fakeBotToken } from './fake-slack-tokens.js';

/*
  A host the sandbox was refused (the egress wall's card), asked about in
  Slack (permission-prompts.ts). The host is whatever the sandbox tried to
  reach: untrusted. It is shown, and acted on, only once it passes the egress
  proxy's own HOST_RE. Allow widens the turn's LIVE session only, as the
  prompt's own user (`proxy:add-host`, which re-checks that the user owns the
  session); Deny calls nothing. Every answer is a COPY line, and settles.
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
