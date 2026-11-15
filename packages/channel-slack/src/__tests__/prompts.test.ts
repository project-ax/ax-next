import { describe, expect, it } from 'vitest';
import { PROMPT_ID_BYTES, PROMPT_REFUSALS_MAX } from '../limits.js';
import { logCode } from '../log-code.js';
import {
  PROMPT_ID_RE,
  PromptRegistryError,
  createPromptRegistry,
  type PromptContext,
  type PromptSubject,
} from '../prompts.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW_MS = Date.parse('2026-11-14T12:00:00.000Z');
/** Short, so the expiry boundary reads plainly. The plugin passes PROMPT_TTL_MS. */
const TTL_MS = 60_000;

/** Mel's DM turn, as the turn that held a call describes it. */
const MEL: PromptContext = {
  installId: 'q3VtZ0xH4kTn9Wb2LmPa1A',
  teamId: 'T07ABCDEF12',
  channel: 'D07MEL0DM01',
  threadTs: '1763121600.000100',
  askerSlackId: 'U07MEL00001',
  userId: 'usr_mel',
  agentId: 'agt_mel',
  conversationId: 'conv_mel_slack',
  mode: 'dm',
};

/** Ada's turn in a channel connected to a team agent. */
const ADA: PromptContext = {
  installId: 'q3VtZ0xH4kTn9Wb2LmPa1A',
  teamId: 'T07ABCDEF12',
  channel: 'C07TEAM0001',
  threadTs: '1763121700.000200',
  askerSlackId: 'U07ADA00001',
  userId: 'usr_ada',
  agentId: 'agt_team',
  conversationId: 'conv_ada_team',
  mode: 'attended',
};

const HELD: PromptSubject = { kind: 'decision', decisionId: 'dec_0001' };
/** A decision's host-authored summary. Kept exactly as given: blocks.ts cleans it at each draw. */
const SUMMARY = 'Wants to gain access to a new service or key';

/*
  Ids spelled independently of the code under test, with Python's
  base64.urlsafe_b64encode (padding stripped):
    16 bytes of 0x01                -> FIRST_ID
    16 bytes of 0x02                -> SECOND_ID
    0xfb 0xff repeated (16 bytes)   -> URL_SAFE_ID, which needs both `-` and `_`
                                       (plain base64 would say `+` and `/`, then `==`)
*/
const FIRST_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const SECOND_ID = 'AgICAgICAgICAgICAgICAg';
const URL_SAFE_BYTES = [0xfb, 0xff, 0xfb, 0xff, 0xfb, 0xff, 0xfb, 0xff, 0xfb, 0xff, 0xfb, 0xff, 0xfb, 0xff, 0xfb, 0xff];
const URL_SAFE_ID = '-__7__v_-__7__v_-__7_w';

const GONE = { ok: false, reason: 'gone' };
const BUSY = { ok: false, reason: 'busy' };

/** A registry on a clock the test moves. By default, call n of randomBytes fills every byte with n. */
function registry(o: { max?: number; randomBytes?: (size: number) => Buffer } = {}) {
  let nowMs = NOW_MS;
  /** The size asked of the default randomBytes, once per id minted. */
  const sizes: number[] = [];
  const prompts = createPromptRegistry({
    now: () => nowMs,
    randomBytes:
      o.randomBytes ??
      ((size) => {
        sizes.push(size);
        return Buffer.alloc(size, sizes.length);
      }),
    ttlMs: TTL_MS,
    max: o.max ?? 10,
  });
  return {
    prompts,
    sizes,
    at(ms: number) {
      nowMs = ms;
    },
  };
}

/** What `fn` refused with: a PromptRegistryError (the test fails if it didn't throw one). */
function refused(fn: () => unknown): PromptRegistryError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PromptRegistryError);
    return err as PromptRegistryError;
  }
  throw new Error('expected a PromptRegistryError, and nothing was thrown');
}

