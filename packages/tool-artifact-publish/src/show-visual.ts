import type { ToolDescriptor } from '@ax/core';

export const SHOW_VISUAL_TOOL_NAME = 'show_visual' as const;

/** Largest HTML body we accept, in UTF-8 bytes (100 KB). */
export const MAX_VISUAL_HTML_BYTES = 102_400;
export const MAX_VISUAL_TITLE_CHARS = 120;
export const MAX_VISUAL_SUMMARY_CHARS = 1000;

/**
 * The model passes a title, a plain-text summary and self-contained HTML; the
 * runner-side executor stores the HTML as an artifact and the chat renders it
 * inline in a sandboxed frame. Like `artifact_publish`, the executor lives in
 * the runner, so this host-side descriptor only advertises the tool.
 *
 * Every rule lives in the top-level `description` on purpose: the claude-sdk
 * runner drops per-property descriptions, so anything placed there is never
 * seen by the model.
 */
export const SHOW_VISUAL_DESCRIPTOR: ToolDescriptor = {
  name: SHOW_VISUAL_TOOL_NAME,
  description: [
    'Show the person a visual (a chart or a small card) inline in this chat.',
    '',
    'When: use it when the answer is a trend, a comparison, or naturally card-shaped',
    '(a forecast, a status). If the person asks for a chart, graph, visual or card,',
    'always make one. A short answer stays text: never make a visual for a one-line',
    'answer.',
    '',
    'How: pass a title, a plain-text summary and self-contained HTML (at most 100 KB).',
    'The HTML runs in a sandboxed frame with scripts but NO network: nothing can be',
    'fetched or loaded (no CDNs, web fonts, remote images or APIs). Gather the data',
    'with your other tools first and write it into the HTML.',
    "Don't use iframes, objects or embeds; they are removed.",
    "Don't add links or forms: the visual can't open pages. Put any URLs in your reply text.",
    '',
    'Look like the app:',
    '- Color only with the provided CSS variables, written as hsl(var(--name)):',
    '  --background, --foreground, --card, --card-foreground, --muted,',
    '  --muted-foreground, --border, --primary, --accent, --destructive, --warning,',
    '  and --chart-1 to --chart-5 for data series. No other colors.',
    "- Fonts are already set (Inter; code uses the system monospace). Don't set font-family.",
    '- The visual already sits in a card under its title. Don\'t repeat the title or',
    '  add an outer border, background or shadow.',
    '- Light and dark mode switch live; the CSS variables follow automatically.',
    '',
    'Charts: Chart.js 4 is preloaded as the global Chart and themed to match. Leave',
    "dataset colors unset to get the palette, or use ax.chartColor('chart-2'). For",
    'per-bar or per-point colors (say, to highlight one bar), pass an array of',
    'ax.chartColor(...) values. ax.color(name, alpha) and ax.chartColor(name, alpha)',
    'take an optional alpha from 0 to 1. Colors from ax.* follow light and dark mode',
    'automatically, even ones you put in chart options. For your own canvas drawing,',
    "ax.color('foreground') returns the current color and the window fires an",
    "'ax:theme' event when the theme changes.",
    '',
    'summary: the takeaway in one or two plain sentences. It is shown if the visual',
    "can't be displayed, and screen readers read it.",
    '',
    'Also say the takeaway in your reply text. Titles, memory and notifications read',
    'your text, not the visual.',
  ].join('\n'),
  activityPhrase: 'Making a visual',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: `Short title shown above the visual (at most ${MAX_VISUAL_TITLE_CHARS} characters).`,
      },
      summary: {
        type: 'string',
        description: `Plain-text takeaway, one or two sentences (at most ${MAX_VISUAL_SUMMARY_CHARS} characters).`,
      },
      html: {
        type: 'string',
        description: 'Self-contained HTML for the visual, at most 100 KB. No network access.',
      },
    },
    required: ['title', 'summary', 'html'],
    additionalProperties: false,
  },
  executesIn: 'sandbox',
};
