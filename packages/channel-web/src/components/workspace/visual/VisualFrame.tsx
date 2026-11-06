// One chat visual: a card holding the agent's HTML in a sandboxed srcdoc frame.
//
// The frame is untrusted. It runs with `sandbox="allow-scripts"` (an opaque
// origin), so all it can do to us is post messages, and parseFrameMessage
// decides which of those count. We post back to its contentWindow with '*'
// because an opaque origin has no name to target; what we send (the theme and
// export requests) is nothing a frame couldn't already know.
//
// Anything going wrong ends in one quiet line and the summary, never the
// agent's own error text. An error from the frame unmounts it outright: after
// ready that means its runtime tore the document down, and we don't keep a
// frame around that has said it's compromised.

import type React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { saveBlob } from '@/lib/file-download';
import { useResolvedTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { ThreadVisual } from '@/lib/workspace-types';
import { isPngBlob, parseFrameMessage } from './frame-messages';
import { DEFAULT_VISUAL_ASSETS } from './visual-assets';
import {
  VISUAL_DEFAULT_HEIGHT,
  VISUAL_IFRAME_SANDBOX,
  buildVisualDocument,
  readThemeTokens,
  visualFileName,
} from './visual-doc';
import { loadVisualHtml, recalledHeight, rememberHeight } from './visual-source';

const READY_TIMEOUT_MS = 8_000;
const EXPORT_TIMEOUT_MS = 10_000;

interface Loaded {
  html: string;
  srcdoc: string;
}

export function VisualFrame(props: { conversationId: string; visual: ThreadVisual }): React.JSX.Element {
  const { conversationId, visual } = props;
  const { artifactId, title, summary } = visual;
  const mode = useResolvedTheme();
  const descriptionId = useId();

  // A recalled height means this visual was on screen before: show it at its
  // size and skip the fade, so a remount doesn't flicker.
  const [recalled] = useState(() => recalledHeight(artifactId));
  const [height, setHeight] = useState(recalled ?? VISUAL_DEFAULT_HEIGHT);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pendingExports = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // The srcdoc is built once, in the theme of the moment it loads. Later
  // changes go over postMessage; rebuilding would reload the visual.
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    let live = true;
    loadVisualHtml(conversationId, artifactId).then(
      (html) => {
        if (!live) return;
        try {
          const srcdoc = buildVisualDocument(
            { html, mode: modeRef.current, tokens: readThemeTokens() },
            DEFAULT_VISUAL_ASSETS,
          );
          setLoaded({ html, srcdoc });
        } catch {
          setFailed(true);
        }
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [conversationId, artifactId]);

  // The ready budget only runs while someone could be looking: the tab is
  // visible and the card is on screen. A browser may not run a frame it isn't
  // painting, so a visual scrolled out of view (or one that arrived in a
  // background tab) mustn't be failed for being slow. The budget pauses and
  // resumes rather than restarting, so scrolling past a broken visual a few
  // times still ends in the quiet failure after 8 s of it being in view.
  // It starts at mount, not at load, so a fetch that never answers fails too (the fetch
  // has its own timeout as well, for cards that are never seen).
  const cardRef = useRef<HTMLDivElement>(null);
  const watching = useWatched(cardRef);
  const readyBudget = useRef(READY_TIMEOUT_MS);
  useEffect(() => {
    if (ready || failed || !watching) return;
    const started = Date.now();
    const timer = setTimeout(() => setFailed(true), readyBudget.current);
    return () => {
      clearTimeout(timer);
      readyBudget.current = Math.max(0, readyBudget.current - (Date.now() - started));
    };
  }, [ready, failed, watching]);

  const settleExport = useCallback((requestId: string): boolean => {
    const timer = pendingExports.current.get(requestId);
    if (timer === undefined) return false;
    clearTimeout(timer);
    pendingExports.current.delete(requestId);
    return true;
  }, []);

  useEffect(() => {
    const pending = pendingExports.current;
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow ?? null;
      const msg = parseFrameMessage(event, frame, new Set(pending.keys()));
      if (!msg) return;
      switch (msg.type) {
        case 'size':
          setHeight(msg.height);
          rememberHeight(artifactId, msg.height);
          return;
        case 'ready':
          // msg.locked is the frame's own claim about itself: never acted on.
          if (!msg.rendered) {
            setFailed(true);
            return;
          }
          setHeight(msg.height);
          rememberHeight(artifactId, msg.height);
          setReady(true);
          return;
        case 'error':
          setFailed(true);
          return;
        case 'export-result': {
          if (!settleExport(msg.requestId)) return;
          const blob = msg.blob;
          void (async () => {
            if (blob && (await isPngBlob(blob))) {
              saveBlob(new Blob([blob], { type: 'image/png' }), visualFileName(title, 'png'));
            } else {
              setExportFailed(true);
            }
          })();
          return;
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [artifactId, title, settleExport]);

  // Drop outstanding exports when the frame goes away (failure or unmount).
  useEffect(() => {
    if (failed) clearAll(pendingExports.current);
  }, [failed]);
  useEffect(() => {
    const pending = pendingExports.current;
    return () => clearAll(pending);
  }, []);

  // Covers a theme toggled while loading too: becoming ready posts the current one.
  useEffect(() => {
    if (!ready || failed) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'ax-visual:theme', mode, tokens: readThemeTokens() },
      '*',
    );
  }, [mode, ready, failed]);

  // Tell the frame whenever its card comes into view (and on ready, if it
  // already is). A frame the browser wasn't painting may have built a chart
  // at 0 width; the runtime refits its charts on this.
  useEffect(() => {
    if (!ready || failed || !watching) return;
    iframeRef.current?.contentWindow?.postMessage({ type: 'ax-visual:visible' }, '*');
  }, [ready, failed, watching]);

  const downloadPng = () => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame || !ready || failed) return;
    setExportFailed(false);
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (settleExport(requestId)) setExportFailed(true);
    }, EXPORT_TIMEOUT_MS);
    pendingExports.current.set(requestId, timer);
    frame.postMessage({ type: 'ax-visual:export', requestId, format: 'png' }, '*');
  };

  const downloadHtml = () => {
    if (!loaded) return;
    const doc = buildVisualDocument(
      { html: loaded.html, mode, tokens: readThemeTokens(), standalone: true, title },
      DEFAULT_VISUAL_ASSETS,
    );
    saveBlob(new Blob([doc], { type: 'text/html' }), visualFileName(title, 'html'));
  };

  return (
    <Card ref={cardRef} className="w-full max-w-[604px] overflow-hidden">
      <CardHeader className="flex-row items-center justify-between gap-2 py-1 pl-4 pr-1">
        <CardTitle className="truncate text-sm font-medium">{title}</CardTitle>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Download visual">
              <Download />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={!ready || failed} onSelect={downloadPng}>
                Download as PNG
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!loaded} onSelect={downloadHtml}>
                Download as HTML
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent className="p-0">
        {failed ? (
          <div className="flex flex-col gap-1 px-4 pb-4">
            <p className="text-sm text-muted-foreground">This visual couldn't be displayed.</p>
            <p className="text-sm">{summary}</p>
          </div>
        ) : (
          <div className="relative" style={{ height }}>
            {!ready && <Skeleton className="absolute inset-0 rounded-none" />}
            {loaded && (
              <iframe
                ref={iframeRef}
                sandbox={VISUAL_IFRAME_SANDBOX}
                srcDoc={loaded.srcdoc}
                title={title}
                aria-describedby={descriptionId}
                style={{ height }}
                className={cn(
                  'block w-full border-0',
                  ready ? 'opacity-100' : 'opacity-0',
                  recalled === undefined && 'transition-opacity motion-reduce:transition-none',
                )}
              />
            )}
            <p id={descriptionId} className="sr-only">
              {summary}
            </p>
          </div>
        )}
        {exportFailed && (
          <p className="px-4 pb-3 text-sm text-muted-foreground">
            We couldn't make a picture of this visual. The HTML download still works.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * True while the page is visible and the element intersects the viewport.
 * Without IntersectionObserver the element counts as on screen, so the ready
 * timeout still applies.
 */
function useWatched(ref: React.RefObject<HTMLElement | null>): boolean {
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible');
  const [onScreen, setOnScreen] = useState(() => typeof IntersectionObserver !== 'function');

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setOnScreen(last.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return pageVisible && onScreen;
}

function clearAll(pending: Map<string, ReturnType<typeof setTimeout>>): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}

export default VisualFrame;
