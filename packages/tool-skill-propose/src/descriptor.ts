import type { ToolDescriptor } from '@ax/core';

export const SKILL_PROPOSE_TOOL_NAME = 'skill_propose' as const;

/**
 * TASK-74 (out-of-git Part D / §D1). The agent authors a skill bundle into
 * `/ephemeral/skill-draft/<id>/` (throwaway scratch git never sees), then calls
 * this tool with the draft dir path. The runner-side executor reads the dir,
 * validates it structurally, and ships it to the host's `skills:propose` gate.
 *
 * Sandbox-executed (mirror of `artifact_publish`): the executor runs inside the
 * runner pod because only it can read `/ephemeral/skill-draft/**` at call time.
 * The host-side plugin in this package only registers this descriptor so the
 * catalog advertises the tool to the model.
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
    'First write the bundle into /ephemeral/skill-draft/<id>/ — a SKILL.md with',
    'YAML frontmatter (id, description, version, and any capability proposal:',
    'allowedHosts, credentials, packages) plus any helper files — then call this',
    'tool with that directory path.',
    '',
    'What happens next:',
    '  - A self-authored skill that needs NO capabilities becomes available on',
    "    the user's next message — tell them it's ready next turn.",
    '  - A skill that needs network access or a credential waits for the user to',
    '    approve it on an inline card; once approved it is ready next turn.',
    '',
    'IMPORTANT: a skill you propose this turn is NOT available this turn — skills',
    'are discovered when your session starts. Do not try to invoke it now. Tell',
    "the user it will be ready on their next message; if they asked you to create",
    'AND use a skill in one breath, propose it and offer to continue once they',
    'reply.',
    '',
    'Only /ephemeral/skill-draft/<id>/ paths are accepted (others rejected).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Absolute path to the draft directory under /ephemeral/skill-draft/, e.g. /ephemeral/skill-draft/linear.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  executesIn: 'sandbox',
};
