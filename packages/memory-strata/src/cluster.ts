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

const KNOWN_CATEGORIES: ReadonlySet<ClusterCategory> = new Set([
  'entity', 'preference', 'decision', 'episode', 'general',
]);

/**
 * factTypes that are NOT doc categories, mapped to the category they live in.
 *
 * `answer` (2026-07-29, assistant-content extraction) is a first-class factType —
 * it marks content the ASSISTANT provided — but it deliberately has NO doc
 * category of its own. It shares `general` with the user-side facts on the same
 * subject, so both land in ONE doc: splitting them would break the co-location
 * that lets BM25 match an assistant fact from the question's topic terms.
 *
 * Explicit rather than leaning on the unknown-value fallback below (which yields
 * the same `general` today) so the routing is legible here and a future taxonomy
 * edit can't silently reroute it. This is the case cluster.ts's header
 * anticipated: "a new inbox factType that maps to an existing doc category".
 */
const FACT_TYPE_TO_CATEGORY: ReadonlyMap<string, ClusterCategory> = new Map([
  ['answer', 'general'],
]);

function normalizeCategory(raw: string | undefined): ClusterCategory {
  const candidate = raw ?? 'general';
  const mapped = FACT_TYPE_TO_CATEGORY.get(candidate);
  if (mapped !== undefined) return mapped;
  return KNOWN_CATEGORIES.has(candidate as ClusterCategory)
    ? (candidate as ClusterCategory)
    : 'general';
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
    const cat = normalizeCategory(o.frontmatter.factType);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  let best: ClusterCategory = 'general';
  let bestCount = -1;
  for (const [cat, n] of counts) {
    if (n > bestCount) { best = cat; bestCount = n; }
  }
  return best;
}
