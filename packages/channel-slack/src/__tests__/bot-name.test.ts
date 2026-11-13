import { describe, expect, it } from 'vitest';
import { RESERVED_BOT_NAMES, checkBotName, defaultBotName } from '../bot-name.js';
import { BOT_HANDLE_MAX, BOT_NAME_MAX } from '../limits.js';

describe('defaultBotName (the handle form of the branding name)', () => {
  it.each([
    ['Canopy Works', 'canopy-works'],
    ['Café Société', 'cafe-societe'],
    ['日本', 'ax'],
    ['!!!', 'ax'],
    ['Here', 'ax'],
  ])('%j → %j', (name, expected) => {
    expect(defaultBotName(name)).toBe(expected);
  });

  it('no branding name → ax', () => {
    expect(defaultBotName(null)).toBe('ax');
  });

  it('a 40-letter name is cut to 21 characters, the handle cap', () => {
    expect(BOT_HANDLE_MAX).toBe(21);
    const out = defaultBotName('A'.repeat(40));
    expect(out).toBe('a'.repeat(21));
  });

  it('trims a separator the cut leaves at the end', () => {
    // 20 letters, a space (→ "-") at index 20, then more: the cut keeps the "-".
    expect(defaultBotName(`${'b'.repeat(20)} tail`)).toBe('b'.repeat(20));
  });

  it('collapses runs of other characters to one dash and trims separators at both ends', () => {
    expect(defaultBotName('  --Acme -- Corp!! ._')).toBe('acme-corp');
    expect(defaultBotName('._Ada.Labs_.')).toBe('ada.labs');
  });

  it.each([
    ['Slack Bot', 'slack-bot'],
    ['Every One', 'every-one'],
    ['every_one', 'every_one'],
    ['Chan.Nel', 'chan.nel'],
  ])('%j has the handle form %j, whose Slack handle is reserved → ax', (name, handleForm) => {
    // Slack's handle drops `-` (spike: `ax-spike-a` → `axspikea`), so these
    // would all derive a reserved @handle.
    expect(defaultBotName(name)).toBe('ax');
    expect(checkBotName(handleForm)).toEqual({ ok: false, reason: 'reserved' });
  });

  it('keeps every default a name checkBotName accepts', () => {
    for (const name of ['Canopy Works', 'Café Société', 'x'.repeat(80), 'ﬁnance', 'İstanbul Ops', null]) {
      const out = defaultBotName(name);
      expect(checkBotName(out)).toEqual({ ok: true, name: out });
    }
  });
});

describe('checkBotName', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['a'.repeat(BOT_NAME_MAX + 1), 'too-long'],
    ['a!', 'bad-characters'],
    ['---', 'bad-characters'],
    ['._-', 'bad-characters'],
    ['Café', 'bad-characters'],
    ['日本', 'bad-characters'],
    ['Every One', 'reserved'],
    ['SLACKBOT', 'reserved'],
    [' here ', 'reserved'],
    ['Chan nel', 'reserved'],
    // Slack derives the @handle without `-` (and we treat `.` and `_` the
    // same), so each of these would become a reserved handle.
    ['slack-bot', 'reserved'],
    ['Slack.Bot', 'reserved'],
    ['every_one', 'reserved'],
    ['here-', 'reserved'],
    ['chan nel', 'reserved'],
    ['-._Every One_.-', 'reserved'],
  ] as const)('%j → %s', (raw, reason) => {
    expect(checkBotName(raw)).toEqual({ ok: false, reason });
  });

  it('trims and collapses whitespace runs to one space', () => {
    expect(checkBotName('  Ada   Bot ')).toEqual({ ok: true, name: 'Ada Bot' });
    expect(checkBotName('Ada\t\nBot')).toEqual({ ok: true, name: 'Ada Bot' });
  });

  it('allows exactly 35 characters, the display-name cap', () => {
    expect(BOT_NAME_MAX).toBe(35);
    const name = 'a'.repeat(BOT_NAME_MAX);
    expect(checkBotName(name)).toEqual({ ok: true, name });
  });

  it('allows letters, digits, spaces, dots, dashes and underscores', () => {
    expect(checkBotName('Ada_Bot-2.0 beta')).toEqual({ ok: true, name: 'Ada_Bot-2.0 beta' });
  });

  it('counts characters, not UTF-16 units, so 18 emoji are refused for their characters', () => {
    expect(checkBotName('🙂'.repeat(18))).toEqual({ ok: false, reason: 'bad-characters' });
  });

  it('a near miss of a reserved word is still a fine name', () => {
    for (const name of ['slack-bots', 'here.now', 'every-one2', 'my_channel']) {
      expect(checkBotName(name), name).toEqual({ ok: true, name });
    }
  });

  it("reserves Slack's own names", () => {
    expect([...RESERVED_BOT_NAMES].sort()).toEqual(['channel', 'everyone', 'here', 'slackbot']);
  });
});
