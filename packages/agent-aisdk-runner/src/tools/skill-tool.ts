// ---------------------------------------------------------------------------
// The `Skill` tool — the progressive-load half of §4.
//
// The Anthropic SDK ships a built-in `Skill` tool; `ai@7` does not, so we build
// it. It is deliberately boring: look up a discovered skill by name, hand back
// its body and its bundle directory. The interesting decisions are the three
// below, and all three are about what happens when something is WRONG.
//
//   1. It goes through `wrapWithPolicy` like every other tool (I₁). Executing
//      in-process is not a reason to skip the gate — it is a reason to be
//      explicit that we didn't.
//   2. An unknown name is a RESULT, not a throw. A typo'd skill name is a model
//      mistake to recover from; the response names the skills that do exist so
//      the next call succeeds. Throwing would surface as an error result and
//      teach the model nothing.
//   3. A skill whose MCP servers can't run still LOADS, and the response says
//      so. Design §3: "degradation must be visible, not silent" — the same
//      pattern as the egress-block remediation notes. Tell the model about the
//      constraint at the moment it matters and it adapts; stay quiet and it
//      hallucinates tools that will never resolve.
// ---------------------------------------------------------------------------

import { jsonSchema, tool, type Tool } from 'ai';
import type { HoldLatch, ToolPolicy } from '@ax/agent-runner-core';
import type { DiscoveredSkill } from '../skills-index.js';
import { wrapWithPolicy } from './policy-wrap.js';

/** The ax-native tool name. Matches the SDK built-in so prompts port cleanly. */
export const SKILL_TOOL_NAME = 'Skill';

/**
 * Appended to the response of any skill whose MCP servers were materialized.
 * Exported so the acceptance test asserts the DEGRADATION by identity rather
 * than by a substring that a reword would silently break.
 */
export const MCP_UNAVAILABLE_NOTE =
  'Note: this skill declares MCP servers. They are not available on this runner, ' +
  'so any tool this skill tells you to call from one of those servers does not exist ' +
  'and never will in this session. Follow the rest of the skill using the tools you ' +
  'actually have, and say plainly which steps you could not do rather than pretending ' +
  'a missing tool ran.';

export interface BuildSkillToolOptions {
  policy: ToolPolicy;
  skills: DiscoveredSkill[];
  /** The one latch shared by every tool this turn — see WrapWithPolicyOptions. */
  holdLatch: HoldLatch;
}

/**
 * Build the one-entry `{ Skill: … }` record the loop spreads into its tool set.
 *
 * Returns an EMPTY record when nothing is installed — the same reasoning as
 * `buildSkillsPromptSection` returning `''`. Advertising a `Skill` tool whose
 * only possible answer is "there aren't any" spends tokens on every turn and
 * invites the model to call it and be disappointed.
 */
export function buildSkillTool(
  opts: BuildSkillToolOptions,
): Record<string, Tool> {
  if (opts.skills.length === 0) return {};

  const available = opts.skills.map((s) => s.name).join(', ');

  const execute = wrapWithPolicy(
    { policy: opts.policy, name: SKILL_TOOL_NAME, isBuiltin: true, holdLatch: opts.holdLatch },
    async (input) => {
      const requested = typeof input['name'] === 'string' ? input['name'].trim() : '';
      const found = lookup(opts.skills, requested);

      if (found === undefined) {
        // Decision 2. Phrased as a correction the model can act on in one step.
        return (
          `No skill named ${JSON.stringify(requested)} is installed. ` +
          `Available skills: ${available}. ` +
          'Call Skill again with one of those exact names, or continue without a skill.'
        );
      }

      const parts = [
        `# Skill: ${found.name}`,
        '',
        `Bundle directory: ${found.dir}`,
        "Any file this skill references lives in that directory — Read or Bash within it. Everything there is read-only.",
        '',
        found.body.trim(),
      ];
      // Decision 3 — after the body, so the model reads the instructions and
      // then the caveat that modifies them.
      if (found.hasMcpServers) parts.push('', MCP_UNAVAILABLE_NOTE);

      return parts.join('\n');
    },
  );

  return {
    [SKILL_TOOL_NAME]: tool({
      description:
        'Load the full instructions for one of the available skills listed in the ' +
        'system prompt. Call this before following a skill. Returns the skill body ' +
        'and its bundle directory.',
      // Hand-written JSON Schema via `jsonSchema()` rather than zod: the AI SDK
      // accepts either, and staying zod-free keeps this package's dependency
      // surface inside the sandbox as small as it already is.
      inputSchema: jsonSchema<{ name: string }>({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: `The skill's name, exactly as listed in the system prompt. One of: ${available}.`,
          },
        },
        required: ['name'],
        additionalProperties: false,
      }),
      execute,
    }),
  };
}

/**
 * Name → skill. Exact manifest name first, then the bundle directory id, then a
 * case-insensitive pass over both.
 *
 * The lenience is deliberate and costs nothing: `id` and `name` are usually the
 * same string but are allowed to diverge, the model sees only `name`, and the
 * only alternative to matching a near-miss is a round trip that ends in the
 * same place. Nothing here grants reach — every candidate is already in the
 * host-projected set.
 */
function lookup(
  skills: DiscoveredSkill[],
  requested: string,
): DiscoveredSkill | undefined {
  if (requested.length === 0) return undefined;
  const lower = requested.toLowerCase();
  return (
    skills.find((s) => s.name === requested) ??
    skills.find((s) => s.id === requested) ??
    skills.find(
      (s) => s.name.toLowerCase() === lower || s.id.toLowerCase() === lower,
    )
  );
}
