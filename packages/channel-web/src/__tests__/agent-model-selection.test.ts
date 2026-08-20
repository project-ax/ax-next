import { describe, expect, it } from 'vitest';
import { effectiveModelId } from '../components/admin/AgentForm';

// ---------------------------------------------------------------------------
// #401, pinned deterministically.
//
// The integration test in admin-agents.test.tsx exercises the real form, but it
// could only ever catch this bug PROBABILISTICALLY (~10% of runs) because the
// defect lived in a one-commit render window. These cases pin the same rule
// without racing anything: the picker's effective selection is a pure function
// of the form's model and the available options.
//
// The rule that matters: with no explicit choice, the effective selection is
// the FIRST option — because that is what a `<select>` visually displays when
// its `value` matches no `<option>`. Anything else lets the UI and the form
// state disagree, which is exactly what produced "no model is available to
// assign" over a dropdown showing a model.
// ---------------------------------------------------------------------------

const OPTIONS = [
  { id: 'anthropic/claude-sonnet-4-6' },
  { id: 'anthropic/claude-opus-4-7' },
];

describe('effectiveModelId', () => {
  it('falls back to the first option when nothing is chosen yet', () => {
    // Pre-fix this was `''` until an effect committed — the whole bug.
    expect(effectiveModelId('', OPTIONS)).toBe('anthropic/claude-sonnet-4-6');
  });

  it('keeps an explicit choice over the first option', () => {
    expect(effectiveModelId('anthropic/claude-opus-4-7', OPTIONS)).toBe(
      'anthropic/claude-opus-4-7',
    );
  });

  it('keeps a chosen model the list no longer offers', () => {
    // The picker appends a "(not available)" entry for this case, so the
    // displayed value is still the agent's own model and must round-trip.
    expect(effectiveModelId('anthropic/retired-model', OPTIONS)).toBe(
      'anthropic/retired-model',
    );
  });

  it('is empty only when there is genuinely nothing to pick', () => {
    // This is the ONE state where "no model is available to assign" is honest.
    expect(effectiveModelId('', [])).toBe('');
  });
});
