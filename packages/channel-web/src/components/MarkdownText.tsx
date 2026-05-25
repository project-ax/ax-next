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
import { useConversationId } from '../lib/use-conversation-id';

const AX_ARTIFACT_PREFIX = 'ax://artifact/';

// Mirrors react-markdown's built-in safe-protocol list. We can't import
// `defaultUrlTransform` directly because `react-markdown` isn't a direct
// dep of `@ax/channel-web` — only a transitive of
// `@assistant-ui/react-markdown` — so we inline the (tiny) check here.
// Keep in sync with react-markdown@10: lib/index.js `safeProtocol` regex.
const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;

/**
 * Pass `ax://...` URLs through; defer everything else to the standard
 * safe-protocol filter. Keeps the default protection against
 * `javascript:` / `data:` etc. while letting our custom Anchor see the
 * artifact URL it needs to intercept.
 */
function urlTransform(url: string): string {
  if (url.startsWith(AX_ARTIFACT_PREFIX)) return url;
  const colon = url.indexOf(':');
  const questionMark = url.indexOf('?');
  const numberSign = url.indexOf('#');
  const slash = url.indexOf('/');
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    SAFE_PROTOCOL.test(url.slice(0, colon))
  ) {
    return url;
  }
  return '';
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
      if (obj.toolName !== 'artifact_publish') continue;
      let parsed: unknown;
      try {
        parsed =
          typeof obj.result === 'string'
            ? JSON.parse(obj.result)
            : obj.result;
      } catch {
        continue; // skip non-JSON tool_results
      }
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
    className="aui-md prose dark:prose-invert max-w-none prose-p:leading-7 prose-pre:bg-card prose-pre:border prose-pre:border-border/40 prose-pre:rounded-xl prose-pre:backdrop-blur-sm prose-code:font-mono prose-code:text-[0.85em] prose-headings:tracking-tight prose-a:text-amber prose-a:no-underline hover:prose-a:underline prose-th:text-left"
  />
);
