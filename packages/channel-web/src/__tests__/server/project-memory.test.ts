/**
 * W3d-2 — attaching `projects:conversation-changes` to the answer each change
 * belongs to. Only `memory/` paths show; a change goes on the answer of the
 * exchange open at its `turnAt`; one path changed twice in an exchange lists
 * once, as its later change.
 */
import { describe, it, expect } from 'vitest';
import {
  attachProjectMemory,
  parseConversationChangesReply,
  type ConversationChange,
  type ConversationChangesReply,
} from '../../server/project-memory.js';
import type { ExchangeTurn } from '../../server/exchanges.js';
import type { ThreadMessage } from '../../lib/workspace-types.js';

const turns: ExchangeTurn[] = [
  { turnId: 'u1', role: 'user', createdAt: '2026-10-19T10:00:00.000Z' },
  { turnId: 'a1', role: 'assistant', createdAt: '2026-10-19T10:00:05.000Z' },
  { turnId: 'u2', role: 'user', createdAt: '2026-10-19T10:05:00.000Z' },
  { turnId: 'a2s', role: 'assistant', createdAt: '2026-10-19T10:05:03.000Z' },
  { turnId: 'a2', role: 'assistant', createdAt: '2026-10-19T10:05:09.000Z' },
];

function thread(): ThreadMessage[] {
  return [
    { kind: 'user', id: 'u1', text: 'first' },
    { kind: 'agent', id: 'a1', text: 'one', at: '2026-10-19T10:00:05.000Z' },
    { kind: 'user', id: 'u2', text: 'second' },
    { kind: 'steps', id: 'a2s', text: '', at: '2026-10-19T10:05:03.000Z', stepsLabel: 'Worked', steps: [] },
    { kind: 'agent', id: 'a2', text: 'two', at: '2026-10-19T10:05:09.000Z' },
  ];
}

const C = (over: Partial<ConversationChange>): ConversationChange => ({
  versionId: 'v',
  path: 'memory/people.md',
  change: 'edited',
  turnAt: '2026-10-19T10:00:06.000Z',
  undo: 'available',
  ...over,
});

const reply = (changes: ConversationChange[], canEdit = true): ConversationChangesReply => ({ canEdit, changes });

function pm(t: ThreadMessage[], id: string): unknown {
  return (t.find((x) => x.id === id) as Record<string, unknown> | undefined)?.projectMemory;
}

describe('parseConversationChangesReply (W3d-2)', () => {
  it('rejects a reply that is not the documented shape', () => {
    for (const bad of [null, 'x', [], {}, { canEdit: true }, { changes: [] }, { canEdit: 'yes', changes: [] }]) {
      expect(parseConversationChangesReply(bad)).toBeNull();
    }
  });

  it('drops a malformed change, keeps the rest, and copies only named fields', () => {
    const good = { ...C({ versionId: 'v1' }), folderId: 'fld_secret', blobSha: 'abc' };
    const out = parseConversationChangesReply({
      canEdit: false,
      changes: [
        good,
        null,
        { ...C({}), versionId: '' },
        { ...C({}), path: 7 },
        { ...C({}), change: 'renamed' },
        { ...C({}), undo: 'maybe' },
        { ...C({}), turnAt: undefined },
      ],
      extra: 'ignored',
    });
    expect(out).toEqual({ canEdit: false, changes: [C({ versionId: 'v1' })] });
  });
});

