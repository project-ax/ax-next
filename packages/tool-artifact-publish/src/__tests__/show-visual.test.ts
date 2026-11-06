import { describe, it, expect } from 'vitest';
import {
  SHOW_VISUAL_DESCRIPTOR,
  MAX_VISUAL_HTML_BYTES,
  MAX_VISUAL_TITLE_CHARS,
  MAX_VISUAL_SUMMARY_CHARS,
} from '../show-visual.js';

describe('SHOW_VISUAL_DESCRIPTOR', () => {
  it('is a sandbox tool named show_visual with a short phrase', () => {
    expect(SHOW_VISUAL_DESCRIPTOR.name).toBe('show_visual');
    expect(SHOW_VISUAL_DESCRIPTOR.executesIn).toBe('sandbox');
    expect(SHOW_VISUAL_DESCRIPTOR.activityPhrase).toBe('Making a visual');
  });

  it('takes exactly title, summary and html, all required strings', () => {
    const s = SHOW_VISUAL_DESCRIPTOR.inputSchema as {
      properties: Record<string, { type: string }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(s.properties)).toEqual(['title', 'summary', 'html']);
    expect(Object.values(s.properties).map((p) => p.type)).toEqual(['string', 'string', 'string']);
    expect(s.required).toEqual(['title', 'summary', 'html']);
    expect(s.additionalProperties).toBe(false);
  });

  it('carries every rule in the top-level description (claude-sdk drops property descriptions)', () => {
    for (const needle of ['always make one', 'NO network', '100 KB', 'hsl(var(--', '--chart-1', 'Chart.js', 'ax.chartColor', 'array of', 'optional alpha', "Don't add links or forms", 'reply text', "Don't use iframes, objects or embeds; they are removed."])
      expect(SHOW_VISUAL_DESCRIPTOR.description).toContain(needle);
  });

  it('pins the limits', () => {
    expect([MAX_VISUAL_HTML_BYTES, MAX_VISUAL_TITLE_CHARS, MAX_VISUAL_SUMMARY_CHARS]).toEqual([100 * 1024, 120, 1000]);
  });
});
