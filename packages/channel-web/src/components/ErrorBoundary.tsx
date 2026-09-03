/**
 * ErrorBoundary — the floor underneath every render-phase throw in the SPA.
 *
 * Response validation at the API boundary (`WorkspaceShapeError` in
 * `lib/workspace-api.ts`) is the primary defence against shape drift; this
 * is the backstop for everything nobody thought to guard. A server/client
 * version skew during a deploy is exactly when response shapes drift, and
 * precisely when the page most needs to stay up — so a broken subtree
 * degrades into a fallback panel instead of unmounting the whole app into
 * a blank page.
 *
 * Granularity (TASK-273 design call): per-surface, not one app-level net.
 * Each surface gets its own boundary so the rest of the page stays usable:
 * a broken thread panel must not take the sidebar with it, and a broken
 * workspace rail must not take chat. `main.tsx` additionally wraps the
 * whole `<App />` as the last resort for throws above every surface
 * (boot gate, providers).
 *
 * Copy follows the voice rules: plain language, what happened plus one
 * concrete next action, "we" not "you" — never a stack trace, never a
 * silent white screen. The real error goes to `console.error` where it is
 * useful and harmless.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

interface ErrorBoundaryProps {
  /** Which surface this boundary guards — shown in the console log line. */
  surface: string;
  children: ReactNode;
  /** Overrides the default fallback panel for this surface. */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Loud in the console, quiet on screen: the fallback panel carries
    // authored copy; the raw error (possibly untrusted server content)
    // never reaches the DOM.
    console.error(`[channel-web] ${this.props.surface} crashed`, error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }
    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }
    return (
      <div
        role="alert"
        className="flex flex-1 items-center justify-center bg-background p-6"
      >
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>This part hit a snag</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Something went wrong showing this panel. Your chats and work are
              safe — give it another try, or reload the page for a fresh start.
            </p>
            <div className="flex gap-2">
              <Button onClick={this.handleRetry}>Try again</Button>
              <Button variant="outline" onClick={this.handleReload}>
                Reload page
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
