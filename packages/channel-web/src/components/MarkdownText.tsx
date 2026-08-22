/**
 * MarkdownText — assistant-ui Markdown text part renderer.
 *
 * Ported from v1 (`~/dev/ai/ax/ui/chat/src/components/markdown-text.tsx`)
 * with the same `@assistant-ui/react-markdown` + `remark-gfm` setup.
 *
 * Phase 3 addition (Task 15): intercept `ax://artifact/<id>` links and
 * render them as `<ArtifactChip variant="link" />` so the prose-link form
 * of a published artifact becomes a downloadable affordance instead of
 * getting stripped by react-markdown's default safe-protocol filter.
 *
 * Mechanism:
 *   - `urlTransform` lets `ax://artifact/...` through (default behavior
 *     drops disallowed protocols). Everything else flows through
 *     `defaultUrlTransform` so we don't accidentally widen the safe-URL
 *     surface (no `javascript:` injection, etc.).
 *   - `components.a` (Anchor) checks `href` for `ax://artifact/<id>`,
 *     looks up the matching `artifact_publish` tool-call result across the
 *     WHOLE thread, and renders the chip. Non-ax links fall through to
 *     a regular `<a target="_blank" rel="noopener noreferrer">`.
 *
 * TASK-20: the lookup scans every thread message, NOT just the link's own
 * message. The runner emits the `artifact_publish` tool result and then the
 * closing-text link as a *separate* assistant turn, and reload
 * (`conversations:get`) builds one renderable message per turn — so the
 * tool-call result and the link routinely live in different messages. A
 * current-message-only scan never found the result and rendered a dead
 * "unknown artifact" chip on both the live turn and reload.
 */
import type { ComponentPropsWithoutRef, FC } from 'react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import { useAui, useAuiState } from '@assistant-ui/react';
import remarkGfm from 'remark-gfm';
import { ArtifactChip } from './ArtifactChip';
import { MARKDOWN_PROSE_CLASS, safeUrlTransform } from './Markdown';
import { useConversationId } from '../lib/use-conversation-id';
import { stripMcpToolPrefix } from '../lib/tool-name';

const AX_ARTIFACT_PREFIX = 'ax://artifact/';

/**
 * Pass `ax://...` URLs through; defer everything else to the standard
 * safe-protocol filter. Keeps the default protection against
 * `javascript:` / `data:` etc. while letting our custom Anchor see the
 * artifact URL it needs to intercept.
 *
 * The filter itself lives in `./Markdown` now, which renders the same
 * markdown for callers that have a string rather than a message part. It used
 * to be inlined here under a comment explaining that `react-markdown` was not
 * a direct dependency and so `defaultUrlTransform` could not be imported —
 * it is one now, and one copy of "which URLs are safe" is the point.
 */
function urlTransform(url: string): string {
  if (url.startsWith(AX_ARTIFACT_PREFIX)) return url;
  return safeUrlTransform(url);
}

/**
 * Result shape emitted by the `artifact_publish` runner tool — mirrored
 * from `ToolUse.tsx`. Every field is treated as optional at the
 * parse boundary because we don't trust the assistant; we only build a
 * chip when the full set is present.
 */
interface ArtifactToolResult {
  artifactId: string;
  path: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
}

interface ThreadMessageLikeShape {
  content?: readonly unknown[];
}

/**
 * A tool-call part's result can arrive in three shapes: a JSON string, an
 * already-parsed object, or the SDK/MCP ARRAY shape `[{type:'text', text}]`
 * that the runner persists for an artifact_publish result (TASK-77 — the
 * same shape `checkPathScope` now reads server-side). Reduce all three to
 * candidate object(s) to test for the artifact fields. Array entries that
 * aren't `text` blocks (e.g. images) are ignored.
 */
function resultCandidates(result: unknown): unknown[] {
  if (typeof result === 'string') {
    try {
      return [JSON.parse(result)];
    } catch {
      return [];
    }
  }
  if (Array.isArray(result)) {
    const out: unknown[] = [];
    for (const entry of result) {
      if (
        entry &&
        typeof entry === 'object' &&
        (entry as { type?: unknown }).type === 'text' &&
        typeof (entry as { text?: unknown }).text === 'string'
      ) {
        try {
          out.push(JSON.parse((entry as { text: string }).text));
        } catch {
          /* not JSON — skip this entry */
        }
      }
    }
    return out;
  }
  // Already an object (or null/undefined — filtered out below).
  return [result];
}

