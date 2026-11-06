// ---------------------------------------------------------------------------
// Sandbox-side executor for the `show_visual` tool. The model hands us a title,
// a plain-text summary and a self-contained HTML document; we store the HTML as
// a text/html artifact (blob.put + artifact.publish, the same pair
// `artifact_publish` uses; the host derives text/html from the `.html` key) and
// return only the reference. The chat renders it
// later inside a sandboxed, no-network frame.
//
// Every field is model output, so every check runs BEFORE any byte crosses to
// the host: an over-cap or malformed call costs nothing but the error string.
// The error copy is written for the model — it reads it and tries again.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import type { IpcClient, ToolCall } from '@ax/ipc-protocol';
import {
  MAX_VISUAL_HTML_BYTES,
  MAX_VISUAL_SUMMARY_CHARS,
  MAX_VISUAL_TITLE_CHARS,
} from '@ax/tool-artifact-publish';
import { publishBytesToHost } from './artifact-publish-executor.js';

export interface ShowVisualOutput {
  artifactId: string;
  title: string;
  summary: string;
}

export interface CreateShowVisualExecutorOptions {
  client: Pick<IpcClient, 'callBinaryUpload' | 'call'>;
  /**
   * The conversation this session is bound to — the artifact row's ownership
   * scope. Unlike `artifact_publish` there is no degraded path: a visual with
   * no row can never be rendered, so with no conversation we refuse outright.
   */
  conversationId: string | null;
}

// Line breaks of every kind, including the Unicode separators a renderer would
// also break on.
const LINE_BREAK = /[\r\n\u2028\u2029]/;

export function createShowVisualExecutor(opts: CreateShowVisualExecutorOptions) {
  return async function execute(call: ToolCall): Promise<ShowVisualOutput> {
    const input = (call.input ?? {}) as { title?: unknown; summary?: unknown; html?: unknown };

    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title.length === 0) {
      throw new Error('show_visual: title is required (a short single-line string)');
    }
    if (LINE_BREAK.test(title)) {
      throw new Error('show_visual: title must be a single line');
    }
    if (title.length > MAX_VISUAL_TITLE_CHARS) {
      throw new Error(
        `show_visual: title is too long (${title.length} characters, max ${MAX_VISUAL_TITLE_CHARS})`,
      );
    }

    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (summary.length === 0) {
      throw new Error('show_visual: summary is required (one or two plain sentences)');
    }
    if (summary.length > MAX_VISUAL_SUMMARY_CHARS) {
      throw new Error(
        `show_visual: summary is too long (${summary.length} characters, max ${MAX_VISUAL_SUMMARY_CHARS})`,
      );
    }

    if (typeof input.html !== 'string' || input.html.trim().length === 0) {
      throw new Error('show_visual: html is required');
    }
    // The cap is in UTF-8 bytes, which is what gets stored and shipped to the
    // browser — a string's .length would let multi-byte text through at ~3x.
    const bytes = Buffer.from(input.html, 'utf8');
    if (bytes.byteLength > MAX_VISUAL_HTML_BYTES) {
      throw new Error(
        `show_visual: html is ${bytes.byteLength} bytes, over the 100 KB limit (${MAX_VISUAL_HTML_BYTES} bytes). Simplify it (fewer data points, shorter markup) and call show_visual again.`,
      );
    }

    if (opts.conversationId === null) {
      throw new Error(
        "show_visual: this session is not attached to a conversation, so a visual can't be shown here",
      );
    }

    // The re-publish key is derived from the content, never from model input,
    // so the model has no say over it; the host types it text/html from the
    // `.html` extension.
    const localSha = createHash('sha256').update(bytes).digest('hex');
    const published = await publishBytesToHost({
      client: opts.client,
      conversationId: opts.conversationId,
      bytes,
      path: `visuals/${localSha}.html`,
      title,
    });

    return { artifactId: published.artifactId, title, summary };
  };
}
