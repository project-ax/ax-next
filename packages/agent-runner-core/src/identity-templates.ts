// ---------------------------------------------------------------------------
// Canonical agent-identity templates — re-exported from the shared
// `@ax/agent-identity-templates` pure-data package (TASK-140).
//
// The template bytes used to live here (Phase 1). They now live in their own
// kernel-free package so the template stays pure data with no cross-plugin
// runtime import (Invariant #2). The runner
// keeps importing from this module path (`./identity-templates.js`) so its own
// call sites + tests are unchanged.
// ---------------------------------------------------------------------------

export {
  BOOTSTRAP_TEMPLATE,
  IDENTITY_SCAFFOLD,
  SOUL_SCAFFOLD,
  fallbackIdentityLine,
  bootstrapPreamble,
} from '@ax/agent-identity-templates';
