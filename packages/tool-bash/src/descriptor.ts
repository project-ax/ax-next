import type { ToolDescriptor } from '@ax/core';

// JSON Schema that LLM providers forward to the model. Kept as a plain
// object literal — not a zod schema — so the shape is transport-agnostic
// (see five invariants, I1).
export const bashToolDescriptor: ToolDescriptor = {
  name: 'bash',
  description:
    'Execute a shell command in /bin/bash -c and return stdout/stderr/exitCode.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', maxLength: 16_384 },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 300_000 },
    },
    required: ['command'],
    additionalProperties: false,
  },
};