// ── Adding ──────────────────────────────────────────────────────────────────

describe('createPromptRegistry: add', () => {
  it('mints the id from PROMPT_ID_BYTES random bytes, spelled base64url: 22 characters PROMPT_ID_RE takes', () => {
    const asked: number[] = [];
    const { prompts } = registry({
      randomBytes: (size) => {
        asked.push(size);
        return Buffer.from(URL_SAFE_BYTES);
      },
    });
    const prompt = prompts.add(MEL, HELD, SUMMARY);
    expect(asked).toEqual([PROMPT_ID_BYTES]);
    expect(prompt.id).toBe(URL_SAFE_ID);
    expect(PROMPT_ID_RE.test(prompt.id)).toBe(true);
  });

  it("keeps the turn's context, the subject and the subject text as given, not yet posted, until now + the TTL", () => {
    const { prompts } = registry();
    expect(prompts.add(MEL, HELD, SUMMARY)).toEqual({
      id: FIRST_ID,
      installId: 'q3VtZ0xH4kTn9Wb2LmPa1A',
      teamId: 'T07ABCDEF12',
      channel: 'D07MEL0DM01',
      threadTs: '1763121600.000100',
      askerSlackId: 'U07MEL00001',
      userId: 'usr_mel',
      agentId: 'agt_mel',
      conversationId: 'conv_mel_slack',
      mode: 'dm',
      subject: { kind: 'decision', decisionId: 'dec_0001' },
      subjectText: 'Wants to gain access to a new service or key',
      messageTs: null,
      expiresAt: NOW_MS + 60_000,
    });
  });

  it('keeps the subject text raw: the same string both draws are handed, never a cleaned copy', () => {
    const { prompts } = registry();
    // Cleaning would mark the broadcast and collapse the spaces (format.ts).
    const raw = '<!here>   wants   to\tsend';
    expect(prompts.add(MEL, HELD, raw).subjectText).toBe('<!here>   wants   to\tsend');
  });

  it('keeps a copy of only the fields a prompt names: a wider object leaves the rest behind', () => {
    const { prompts } = registry();
    const wider = { ...MEL, botToken: 'not-for-the-registry', source: 'user' };
    const subject = { kind: 'decision', decisionId: 'dec_0001', call: { input: 'model text' } } as PromptSubject;
    const prompt = prompts.add(wider, subject, SUMMARY);
    expect(Object.keys(prompt).sort()).toEqual([
      'agentId',
      'askerSlackId',
      'channel',
      'conversationId',
      'expiresAt',
      'id',
      'installId',
      'messageTs',
      'mode',
      'subject',
      'subjectText',
      'teamId',
      'threadTs',
      'userId',
    ]);
    expect(prompt.subject).toEqual({ kind: 'decision', decisionId: 'dec_0001' });
    // Changing what was handed in changes nothing kept.
    wider.askerSlackId = 'U07ADA00001';
    expect(prompts.claim(prompt.id)).toMatchObject({ ok: true, prompt: { askerSlackId: 'U07MEL00001' } });
  });

  it('hands out frozen prompts: nobody holding one can change who may answer it, or what it asks', () => {
    const { prompts } = registry();
    const prompt = prompts.add(MEL, HELD, SUMMARY);
    expect(() => {
      (prompt as { askerSlackId: string }).askerSlackId = 'U07ADA00001';
    }).toThrow(TypeError);
    expect(() => {
      (prompt.subject as { decisionId: string }).decisionId = 'dec_9999';
    }).toThrow(TypeError);
    prompts.posted(prompt.id, '1763121601.000300');
    const claim = prompts.claim(prompt.id);
    expect(claim).toMatchObject({
      ok: true,
      prompt: { askerSlackId: 'U07MEL00001', subject: { decisionId: 'dec_0001' }, messageTs: '1763121601.000300' },
    });
    expect(claim.ok && Object.isFrozen(claim.prompt)).toBe(true);
  });

  it("refuses any turn but a DM or an attended channel turn, whatever the type says: an outsider's turn never gets a prompt", () => {
    for (const mode of ['external', 'DM', 'Attended', 'attended ', '', undefined, null]) {
      const { prompts, sizes } = registry();
      const turn = { ...MEL, mode } as unknown as PromptContext;
      expect(refused(() => prompts.add(turn, HELD, SUMMARY)).code, String(mode)).toBe('prompt-mode-refused');
      expect(prompts.size()).toBe(0);
      // Refused before an id was minted.
      expect(sizes).toEqual([]);
    }
    const { prompts } = registry();
    expect(prompts.add(MEL, HELD, SUMMARY).mode).toBe('dm');
    expect(prompts.add(ADA, HELD, SUMMARY).mode).toBe('attended');
    expect(prompts.size()).toBe(2);
  });

  it('refuses a subject of a kind it does not know, and keeps each kind it knows with exactly its fields', () => {
    const { prompts, sizes } = registry();
    const unknown = { kind: 'routine', decisionId: 'dec_0001' } as unknown as PromptSubject;
    expect(refused(() => prompts.add(MEL, unknown, SUMMARY)).code).toBe('prompt-subject-unknown');
    expect(prompts.size()).toBe(0);
    expect(sizes).toEqual([]);

    const host = { kind: 'host', host: 'api.example.com', sessionId: 'ses_0001', extra: 1 } as PromptSubject;
    expect(prompts.add(MEL, host, 'Wants to connect to api.example.com').subject).toEqual({
      kind: 'host',
      host: 'api.example.com',
      sessionId: 'ses_0001',
    });
    const skill = { kind: 'skill', skillId: 'skl_0001', extra: 1 } as PromptSubject;
    expect(prompts.add(MEL, skill, 'Wants to start using a skill.').subject).toEqual({
      kind: 'skill',
      skillId: 'skl_0001',
    });
  });

  it('never hands out an id that is already open: a repeat leaves the open prompt as it was', () => {
    const { prompts } = registry({ randomBytes: (size) => Buffer.alloc(size, 1) });
    expect(prompts.add(MEL, HELD, SUMMARY).id).toBe(FIRST_ID);
    // The same, well-formed id again, for someone else's question.
    const err = refused(() => prompts.add(ADA, { kind: 'decision', decisionId: 'dec_0002' }, SUMMARY));
    expect(err.code).toBe('prompt-id-unusable');
    expect(prompts.size()).toBe(1);
    expect(prompts.claim(FIRST_ID)).toMatchObject({
      ok: true,
      prompt: { askerSlackId: 'U07MEL00001', subject: { decisionId: 'dec_0001' } },
    });
  });

  it('never hands out an id the interactions route would refuse (random bytes come back short)', () => {
    // A new id, so only its shape is wrong: 15 bytes spell 20 characters.
    const { prompts } = registry({ randomBytes: (size) => Buffer.alloc(size - 1, 7) });
    expect(refused(() => prompts.add(MEL, HELD, SUMMARY)).code).toBe('prompt-id-unusable');
    expect(prompts.size()).toBe(0);
  });
});

