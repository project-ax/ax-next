import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { describe, expect, it } from 'vitest';
import {
  TURN_EVENT_HOOKS,
  createTurnRegistry,
  subscribeTurnEvents,
  type PermissionIn,
  type StreamChunkIn,
  type TurnErrorIn,
  type TurnSink,
} from '../turn-registry.js';

/** A logger that keeps nothing: these tests aren't about the log. */
const QUIET = { warn: (): void => undefined };

/** A logger that keeps every warn line. */
function recordingLogger() {
  const lines: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
  return { lines, logger: { warn: (msg: string, fields?: Record<string, unknown>): void => void lines.push({ msg, fields }) } };
}

const CONVERSATION = 'conv_alice_slack';
const REQ = 'req-aaaaaaaaaaaa';

function recordingSink(over: Partial<TurnSink> = {}) {
  const seen: string[] = [];
  const chunks: StreamChunkIn[] = [];
  const permissions: PermissionIn[] = [];
  const sink: TurnSink = {
    reqId: REQ,
    conversationId: CONVERSATION,
    mode: 'dm',
    chunk: (c) => {
      chunks.push(c);
      seen.push(`chunk ${c.kind ?? '?'}`);
    },
    end: () => seen.push('end'),
    error: () => seen.push('error'),
    permission: (p) => {
      permissions.push(p);
      seen.push(`permission ${p.kind}`);
    },
    ...over,
  };
  return { sink, seen, chunks, permissions };
}

const ctxFor = (conversationId?: string) =>
  makeAgentContext({
    sessionId: 's',
    agentId: 'agt_alice',
    userId: 'usr_alice',
    // The IPC listener restamps ctx.reqId per request; only the payload's names the turn.
    reqId: 'req-ipc-restamped',
    ...(conversationId !== undefined ? { conversationId } : {}),
  });

describe('modeOf: which kind of Slack turn a spawn is for (TASK-1131)', () => {
  it("names a registered turn's mode, for its own conversation only, until it unregisters", () => {
    const r = createTurnRegistry({ logger: QUIET });
    const undo = r.register(recordingSink({ mode: 'external' }).sink);
    expect(r.modeOf(REQ, CONVERSATION)).toBe('external');
    expect(r.modeOf(REQ, 'conv_someone_else')).toBeNull();
    expect(r.modeOf(REQ, undefined)).toBeNull();
    expect(r.modeOf('req-never-registered', CONVERSATION)).toBeNull();
    undo();
    expect(r.modeOf(REQ, CONVERSATION)).toBeNull();
  });

  it('a later sink under the same reqId answers with its own mode, and the first undo leaves it', () => {
    const r = createTurnRegistry({ logger: QUIET });
    const undoFirst = r.register(recordingSink({ mode: 'dm' }).sink);
    r.register(recordingSink({ mode: 'attended' }).sink);
    undoFirst();
    expect(r.modeOf(REQ, CONVERSATION)).toBe('attended');
  });
});

