import { describe, expect, it } from 'vitest';
import { ACTION_ALLOW, ACTION_DENY, actionOf, outcomeBlocks, promptBlocks } from '../blocks.js';
import { COPY } from '../copy.js';
import { cleanPromptSubject } from '../format.js';
import { PROMPT_SUBJECT_MAX } from '../limits.js';
import { spellsMention } from './lenient-decoder.js';

/** Today in the web app, as turn.ts links it. */
const TODAY = 'https://canopyworks.ai/workspace';
/** A prompt id as the registry mints them: 16 random bytes, base64url. */
const PROMPT_ID = 'AbCdEfGhIjKlMnOpQrStUv';
/** A decision's host-authored summary (decisions' templates.ts). */
const SUBJECT = 'Wants to gain access to a new service or key';
/** The mark that keeps a reference or a broadcast from working (built, never typed: source-hygiene.test.ts). */
const ZWSP = String.fromCharCode(0x200b);
/** Nothing but bidi, zero-width and line-separator characters, and whitespace. */
const INVISIBLE_ONLY = ` ${[0x202e, 0x200b, 0x2066, 0x200f, 0xfeff, 0x2028, 0x2060].map((c) => String.fromCharCode(c)).join(' ')}\n\t `;

/*
  Slack's own caps (docs.slack.dev, read 2026-11-14; see
  .claude/memory/decisions/2026-11-14-TASK-1095.md): a button's text, its
  action_id and its value, and a section's text.
*/
const BUTTON_TEXT_MAX = 75;
const ACTION_ID_MAX = 255;
const BUTTON_VALUE_MAX = 2_000;
const SECTION_TEXT_MAX = 3_000;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every object in a block tree, depth first: the blocks, their elements and their text objects. */
function objectsIn(value: unknown): Obj[] {
  if (Array.isArray(value)) return value.flatMap(objectsIn);
  if (!isObj(value)) return [];
  return [value, ...Object.values(value).flatMap(objectsIn)];
}

/** Every text object (`plain_text` or `mrkdwn`) in the blocks. */
function textObjects(blocks: readonly unknown[]): Array<{ type: string; text: string }> {
  return objectsIn(blocks).flatMap((o) =>
    (o['type'] === 'plain_text' || o['type'] === 'mrkdwn') && typeof o['text'] === 'string'
      ? [{ type: o['type'], text: o['text'] }]
      : [],
  );
}

/** Every button in the blocks. */
function buttons(blocks: readonly unknown[]): Obj[] {
  return objectsIn(blocks).filter((o) => o['type'] === 'button');
}

/** The subject's section: the first block of a prompt and of its outcome. */
function sectionText(message: { blocks: readonly unknown[] }): { type: string; text: string } {
  const section = message.blocks[0] as Obj;
  expect(section['type']).toBe('section');
  return section['text'] as { type: string; text: string };
}

const prompt = (subject: string) => promptBlocks({ subject, promptId: PROMPT_ID, todayLink: TODAY });

/**
 * Subjects that try to ping someone or a whole channel, spelled every way
 * Slack (or a decoder in front of it) could read, and two long ones.
 */
const HOSTILE_SUBJECTS = [
  '<!channel> approve',
  '@here now',
  '&#64;everyone',
  '&lt;!here&gt; please',
  'ask <@U0123ABCD> in <#C0123ABCD>',
  '@everyone '.repeat(1_000),
  'x'.repeat(10_000),
];

