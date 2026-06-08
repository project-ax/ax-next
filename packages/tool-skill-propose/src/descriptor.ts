import type { ToolDescriptor } from '@ax/core';

export const SKILL_PROPOSE_TOOL_NAME = 'skill_propose' as const;

/**
 * TASK-74 (out-of-git Part D / §D1; filestore-user-files Phase 3 / TASK-165).
 * The agent authors a skill bundle into the draft dir `<root>/.skill-draft/<id>/`
 * — where `<root>` is the durable per-agent mount when one is wired, else the
 * ephemeral scratch tier — then calls this tool with that dir path. The runner-
 * side executor reads the dir, validates it structurally, and ships it to the
 * host's `skills:propose` gate.
 *
 * The DESCRIPTOR is host-side and static (catalog advertisement), so it does NOT
 * hard-code the tier-specific root: the live `<root>/.skill-draft/` path is told
 * to the model in the per-session skill-authoring operating note (composed in the
 * runner from the resolved draft root — see `skillAuthoringNote`). The descriptor
 * just names the `.skill-draft/<id>` directory and points at the operating notes.
 *
 * Sandbox-executed (mirror of `artifact_publish`): the executor runs inside the
 * runner pod because only it can read the draft dir at call time. The host-side
 * plugin in this package only registers this descriptor so the catalog advertises
 * the tool to the model.
 *
 * The description ALSO carries the spawn-time-discovery guidance (design §D6):
 * a proposed skill is available NEXT turn, not this one. Without it the agent
 * may try to invoke a skill it just proposed, fail to find it, and get confused.
 */
export const SKILL_PROPOSE_DESCRIPTOR: ToolDescriptor = {
  name: SKILL_PROPOSE_TOOL_NAME,
  description: [
    'Propose a new skill you have authored, so it can become available to you.',
    '',
    'A skill is pure KNOW-HOW — instructions and helper files. It does NOT carry',
    'access to a service. The access — the hosts it talks to, the key it spends,',
    'the CLI/MCP it runs — is a separate first-class thing called a CONNECTOR. A',
    'skill REFERENCES the connectors it uses; it never contains them.',
    '',
    'First write the bundle into your skill-draft directory .skill-draft/<id>/',
    '(its full path is given in your operating notes) — a SKILL.md with YAML',
    'frontmatter plus any helper files — then call this tool with that directory',
    'path. The frontmatter contract (between the --- fences) is:',
    '  name: <lowercase-slug>   # e.g. "linear"; NOT "id". /^[a-z][a-z0-9-]{0,63}$/',
    '  description: <one line summarising what the skill does>',
    '  version: 1               # a non-negative INTEGER (not a semver string)',
    '  connectors: [linear]     # OPTIONAL — ids of the connectors this skill uses',
    '',
    'Do NOT write a "capabilities" block (allowedHosts / credentials / mcpServers',
    '/ packages) — a skill manifest that declares one is REJECTED. If the skill',
    'needs to reach a service that has no connector yet, author the connector FIRST',
    '(use connector_propose / the ax-connector-creator skill), then reference its',
    'id in the connectors: list here.',
    '',
    'What happens next:',
    "  - The skill becomes available on the user's next message — tell them it's",
    '    ready next turn.',
    '  - The reach comes from the connectors it references: a referenced connector',
    "    that the user hasn't approved yet surfaces an inline approval card the",
    '    first time the skill needs it. If it relies on a connector that needs a',
    "    key, SAY SO when you propose the skill.",
    '',
    'IMPORTANT: a skill you propose this turn is NOT available this turn — skills',
    'are discovered when your session starts. Do not try to invoke it now. Tell',
    "the user it will be ready on their next message; if they asked you to create",
    'AND use a skill in one breath, propose it and offer to continue once they',
    'reply.',
    '',
    'Only .skill-draft/<id>/ paths under the draft root from your operating notes',
    'are accepted (others rejected).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Absolute path to the draft directory .skill-draft/<id> under the draft root given in your operating notes, e.g. <root>/.skill-draft/linear.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  executesIn: 'sandbox',
};
