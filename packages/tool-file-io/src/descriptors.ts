import type { ToolDescriptor } from '@ax/core';

// JSON Schema that LLM providers forward to the model. Kept as plain
// object literals — not zod schemas — so the shape is transport-agnostic
// (invariant I1). additionalProperties: false so the LLM can't smuggle
// extra fields past the boundary.
export const readFileToolDescriptor: ToolDescriptor = {
  name: 'read_file',
  description: 'Read a UTF-8 file from the workspace (max 1 MiB).',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', maxLength: 4096 } },
    required: ['path'],
    additionalProperties: false,
  },
};

export const writeFileToolDescriptor: ToolDescriptor = {
  name: 'write_file',
  description: 'Write a UTF-8 file inside the workspace (max 1 MiB).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', maxLength: 4096 },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
};
