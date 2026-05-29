// ---------------------------------------------------------------------------
// @ax/validator-skill — workspace:pre-apply subscriber that:
//   1. Vetoes agent writes to Claude Agent SDK setting-source paths
//      (`.claude/settings.json`, `.claude/agents/`, `CLAUDE.md`, etc.) —
//      these become live config when Phase 0 enables
//      `settingSources: ['user', 'project']`, so any agent-authored
//      write would let the model bootstrap new sub-agents, slash-
//      commands, ruleset files, or rewrite its own SDK settings. See
//      docs/notes/2026-05-17-sdk-setting-sources-audit.md.
//   2. For `.ax/draft-skills/<id>/SKILL.md`: accept-but-annotate via a
//      content safety scan (Phase 2). Never vetoes on SKILL.md content;
//      structural validity is enforced lazily at promote.
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
//   - Match (safety scan): paths under `.ax/draft-skills/<skill>/SKILL.md`
//     (the canonical skill-file shape).
//   - Action (safety scan): run regex scan then optional LLM scan;
//     set/clear a host-side quarantine flag — NEVER reject on content.
//   - Pass-through: any other path (`.claude/skills/<name>/...`,
//     `.ax/CLAUDE.md`, etc.) is allowed without inspection.
//   - Deletes: pass-through for SKILL.md (nothing to validate when the
//     file is going away). SDK-config deletes also pass-through —
//     removing a hostile file is fine; the threat is *adding* one.
//
// Capability budget: NO spawn, NO file I/O. Network access is gated
// behind the soft-dep `llm:call:anthropic` which degrades gracefully
// when unavailable (CLI preset). See SECURITY.md for the threat-model
// walk.
// ---------------------------------------------------------------------------

import type { FileChange, Plugin, WorkspaceVersion } from '@ax/core';
import { reject } from '@ax/core';
import { stripCapabilitiesFromFrontmatter } from './frontmatter.js';
import { regexScan, llmScan } from './skill-safety-scan.js';

const PLUGIN_NAME = '@ax/validator-skill';

// Match `.ax/draft-skills/<skill-name>/SKILL.md` exactly, capturing <skill-name>.
// The `<skill-name>` segment is `[^/]+` so subdirectories aren't allowed
// (skills are flat under .ax/draft-skills/). A future relaxation (e.g.,
// supporting nested skill packages) would update this regex; for now keep it
// strict so the validator surface is unambiguous.
const SKILL_PATH = /^\.ax\/draft-skills\/([^/]+)\/SKILL\.md$/;

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

export interface ValidatorSkillConfig {
  scan?: {
    /** Fast model for the Layer-2 LLM scan. Default: Claude Haiku 4.5. */
    llmModel?: string;
    /** Cap on bytes sent to the LLM. Default 16384. */
    maxScanBytes?: number;
    /** Per-call LLM timeout (ms). Default 8000. */
    llmTimeoutMs?: number;
  };
}