// ── Claiming, settling, releasing ───────────────────────────────────────────

describe('createPromptRegistry: claim, settle, release', () => {
  it('a claim takes an open prompt once: another claim while it is being answered is busy', () => {
    const { prompts } = registry();
    const prompt = prompts.add(MEL, HELD, SUMMARY);
    expect(prompts.claim(prompt.id)).toEqual({ ok: true, prompt });
    expect(prompts.claim(prompt.id)).toEqual(BUSY);
    expect(prompts.claim(prompt.id)).toEqual(BUSY);
  });

  it('release makes a claimed prompt answerable again (a failure the asker can retry)', () => {
    const { prompts } = registry();
    const prompt = prompts.add(MEL, HELD, SUMMARY);
    expect(prompts.claim(prompt.id).ok).toBe(true);
    prompts.release(prompt.id);
    expect(prompts.claim(prompt.id)).toEqual({ ok: true, prompt });
  });

  it('settle ends a prompt for good: a later claim finds it gone, and a late release brings nothing back', () => {
    const { prompts } = registry();
    const prompt = prompts.add(MEL, HELD, SUMMARY);
    expect(prompts.claim(prompt.id).ok).toBe(true);
    prompts.settle(prompt.id);
    expect(prompts.claim(prompt.id)).toEqual(GONE);
    prompts.release(prompt.id);
    expect(prompts.claim(prompt.id)).toEqual(GONE);
    expect(prompts.size()).toBe(0);
  });

  it('settling one prompt leaves the others open', () => {
    const { prompts } = registry();
    const mel = prompts.add(MEL, HELD, SUMMARY);
    const ada = prompts.add(ADA, { kind: 'decision', decisionId: 'dec_0002' }, SUMMARY);
    expect(prompts.claim(mel.id).ok).toBe(true);
    prompts.settle(mel.id);
    expect(prompts.claim(ada.id)).toEqual({ ok: true, prompt: ada });
  });

  it('an id it never handed out is gone, whatever it spells', () => {
    const { prompts } = registry();
    prompts.add(MEL, HELD, SUMMARY);
    for (const id of [SECOND_ID, FIRST_ID.toLowerCase(), '', '__proto__', 'constructor', 'toString']) {
      expect(prompts.claim(id), id).toEqual(GONE);
    }
    expect(prompts.claim(FIRST_ID).ok).toBe(true);
  });
});