/**
 * Build the `artifactId → result` registry by scanning EVERY part of EVERY
 * message in the thread (TASK-20). The published artifact's tool-call result
 * and the markdown link that references it routinely land in different
 * messages, so a single-message scan misses the result.
 */
function parseArtifactsFromThread(
  messages: readonly unknown[],
): Map<string, ArtifactToolResult> {
  const map = new Map<string, ArtifactToolResult>();
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const parts = (m as ThreadMessageLikeShape).content;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      const obj = p as {
        type?: unknown;
        toolName?: unknown;
        result?: unknown;
      };
      if (obj.type !== 'tool-call') continue;
      // The runner emits the MCP-namespaced `mcp__ax-sandbox-tools__artifact_publish`
      // (the SDK renames MCP tools at the canUseTool boundary, and that name is
      // what's persisted + reaches the part). Strip the prefix before matching so
      // we pair the artifact link with its result regardless of the bare vs.
      // namespaced form (TASK-81).
      if (typeof obj.toolName !== 'string') continue;
      if (stripMcpToolPrefix(obj.toolName) !== 'artifact_publish') continue;
      for (const parsed of resultCandidates(obj.result)) {
        if (!parsed || typeof parsed !== 'object') continue;
        const r = parsed as Partial<ArtifactToolResult>;
        if (
          typeof r.artifactId === 'string' &&
          typeof r.path === 'string' &&
          typeof r.displayName === 'string' &&
          typeof r.mediaType === 'string' &&
          typeof r.sizeBytes === 'number'
        ) {
          // First publish of an id wins — a re-publish in a later turn carries
          // identical content (the id is the content sha), so dedup is a no-op
          // for correctness and keeps the earliest reference stable.
          if (!map.has(r.artifactId)) {
            map.set(r.artifactId, {
              artifactId: r.artifactId,
              path: r.path,
              displayName: r.displayName,
              mediaType: r.mediaType,
              sizeBytes: r.sizeBytes,
            });
          }
        }
      }
    }
  }
  return map;
}

// Accepts the full anchor prop set react-markdown passes (which includes
// react-markdown's own `ExtraProps` like `node`). We only consume `href`
// and `children`; everything else passes through to the fallback `<a>`.
type AnchorProps = ComponentPropsWithoutRef<'a'>;

const EMPTY_MESSAGES: readonly unknown[] = Object.freeze([]);

interface ThreadStateShape {
  getState(): { messages?: readonly unknown[] };
}

const Anchor: FC<AnchorProps> = ({ href, children, ...anchorProps }) => {
  const conversationId = useConversationId();
  const aui = useAui();
  // Reactive read of ALL thread messages — the artifact's `artifact_publish`
  // tool-call result lives in a different message than this link (TASK-20).
  // `aui.thread().getState().messages` is the thread's message list; reading
  // it through `useAuiState` re-renders this anchor when the thread changes.
  const messages = useAuiState(
    () =>
      (aui.thread() as unknown as ThreadStateShape).getState().messages ??
      EMPTY_MESSAGES,
  );
  if (typeof href === 'string' && href.startsWith(AX_ARTIFACT_PREFIX)) {
    const artifactId = href.slice(AX_ARTIFACT_PREFIX.length);
    const artifacts = parseArtifactsFromThread(messages);
    const match = artifacts.get(artifactId);
    if (!match || conversationId === null) {
      return (
        <ArtifactChip
          variant="link"
          conversationId={conversationId ?? ''}
          artifactId={artifactId}
        />
      );
    }
    return (
      <ArtifactChip
        variant="link"
        conversationId={conversationId}
        path={match.path}
        displayName={match.displayName}
        mediaType={match.mediaType}
        sizeBytes={match.sizeBytes}
        artifactId={match.artifactId}
      />
    );
  }
  // Spread incoming props (title, data-*, aria-*, etc.) but write our own
  // `href`/`target`/`rel` AFTER so callers can't override the safe-window
  // semantics or substitute a different href.
  return (
    <a {...anchorProps} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
};

export const MarkdownText: FC = () => (
  <MarkdownTextPrimitive
    remarkPlugins={[remarkGfm]}
    urlTransform={urlTransform}
    components={{ a: Anchor }}
    className={MARKDOWN_PROSE_CLASS}
  />
);