describe('createTurnRegistry', () => {
  it("another reqId's chunk is ignored", () => {
    const r = createTurnRegistry({ logger: QUIET });
    const { sink, chunks } = recordingSink();
    r.register(sink);
    r.onStreamChunk({ reqId: 'req-someone-else', kind: 'text', text: 'not yours' });
    r.onStreamChunk({ reqId: REQ, kind: 'text', text: 'yours' });
    expect(chunks).toEqual([{ reqId: REQ, kind: 'text', text: 'yours' }]);
  });

  it('a chunk is handed on with only the fields it names, each of the right type', () => {
    const r = createTurnRegistry({ logger: QUIET });
    const { sink, chunks } = recordingSink();
    r.register(sink);
    r.onStreamChunk({
      reqId: REQ,
      kind: 'tool-use',
      toolCallId: 'call_1',
      toolName: 'mcp__ax-sandbox-tools__show_visual',
      activityPhrase: 42,
      input: { secret: 'never needed' },
      isError: 'yes',
    });
    expect(chunks).toEqual([
      { reqId: REQ, kind: 'tool-use', toolCallId: 'call_1', toolName: 'mcp__ax-sandbox-tools__show_visual' },
    ]);
  });

  it('turn-end for the same conversation with a different reqId is ignored', () => {
    const r = createTurnRegistry({ logger: QUIET });
    const { sink, seen } = recordingSink();
    r.register(sink);
    r.onTurnEnd(ctxFor(CONVERSATION), { reqId: 'req-another-turn', reason: 'complete' });
    expect(seen).toEqual([]);
    r.onTurnEnd(ctxFor(CONVERSATION), { reqId: REQ, reason: 'complete' });
    expect(seen).toEqual(['end']);
  });

  it('turn-end for another conversation is ignored, even naming this reqId', () => {
    const r = createTurnRegistry({ logger: QUIET });
    const { sink, seen } = recordingSink();
    r.register(sink);
    r.onTurnEnd(ctxFor('conv_someone_else'), { reqId: REQ });
    r.onTurnEnd(ctxFor(undefined), { reqId: REQ });
    expect(seen).toEqual([]);
  });

  it('a folded reqId ends the turn', () => {
    const r = createTurnRegistry({ logger: QUIET });
    const { sink, seen } = recordingSink();
    r.register(sink);
    r.onTurnEnd(ctxFor(CONVERSATION), { reqId: 'req-the-turn-that-answered', foldedReqIds: [REQ] });
    expect(seen).toEqual(['end']);
  });

  it('only a real array of exact ids counts as folded', () => {
    const r = createTurnRegistry({ logger: QUIET });
    const { sink, seen } = recordingSink();
    r.register(sink);
    for (const foldedReqIds of [REQ, { 0: REQ }, [`${REQ} `], [REQ.toUpperCase()]]) {
      r.onTurnEnd(ctxFor(CONVERSATION), { reqId: 'req-other', foldedReqIds });
    }
    expect(seen).toEqual([]);
  });

  /** Turn-ends that name no turn: a turn run dark. */
  const DARK_ENDS: unknown[] = [{}, { reqId: '' }, { reqId: 42 }, undefined, null, 'text'];

  it('a turn-end with no reqId ends a turn that has begun: one whose own chunk came (a turn run dark)', () => {
    for (const payload of DARK_ENDS) {
      const r = createTurnRegistry({ logger: QUIET });
      const { sink, seen } = recordingSink();
      r.register(sink);
      r.onStreamChunk({ reqId: REQ, kind: 'text', text: 'hi' });
      r.onTurnEnd(ctxFor(CONVERSATION), payload);
      expect(seen, JSON.stringify(payload)).toEqual(['chunk text', 'end']);
    }
  });

  /*
    A warm agent's reaction to a Deny runs dark (decisions:dismiss wakes it
    with no continuation id), and its turn-end names no turn. The person's
    next message, sent right after the Deny, has its turn registered by then
    and not yet begun: ending it there ended their reply with nothing said,
    and their real answer streamed to nobody.
  */
  it("a turn-end with no reqId before the turn has begun is another turn's: it doesn't end this one", () => {
    for (const payload of DARK_ENDS) {
      const r = createTurnRegistry({ logger: QUIET });
      const { sink, seen } = recordingSink();
      r.register(sink);
      r.onTurnEnd(ctxFor(CONVERSATION), payload);
      // Another turn's chunk doesn't begin this one.
      r.onStreamChunk({ reqId: 'req-someone-else', kind: 'text', text: 'not yours' });
      r.onTurnEnd(ctxFor(CONVERSATION), payload);
      expect(seen, JSON.stringify(payload)).toEqual([]);
      expect(r.size()).toBe(1);
      // Its own turn then runs, and ends, as any turn does.
      r.onStreamChunk({ reqId: REQ, kind: 'text', text: 'yours' });
      r.onTurnEnd(ctxFor(CONVERSATION), { reqId: REQ, reason: 'complete' });
      expect(seen, JSON.stringify(payload)).toEqual(['chunk text', 'end']);
    }
  });

  it('a turn-end naming this reqId, or folding it, ends it before its first chunk', () => {
    for (const payload of [{ reqId: REQ }, { reqId: 'req-the-turn-that-answered', foldedReqIds: [REQ] }, { foldedReqIds: [REQ] }]) {
      const r = createTurnRegistry({ logger: QUIET });
      const { sink, seen } = recordingSink();
      r.register(sink);
      r.onTurnEnd(ctxFor(CONVERSATION), payload);
      expect(seen, JSON.stringify(payload)).toEqual(['end']);
    }
  });

  it('a sink registered again under the same reqId begins afresh: the one before it began, not this one', () => {
    const r = createTurnRegistry({ logger: QUIET });
    const first = recordingSink();
    const undo = r.register(first.sink);
    r.onStreamChunk({ reqId: REQ, kind: 'text', text: 'first' });
    undo();
    const second = recordingSink();
    r.register(second.sink);
    r.onTurnEnd(ctxFor(CONVERSATION), {});
    expect(second.seen).toEqual([]);
    r.onStreamChunk({ reqId: REQ, kind: 'text', text: 'second' });
    r.onTurnEnd(ctxFor(CONVERSATION), {});
    expect(second.seen).toEqual(['chunk text', 'end']);
  });

  it('turn-error is matched by reqId only', () => {
    const r = createTurnRegistry({ logger: QUIET });
    const { sink, seen } = recordingSink();
    r.register(sink);
    r.onTurnError({ reason: 'chat-run-timeout' });
    r.onTurnError({ reqId: 'req-other', reason: 'chat-run-timeout' });
    r.onTurnError(null);
    expect(seen).toEqual([]);
    r.onTurnError({ reqId: REQ, reason: 'chat-run-timeout' });
    expect(seen).toEqual(['error']);
  });

  it('a turn-error hands its sink the reason and the detail, each only when a string, and nothing else', () => {
    const r = createTurnRegistry({ logger: QUIET });
    const got: TurnErrorIn[] = [];
    r.register(recordingSink({ error: (e) => got.push(e) }).sink);
    r.onTurnError({ reqId: REQ, reason: 'dev-service-failed', detail: 'Dev service x failed', error: 'raw', extra: 1 });
    r.onTurnError({ reqId: REQ, reason: 42, detail: { x: 1 } });
    // Strict: a field that isn't a string is absent, not present as undefined.
    expect(got).toStrictEqual([{ reason: 'dev-service-failed', detail: 'Dev service x failed' }, {}]);
  });

  it('malformed payloads are ignored, never thrown on', () => {
    const r = createTurnRegistry({ logger: QUIET });
    const { sink, seen } = recordingSink();
    r.register(sink);
    for (const p of [undefined, null, 42, 'x', [], { reqId: 42 }, { kind: 'text' }]) {
      expect(() => r.onStreamChunk(p)).not.toThrow();
      expect(() => r.onTurnError(p)).not.toThrow();
    }
    expect(seen).toEqual([]);
  });

  it('unregister stops delivery, and a sink that throws never breaks the registry', () => {
    const r = createTurnRegistry({ logger: QUIET });
    const thrower = recordingSink({
      chunk: () => {
        throw new Error('sink bug');
      },
    });
    const unregister = r.register(thrower.sink);
    expect(() => r.onStreamChunk({ reqId: REQ, kind: 'text', text: 'x' })).not.toThrow();
    unregister();
    const { sink, seen } = recordingSink();
    r.register(sink);
    r.onStreamChunk({ reqId: REQ, kind: 'text', text: 'y' });
    expect(seen).toEqual(['chunk text']);
    unregister();
    // Unregistering the old sink twice must not drop the new one.
    r.onTurnEnd(ctxFor(CONVERSATION), { reqId: REQ });
    expect(seen).toEqual(['chunk text', 'end']);
  });

  it('size counts the sinks held now: an undo releases its own, once', () => {
    const r = createTurnRegistry({ logger: QUIET });
    expect(r.size()).toBe(0);
    const undoA = r.register(recordingSink().sink);
    const undoB = r.register(recordingSink({ reqId: 'req-bbbbbbbbbbbb' }).sink);
    expect(r.size()).toBe(2);
    undoA();
    undoA();
    expect(r.size()).toBe(1);
    // A second sink for the same reqId replaces the first; the first's undo can't remove it.
    const undoC = r.register(recordingSink({ reqId: 'req-bbbbbbbbbbbb' }).sink);
    undoB();
    expect(r.size()).toBe(1);
    undoC();
    expect(r.size()).toBe(0);
  });

  describe('permission cards', () => {
    const hostCard = { kind: 'host', host: 'api.example.com', sessionId: 'sess_1', reqId: REQ };
    const skillCard = {
      kind: 'skill',
      skillId: 'github',
      description: 'Work with GitHub',
      hosts: ['api.github.com'],
      slots: [],
      packages: { npm: [], pypi: [] },
    };

    it('a host card is routed by the payload reqId only: a matching ctx conversation is not enough', () => {
      const r = createTurnRegistry({ logger: QUIET });
      const mine = recordingSink();
      const other = recordingSink({ reqId: 'req-bbbbbbbbbbbb' });
      r.register(mine.sink);
      r.register(other.sink);
      // The firing ctx's conversation matches the turn; the payload names another reqId.
      r.onPermissionRequest(ctxFor(CONVERSATION), { ...hostCard, reqId: 'req-nobody' });
      // No reqId at all.
      r.onPermissionRequest(ctxFor(CONVERSATION), { kind: 'host', host: 'api.example.com', sessionId: 'sess_1' });
      expect(mine.permissions).toEqual([]);
      expect(other.permissions).toEqual([]);
      r.onPermissionRequest(ctxFor(undefined), hostCard);
      expect(mine.permissions).toEqual([{ kind: 'host', host: 'api.example.com', sessionId: 'sess_1' }]);
      expect(other.permissions).toEqual([]);
    });

    it('a skill card is routed by the firing ctx conversation only, to every sink in it', () => {
      const r = createTurnRegistry({ logger: QUIET });
      const a = recordingSink();
      const b = recordingSink({ reqId: 'req-bbbbbbbbbbbb' });
      const elsewhere = recordingSink({ reqId: 'req-cccccccccccc', conversationId: 'conv_other' });
      r.register(a.sink);
      r.register(b.sink);
      r.register(elsewhere.sink);
      // A reqId in the payload is not a routing key for a skill card.
      r.onPermissionRequest(ctxFor('conv_nobody'), { ...skillCard, reqId: REQ });
      r.onPermissionRequest(ctxFor(undefined), { ...skillCard, reqId: REQ });
      expect(a.permissions).toEqual([]);
      r.onPermissionRequest(ctxFor(CONVERSATION), skillCard);
      const expected = {
        kind: 'skill',
        skillId: 'github',
        description: 'Work with GitHub',
        needsKey: false,
        reach: { hosts: ['api.github.com'], downloads: false },
      };
      expect(a.permissions).toEqual([expected]);
      expect(b.permissions).toEqual([expected]);
      expect(elsewhere.permissions).toEqual([]);
    });

    it('needsKey: true for a slot without haveExisting, a non-object slot, or non-array slots; false for [] and all-true', () => {
      const needsKeyFor = (slots: unknown): boolean | undefined => {
        const r = createTurnRegistry({ logger: QUIET });
        const { sink, permissions } = recordingSink();
        r.register(sink);
        r.onPermissionRequest(ctxFor(CONVERSATION), { ...skillCard, slots });
        const got = permissions[0];
        return got?.kind === 'skill' ? got.needsKey : undefined;
      };
      expect(needsKeyFor([{ slot: 'a', kind: 'api-key' }])).toBe(true);
      expect(needsKeyFor([{ slot: 'a', haveExisting: false }])).toBe(true);
      expect(needsKeyFor([{ slot: 'a', haveExisting: true }, { slot: 'b' }])).toBe(true);
      expect(needsKeyFor([{ slot: 'a', haveExisting: 'true' }])).toBe(true);
      expect(needsKeyFor(['x'])).toBe(true);
      expect(needsKeyFor([null])).toBe(true);
      expect(needsKeyFor('nope')).toBe(true);
      expect(needsKeyFor(undefined)).toBe(true);
      expect(needsKeyFor({ length: 0 })).toBe(true);
      expect(needsKeyFor([])).toBe(false);
      expect(needsKeyFor([{ slot: 'a', haveExisting: true }, { slot: 'b', haveExisting: true }])).toBe(false);
    });

    it("a skill card's absent description is the empty string", () => {
      const r = createTurnRegistry({ logger: QUIET });
      const { sink, permissions } = recordingSink();
      r.register(sink);
      const { description: _omit, ...noDescription } = skillCard;
      r.onPermissionRequest(ctxFor(CONVERSATION), noDescription);
      expect(permissions).toEqual([
        { kind: 'skill', skillId: 'github', description: '', needsKey: false, reach: { hosts: ['api.github.com'], downloads: false } },
      ]);
    });

    it("a skill card's reach: its hosts and whether it downloads; null (card kept) when hosts or packages isn't the broker's shape", () => {
      /** Every card the sink heard for `card`: one, whatever its reach (a reach is never a reason to drop it). */
      const heard = (card: Record<string, unknown>): PermissionIn[] => {
        const r = createTurnRegistry({ logger: QUIET });
        const { sink, permissions } = recordingSink();
        r.register(sink);
        r.onPermissionRequest(ctxFor(CONVERSATION), card);
        return permissions;
      };
      const reachOf = (card: Record<string, unknown>): unknown => {
        const got = heard(card);
        expect(got).toHaveLength(1);
        return got[0]?.kind === 'skill' ? got[0].reach : 'not a skill card';
      };
      const without = (field: 'hosts' | 'packages'): Record<string, unknown> => {
        const card: Record<string, unknown> = { ...skillCard };
        delete card[field];
        return card;
      };

      expect(reachOf({ ...skillCard, hosts: ['api.open-meteo.com'], packages: { npm: [], pypi: [] } })).toEqual({
        hosts: ['api.open-meteo.com'],
        downloads: false,
      });
      // Whether anything is downloaded, never what: the package names stay behind.
      expect(reachOf({ ...skillCard, packages: { npm: ['left-pad'], pypi: [] } })).toEqual({
        hosts: ['api.github.com'],
        downloads: true,
      });
      expect(reachOf({ ...skillCard, packages: { npm: [], pypi: ['requests'] } })).toEqual({
        hosts: ['api.github.com'],
        downloads: true,
      });
      expect(reachOf({ ...skillCard, hosts: [] })).toEqual({ hosts: [], downloads: false });

      const unreadable: Array<[string, Record<string, unknown>]> = [
        ['hosts absent', without('hosts')],
        ['hosts a string', { ...skillCard, hosts: 'x' }],
        ['hosts holding a number', { ...skillCard, hosts: [1] }],
        ['hosts holding a string and a number', { ...skillCard, hosts: ['api.github.com', 1] }],
        ['packages absent', without('packages')],
        ['packages without pypi', { ...skillCard, packages: { npm: [] } }],
        ['packages a string', { ...skillCard, packages: 'x' }],
        ['packages an array', { ...skillCard, packages: [] }],
        ['npm a string', { ...skillCard, packages: { npm: 'left-pad', pypi: [] } }],
      ];
      for (const [name, card] of unreadable) {
        expect(reachOf(card), name).toBeNull();
        // The card itself is kept, as before: only its reach is unknown.
        expect(heard(card)[0], name).toMatchObject({ kind: 'skill', skillId: 'github', needsKey: false });
      }
    });

    it('malformed cards are dropped, never thrown on: other kinds, wrong types, empty ids', () => {
      const r = createTurnRegistry({ logger: QUIET });
      const { sink, seen } = recordingSink();
      r.register(sink);
      const bad: unknown[] = [
        undefined,
        null,
        42,
        'x',
        [],
        {},
        { kind: 'connector', reqId: REQ, host: 'h', sessionId: 's', skillId: 'k' },
        { kind: 'host', reqId: REQ, host: '', sessionId: 'sess_1' },
        { kind: 'host', reqId: REQ, host: 'api.example.com', sessionId: '' },
        { kind: 'host', reqId: REQ, host: 42, sessionId: 'sess_1' },
        { kind: 'host', reqId: REQ, host: 'api.example.com', sessionId: ['sess_1'] },
        { kind: 'host', reqId: 42, host: 'api.example.com', sessionId: 'sess_1' },
        { ...skillCard, skillId: '' },
        { ...skillCard, skillId: 7 },
        { ...skillCard, description: 7 },
      ];
      for (const p of bad) {
        expect(() => r.onPermissionRequest(ctxFor(CONVERSATION), p)).not.toThrow();
      }
      expect(seen).toEqual([]);
    });

    it('a sink without a permission handler, or one that throws, never breaks the registry', () => {
      const r = createTurnRegistry({ logger: QUIET });
      const quiet = recordingSink();
      const { permission: _unused, ...rest } = quiet.sink;
      r.register(rest);
      expect(() => r.onPermissionRequest(ctxFor(CONVERSATION), skillCard)).not.toThrow();
      expect(() => r.onPermissionRequest(ctxFor(CONVERSATION), hostCard)).not.toThrow();
      const thrower = recordingSink({
        permission: () => {
          throw new Error('sink bug');
        },
      });
      r.register(thrower.sink);
      expect(() => r.onPermissionRequest(ctxFor(CONVERSATION), skillCard)).not.toThrow();
      expect(() => r.onPermissionRequest(ctxFor(CONVERSATION), hostCard)).not.toThrow();
      // A throwing sink does not stop the next sink in the same conversation.
      const r2 = createTurnRegistry({ logger: QUIET });
      const bad = recordingSink({
        permission: () => {
          throw new Error('sink bug');
        },
      });
      const good = recordingSink({ reqId: 'req-bbbbbbbbbbbb' });
      r2.register(bad.sink);
      r2.register(good.sink);
      r2.onPermissionRequest(ctxFor(CONVERSATION), skillCard);
      expect(good.permissions).toHaveLength(1);
    });

    it('a permission sink that throws is logged by its code alone: never the message, the card or an id', () => {
      const { lines, logger } = recordingLogger();
      const r = createTurnRegistry({ logger });
      const thrower = recordingSink({
        permission: () => {
          throw new PluginError({ code: 'sink-broke', plugin: 'test', message: 'api.example.com sess_1 github' });
        },
      });
      r.register(thrower.sink);
      r.onPermissionRequest(ctxFor(CONVERSATION), hostCard);
      r.onPermissionRequest(ctxFor(CONVERSATION), skillCard);
      expect(lines).toEqual([
        { msg: 'slack_turn_sink_failed', fields: { stage: 'permission', code: 'sink-broke' } },
        { msg: 'slack_turn_sink_failed', fields: { stage: 'permission', code: 'sink-broke' } },
      ]);
      // A plain Error has no code to give: `unknown`, and its message stays out.
      const r2 = createTurnRegistry({ logger });
      lines.length = 0;
      r2.register(
        recordingSink({
          permission: () => {
            throw new Error('api.example.com');
          },
        }).sink,
      );
      r2.onPermissionRequest(ctxFor(CONVERSATION), hostCard);
      expect(lines).toEqual([{ msg: 'slack_turn_sink_failed', fields: { stage: 'permission', code: 'unknown' } }]);
    });

    it('a logger that throws too never breaks the registry, and the next sink still gets the card', () => {
      const r = createTurnRegistry({
        logger: {
          warn: () => {
            throw new Error('log sink down');
          },
        },
      });
      const bad = recordingSink({
        permission: () => {
          throw new Error('sink bug');
        },
      });
      const good = recordingSink({ reqId: 'req-bbbbbbbbbbbb' });
      r.register(bad.sink);
      r.register(good.sink);
      expect(() => r.onPermissionRequest(ctxFor(CONVERSATION), skillCard)).not.toThrow();
      expect(good.permissions).toHaveLength(1);
    });
  });

  it("a sink's end or error that throws is logged by stage and code, even after its chunk failed once", () => {
    const { lines, logger } = recordingLogger();
    const r = createTurnRegistry({ logger });
    const boom = (): never => {
      throw new PluginError({ code: 'sink-broke', plugin: 'test', message: 'no' });
    };
    r.register(recordingSink({ chunk: boom, end: boom, error: boom }).sink);
    r.onStreamChunk({ reqId: REQ, kind: 'text', text: 'one' });
    r.onStreamChunk({ reqId: REQ, kind: 'text', text: 'two' });
    r.onTurnError({ reqId: REQ });
    r.onTurnEnd(ctxFor(CONVERSATION), { reqId: REQ });
    expect(lines).toEqual([
      { msg: 'slack_turn_sink_failed', fields: { stage: 'chunk', code: 'sink-broke' } },
      { msg: 'slack_turn_sink_failed', fields: { stage: 'error', code: 'sink-broke' } },
      { msg: 'slack_turn_sink_failed', fields: { stage: 'end', code: 'sink-broke' } },
    ]);
  });

  it("a sink's chunk that throws is logged once for that sink, not once per streamed piece; each sink gets its own line", () => {
    const { lines, logger } = recordingLogger();
    const r = createTurnRegistry({ logger });
    const boom = (): never => {
      throw new PluginError({ code: 'sink-broke', plugin: 'test', message: 'text of the reply' });
    };
    const second = 'req-bbbbbbbbbbbb';
    r.register(recordingSink({ chunk: boom }).sink);
    r.register(recordingSink({ reqId: second, chunk: boom }).sink);
    for (let i = 0; i < 5; i++) r.onStreamChunk({ reqId: REQ, kind: 'text', text: 'hi' });
    expect(lines).toEqual([{ msg: 'slack_turn_sink_failed', fields: { stage: 'chunk', code: 'sink-broke' } }]);
    for (let i = 0; i < 5; i++) r.onStreamChunk({ reqId: second, kind: 'text', text: 'hi' });
    expect(lines).toEqual([
      { msg: 'slack_turn_sink_failed', fields: { stage: 'chunk', code: 'sink-broke' } },
      { msg: 'slack_turn_sink_failed', fields: { stage: 'chunk', code: 'sink-broke' } },
    ]);
  });

  it('subscribeTurnEvents wires the four hooks on the bus, and its undo removes them', async () => {
    const bus = new HookBus();
    const r = createTurnRegistry({ logger: QUIET });
    const { sink, seen } = recordingSink();
    r.register(sink);
    const undo = subscribeTurnEvents(bus, r, '@ax/channel-slack/turns');
    expect(TURN_EVENT_HOOKS).toEqual([
      'chat:stream-chunk',
      'chat:turn-end',
      'chat:turn-error',
      'chat:permission-request',
    ]);
    await bus.fire('chat:stream-chunk', ctxFor(CONVERSATION), { reqId: REQ, kind: 'text', text: 'hi' });
    await bus.fire('chat:turn-error', ctxFor(CONVERSATION), { reqId: REQ });
    await bus.fire('chat:turn-end', ctxFor(CONVERSATION), { reqId: REQ });
    await bus.fire('chat:permission-request', ctxFor(CONVERSATION), {
      kind: 'host',
      host: 'api.example.com',
      sessionId: 'sess_1',
      reqId: REQ,
    });
    expect(seen).toEqual(['chunk text', 'error', 'end', 'permission host']);
    undo();
    for (const hook of TURN_EVENT_HOOKS) expect(bus.unsubscribe(hook, '@ax/channel-slack/turns')).toBe(0);
  });
});