// ── Expiry ──────────────────────────────────────────────────────────────────

describe('createPromptRegistry: expiry', () => {
  it('a prompt can be answered until it expires; from then on it is gone and forgotten, even if the clock steps back', () => {
    const { prompts, at } = registry();
    const prompt = prompts.add(MEL, HELD, SUMMARY);
    expect(prompt.expiresAt).toBe(NOW_MS + 60_000);
    at(NOW_MS + 59_999);
    expect(prompts.claim(prompt.id).ok).toBe(true);
    prompts.release(prompt.id);
    at(NOW_MS + 60_000);
    expect(prompts.claim(prompt.id)).toEqual(GONE);
    // Dropped, not just hidden: back inside its window it is still gone.
    at(NOW_MS);
    expect(prompts.claim(prompt.id)).toEqual(GONE);
    expect(prompts.size()).toBe(0);
  });

  it('one being answered when it expires stays under its answer (another click is busy, not gone), and goes once released', () => {
    const { prompts, at } = registry();
    const prompt = prompts.add(MEL, HELD, SUMMARY);
    expect(prompts.claim(prompt.id).ok).toBe(true);
    at(NOW_MS + 60_001);
    // Adding sweeps expired prompts: this one is being answered, so it stays.
    prompts.add(ADA, HELD, SUMMARY);
    expect(prompts.claim(prompt.id)).toEqual(BUSY);
    expect(prompts.size()).toBe(2);
    prompts.release(prompt.id);
    expect(prompts.claim(prompt.id)).toEqual(GONE);
    expect(prompts.size()).toBe(1);
  });
});

// ── The cap ─────────────────────────────────────────────────────────────────

