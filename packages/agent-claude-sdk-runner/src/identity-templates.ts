// ---------------------------------------------------------------------------
// Canonical agent-identity templates — re-exported from the shared
// `@ax/agent-identity-templates` pure-data package (TASK-140).
//
// The template bytes used to live here (Phase 1). They now live in their own
// kernel-free package so a SECOND consumer — `@ax/channel-web`'s bootstrap
// route, which seeds `.ax/BOOTSTRAP.md` at agent create — can import the SAME
// constants without a cross-plugin runtime import (Invariant #2). The runner
// keeps importing from this module path (`./identity-templates.js`) so its own
// call sites + tests are unchanged.
// ---------------------------------------------------------------------------

export {
  BOOTSTRAP_TEMPLATE,
  IDENTITY_SCAFFOLD,
  SOUL_SCAFFOLD,
  fallbackIdentityLine,
} from '@ax/agent-identity-templates';
