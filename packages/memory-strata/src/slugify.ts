// Subject -> URL-safe slug. Used as the directory/file name for canonical
// docs (docs/<category>/<slug>.md). Defensive: an Observer that returns
// path-traversal characters in `subject` cannot cause us to write outside
// the memory tree. Any input that collapses to empty after stripping
// non-alphanumeric characters falls back to "general" (the Observer's
// default subject) so every doc always has a valid filename.
// Internal only — not part of the public @ax/memory-strata API surface.

const FALLBACK = 'general';

export function slugify(input: string): string {
  const lowered = input.toLowerCase();
  const dasherized = lowered.replace(/[^a-z0-9]+/g, '-');
  const trimmed = dasherized.replace(/^-+|-+$/g, '');
  return trimmed.length === 0 ? FALLBACK : trimmed;
}