describe('createPromptRegistry: max', () => {
  it('past max, adding forgets the oldest prompt', () => {
    const { prompts } = registry({ max: 3 });
    const [a, b, c] = [1, 2, 3].map((n) => prompts.add(MEL, { kind: 'decision', decisionId: `dec_000${n}` }, SUMMARY));
    const d = prompts.add(ADA, HELD, SUMMARY);
    expect(prompts.size()).toBe(3);
    expect(prompts.claim(a!.id)).toEqual(GONE);
    for (const p of [b!, c!, d]) expect(prompts.claim(p.id).ok).toBe(true);
  });

  it('past max, a prompt being answered is never forgotten under its answer: the oldest idle one goes instead', () => {
    const { prompts } = registry({ max: 3 });
    const [a, b, c] = [1, 2, 3].map((n) => prompts.add(MEL, { kind: 'decision', decisionId: `dec_000${n}` }, SUMMARY));
    expect(prompts.claim(a!.id).ok).toBe(true);
    const d = prompts.add(ADA, HELD, SUMMARY);
    expect(prompts.size()).toBe(3);
    expect(prompts.claim(b!.id)).toEqual(GONE);
    expect(prompts.claim(a!.id)).toEqual(BUSY);
    prompts.release(a!.id);
    for (const p of [a!, c!, d]) expect(prompts.claim(p.id).ok).toBe(true);
  });

  it('with every open prompt being answered, adding refuses rather than grow past max', () => {
    const { prompts } = registry({ max: 2 });
    const a = prompts.add(MEL, HELD, SUMMARY);
    const b = prompts.add(ADA, HELD, SUMMARY);
    expect(prompts.claim(a.id).ok).toBe(true);
    expect(prompts.claim(b.id).ok).toBe(true);

    const err = refused(() => prompts.add(MEL, { kind: 'decision', decisionId: 'dec_0003' }, SUMMARY));
    expect(err.code).toBe('prompts-full');
    // What a caller logs: the code, never the message.
    expect(logCode(err)).toBe('prompts-full');
    expect(prompts.size()).toBe(2);
    expect(prompts.claim(a.id)).toEqual(BUSY);
    expect(prompts.claim(b.id)).toEqual(BUSY);

    // Once one is released, it is the oldest idle one, and makes room.
    prompts.release(a.id);
    const c = prompts.add(MEL, { kind: 'decision', decisionId: 'dec_0003' }, SUMMARY);
    expect(prompts.claim(a.id)).toEqual(GONE);
    expect(prompts.claim(c.id).ok).toBe(true);
  });
});

// ── Refusals ────────────────────────────────────────────────────────────────

describe('createPromptRegistry: firstRefusal', () => {
  it('is true the first time each person is refused on a prompt, then false', () => {
    const { prompts } = registry();
    const mel = prompts.add(MEL, HELD, SUMMARY);
    expect(prompts.firstRefusal(mel.id, 'U07ADA00001')).toBe(true);
    expect(prompts.firstRefusal(mel.id, 'U07ADA00001')).toBe(false);
    expect(prompts.firstRefusal(mel.id, 'U07BOB00001')).toBe(true);
    // Each prompt keeps its own count.
    const other = prompts.add(MEL, { kind: 'decision', decisionId: 'dec_0002' }, SUMMARY);
    expect(prompts.firstRefusal(other.id, 'U07ADA00001')).toBe(true);
  });

  it('remembers at most PROMPT_REFUSALS_MAX people on a prompt, then says false to anyone new', () => {
    const { prompts } = registry();
    const mel = prompts.add(MEL, HELD, SUMMARY);
    for (let i = 0; i < PROMPT_REFUSALS_MAX; i += 1) {
      expect(prompts.firstRefusal(mel.id, `U07PERSON${i}`), `person ${i}`).toBe(true);
    }
    expect(prompts.firstRefusal(mel.id, 'U07ONEMORE1')).toBe(false);
    expect(prompts.firstRefusal(mel.id, 'U07ONEMORE2')).toBe(false);
  });

  it('is false for a prompt it does not hold: nobody is told anything about a prompt that is not there', () => {
    const { prompts } = registry();
    const mel = prompts.add(MEL, HELD, SUMMARY);
    expect(prompts.claim(mel.id).ok).toBe(true);
    prompts.settle(mel.id);
    expect(prompts.firstRefusal(mel.id, 'U07ADA00001')).toBe(false);
    expect(prompts.firstRefusal(SECOND_ID, 'U07ADA00001')).toBe(false);
  });
});

