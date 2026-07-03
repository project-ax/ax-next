// Near-duplicate slug detection (multi-session enumeration design, D4). The
// autopsy found one instance minting several docs (`b-29-bomber-model`,
// `b-29-bomber-model-kit`, ...) which inflates enumeration counts ("how many
// projects" answered 9 vs gold 2). Rule is deliberately conservative:
// same-category callers only, both slugs ≥ 3 tokens, token-SUBSET relation,
// and at most ONE token of difference — `user` never merges into
// `user-s-watch`, but `b-29-bomber-model` folds into `b-29-bomber-model-kit`.

export function findNearDupSlug(newSlug: string, existingSlugs: string[]): string | null {
  const nt = tokens(newSlug);
  if (nt.length < 3) return null;
  for (const existing of existingSlugs) {
    if (existing === newSlug) continue;
    const et = tokens(existing);
    if (et.length < 3) continue;
    const [small, big] = nt.length <= et.length ? [nt, et] : [et, nt];
    if (big.length - small.length > 1) continue;
    const bigSet = new Set(big);
    if (small.every((t) => bigSet.has(t))) return existing;
  }
  return null;
}

function tokens(slug: string): string[] {
  return slug.split('-').filter((t) => t.length > 0);
}
