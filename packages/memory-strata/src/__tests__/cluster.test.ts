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

describe('answer factType routing (2026-07-29)', () => {
  it('routes an answer observation to the general doc category', () => {
    const inbox: InboxFile[] = [
      makeFile('rome-restaurants', 'answer', 'a'),
    ];
    const clusters = clusterBySubject(inbox);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.category).toBe('general');
    expect(clusters[0]?.slug).toBe('rome-restaurants');
  });

  it('lets a majority user factType win over a single answer fact', () => {
    const inbox: InboxFile[] = [
      makeFile('rome-restaurants', 'answer', 'a'),
      makeFile('rome-restaurants', 'entity', 'b'),
      makeFile('rome-restaurants', 'entity', 'c'),
    ];
    const clusters = clusterBySubject(inbox);
    expect(clusters[0]?.category).toBe('entity');
  });

  it('does NOT let answer facts outvote a minority of non-answer facts (review fix)', () => {
    // Before the fix, `answer` votes normalize to `general` and can win a
    // majority outright — 2 entity + 3 answer would flip the cluster to
    // `general`, splitting the subject across docs/entity/rome.md AND
    // docs/general/rome.md. `answer` observations must not vote at all.
    const inbox: InboxFile[] = [
      makeFile('rome', 'entity', 'e1'),
      makeFile('rome', 'entity', 'e2'),
      makeFile('rome', 'answer', 'a1'),
      makeFile('rome', 'answer', 'a2'),
      makeFile('rome', 'answer', 'a3'),
    ];
    const clusters = clusterBySubject(inbox);
    expect(clusters[0]?.category).toBe('entity');
  });

  it('an all-answer cluster falls back to "general" (no non-answer votes)', () => {
    const inbox: InboxFile[] = [
      makeFile('rome', 'answer', 'a1'),
      makeFile('rome', 'answer', 'a2'),
      makeFile('rome', 'answer', 'a3'),
    ];
    const clusters = clusterBySubject(inbox);
    expect(clusters[0]?.category).toBe('general');
  });
});
