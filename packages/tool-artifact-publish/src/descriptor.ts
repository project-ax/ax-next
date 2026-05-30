import type { ToolDescriptor } from '@ax/core';

export const ARTIFACT_PUBLISH_TOOL_NAME = 'artifact_publish' as const;

/**
 * Phase 2 (`artifact_publish`). The model invokes this tool with a path
 * under /permanent/workspace/** or /permanent/.ax/artifacts/**; the
 * runner-side executor stats + hashes the file and returns the
 * artifactId/downloadUrl/path/displayName/mediaType/sizeBytes/sha256
 * shape the design doc specifies.
 *
 * Sandbox-executed (D1): the executor runs inside the runner pod
 * because only it has filesystem access to /permanent at call time.
 * The host-side plugin in this package only registers the descriptor
 * so the catalog advertises it to the model.
 */
export const ARTIFACT_PUBLISH_DESCRIPTOR: ToolDescriptor = {
  name: ARTIFACT_PUBLISH_TOOL_NAME,
  description: [
    'Publish a file as a downloadable artifact for the user.',
    'Returns a stable ax://artifact/<id> URL that you can embed in your',
    'response text or markdown links.',
    '',
    'Write your deliverable to /ephemeral/artifacts/ and publish it from there.',
    '',
    'Allowed paths (others rejected):',
    '  - /ephemeral/artifacts/**  (your artifact namespace — write deliverables here)',
    '  - /permanent/workspace/**  (publish a snapshot of versioned project content)',
    '',
    'The bytes are stored durably the moment this tool returns — nothing is',
    'committed, and the URL works immediately. Symlinks and files larger than',
    '100 MiB are rejected.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Absolute path under /ephemeral/artifacts/ (or /permanent/workspace/) to publish.',
      },
      displayName: {
        type: 'string',
        description: 'Optional user-friendly name. Defaults to basename(path).',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  executesIn: 'sandbox',
};
