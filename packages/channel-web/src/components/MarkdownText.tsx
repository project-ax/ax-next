/**
 * MarkdownText — assistant-ui Markdown text part renderer (Task 18).
 *
 * Ported verbatim from v1 (`~/dev/ai/ax/ui/chat/src/components/markdown-text.tsx`):
 * same `@assistant-ui/react-markdown` + `remark-gfm` setup. The v1 className
 * is a tailwind `prose` chain — channel-web uses plain CSS, so most of
 * those classes are inert here, but we keep them so future Tailwind
 * adoption (or a port to a `prose` shim) is a one-line change.
 */
import type { FC } from 'react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';

export const MarkdownText: FC = () => (
  <MarkdownTextPrimitive
    remarkPlugins={[remarkGfm]}
    className="aui-md prose dark:prose-invert max-w-none prose-p:leading-7 prose-pre:bg-card prose-pre:border prose-pre:border-border/40 prose-pre:rounded-xl prose-pre:backdrop-blur-sm prose-code:font-mono prose-code:text-[0.85em] prose-headings:tracking-tight prose-a:text-amber prose-a:no-underline hover:prose-a:underline prose-th:text-left"
  />
);
