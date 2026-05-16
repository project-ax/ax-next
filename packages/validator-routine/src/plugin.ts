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
        async (_ctx, input) => {
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
            }
          }
          return undefined;
        },
      );
    },
  };
}
