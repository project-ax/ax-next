/**
 * The heading guard, guarded (TASK-446).
 *
 * "Which direction does this fail in?" is the question that decides whether a
 * heading test is worth anything, and the honest way to answer it is to hand
 * the guard each wrong outline and watch it complain — not to assert in a
 * comment that it would.
 *
 * The four wrong shapes, and why each one is here:
 *
 *   - NO HEADINGS. The vacuous pass, and the exact state the two surfaces were
 *     measured in. A guard that loops over the headings it found and asserts
 *     something about each is green on `[]`.
 *   - TWO `h1`s. The likeliest way to "fix" the card wrongly: add an `h1` to a
 *     component that is sometimes mounted next to another one.
 *   - A BODY THAT OPENS TOO DEEP. What the Skills and Connectors tabs did —
 *     first heading an `h3`, two levels skipped before the page began.
 *   - A SKIP ON THE WAY DOWN. `h2` → `h4`.
 *
 * And one shape that must NOT be reported, because a guard that flags it would
 * be unusable on any real page: coming back UP a level (`h3` → `h2`) is just a
 * section closing.
 */
import { describe, expect, it } from 'vitest';
import {
  headingLevels,
  headingOutline,
  headingOutlineProblems,
} from '../heading-outline';

/**
 * A detached tree, so these cases never depend on what a component rendered.
 *
 * `innerHTML` with a literal in a test file — no caller, no fixture and no
 * network reaches it, so there is no untrusted string for it to parse. (Said
 * out loud because "innerHTML" is a word worth stopping on every time.)
 */
function tree(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('headingOutlineProblems', () => {
  it('passes a correct outline', () => {
    const root = tree(`
      <h1>Quill</h1>
      <h2>Conversation</h2>
      <h2>Agent details</h2>
      <h3>Granted by you</h3>
    `);
    expect(headingOutlineProblems(root)).toEqual([]);
  });

  it('reports a tree with no headings at all, rather than passing vacuously', () => {
    const root = tree('<div>Quill</div><p>what is on today</p>');
    expect(headingOutlineProblems(root)).toEqual(['renders no headings at all']);
  });

  it('reports a second h1', () => {
    const root = tree('<h1>Quill</h1><h2>Conversation</h2><h1>Today</h1>');
    expect(headingOutlineProblems(root)).toEqual([
      'has 2 h1s ("Quill", "Today"); a page has exactly one',
    ]);
  });

  it('reports a body that opens below its top level', () => {
    const root = tree('<h3>Installed</h3><h3>Not installed</h3>');
    expect(headingOutlineProblems(root)).toEqual([
      'opens at h3 ("Installed"), expected h1',
    ]);
  });

  it('reports a skipped level on the way down', () => {
    const root = tree('<h1>Skills</h1><h2>Installed</h2><h4>Authored</h4>');
    expect(headingOutlineProblems(root)).toEqual([
      'h2 ("Installed") skips to h4 ("Authored")',
    ]);
  });

  it('does not report coming back up a level', () => {
    const root = tree(`
      <h1>Connectors</h1>
      <h2>Connectors</h2>
      <h3>Connected</h3>
      <h2>Allowed sites</h2>
    `);
    expect(headingOutlineProblems(root)).toEqual([]);
  });

  /*
    A FRAGMENT opens where its host puts it. `ConnectorsTab` rendered alone has
    no `h1` because its `h1` is the Settings pane title it normally sits under —
    so measuring it against `topLevel: 1` would report a defect that only exists
    in the test harness.
  */
  it('measures a fragment against the level its host gives it', () => {
    const root = tree('<h2>Connectors</h2><h3>Connected</h3>');
    expect(headingOutlineProblems(root, 2)).toEqual([]);
    expect(headingOutlineProblems(root, 1)).toEqual([
      'opens at h2 ("Connectors"), expected h1',
    ]);
  });

  /*
    `role="heading"` counts. Someone "fixing" a level by swapping the element
    for a `div` with an ARIA level has changed nothing about the outline, and
    the guard should keep seeing it — including the skip it still has.
  */
  it('sees ARIA headings, so a div cannot hide a level', () => {
    const root = tree(
      '<h1>Skills</h1><div role="heading" aria-level="4">Authored</div>',
    );
    expect(headingLevels(root)).toEqual([1, 4]);
    expect(headingOutlineProblems(root)).toEqual([
      'h1 ("Skills") skips to h4 ("Authored")',
    ]);
  });
});

describe('headingOutline', () => {
  it('reads levels and text in DOM order', () => {
    const root = tree('<h1>Quill</h1><h2>Memory</h2><h3>Rules you gave me</h3>');
    expect(headingOutline(root)).toEqual([
      'h1: Quill',
      'h2: Memory',
      'h3: Rules you gave me',
    ]);
  });
});