describe('promptBlocks: an approval prompt', () => {
  it('is the subject, then Allow and Deny, then who may answer and the Today link', () => {
    expect(prompt(SUBJECT)).toStrictEqual({
      text: COPY.heldAsked,
      blocks: [
        { type: 'section', text: { type: 'plain_text', text: SUBJECT, emoji: false } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: COPY.promptAllow, emoji: false },
              style: 'primary',
              action_id: ACTION_ALLOW,
              value: PROMPT_ID,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: COPY.promptDeny, emoji: false },
              action_id: ACTION_DENY,
              value: PROMPT_ID,
            },
          ],
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: COPY.promptOnlyAsker },
            { type: 'mrkdwn', text: COPY.promptToday(TODAY) },
          ],
        },
      ],
    });
  });

  it('shows the subject only as plain_text in its section: never mrkdwn, never the notification text', () => {
    // A subject that would be a link and bold text if Slack formatted it.
    const subject = 'Wants to open *this* <https://evil.example|link>';
    const out = prompt(subject);
    const holding = textObjects(out.blocks).filter((t) => t.text.split(ZWSP).join('').includes('evil.example'));
    expect(holding).toEqual([{ type: 'plain_text', text: sectionText(out).text }]);
    expect(out.text).toBe(COPY.heldAsked);
    expect(out.text).not.toContain('evil.example');
    // The plain subject, too: one text object holds it, and it is plain_text.
    const plain = prompt(SUBJECT);
    expect(textObjects(plain.blocks).filter((t) => t.text.includes(SUBJECT))).toEqual([
      { type: 'plain_text', text: SUBJECT },
    ]);
    expect(plain.text).not.toContain(SUBJECT);
  });

  it('carries the Today link itself, so an install from before buttons can still answer (Review Focus 4)', () => {
    const context = prompt(SUBJECT).blocks[2] as Obj;
    expect(context['type']).toBe('context');
    const lines = textObjects([context]);
    expect(lines.every((t) => t.type === 'mrkdwn')).toBe(true);
    expect(lines.map((t) => t.text)).toContain(COPY.promptToday(TODAY));
  });

  it("for a request that doesn't wait in Today (a blocked host): no Today line, and nothing else changes", () => {
    const linked = promptBlocks({ subject: SUBJECT, promptId: PROMPT_ID, todayLink: TODAY });
    const unlinked = promptBlocks({ subject: SUBJECT, promptId: PROMPT_ID, todayLink: null });
    expect(unlinked.blocks.at(-1)).toStrictEqual({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: COPY.promptOnlyAsker }],
    });
    expect(unlinked.text).toBe(linked.text);
    expect(unlinked.blocks.slice(0, -1)).toStrictEqual(linked.blocks.slice(0, -1));
    expect(JSON.stringify(unlinked)).not.toMatch(/https?:/);
  });

  it('both buttons carry the prompt id and nothing else, and fit Slack: labels, action ids and values', () => {
    const out = prompt(SUBJECT);
    const both = buttons(out.blocks);
    expect(both.map((b) => b['action_id'])).toEqual([ACTION_ALLOW, ACTION_DENY]);
    for (const b of both) {
      expect(b['value']).toBe(PROMPT_ID);
      expect((b['value'] as string).length).toBeLessThanOrEqual(BUTTON_VALUE_MAX);
      expect((b['action_id'] as string).length).toBeLessThanOrEqual(ACTION_ID_MAX);
      const label = b['text'] as { type: string; text: string };
      expect(label.type).toBe('plain_text');
      expect(label.text.length).toBeGreaterThan(0);
      expect(label.text.length).toBeLessThanOrEqual(BUTTON_TEXT_MAX);
    }
    // Allow is the primary button; Deny has no style at all (Slack's default).
    expect(both[0]?.['style']).toBe('primary');
    expect(both[1]).not.toHaveProperty('style');
    // The value is the only place the id goes.
    const placed = objectsIn(out.blocks).filter((o) => Object.values(o).includes(PROMPT_ID));
    expect(placed).toEqual(both);
  });

  it('sets no block_id anywhere: Slack mints them, and wants a new one per update', () => {
    for (const out of [prompt(SUBJECT), outcomeBlocks({ subject: SUBJECT, line: COPY.decisionDenied })]) {
      expect(objectsIn(out.blocks).filter((o) => 'block_id' in o)).toEqual([]);
    }
  });

  it.each(HOSTILE_SUBJECTS.map((s) => [s.length > 60 ? `${s.slice(0, 40)}... (${s.length})` : s, s]))(
    'a hostile subject (%s) pings nobody, stays plain_text and is capped',
    (_name, subject) => {
      const out = prompt(subject);
      const shown = sectionText(out);
      expect(shown.type).toBe('plain_text');
      expect(shown.text).not.toMatch(/<[!@#]/);
      expect(spellsMention(shown.text)).toBe(false);
      expect(shown.text.length).toBeGreaterThan(0);
      expect(shown.text.length).toBeLessThanOrEqual(PROMPT_SUBJECT_MAX);
      expect(shown.text.length).toBeLessThanOrEqual(SECTION_TEXT_MAX);
      // Nothing anywhere in the message can ping either.
      for (const t of [out.text, ...textObjects(out.blocks).map((x) => x.text)]) {
        expect(spellsMention(t), t.slice(0, 40)).toBe(false);
      }
    },
  );

  it('a short hostile subject still reads as written: only invisible marks are added', () => {
    for (const subject of ['<!channel> approve', '@here now', '&#64;everyone']) {
      const shown = sectionText(prompt(subject)).text;
      expect(shown).not.toBe(subject);
      expect(shown.split(ZWSP).join(''), subject).toBe(subject);
    }
  });

  it('a subject with nothing printable left shows the generic line: Slack refuses an empty section', () => {
    for (const subject of [INVISIBLE_ONLY, '', '   \n\t ']) {
      expect(sectionText(prompt(subject))).toStrictEqual({ type: 'plain_text', text: COPY.heldAsked, emoji: false });
    }
  });

  it('draws the subject through cleanPromptSubject, the one recipe', () => {
    for (const subject of [SUBJECT, ...HOSTILE_SUBJECTS, `a${String.fromCharCode(0x202e)}b`]) {
      expect(sectionText(prompt(subject)).text).toBe(cleanPromptSubject(subject));
    }
  });
});

