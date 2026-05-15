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
          for (const c of input.changes) {
            if (c.kind !== 'put') continue;
            if (!ROUTINE_PATH.test(c.path)) continue;
            const r = parseRoutineFrontmatterBytes(c.content);
            if (!r.ok) {
              return reject({ reason: `${c.path}: ${r.reason}` });
            }
          }
          return undefined;
        },
      );
    },
  };
}
