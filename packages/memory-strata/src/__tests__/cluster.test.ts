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
  it('groups 5 observations into 2 clusters by slug(subject)', () => {
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
});