describe('outcomeBlocks: a prompt once answered', () => {
  it('redraws the same section, then the outcome line where the buttons were', () => {
    const line = COPY.decisionAllowed;
    expect(outcomeBlocks({ subject: SUBJECT, line })).toStrictEqual({
      text: line,
      blocks: [
        { type: 'section', text: { type: 'plain_text', text: SUBJECT, emoji: false } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: line }] },
      ],
    });
  });

  it("the section is the prompt's own, for any subject: the asker sees the question that was answered", () => {
    for (const subject of [SUBJECT, INVISIBLE_ONLY, ...HOSTILE_SUBJECTS]) {
      const asked = prompt(subject).blocks[0];
      expect(outcomeBlocks({ subject, line: COPY.decisionDenied }).blocks[0]).toStrictEqual(asked);
    }
  });

  it('leaves nothing to click: no actions block, no button, no action_id and no value anywhere', () => {
    for (const subject of [SUBJECT, ...HOSTILE_SUBJECTS]) {
      for (const line of [COPY.decisionDenied, COPY.promptClosed, COPY.decisionChanged(TODAY)]) {
        const out = outcomeBlocks({ subject, line });
        const all = objectsIn(out.blocks);
        expect(all.filter((o) => o['type'] === 'actions' || o['type'] === 'button')).toEqual([]);
        expect(all.filter((o) => 'value' in o || 'action_id' in o)).toEqual([]);
      }
    }
  });
});

describe('actionOf: which button a click names', () => {
  it("names Allow and Deny by our exact action ids", () => {
    expect(ACTION_ALLOW).toBe('ax_prompt_allow');
    expect(ACTION_DENY).toBe('ax_prompt_deny');
    expect(actionOf('ax_prompt_allow')).toBe('allow');
    expect(actionOf('ax_prompt_deny')).toBe('deny');
  });

  it('anything else is no action: exact match only, case and spacing included', () => {
    for (const id of [
      'AX_PROMPT_ALLOW',
      'Ax_Prompt_Deny',
      '',
      ' ax_prompt_allow',
      'ax_prompt_allow ',
      'ax_prompt_allowx',
      'ax_prompt_',
      'allow',
      'deny',
      'toString',
      '__proto__',
      'constructor',
    ]) {
      expect(actionOf(id), JSON.stringify(id)).toBeNull();
    }
  });
});
