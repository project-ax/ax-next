// ---------------------------------------------------------------------------
// @ax/validator-skill — workspace:pre-apply subscriber that vetoes
// SKILL.md additions/modifications with malformed frontmatter.
//
// Phase 3 ships this as the first real subscriber on workspace:pre-
// apply. Identity validators (IDENTITY.md, SOUL.md) and a richer
// skill-schema check land in Phase 4+; the contract for ALL of them
// is the same — they get .ax/-filtered FileChange[] and decide
// allow/veto.
//
// Scope:
//   - Match: paths under `.ax/skills/<skill>/SKILL.md` (the canonical
//     skill-file shape).
//   - Action: parse YAML frontmatter; veto if name/description missing
//     or YAML is malformed.
//   - Pass-through: any other path (CLAUDE.md, source files, etc.)
//     is allowed without inspection.
//   - Deletes: pass-through (nothing to validate when the file is
//     going away).
//
// Capability budget: NO spawn, NO network, NO file I/O. The plugin
// consumes only the bytes already in the FileChange payload and
// returns a decision. See SECURITY.md for the threat-model walk.
// ---------------------------------------------------------------------------

import type { FileChange, Plugin, WorkspaceVersion } from '@ax/core';
import { reject } from '@ax/core';
import { parseFrontmatterBytes } from './frontmatter.js';

const PLUGIN_NAME = '@ax/validator-skill';

// Match `.ax/skills/<skill-name>/SKILL.md` exactly. The `<skill-name>`
// segment is `[^/]+` so subdirectories aren't allowed (skills are flat
// under .ax/skills/). A future relaxation (e.g., supporting nested
// skill packages) would update this regex; for now keep it strict so
// the validator surface is unambiguous.
const SKILL_PATH = /^\.ax\/skills\/[^/]+\/SKILL\.md$/;

interface PreApplyPayload {
  changes: FileChange[];
  parent: WorkspaceVersion | null;
  reason: string;
}

export function createValidatorSkillPlugin(): Plugin {
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
            if (!SKILL_PATH.test(c.path)) continue;

            const r = parseFrontmatterBytes(c.content);
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
