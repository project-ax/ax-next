// Group inbox observations by slug(subject) so the Consolidator can deduplicate
// and promote them per-subject.
//
// WHY slug-based grouping: the Observer emits a free-text `subject` field —
// "React" and "react" are the same topic but string-equal comparison would
// produce two clusters. Slug normalization (lowercase, non-alphanumeric runs
// → '-') collapses those collisions before dedup/promote runs, so the
// Consolidator never writes two `docs/preference/react.md` files from two
// differently-cased observations about the same subject. Observations missing
// a subject fall into the "general" slug — same fallback that `slugify` uses
// for empty input.
//
// WHY ClusterCategory is a separate type from DocCategory (paths.ts): a cluster
// category is "what kind of fact dominated the inbox observations", derived by
// majority vote over `factType`. A DocCategory is "where to put the promoted
// file on disk". They happen to share the same value set today, but they carry
// different semantics — the Consolidator (Task 2A.9) maps the cluster's winner
// to a doc path. Keeping them separate means a future split (e.g. a new inbox
// factType that maps to an existing doc category) doesn't collapse the two
// concerns.

import type { InboxFile } from './inbox-store.js';
import { slugify } from './slugify.js';

export type ClusterCategory =
  | 'entity'
  | 'preference'
  | 'decision'
  | 'episode'
  | 'general';

export interface Cluster {
  /** Slug of the subject; used as the doc filename. */
  slug: string;
  /** Doc category — the most common factType across the cluster's observations. */
  category: ClusterCategory;
  observations: InboxFile[];
}

/**
 * Group a flat list of inbox observations into clusters, one per unique
 * slugified subject.
 *
 * Observations are accumulated in the order they appear in `inbox`. The
 * returned array is in the order clusters were first encountered (Map
 * insertion order), which is deterministic for a given input sequence.
 * Callers that need stable ordering should sort the result themselves.
 */
export function clusterBySubject(inbox: InboxFile[]): Cluster[] {
  const buckets = new Map<string, InboxFile[]>();
  for (const f of inbox) {
    const slug = slugify(f.frontmatter.subject ?? '');
    const list = buckets.get(slug) ?? [];
    list.push(f);
    buckets.set(slug, list);
  }
  const out: Cluster[] = [];
  for (const [slug, observations] of buckets) {
    out.push({ slug, category: pickCategory(observations), observations });
  }
  return out;
}

/**
 * Pick the most common `factType` across a group of observations.
 *
 * Ties are broken by the first-encountered winner (Map insertion order).
 * Any `factType` value not matching the five known categories is treated
 * as 'general' — which is the Observer's declared default, so in practice
 * this branch is noise protection.
 */
function pickCategory(obs: InboxFile[]): ClusterCategory {
  const counts = new Map<ClusterCategory, number>();
  for (const o of obs) {
    const cat = (o.frontmatter.factType ?? 'general') as ClusterCategory;
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  let best: ClusterCategory = 'general';
  let bestCount = -1;
  for (const [cat, n] of counts) {
    if (n > bestCount) { best = cat; bestCount = n; }
  }
  return best;
}
