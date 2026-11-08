import type { ToolDescriptor } from '@ax/core';
import { ARTIFACT_TITLE_MAX } from '@ax/ipc-protocol';

export const ARTIFACT_PUBLISH_TOOL_NAME = 'artifact_publish' as const;

/**
 * The model invokes this with a path in its files folder and a short title; the
 * runner-side executor validates the path against the session's real files
 * root, stats + hashes the file, streams the bytes to the host blob store and
 * asks the host (`artifact.publish` → `artifacts:publish`) to add a version.
 *
 * The DESCRIPTOR is host-side and static (catalog advertisement), so — exactly
 * like `@ax/tool-skill-propose`'s — it does NOT hard-code the folder's path. It
 * names the folder by role; the per-session operating notes give its literal
 * path, and a relative path is taken relative to it.
 *
 * Sandbox-executed (D1): the executor runs inside the runner pod because only it
 * can read the file at call time. The host-side plugin in this package only
 * registers this descriptor so the catalog advertises the tool.
 */
export const ARTIFACT_PUBLISH_DESCRIPTOR: ToolDescriptor = {
  name: ARTIFACT_PUBLISH_TOOL_NAME,
  description:
    'Publish a finished file from your files folder so the person can open it, preview it and share it. Give it a short human name in `title`, like "Q3 pipeline report". Publish only things meant for the person — never helper scripts, scratch notes or intermediate data. After you change the file, publish it again: the same path (or the same artifactId) adds a new version, and anyone with its link sees the newest one. To update something you published in an earlier chat, edit its file and publish that path again. Web pages open in a locked-down viewer with no internet access, so keep every script, style and image inside the HTML file; fetch(), forms and outside scripts or fonts won\'t work. HTML pages also run with no nested frames (iframe, frame, object, embed), no shadow DOM (attachShadow or declarative shadow DOM) and no document.write, and an HTML page is refused if it is over 4 MiB or has more than about 150,000 elements and runs of text (a table of roughly 7,000 rows of ten cells). To match the app\'s look, a page can use these ready-made colors, which follow light and dark mode: var(--ax-background), var(--ax-foreground), var(--ax-card), var(--ax-muted), var(--ax-muted-foreground), var(--ax-border), var(--ax-primary), var(--ax-accent), var(--ax-destructive), var(--ax-warning) and var(--ax-chart-1) to var(--ax-chart-5) for data series. Each is a complete color: use it as `fill: var(--ax-chart-1)`, never inside hsl(). Define any colors of your own as valid CSS colors too. Returns { artifactId, version, title, kind, extension, url, path }. Symlinks and files over 100 MiB are refused.',
  activityPhrase: 'Publishing a file',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'The file to publish: a path relative to your files folder (like "reports/q3.pdf"), or its absolute path there.',
      },
      title: {
        type: 'string',
        maxLength: ARTIFACT_TITLE_MAX,
        description: 'A short human name for it, like "Q3 pipeline report".',
      },
      artifactId: {
        type: 'string',
        description:
          'Optional. The id of an artifact you published before, to add this file as its new version.',
      },
    },
    required: ['path', 'title'],
    additionalProperties: false,
  },
  executesIn: 'sandbox',
};
