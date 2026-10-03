/**
 * TASK-700 — the launch disclosure for connector access, guarded as COPY.
 *
 * The words are the deliverable, so the test pins what they must say and what
 * they must not. It is deliberately not a snapshot: a snapshot passes on any
 * rewording, including one that quietly drops "without asking".
 * Each assertion names one of the four ideas the card requires, so deleting an
 * idea reddens exactly that assertion.
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_ACCESS_KINDS,
  connectorAccessCopy,
  type ConnectorAccessNoticeKind,
} from '../connector-access-copy';

/** The whole visible text of one notice, as a reader meets it. */
function textOf(kind: ConnectorAccessNoticeKind): string {
  const c = connectorAccessCopy(kind);
  return `${c.headline} ${c.details}`;
}

/** Sentences, counted by terminal punctuation followed by a space or the end. */
function sentenceCount(s: string): number {
  return (s.match(/[.!?](?=\s|$)/g) ?? []).length;
}

describe('connector access notice copy', () => {
  it('covers every kind the surfaces use', () => {
    expect([...CONNECTOR_ACCESS_KINDS].sort()).toEqual(['attach', 'author', 'key', 'sign-in']);
  });

  it.each(CONNECTOR_ACCESS_KINDS)('%s: is two or three short sentences', (kind) => {
    const n = sentenceCount(textOf(kind));
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(3);
    // "Short": the longest single sentence stays readable at a glance.
    for (const sentence of textOf(kind).split(/(?<=[.!?])\s+/)) {
      expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(30);
    }
  });

  it.each(CONNECTOR_ACCESS_KINDS)('%s: says the assistant gets the access', (kind) => {
    expect(connectorAccessCopy(kind).headline).toMatch(/access/i);
  });

  it.each(CONNECTOR_ACCESS_KINDS)('%s: says what runs unasked: the tools set to Allow', (kind) => {
    // TASK-742 — deliberately changed. The old pin was "without asking you each
    // time" about every tool. Since TASK-736 a tool can be Ask first or Deny,
    // so the unasked reach is the tools at Allow, and the sentence must say so
    // rather than claim it of all of them.
    const h = connectorAccessCopy(kind).headline;
    expect(h).toMatch(/read or change things/i);
    expect(h).toMatch(/any tool set to Allow can read or change things[^.]*without asking/i);
    expect(h).not.toMatch(/each time/i);
  });

  it.each(CONNECTOR_ACCESS_KINDS)('%s: names the way something it reads can steer it', (kind) => {
    const d = connectorAccessCopy(kind).details;
    expect(d).toMatch(/web page or a file/i);
    expect(d).toMatch(/trick/i);
  });

  it.each(CONNECTOR_ACCESS_KINDS)('%s: tells the reader what to do about it', (kind) => {
    expect(connectorAccessCopy(kind).details).toMatch(/comfortable handing to an assistant/i);
  });

  it.each(['key', 'attach', 'author'] as const)(
    '%s: points at the narrowest key the service offers',
    (kind) => {
      expect(connectorAccessCopy(kind).details).toMatch(/fewest permissions the service offers/i);
    },
  );

  it('sign-in: does not tell anyone to narrow a key they are not holding', () => {
    // A sign-in has no key to choose. Advice the reader cannot follow is noise
    // at the one moment they are deciding.
    expect(connectorAccessCopy('sign-in').details).not.toMatch(/fewest permissions/i);
  });

  it.each(CONNECTOR_ACCESS_KINDS)('%s: avoids the words the card retired', (kind) => {
    // No MCP, no scope, no token: a person deciding whether to hand over a key
    // should not have to know what any of them mean.
    expect(textOf(kind)).not.toMatch(/\bMCP\b/);
    expect(textOf(kind)).not.toMatch(/\bscopes?\b/i);
    expect(textOf(kind)).not.toMatch(/\btokens?\b/i);
  });

  it.each(CONNECTOR_ACCESS_KINDS)('%s: makes no promise of a protection that does not exist', (kind) => {
    // Nothing here may imply that the assistant checks, confirms, logs, or can
    // be undone. "asking" appears exactly once and only as "without asking" —
    // re-pinned deliberately by TASK-742: the one "without asking" is now
    // scoped to tools set to Allow (asserted above), and the notice still does
    // not promise that any OTHER tool asks, because an admin default can be
    // Allow too.
    const t = textOf(kind);
    expect(t).not.toMatch(/\b(safe|safely|secure|secured|protected|protects|guarantee[ds]?)\b/i);
    expect(t).not.toMatch(/\b(undo|revoke|reversible)\b/i);
    expect((t.match(/asking/gi) ?? []).length).toBe(1);
    expect(t).toMatch(/without asking/i);
  });

  it('is jokes-free: no exclamation marks anywhere', () => {
    // CLAUDE.md › Voice & Tone: real security topic, drop the jokes.
    for (const kind of CONNECTOR_ACCESS_KINDS) expect(textOf(kind)).not.toContain('!');
  });
});
