/**
 * Standalone operator script: wipes pre-redesign credential rows from storage.
 *
 * The wipe is idempotent via a storage marker key. Calling this a second time
 * (without deleting the marker) is a no-op. To force a re-wipe, delete the
 * marker key from storage first.
 *
 * This file re-exports the implementation from `src/wipe-pre-redesign.ts` so
 * the function can be invoked independently of the plugin init path (e.g. from
 * a one-off migration script). The compiled implementation ships in
 * `dist/wipe-pre-redesign.js`.
 */
export {
  wipePreRedesignCredentials,
  WIPE_MARKER_KEY,
  CREDENTIAL_PREFIX,
} from '../src/wipe-pre-redesign.js';
