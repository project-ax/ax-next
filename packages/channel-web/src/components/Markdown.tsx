/**
 * Markdown for a plain string, and the one URL policy the whole package shares.
 *
 * WHY THIS EXISTS. `MarkdownText` renders the assistant's markdown, but it
 * cannot render anybody else's: `MarkdownTextPrimitive` takes its text from
 * `useMessagePartText()` and deliberately drops `children` from its props, so
 * it only works inside a mounted assistant-ui thread with a message part in
 * scope. A file viewer has a string.
 *
 * THIS IS NOT A SECOND MARKDOWN PIPELINE. It is the same one: `react-markdown`
 * with `remark-gfm`, which is exactly what `MarkdownTextPrimitive` runs
 * internally, at the same version that was already resolved in the lockfile.
 * All this file does is call it directly and export `safeUrlTransform` so the
 * two call sites cannot drift apart on what a safe URL is — the old copy of
 * that check lived in `MarkdownText.tsx` under a comment apologising for not
 * being able to import it. Now it can.
 *
 * THE POLICY IS NARROWER HERE, ON PURPOSE. `MarkdownText` renders text the
 * user just watched an agent write, inside a conversation that owns the
 * artifacts it links to. This renders a FILE out of the agent's workspace,
 * which is untrusted content with no conversation around it:
 *
 *   - `img` renders as its alt text, not as an image. A remote `<img>` in a
 *     file body is an outbound request made by the reader's browser on the
 *     file author's behalf — a tracking pixel with a markdown costume on. The
 *     alt text still tells the reader an image was there.
 *   - `ax://artifact/...` is NOT widened. That widening exists so a link in a
 *     conversation can become a download chip for an artifact published in
 *     that same conversation; here there is no conversation, so the URL would
 *     resolve against nothing. It falls to the safe-protocol filter, which
 *     blanks it.
 *
 * Raw HTML is inert either way: `rehype-raw` is not installed and
 * `allowDangerousHtml` is off, so `<script>` in a file body renders as the
 * literal text `<script>`.
 */
import type { ComponentPropsWithoutRef, FC } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/**
 * Mirrors react-markdown's built-in safe-protocol list. Kept in sync with
 * react-markdown@10: lib/index.js `safeProtocol`.
 */
const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;

/**
 * react-markdown's default URL policy, as a function we own.
 *
 * Relative-ish URLs pass (no colon, or a colon that comes after the first
 * `/`, `?` or `#` — i.e. it is part of a path, not a scheme). Absolute ones
 * pass only on a known-safe scheme. Everything else — `javascript:`, `data:`,
 * `vbscript:` — becomes the empty string.
 *
 * Exported because `MarkdownText` composes its `ax://artifact/` widening on
 * top of it. One definition, two callers; the alternative is two definitions
 * that agree until one of them is edited.
 */
export function safeUrlTransform(url: string): string {
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
 * The class list `MarkdownText` has always carried. Exported so there is one
 * copy of it rather than two.
 *
 * Be aware of what it does NOT do: `@tailwindcss/typography` is not installed
 * in this package, so every `prose-*` utility in here emits no CSS at all. An
 * assistant reply gets its block rhythm from the `.msg-body` rules in
 * `index.css`, not from these. Anything rendered OUTSIDE the thread needs
 * `.ax-md` (below) or it inherits Preflight — headings the size of body text,
 * lists with no markers.
 */
export const MARKDOWN_PROSE_CLASS =
  'aui-md prose dark:prose-invert max-w-none prose-p:leading-7 prose-pre:bg-card prose-pre:border prose-pre:border-border/40 prose-pre:rounded-xl prose-pre:backdrop-blur-sm prose-code:font-mono prose-code:text-[0.85em] prose-headings:tracking-tight prose-a:text-amber prose-a:no-underline hover:prose-a:underline prose-th:text-left';

type AnchorProps = ComponentPropsWithoutRef<'a'>;
type ImageProps = ComponentPropsWithoutRef<'img'>;

/**
 * Incoming props are spread FIRST and the safe attributes written after, so a
 * `target` or `rel` in the source cannot override the safe-window semantics.
 */
const ExternalAnchor: FC<AnchorProps> = ({ href, children, ...rest }) => (
  <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
    {children}
  </a>
);

/** An image that never loads. The alt text is what the reader gets. */
const AltTextOnly: FC<ImageProps> = ({ alt }) => (
  <span className="text-muted-foreground italic">
    {alt !== undefined && alt.length > 0 ? alt : 'image'}
  </span>
);

/**
 * Render an arbitrary markdown string.
 *
 * `text` is untrusted by assumption. Nothing here builds markup from it — the
 * only thing between it and the DOM is react-markdown, whose defaults this
 * file narrows rather than widens.
 */
export const Markdown: FC<{ text: string; className?: string }> = ({
  text,
  className,
}) => (
  // `ax-md` is the typography (index.css). It is not optional decoration: this
  // renders outside `.msg-body`, where Preflight has zeroed every heading and
  // stripped every list marker.
  <div className={cn(MARKDOWN_PROSE_CLASS, 'ax-md', className)}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={safeUrlTransform}
      components={{ a: ExternalAnchor, img: AltTextOnly }}
    >
      {text}
    </ReactMarkdown>
  </div>
);