// ── Posting, removing, counting ─────────────────────────────────────────────

describe('createPromptRegistry: posted, remove, size', () => {
  it('posted records the message a prompt was posted as; a claim then carries it', () => {
    const { prompts } = registry();
    const prompt = prompts.add(MEL, HELD, SUMMARY);
    prompts.posted(prompt.id, '1763121601.000300');
    expect(prompts.claim(prompt.id)).toEqual({ ok: true, prompt: { ...prompt, messageTs: '1763121601.000300' } });
  });

  it("posted for an id it doesn't hold changes nothing", () => {
    const { prompts } = registry();
    const prompt = prompts.add(MEL, HELD, SUMMARY);
    prompts.posted(SECOND_ID, '1763121601.000300');
    expect(prompts.size()).toBe(1);
    expect(prompts.claim(SECOND_ID)).toEqual(GONE);
    expect(prompts.claim(prompt.id)).toEqual({ ok: true, prompt });
  });

  it('remove forgets a prompt (its post failed): a click on it finds it gone', () => {
    const { prompts } = registry();
    const mel = prompts.add(MEL, HELD, SUMMARY);
    const ada = prompts.add(ADA, HELD, SUMMARY);
    prompts.remove(mel.id);
    // An id it never handed out: nothing to forget, nothing breaks.
    prompts.remove('AAAAAAAAAAAAAAAAAAAAAA');
    expect(prompts.claim(mel.id)).toEqual(GONE);
    expect(prompts.claim(ada.id)).toEqual({ ok: true, prompt: ada });
    expect(prompts.size()).toBe(1);
  });

  it('size counts the prompts that can still be answered', () => {
    const { prompts, at } = registry();
    expect(prompts.size()).toBe(0);
    const a = prompts.add(MEL, HELD, SUMMARY);
    const b = prompts.add(ADA, HELD, SUMMARY);
    expect(prompts.size()).toBe(2);
    expect(prompts.claim(a.id).ok).toBe(true);
    expect(prompts.size()).toBe(2);
    prompts.settle(a.id);
    expect(prompts.size()).toBe(1);
    prompts.remove(b.id);
    expect(prompts.size()).toBe(0);
    prompts.add(MEL, HELD, SUMMARY);
    expect(prompts.size()).toBe(1);
    at(NOW_MS + 60_000);
    expect(prompts.size()).toBe(0);
  });
});

// ── Options and the id pattern ──────────────────────────────────────────────

describe('createPromptRegistry: options', () => {
  it('ttlMs and max must be positive whole numbers', () => {
    const base = { now: () => NOW_MS, randomBytes: (size: number) => Buffer.alloc(size, 1), ttlMs: TTL_MS, max: 10 };
    expect(() => createPromptRegistry(base)).not.toThrow();
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createPromptRegistry({ ...base, ttlMs: bad }), `ttlMs ${bad}`).toThrow(RangeError);
      expect(() => createPromptRegistry({ ...base, max: bad }), `max ${bad}`).toThrow(RangeError);
    }
  });
});

describe('PROMPT_ID_RE', () => {
  it('takes exactly 22 base64url characters, as the registry mints them', () => {
    for (const id of [FIRST_ID, SECOND_ID, URL_SAFE_ID]) expect(PROMPT_ID_RE.test(id), id).toBe(true);
    for (const id of [
      '',
      FIRST_ID.slice(1),
      `${FIRST_ID}A`,
      '+//7//v/+//7//v/+//7/w',
      `${FIRST_ID.slice(1)}=`,
      `${FIRST_ID}\n`,
      ` ${FIRST_ID.slice(1)}`,
    ]) {
      expect(PROMPT_ID_RE.test(id), JSON.stringify(id)).toBe(false);
    }
  });
});