export function createValidatorSkillPlugin(cfg: ValidatorSkillConfig = {}): Plugin {
  const llmModel = cfg.scan?.llmModel ?? 'claude-haiku-4-5-20251001';
  const maxScanBytes = cfg.scan?.maxScanBytes ?? 16_384;
  const llmTimeoutMs = cfg.scan?.llmTimeoutMs ?? 8_000;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [],
      optionalCalls: [
        {
          hook: 'skills:quarantine-set',
          degradation:
            'commit scan runs but the quarantine flag is not persisted (no skills store) — a later promote may not catch this draft',
        },
        {
          hook: 'skills:quarantine-clear',
          degradation:
            'a previously-quarantined draft cannot be auto-cleared on a clean re-scan (no skills store)',
        },
        {
          hook: 'llm:call:anthropic',
          degradation: 'Layer-2 LLM scan is skipped; the regex layer still runs',
        },
      ],
      subscribes: ['workspace:pre-apply'],
    },
    init({ bus }) {
      bus.subscribe<PreApplyPayload>(
        'workspace:pre-apply',
        PLUGIN_NAME,
        async (ctx, input) => {
          // -----------------------------------------------------------------
          // PASS 1 — hard vetoes (the security boundary). Runs over ALL
          // changes BEFORE any bus.call, so it cannot be aborted by an
          // external-state error (e.g. a quarantine-store outage). HookBus.fire
          // catches a subscriber throw and treats it as a clean pass, so the
          // SDK-config veto MUST NOT be interleaved with the scan/quarantine
          // path — a throw there would silently accept a protected-path write.
          //
          // NOTE: this SDK-config veto fires for EVERY workspace:pre-apply
          // caller, regardless of who initiated the apply. Originally the agent
          // bundle wire was the only caller; since Finding 3 (the
          // workspace:apply facade, PR #119) host-internal callers fire
          // pre-apply too — @ax/conversations drop-turn
          // (`.claude/projects/**/*.jsonl`) and @ax/attachments commit
          // (`.ax/uploads/**`). Neither writes a protected SDK-config path, so
          // there is no veto regression, and vetoing these paths regardless of
          // caller is the safer default. If a host-internal caller is ever
          // added that LEGITIMATELY needs to write one of the protected paths,
          // plumb an `actor` field through PreApplyPayload at that point and
          // gate this check on `actor !== 'host'`. YAGNI until then.
          for (const c of input.changes) {
            if (c.kind !== 'put') continue;
            if (isProtectedSdkConfigPath(c.path)) {
              return reject({
                reason:
                  `${c.path}: SDK-config paths are host-only; agent ` +
                  `writes would escalate SDK behavior. See ` +
                  `docs/notes/2026-05-17-sdk-setting-sources-audit.md.`,
              });
            }
          }

          // -----------------------------------------------------------------
          // PASS 2 — SKILL.md caps-strip + content safety scan + quarantine
          // annotation. NEVER vetoes. A quarantine-store outage degrades to a
          // log (the helpers below try/catch) so a failed bus.call can never
          // abort the subscriber and thereby skip a later hard veto — but
          // PASS 1 already guarantees those ran first, so this is belt-and-
          // suspenders.
          const setQuarantine = async (skillId: string, reason: string) => {
            if (!bus.hasService('skills:quarantine-set')) return;
            try {
              await bus.call('skills:quarantine-set', ctx, {
                ownerUserId: ctx.userId,
                agentId: ctx.agentId,
                skillId,
                reason,
              });
            } catch (e) {
              ctx.logger.warn('skill_quarantine_set_failed', {
                skillId,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          };
          const clearQuarantine = async (skillId: string) => {
            if (!bus.hasService('skills:quarantine-clear')) return;
            try {
              await bus.call('skills:quarantine-clear', ctx, {
                ownerUserId: ctx.userId,
                agentId: ctx.agentId,
                skillId,
              });
            } catch (e) {
              ctx.logger.warn('skill_quarantine_clear_failed', {
                skillId,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          };

          // Build the next change list lazily — if no SKILL.md needs
          // rewriting, we return undefined and the bus keeps the
          // original payload.
          let rewritten: FileChange[] | undefined;
          for (let i = 0; i < input.changes.length; i++) {
            const c = input.changes[i]!;
            if (c.kind !== 'put') continue;

            const skillMatch = SKILL_PATH.exec(c.path);
            if (skillMatch === null) continue;
            const skillId = skillMatch[1]!;

            // Decode the RAW bytes (what actually lands in storage — the
            // pre-apply transform is discarded on the apply path). On non-UTF-8
            // we ACCEPT (no veto) — structural validity is enforced lazily at
            // promote. Non-destructive: we never reject SKILL.md content here.
            let text: string;
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(c.content);
            } catch {
              // Non-UTF-8 SKILL.md can't be decoded/scanned and can't be parsed
              // as YAML at promote. Don't veto (non-destructive) — but quarantine
              // it so an un-scannable draft can't be promoted or (Phase 3)
              // projected. The agent re-saves it as UTF-8 to clear the flag.
              await setQuarantine(
                skillId,
                'SKILL.md is not valid UTF-8 and cannot be safety-scanned — re-save it as UTF-8 text.',
              );
              continue;
            }

            // Capabilities-strip (I-P1-2) — UNCHANGED. The transform is discarded
            // on the apply path; kept as defense-in-depth + the observable warn.
            const stripResult = stripCapabilitiesFromFrontmatter(text);
            if (stripResult.stripped) {
              const newBytes = new TextEncoder().encode(stripResult.text);
              if (rewritten === undefined) rewritten = input.changes.slice();
              rewritten[i] = { ...c, content: newBytes };
              ctx.logger.warn('skill_capabilities_stripped', {
                path: c.path,
                reason:
                  'workspace-authored SKILL.md may not declare a capabilities ' +
                  'block; host strips it before storage.',
              });
            }

            // Content safety scan (Phase 2) — accept-but-annotate. NEVER vetoes.
            // Regex-first; LLM only when regex is clean. Scan the submitted text
            // (before the capability strip — we inspect what the agent sent, not
            // what's stored).
            let scanHit = regexScan(text);
            let llmDegraded = false;
            if (scanHit === null && bus.hasService('llm:call:anthropic')) {
              const r = await llmScan({
                bus,
                ctx,
                text,
                model: llmModel,
                maxScanBytes,
                timeoutMs: llmTimeoutMs,
              });
              llmDegraded = r.degraded;
              if (r.degraded) {
                ctx.logger.warn('skill_scan_llm_unavailable', { path: c.path, skillId });
              }
              scanHit = r.hit;
            }

            if (scanHit !== null) {
              ctx.logger.warn('skill_quarantined', {
                path: c.path,
                skillId,
                category: scanHit.category,
              });
              await setQuarantine(skillId, scanHit.reason);
            } else if (!llmDegraded) {
              // Confidently clean (regex clean AND either LLM clean or no LLM
              // layer) → clear. On an LLM-degraded scan we leave any existing
              // quarantine as-is: a transient LLM failure must not erase a
              // true-positive the LLM correctly flagged on an earlier run.
              await clearQuarantine(skillId);
            }
          }
          if (rewritten === undefined) return undefined;
          return { ...input, changes: rewritten };
        },
      );
    },
  };
}
