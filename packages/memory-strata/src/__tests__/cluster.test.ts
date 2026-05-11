import { describe, it, expect } from 'vitest';
import type { InboxFile } from '../inbox-store.js';
import { clusterBySubject } from '../cluster.js';

// Helper to build a minimal InboxFile without touching disk.
function makeFile(
  subject: string | undefined,
  factType: string | undefined,
  id = subject ?? 'missing',
): InboxFile {
  return {
    path: `permanent/memory/inbox/${id}.md`,
    frontmatter: {
      id,
      type: 'inbox/observation',
      created: '2026-05-10T00:00:00.000Z',
      confidence: 0.8,
      pinned: false,
      summary: `Fact about ${subject ?? 'unknown'}`,
      subject,
      factType,
    },
    body: `fact about ${subject ?? 'unknown'}\n`,
  };
}

describe('clusterBySubject', () => {
  it('groups observations by slug normalization (3 distinct slugs)', () => {
    const inbox: InboxFile[] = [
      makeFile('react', 'preference', 'obs-1'),
      makeFile('React', 'preference', 'obs-2'),   // same slug as 'react'
      makeFile('react.js', 'entity', 'obs-3'),    // 'react-js' — separate slug
      makeFile('project alpha', 'decision', 'obs-4'),
      makeFile('Project Alpha', 'decision', 'obs-5'),
    ];
    const clusters = clusterBySubject(inbox);
    // 'react' and 'React' → slug 'react'; 'react.js' → 'react-js';
    // 'project alpha' and 'Project Alpha' → slug 'project-alpha'
    expect(clusters).toHaveLength(3);
    const react = clusters.find((c) => c.slug === 'react');
    expect(react?.observations).toHaveLength(2);
    const reactJs = clusters.find((c) => c.slug === 'react-js');
    expect(reactJs?.observations).toHaveLength(1);
    const alpha = clusters.find((c) => c.slug === 'project-alpha');
    expect(alpha?.observations).toHaveLength(2);
  });

  it('maps to exactly 2 clusters when using non-overlapping subjects', () => {
    const inbox: InboxFile[] = [
      makeFile('react', 'preference', 'r1'),
      makeFile('react', 'preference', 'r2'),
      makeFile('react', 'entity', 'r3'),
      makeFile('project alpha', 'decision', 'a1'),
      makeFile('project alpha', 'decision', 'a2'),
    ];
    const clusters = clusterBySubject(inbox);
    expect(clusters).toHaveLength(2);
    const react = clusters.find((c) => c.slug === 'react');
    expect(react?.observations).toHaveLength(3);
    const alpha = clusters.find((c) => c.slug === 'project-alpha');
    expect(alpha?.observations).toHaveLength(2);
  });

  it('assigns category as the most-common factType in the cluster', () => {
    const inbox: InboxFile[] = [
      makeFile('react', 'preference', 'r1'),
      makeFile('react', 'preference', 'r2'),
      makeFile('react', 'entity', 'r3'),
    ];
    const [cluster] = clusterBySubject(inbox);
    // 2 preference vs 1 entity → preference wins
    expect(cluster!.category).toBe('preference');
  });

  it('observation with missing subject falls into "general" slug', () => {
    const inbox: InboxFile[] = [
      makeFile(undefined, 'entity', 'no-subject'),
    ];
    const [cluster] = clusterBySubject(inbox);
    expect(cluster!.slug).toBe('general');
    expect(cluster!.observations).toHaveLength(1);
  });

  it('observation with missing factType falls into "general" category', () => {
    const inbox: InboxFile[] = [
      makeFile('react', undefined, 'no-type'),
    ];
    const [cluster] = clusterBySubject(inbox);
    expect(cluster!.category).toBe('general');
  });

  it('returns empty array for empty inbox', () => {
    expect(clusterBySubject([])).toEqual([]);
  });

  it('breaks ties in category by first-encountered factType', () => {
    const inbox: InboxFile[] = [
      makeFile('react', 'preference', 't1'),
      makeFile('react', 'entity', 't2'),
    ];
    const [cluster] = clusterBySubject(inbox);
    // 1 preference vs 1 entity — preference was first, so it wins
    expect(cluster!.category).toBe('preference');
  });

  it('treats unknown factType values as "general"', () => {
    const inbox: InboxFile[] = [
      makeFile('react', 'habit' as never, 't1'),  // not in the known union
      makeFile('react', 'preference', 't2'),
    ];
    const [cluster] = clusterBySubject(inbox);
    // 1 unknown (-> general) vs 1 preference. Both bucket at 1; first-seen wins:
    // 'general' was inserted first so it wins the tie. Verify the unknown
    // value did NOT survive into category.
    expect(cluster!.category).toBe('general');
  });
});