describe('attachProjectMemory (W3d-2)', () => {
  it('puts each change on its own exchange answer — the LAST answer message of it', () => {
    const out = attachProjectMemory(
      thread(),
      turns,
      'prj_1',
      reply([
        C({ versionId: 'v1', path: 'memory/a.md', turnAt: '2026-10-19T10:00:06.000Z', change: 'created' }),
        C({ versionId: 'v2', path: 'memory/b.md', turnAt: '2026-10-19T10:05:10.000Z', change: 'deleted' }),
      ]),
    );
    expect(pm(out, 'a1')).toEqual({
      projectId: 'prj_1',
      canEdit: true,
      files: [{ versionId: 'v1', path: 'memory/a.md', change: 'created', undo: 'available' }],
    });
    expect(pm(out, 'a2')).toEqual({
      projectId: 'prj_1',
      canEdit: true,
      files: [{ versionId: 'v2', path: 'memory/b.md', change: 'deleted', undo: 'available' }],
    });
    expect(pm(out, 'a2s')).toBeUndefined();
  });

  it('keeps only memory/ paths', () => {
    const out = attachProjectMemory(
      thread(),
      turns,
      'prj_1',
      reply([
        C({ versionId: 'v1', path: 'work/notes.md' }),
        C({ versionId: 'v2', path: 'memoryx/a.md' }),
        C({ versionId: 'v3', path: 'sources/memory/a.md' }),
        C({ versionId: 'v4', path: 'memory/kept.md' }),
      ]),
    );
    expect((pm(out, 'a1') as { files: unknown[] }).files).toEqual([
      { versionId: 'v4', path: 'memory/kept.md', change: 'edited', undo: 'available' },
    ]);
  });

  it('a turnAt late in the exchange (well after the answer) still lands on that exchange', () => {
    // The turn-end is stamped after the answer turn is persisted, before the
    // person's next message — however late the background pass finished.
    const out = attachProjectMemory(
      thread(),
      turns,
      'prj_1',
      reply([C({ versionId: 'v1', turnAt: '2026-10-19T10:04:59.999Z' })]),
    );
    expect(pm(out, 'a1')).toBeDefined();
    expect(pm(out, 'a2')).toBeUndefined();
  });

  it('one path changed twice in an exchange lists once, as the later change', () => {
    const out = attachProjectMemory(
      thread(),
      turns,
      'prj_1',
      reply([
        C({ versionId: 'v1', path: 'memory/a.md', change: 'created', undo: 'changed-since' }),
        C({ versionId: 'v2', path: 'memory/b.md' }),
        C({ versionId: 'v3', path: 'memory/a.md', change: 'edited', undo: 'available' }),
      ]),
    );
    expect((pm(out, 'a1') as { files: unknown[] }).files).toEqual([
      { versionId: 'v2', path: 'memory/b.md', change: 'edited', undo: 'available' },
      { versionId: 'v3', path: 'memory/a.md', change: 'edited', undo: 'available' },
    ]);
  });

  it('the same path in two exchanges shows under each', () => {
    const out = attachProjectMemory(
      thread(),
      turns,
      'prj_1',
      reply([
        C({ versionId: 'v1', turnAt: '2026-10-19T10:00:06.000Z', undo: 'changed-since' }),
        C({ versionId: 'v2', turnAt: '2026-10-19T10:05:10.000Z' }),
      ]),
    );
    expect((pm(out, 'a1') as { files: Array<{ versionId: string }> }).files[0]!.versionId).toBe('v1');
    expect((pm(out, 'a2') as { files: Array<{ versionId: string }> }).files[0]!.versionId).toBe('v2');
  });

  it('drops changes that match no answer (before the first exchange, unreadable time)', () => {
    const t = thread();
    const out = attachProjectMemory(
      t,
      turns,
      'prj_1',
      reply([
        C({ versionId: 'v1', turnAt: '2026-10-19T09:00:00.000Z' }),
        C({ versionId: 'v2', turnAt: 'not-a-time' }),
      ]),
    );
    expect(out.map((m) => pm([m], m.id))).toEqual([undefined, undefined, undefined, undefined, undefined]);
    // Untouched messages are the same objects.
    out.forEach((m, i) => expect(m).toBe(t[i]));
  });

  it('a change in an exchange with no answer yet attaches to nothing', () => {
    const live: ThreadMessage[] = [...thread(), { kind: 'user', id: 'u3', text: 'third' }];
    const liveTurns: ExchangeTurn[] = [...turns, { turnId: 'u3', role: 'user', createdAt: '2026-10-19T10:10:00.000Z' }];
    const out = attachProjectMemory(live, liveTurns, 'prj_1', reply([C({ turnAt: '2026-10-19T10:10:01.000Z' })]));
    expect(out.some((m) => pm([m], m.id) !== undefined)).toBe(false);
  });

  it('carries canEdit from the reply (a viewer sees the chip, not Undo)', () => {
    const out = attachProjectMemory(thread(), turns, 'prj_1', reply([C({})], false));
    expect(pm(out, 'a1')).toMatchObject({ canEdit: false });
  });
});
