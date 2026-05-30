// ---------------------------------------------------------------------------
// @ax/validator-skill — two surfaces:
//
//   1. `workspace:pre-apply` subscriber — VETOES agent writes to Claude Agent
//      SDK setting-source paths (`.claude/settings.json`, `.claude/agents/`,
//      `CLAUDE.md`, etc.). These become live config when Phase 0 enables
//      `settingSources: ['user', 'project']`, so any agent-authored write would
//      let the model bootstrap new sub-agents, slash-commands, ruleset files, or
//      rewrite its own SDK settings. See
//      docs/notes/2026-05-17-sdk-setting-sources-audit.md. This is the security
//      boundary and is UNCONDITIONAL — it fires for every workspace:pre-apply
//      caller (agent bundle, host-internal transcript/upload commits).
//
//   2. `skills:scan` service — the skill content safety scan (TASK-74,
//      out-of-git Part D). The skill authoring substrate moved OFF git (the
//      `.ax/draft-skills/<id>/SKILL.md` workspace projection is retired), onto
//      the `skill_propose` chokepoint. The scan's HOME moves with it: instead of
//      matching a git SKILL.md path on `workspace:pre-apply`, the validator now
//      registers `skills:scan` and `@ax/skills`' `skills:propose` calls it at the
//      chokepoint. Accept-but-annotate: it returns a verdict (clean | hit{reason})
//      — the gate quarantines on a hit; the validator NEVER vetoes on content.
//
// Capability budget: NO spawn, NO file I/O. Network access is gated behind the
// soft-dep `llm:call:anthropic` which degrades gracefully when unavailable (CLI
// preset). See SECURITY.md for the threat-model walk.
// ---------------------------------------------------------------------------

import type { FileChange, Plugin, WorkspaceVersion } from '@ax/core';
import { reject } from '@ax/core';
import { regexScan, llmScan } from './skill-safety-scan.js';

const PLUGIN_NAME = '@ax/validator-skill';

// `skills:scan` payload/verdict — re-declared locally (I2: the validator must
// not import @ax/skills). Structurally mirrors @ax/skills' SkillsScanInput /
// SkillsScanOutput; if those drift, reconcile here.
interface SkillsScanInput {
  skillId: string;
  manifestYaml: string;
  bodyMd: string;
  files: Array<{ path: string; contents: string }>;
}
interface SkillsScanOutput {
  verdict: 'clean' | 'hit';
  reason?: string;
}

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
      // `skills:scan` is the skill content safety scan (TASK-74). @ax/skills'
      // `skills:propose` calls it at the authoring chokepoint. ONE authoritative
      // scanner (a service hook, not a subscriber), so a missing scanner
      // degrades cleanly at the gate (treated as 'clean' there).
      registers: ['skills:scan'],
      calls: [],
      optionalCalls: [
        {
          hook: 'llm:call:anthropic',
          degradation: 'Layer-2 LLM scan is skipped; the regex layer still runs',
        },
      ],
      // The SDK-config hard veto stays on workspace:pre-apply (it guards every
      // commit, not just skills — transcript/upload writes too).
      subscribes: ['workspace:pre-apply'],
    },
    init({ bus }) {
      // --- Surface 1: SDK-config hard veto on workspace:pre-apply ----------
      // UNCONDITIONAL security boundary. Rejects an agent write to any Claude
      // Agent SDK setting-source path. The skill SKILL.md scan branch that used
      // to live here is GONE (TASK-74): skill authoring left git, so a
      // `.ax/draft-skills/<id>/SKILL.md` write no longer occurs — the scan moved
      // to the `skills:scan` service below. This subscriber is now ONLY the
      // SDK-config veto.
      bus.subscribe<PreApplyPayload>(
        'workspace:pre-apply',
        PLUGIN_NAME,
        async (_ctx, input) => {
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
          return undefined; // pass-through — no transform.
        },
      );

      // --- Surface 2: skills:scan service (the propose-chokepoint scan) ----
      // Accept-but-annotate. Regex-first (Layer 1); LLM (Layer 2) only when
      // regex is clean AND the soft-dep llm:call:anthropic is loaded. Scans the
      // full bundle TEXT (SKILL.md frontmatter + body + extra-file contents) so
      // an injection hidden in a helper file is caught too. NEVER throws on a
      // hit — returns { verdict: 'hit', reason } and the gate quarantines. A
      // scanner error/timeout degrades to the (clean) Layer-1 verdict; the scan
      // never blocks authoring.
      bus.registerService<SkillsScanInput, SkillsScanOutput>(
        'skills:scan',
        PLUGIN_NAME,
        async (ctx, input) => {
          // Concatenate the scannable surfaces. The manifest + body are the
          // primary attack surface; extra files can hide payloads too. Bounded
          // by the gate's validateBundleFiles caps (<=512 KiB total) so this is
          // never a runaway concat.
          const fileText = input.files.map((f) => f.contents).join('\n');
          const text = `${input.manifestYaml}\n${input.bodyMd}\n${fileText}`;

          let scanHit = regexScan(text);
          if (scanHit === null && bus.hasService('llm:call:anthropic')) {
            const r = await llmScan({
              bus,
              ctx,
              text,
              model: llmModel,
              maxScanBytes,
              timeoutMs: llmTimeoutMs,
            });
            if (r.degraded) {
              ctx.logger.warn('skill_scan_llm_unavailable', { skillId: input.skillId });
            }
            scanHit = r.hit;
          }

          if (scanHit !== null) {
            ctx.logger.warn('skill_quarantined', {
              skillId: input.skillId,
              category: scanHit.category,
            });
            return { verdict: 'hit', reason: scanHit.reason };
          }
          return { verdict: 'clean' };
        },
      );
    },
  };
}
