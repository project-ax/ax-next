// ---------------------------------------------------------------------------
// @ax/validator-skill — the `skills:scan` service: the skill content safety
// scan (TASK-74). Skill authoring runs through the `skill_propose`
// chokepoint, and @ax/skills' `skills:propose` calls this scan there, on the
// whole bundle's text. Accept-but-annotate: it returns a verdict
// (clean | hit{reason}); the gate quarantines on a hit, and the validator
// NEVER refuses on content.
//
// Until TASK-995 it also had a veto on the git workspace's pre-apply event,
// refusing agent writes to the Claude Agent SDK's setting-source paths
// (`.claude/settings.json`, `.claude/agents/`, `CLAUDE.md` and friends). That
// tier is gone, and with it the event. Those names are now ordinary files in
// the agent's home, and nothing loads them as settings: the SDK runner reads
// user settings only (`settingSources: ['user']`), from a CLAUDE_CONFIG_DIR
// it refuses to start without and that may not sit inside the home. The
// runner's own tests pin both, with a real-SDK canary that plants those files.
//
// Capability budget: NO spawn, NO file I/O. Network access is gated behind the
// soft-dep `llm:call:anthropic` which degrades gracefully when unavailable (CLI
// preset). See SECURITY.md for the threat-model walk.
// ---------------------------------------------------------------------------

import type { Plugin } from '@ax/core';
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
      subscribes: [],
    },
    init({ bus }) {
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
