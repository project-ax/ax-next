import type { ToolDescriptor } from '@ax/core';

export const ARTIFACT_PUBLISH_TOOL_NAME = 'artifact_publish' as const;

/**
 * The model invokes this with an absolute path; the runner-side executor
 * validates it against the SESSION'S REAL ROOTS, stats + hashes the file,
 * streams the bytes to the host blob store and returns the artifact metadata.
 *
 * The DESCRIPTOR is host-side and static (catalog advertisement), so — exactly
 * like `@ax/tool-skill-propose`'s — it does NOT hard-code the tier paths. It
 * names the two locations by role and defers to the per-session operating notes
 * for their literal paths, which the runner composes from the resolved roots
 * (`userFilesNote` / `ephemeralScratchNote`). The previous version hard-coded
 * `/ephemeral/artifacts/**` and `/agent/workspace/**`, which were only true on
 * k8s and named a directory nothing creates; see `path-allowlist.ts`.
 *
 * Sandbox-executed (D1): the executor runs inside the runner pod because only it
 * can read the file at call time. The host-side plugin in this package only
 * registers this descriptor so the catalog advertises the tool.
 */
export const ARTIFACT_PUBLISH_DESCRIPTOR: ToolDescriptor = {
  name: ARTIFACT_PUBLISH_TOOL_NAME,
  description: [
    'Publish a file as a downloadable artifact for the user.',
    'Returns a stable ax://artifact/<id> URL that you can embed in your',
    'response text or markdown links.',
    '',
    'Pass the absolute path of a file you have already written. You can publish:',
    '  - any file in your files directory (your working directory — the usual',
    '    place to put a deliverable), or',
    '  - a file in the artifacts/ subdirectory of your scratch space, for a',
    '    deliverable you do not otherwise need to keep.',
    'Both directories are named by their full path in your operating notes.',
    'Nothing else is publishable — a rejection tells you the exact paths that are.',
    '',
    'The bytes are stored durably the moment this tool returns — nothing is',
    'committed, and the URL works immediately. Symlinks and files larger than',
    '100 MiB are rejected.',
  ].join('\n'),
  activityPhrase: 'Publishing a file',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Absolute path of the file to publish — in your files directory, or in the artifacts/ subdirectory of your scratch space (see your operating notes for both paths).',
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
