// Policy-visible path filter (the `.ax/**` + `.claude/**` chokepoint) now
// lives in @ax/core — see `packages/core/src/workspace-policy.ts` for the
// full rationale and the audit source. It moved there in Finding 3 so the
// new backend-agnostic `workspace:apply` facade and this commit-notify path
// share one source of truth (Invariant 4).
//
// We keep this module as a thin re-export so existing importers
// (`workspace-commit-notify.ts`, `__tests__/filter.test.ts`) stay unchanged.
export { filterToPolicy, POLICY_PREFIXES, POLICY_EXACT_PATHS } from '@ax/core';
