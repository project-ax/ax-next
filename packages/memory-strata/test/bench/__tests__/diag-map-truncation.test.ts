import { describe, it, expect } from 'vitest';
import { isDeadLine } from '../diag-map-truncation.js';

// A "dead" map line is one the planner cannot route a question to. Getting this
// predicate wrong is not cosmetic: it is the metric used to compare two maps,
// and its first version reported a map getting WORSE precisely because it had
// stopped being truncated.
describe('isDeadLine', () => {
  it('flags a line that is only a disclaimer', () => {
    expect(isDeadLine('No personal details shared by user.')).toBe(true);
    expect(isDeadLine('User mentioned no personal details or facts about themselves.')).toBe(true);
    expect(isDeadLine('Greeting only; no personal details shared.')).toBe(true);
    expect(isDeadLine('User sent a test message; no personal details or preferences shared.')).toBe(true);
  });

  it('does NOT flag an informative line that merely ends with one', () => {
    // The regression this exists for. At a 120-char cap the trailing clause is
    // truncated away; at 400 it survives, so a phrase-match counted 1,226 dead
    // lines in the cut-400 map where only 18 were dead — and read that as the
    // map degrading when the map had in fact stopped being mutilated.
    expect(
      isDeadLine(
        'User asked informational questions about mussel predators, defenses, and toxins; no personal details or preferences disclosed.',
      ),
    ).toBe(false);
    expect(
      isDeadLine(
        'User requested 10 additional examples of DISC personality-type workplace conflicts, continuing a prior list; no personal details shared.',
      ),
    ).toBe(false);
    expect(
      isDeadLine('User asked which pigment gives lemons their yellow color (general knowledge question; no personal details shared).'),
    ).toBe(false);
  });

  it('leaves ordinary substantive lines alone', () => {
    expect(isDeadLine('User commutes 45 min each way to work in Boston; prefers Tesla over BMW.')).toBe(false);
    expect(isDeadLine('User is curious about marine biology—mussel predator defenses and toxins.')).toBe(false);
  });

  it('flags a line too short to select on, disclaimer or not', () => {
    expect(isDeadLine('Chitchat.')).toBe(true);
    expect(isDeadLine('')).toBe(true);
  });
});
