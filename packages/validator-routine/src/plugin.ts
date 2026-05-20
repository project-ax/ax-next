import type { FileChange, Plugin, WorkspaceVersion } from '@ax/core';
import { reject } from '@ax/core';
import { parseRoutineFrontmatterBytes } from './frontmatter.js';

const PLUGIN_NAME = '@ax/validator-routine';

// Match `.ax/routines/<routine-name>.md` exactly. The `[^/]+` segment
// prevents subdirectories — routines are flat under .ax/routines/.
const ROUTINE_PATH = /^\.ax\/routines\/[^/]+\.md$/;

interface PreApplyPayload {
  changes: FileChange[];
  parent: WorkspaceVersion | null;
  reason: string;
}

export function createValidatorRoutinePlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [],
      subscribes: ['workspace:pre-apply'],
    },
    init({ bus }) {
      bus.subscribe<PreApplyPayload>(
        'workspace:pre-apply',
        PLUGIN_NAME,
        async (ctx, input) => {
          // Track webhook trigger.path → first-seen routine filename so two
          // routines in the same batch can't fight over the same URL. Only
          // catches in-batch collisions; cross-apply collisions (one of the
          // colliders is an unchanged existing routine) still surface at
          // apply time via the K10 last_status='error' path in @ax/routines.
          const webhookPaths = new Map<string, string>();
          for (const c of input.changes) {
            if (c.kind !== 'put') continue;
            if (!ROUTINE_PATH.test(c.path)) continue;
            const r = parseRoutineFrontmatterBytes(c.content);
            if (!r.ok) {
              return reject({ reason: `${c.path}: ${r.reason}` });
            }
            if (r.fields.trigger.kind === 'webhook') {
              const triggerPath = r.fields.trigger.path;
              const prior = webhookPaths.get(triggerPath);
              if (prior !== undefined) {
                return reject({
                  reason: `duplicate webhook trigger.path "${triggerPath}" in ${prior} and ${c.path}`,
                });
              }
              webhookPaths.set(triggerPath, c.path);

              // Destination-first: when hmac is configured, secretRef must
              // equal the canonical refForDestination({kind:'routine-hmac'})
              // output for this (agentId, path). The routines plugin mints
              // and looks the credential up under that exact ref (see
              // routines/src/sync.ts), so any other string silently breaks
              // the webhook (the credential lookup misses → 401 unauthorized).
              // Drift guard for the literal template lives in
              // @ax/credentials's KNOWN_DESTINATION_FIXTURES.
              if (r.fields.trigger.hmac !== undefined) {
                const expected = `routine:${ctx.agentId}:${c.path}:hmac`;
                const actual = r.fields.trigger.hmac.secretRef;
                if (actual !== expected) {
                  return reject({
                    reason: `${c.path}: hmac.secretRef "${actual}" does not match the canonical destination-derived ref "${expected}" (kind=routine-hmac, agentId=${ctx.agentId}, routinePath=${c.path})`,
                  });
                }
              }
            }
          }
          return undefined;
        },
      );
    },
  };
}
