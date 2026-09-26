import { describe, it, expect } from 'vitest';
import {
  DISPLAY_NAME_FALLBACK,
  fenceStoredDisplayName,
  validateCreateInput,
  validateUpdatePatch,
} from '../store.js';
import type { AgentInput } from '../types.js';

// TASK-558. An agent's displayName is drawn for OTHER users (the workspace
// rail, team views — TASK-257), so it is a cross-user surface. Characters that
// rewrite how the surrounding text renders are refused where the name is
// written, and fenced where an older row is read.
//
// These tests need no database: the write door and the read fence are pure.

const vctx = { allowedModels: ['anthropic/claude-opus-4-7'] };

function makeInput(displayName: string): AgentInput {
  return {
    displayName,
    allowedTools: [],
    mcpConfigIds: [],
    model: 'anthropic/claude-opus-4-7',
    visibility: 'personal',
  };
}

// Every code point the card names, plus the rest of the class the channel-web
// fence strips (C0, DEL, C1, zero-width family, BOM). Each is embedded
// mid-name so the leading/trailing-whitespace check cannot be what rejects it.
const REFUSED: Array<[string, string]> = [
  ['U+202A LRE', '‪'],
  ['U+202B RLE', '‫'],
  ['U+202C PDF', '‬'],
  ['U+202D LRO', '‭'],
  ['U+202E RLO', '‮'],
  ['U+2066 LRI', '⁦'],
  ['U+2067 RLI', '⁧'],
  ['U+2068 FSI', '⁨'],
  ['U+2069 PDI', '⁩'],
  ['U+200E LRM', '‎'],
  ['U+200F RLM', '‏'],
  ['U+061C ALM', '؜'],
  ['U+200B ZWSP', '​'],
  ['U+200C ZWNJ', '‌'],
  ['U+200D ZWJ', '‍'],
  ['U+FEFF BOM', '﻿'],
  ['U+0000 NUL', '\u0000'],
  ['U+0009 TAB', '\t'],
  ['U+000A LF', '\n'],
  ['U+001B ESC', '\u001B'],
  ['U+007F DEL', '\u007F'],
  ['U+0085 NEL', '\u0085'],
  ['U+009F APC', '\u009F'],
];

describe('displayName write door (TASK-558)', () => {
  for (const [label, ch] of REFUSED) {
    it(`create refuses ${label}`, () => {
      expect(() => validateCreateInput(makeInput(`Pay${ch}roll`), vctx)).toThrow(
        /displayName must not contain invisible or text-direction control characters/,
      );
    });

    it(`update refuses ${label}`, () => {
      expect(() => validateUpdatePatch({ displayName: `Pay${ch}roll` }, vctx)).toThrow(
        /displayName must not contain invisible or text-direction control characters/,
      );
    });
  }

  it('refuses the Trojan-source shape: an RLO that visually reverses the tail', () => {
    // Renders as "Payroll bot exe.dab" -> reads as something it is not.
    expect(() =>
      validateCreateInput(makeInput('Payroll ‮bad.exe'), vctx),
    ).toThrow(/text-direction control/);
  });

  it('refuses a name made of nothing but controls (passes the 1-128 length check)', () => {
    expect(() => validateCreateInput(makeInput('‮⁦'), vctx)).toThrow(
      /text-direction control/,
    );
  });

  // The class is narrow on purpose: legitimate names must still write.
  it.each([
    ['plain ASCII', 'My Agent'],
    ['Hebrew (RTL script, no controls)', 'עוזר אישי'],
    ['Arabic (RTL script, no controls)', 'مساعد'],
    ['mixed direction', 'Agent مساعد 2'],
    ['CJK', '助手'],
    ['a single emoji', 'Helper 🤖'],
    ['accented Latin', 'Café Bot'],
  ])('accepts %s', (_label, name) => {
    expect(validateCreateInput(makeInput(name), vctx).displayName).toBe(name);
    expect(validateUpdatePatch({ displayName: name }, vctx).displayName).toBe(name);
  });
});

describe('fenceStoredDisplayName — read-side fence for rows written before TASK-558', () => {
  it('passes a clean name through unchanged', () => {
    expect(fenceStoredDisplayName('My Agent')).toBe('My Agent');
    expect(fenceStoredDisplayName('עוזר אישי')).toBe('עוזר אישי');
  });

  it('turns a bidi override into a space rather than letting it reorder the text', () => {
    expect(fenceStoredDisplayName('Payroll ‮bad.exe')).toBe('Payroll bad.exe');
    expect(fenceStoredDisplayName('Pay⁧roll')).toBe('Pay roll');
  });

  it('collapses the run of spaces a stripped control leaves behind, and trims', () => {
    expect(fenceStoredDisplayName('A​​ B‬')).toBe('A B');
  });

  it(`reads a name that fences to nothing as '${DISPLAY_NAME_FALLBACK}'`, () => {
    expect(fenceStoredDisplayName('‮⁦‏')).toBe(DISPLAY_NAME_FALLBACK);
  });

  it('the fallback itself passes the write door (so a re-save of it succeeds)', () => {
    expect(validateCreateInput(makeInput(DISPLAY_NAME_FALLBACK), vctx).displayName).toBe(
      DISPLAY_NAME_FALLBACK,
    );
  });

  it('every refused character is also fenced on read (one class, two doors)', () => {
    for (const [, ch] of REFUSED) {
      expect(fenceStoredDisplayName(`Pay${ch}roll`)).toBe('Pay roll');
    }
  });
});
