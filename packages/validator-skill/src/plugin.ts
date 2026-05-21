// ---------------------------------------------------------------------------
// @ax/validator-skill — workspace:pre-apply subscriber that:
//   1. Vetoes agent writes to Claude Agent SDK setting-source paths
//      (`.claude/settings.json`, `.claude/agents/`, `CLAUDE.md`, etc.) —
//      these become live config when Phase 0 enables
//      `settingSources: ['user', 'project']`, so any agent-authored
//      write would let the model bootstrap new sub-agents, slash-
//      commands, ruleset files, or rewrite its own SDK settings. See
//      docs/notes/2026-05-17-sdk-setting-sources-audit.md.
//   2. Vetoes SKILL.md additions/modifications with malformed frontmatter.
//
// Phase 3 ships this as the first real subscriber on workspace:pre-
// apply. Identity validators (IDENTITY.md, SOUL.md) and a richer
// skill-schema check land in Phase 4+; the contract for ALL of them
// is the same — they get policy-filtered FileChange[] (`.ax/**` +
// `.claude/**`) and decide allow/veto.
//
// Scope:
//   - Veto: SDK-config exact paths and directory prefixes (see lists
//     below). These reject before any content inspection — the audit
//     doc justifies each entry.
//   - Match (frontmatter check): paths under `.ax/skills/<skill>/SKILL.md`
//     (the canonical skill-file shape).
//   - Action (frontmatter check): parse YAML frontmatter; veto if
//     name/description missing or YAML is malformed.
//   - Pass-through: any other path (`.claude/skills/<name>/...`,
//     `.ax/CLAUDE.md`, etc.) is allowed without inspection.
//   - Deletes: pass-through for SKILL.md (nothing to validate when the
//     file is going away). SDK-config deletes also pass-through —
//     removing a hostile file is fine; the threat is *adding* one.
//
// Capability budget: NO spawn, NO network, NO file I/O. The plugin
// consumes only the bytes already in the FileChange payload and
// returns a decision. See SECURITY.md for the threat-model walk.
// ---------------------------------------------------------------------------

import type { FileChange, Plugin, WorkspaceVersion } from '@ax/core';
import { reject } from '@ax/core';
import {
  parseFrontmatterBytes,
  stripCapabilitiesFromFrontmatter,
} from './frontmatter.js';

const PLUGIN_NAME = '@ax/validator-skill';

// Match `.ax/skills/<skill-name>/SKILL.md` exactly. The `<skill-name>`
// segment is `[^/]+` so subdirectories aren't allowed (skills are flat
// under .ax/skills/). A future relaxation (e.g., supporting nested
// skill packages) would update this regex; for now keep it strict so
// the validator surface is unambiguous.
const SKILL_PATH = /^\.ax\/skills\/[^/]+\/SKILL\.md$/;

// SDK setting-source paths the Claude Agent SDK reads from project root
// when `settingSources: ['user', 'project']` is enabled (Phase 0). An
// agent write to any of these escalates SDK behavior — new sub-agents,
// new slash-commands, prompt-injected rules, or a settings.json that
// re-enables disabled tools. Veto unconditionally.
//
// Source-of-truth and per-path rationale:
// docs/notes/2026-05-17-sdk-setting-sources-audit.md
const SDK_CONFIG_EXACT_PATHS = new Set<string>([
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/CLAUDE.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
]);

const SDK_CONFIG_DIR_PREFIXES = [
  '.claude/agents/',
  '.claude/commands/',
  '.claude/rules/',
] as const;

function isProtectedSdkConfigPath(p: string): boolean {
  if (SDK_CONFIG_EXACT_PATHS.has(p)) return true;
  return SDK_CONFIG_DIR_PREFIXES.some((prefix) => p.startsWith(prefix));
}

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
        async (ctx, input) => {
          // Build the next change list lazily — if no SKILL.md needs
          // rewriting, we return undefined and the bus keeps the
          // original payload.
          let rewritten: FileChange[] | undefined;
          for (let i = 0; i < input.changes.length; i++) {
            const c = input.changes[i]!;
            if (c.kind !== 'put') continue;

            // SDK-config veto — checked BEFORE the SKILL.md content
            // parse because audit-list paths are unambiguous rejects
            // regardless of payload.
            //
            // NOTE: this SDK-config veto fires for EVERY
            // workspace:pre-apply caller, regardless of who initiated the
            // apply. Originally the agent bundle wire was the only caller;
            // since Finding 3 (the workspace:apply facade, PR #119)
            // host-internal callers fire pre-apply too — @ax/conversations
            // drop-turn (`.claude/projects/**/*.jsonl`) and @ax/attachments
            // commit (`.ax/uploads/**`). Neither writes a protected
            // SDK-config path, so there is no veto regression, and vetoing
            // these paths regardless of caller is the safer default. If a
            // host-internal caller is ever added that LEGITIMATELY needs to
            // write one of the protected paths, plumb an `actor` field
            // through PreApplyPayload at that point and gate this check on
            // `actor !== 'host'`. YAGNI until then.
            if (isProtectedSdkConfigPath(c.path)) {
              return reject({
                reason:
                  `${c.path}: SDK-config paths are host-only; agent ` +
                  `writes would escalate SDK behavior. See ` +
                  `docs/notes/2026-05-17-sdk-setting-sources-audit.md.`,
              });
            }

            if (!SKILL_PATH.test(c.path)) continue;

            // I-P1-2: workspace-authored SKILL.md cannot self-grant
            // capabilities. Strip the block before content validation
            // so the validator sees the host-policy shape only. The
            // installed-side parser (@ax/skills/manifest.ts) honors
            // capabilities; this path does not.
            let text: string;
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(c.content);
            } catch {
              return reject({ reason: `${c.path}: SKILL.md content is not valid UTF-8` });
            }
            const stripResult = stripCapabilitiesFromFrontmatter(text);
            let contentForValidation: Uint8Array = c.content;
            if (stripResult.stripped) {
              const newBytes = new TextEncoder().encode(stripResult.text);
              contentForValidation = newBytes;
              if (rewritten === undefined) {
                rewritten = input.changes.slice();
              }
              rewritten[i] = { ...c, content: newBytes };
              ctx.logger.warn('skill_capabilities_stripped', {
                path: c.path,
                reason:
                  'workspace-authored SKILL.md may not declare a capabilities ' +
                  'block; host strips it before storage. Install via /admin/skills ' +
                  'to grant hosts or credential slots.',
              });
            }

            const r = parseFrontmatterBytes(contentForValidation);
            if (!r.ok) {
              return reject({ reason: `${c.path}: ${r.reason}` });
            }
          }
          if (rewritten === undefined) return undefined;
          return { ...input, changes: rewritten };
        },
      );
    },
  };
}
