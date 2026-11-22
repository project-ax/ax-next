/**
 * The apps approve page, `/apps/approve/<platformId>/<appId>/<connectorId>`:
 * the link an external app shows one of its viewers. Signed in, it asks
 * "**{appName}** wants to use {connector} as you", shows the tools that
 * covers, and lets the viewer pick which of their own agents lends the
 * connector's sign-in (picked for them when only one can). Allow says yes;
 * Not now goes back to the workspace. Nothing of the workspace is drawn here.
 *
 * It is a consent screen reached from a link we don't control, so:
 *
 *   - Everything the app or a connector says about itself (the app's name,
 *     the connector's name, tool names) is untrusted (I5). It is React text,
 *     never markup, and never a link; each one sits in a `<bdi>` so a
 *     right-to-left run inside it can't reorder the sentence around it.
 *   - Allow sends exactly the tool names this page showed (`approveApp`
 *     echoes them), and the server approves only those, so the yes matches
 *     what was on screen.
 *   - The agent choice is one of the prompt's own candidates (a radio over
 *     that list); an earlier yes whose agent has since dropped out of it
 *     picks nothing.
 *   - Inside a frame it says to open the link in its own tab and asks
 *     nothing of the server, so another page can't dress this one up and
 *     steer a click onto Allow.
 *   - The ids reach the server only through `lib/agent-apps`, which checks
 *     each against its grammar first; a bad one makes no request.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalPrompt, ApprovePageIds } from '@ax/apps-bridge-contract';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  AgentAppsError,
  agentAppsErrorCopy,
  agentAppsStale,
  approveApp,
  fetchApprovalPrompt,
} from '@/lib/agent-apps';

export const APPROVE_DONE = 'Done. You can close this tab and go back to the app.';
const NOT_FOUND = "This link doesn't work any more";
const NOTHING_SHARED = 'Nothing was shared.';
const LOAD_FAILED = "We couldn't load this just now.";
const FRAMED = 'Open this link in its own tab to continue.';
const CHANGED = 'Something changed while this page was open, so nothing was shared. Have another look.';
const WORKSPACE = '/workspace';

type PageState =
  | { status: 'framed' }
  | { status: 'loading' }
  | { status: 'ready'; prompt: ApprovalPrompt; load: number; notice: string | null }
  | { status: 'not-found' }
  | { status: 'failed' }
  | { status: 'done' };

function framed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent that won't even be compared is a frame too.
    return true;
  }
}

/** An earlier yes, while its agent can still lend the connector; else the only candidate; else none. */
function initialChoice(prompt: ApprovalPrompt): string | null {
  const earlier = prompt.approvedAgentId;
  if (earlier !== null && prompt.agents.some((a) => a.agentId === earlier)) return earlier;
  return prompt.agents.length === 1 ? (prompt.agents[0]?.agentId ?? null) : null;
}

function Notice({ title, description, retry }: { title: string; description?: string; retry?: () => void }) {
  return (
    <Empty role="status">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description !== undefined && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {retry && (
        <EmptyContent>
          <Button type="button" variant="outline" onClick={retry}>
            Try again
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

function Approve({
  ids,
  prompt,
  notice,
  onDone,
  onStale,
}: {
  ids: ApprovePageIds;
  prompt: ApprovalPrompt;
  notice: string | null;
  onDone: () => void;
  onStale: (notice: string) => void;
}) {
  const [choice, setChoice] = useState<string | null>(() => initialChoice(prompt));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(notice);
  const inFlight = useRef(false);

  const allow = useCallback(() => {
    if (choice === null || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    void (async () => {
      try {
        await approveApp(ids.platformId, ids.appId, ids.connectorId, choice, prompt.tools);
        onDone();
      } catch (e) {
        // The error carries a status and a code, never an id or a name.
        console.warn('[apps-approve] approve failed', e);
        if (e instanceof AgentAppsError && e.code === 'agent-not-eligible') onStale(agentAppsErrorCopy(e));
        else if (agentAppsStale(e)) onStale(CHANGED);
        else setError(agentAppsErrorCopy(e));
      } finally {
        inFlight.current = false;
        setSending(false);
      }
    })();
  }, [choice, ids, prompt.tools, onDone, onStale]);

  const none = prompt.agents.length === 0;
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle role="heading" aria-level={1} className="break-words text-xl leading-snug">
          <strong>
            <bdi>{prompt.appName}</bdi>
          </strong>{' '}
          wants to use <bdi>{prompt.connectorName}</bdi> as you
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {none ? (
          <p className="text-sm text-muted-foreground">
            None of your agents has <bdi>{prompt.connectorName}</bdi> yet. Add it to one of your agents, then open
            this link again.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <p id="apps-approve-tools" className="text-sm text-muted-foreground">
                It will be able to use:
              </p>
              <ul aria-labelledby="apps-approve-tools" className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {prompt.tools.map((name) => (
                  <li key={name} className="break-all font-mono">
                    <bdi>{name}</bdi>
                  </li>
                ))}
              </ul>
            </div>
            <FieldSet disabled={sending}>
              <FieldLegend variant="label">
                Use <bdi>{prompt.connectorName}</bdi> from
              </FieldLegend>
              <RadioGroup value={choice ?? ''} onValueChange={setChoice}>
                {prompt.agents.map((agent, i) => (
                  <Field key={agent.agentId} orientation="horizontal">
                    <RadioGroupItem value={agent.agentId} id={`apps-approve-agent-${i}`} />
                    <FieldLabel htmlFor={`apps-approve-agent-${i}`} className="break-words font-normal">
                      <bdi>{agent.displayName}</bdi>
                    </FieldLabel>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>
          </>
        )}
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        {none ? (
          <Button asChild variant="outline">
            <a href={WORKSPACE}>Go to your agents</a>
          </Button>
        ) : (
          <>
            <Button asChild variant="ghost">
              <a href={WORKSPACE}>Not now</a>
            </Button>
            <Button type="button" disabled={choice === null || sending} onClick={allow}>
              {sending && <Spinner data-icon="inline-start" />}
              Allow
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}

export function AppsApprovePage({ platformId, appId, connectorId }: ApprovePageIds) {
  const [state, setState] = useState<PageState>(() => (framed() ? { status: 'framed' } : { status: 'loading' }));
  const [attempt, setAttempt] = useState(0);
  const notice = useRef<string | null>(null);
  const loads = useRef(0);
  const request = useRef(0);
  const isFramed = state.status === 'framed';

  useEffect(() => {
    if (isFramed) return;
    const id = ++request.current;
    fetchApprovalPrompt(platformId, appId, connectorId).then(
      (prompt) => {
        if (request.current !== id) return;
        const shown = notice.current;
        notice.current = null;
        // No tools means nothing to say yes to: the server would refuse it as gone.
        if (prompt.tools.length === 0) setState({ status: 'not-found' });
        else setState({ status: 'ready', prompt, load: ++loads.current, notice: shown });
      },
      (e: unknown) => {
        if (request.current !== id) return;
        notice.current = null;
        console.warn('[apps-approve] could not load', e);
        if (e instanceof AgentAppsError && e.code === 'not-found') setState({ status: 'not-found' });
        else setState({ status: 'failed' });
      },
    );
    return () => {
      request.current++;
    };
  }, [platformId, appId, connectorId, attempt, isFramed]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  /** Read the prompt again behind the current page, then show `text` on the fresh one. */
  const refresh = useCallback((text: string) => {
    notice.current = text;
    setAttempt((n) => n + 1);
  }, []);
  const done = useCallback(() => setState({ status: 'done' }), []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-6 font-sans text-foreground">
      {state.status === 'loading' && (
        <div className="flex w-full max-w-md flex-col gap-3" role="status">
          <span className="sr-only">Loading…</span>
          <Skeleton className="h-7 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {state.status === 'ready' && (
        <Approve
          key={state.load}
          ids={{ platformId, appId, connectorId }}
          prompt={state.prompt}
          notice={state.notice}
          onDone={done}
          onStale={refresh}
        />
      )}
      {state.status === 'done' && <Notice title={APPROVE_DONE} />}
      {state.status === 'framed' && <Notice title={FRAMED} />}
      {state.status === 'not-found' && <Notice title={NOT_FOUND} description={NOTHING_SHARED} />}
      {state.status === 'failed' && <Notice title={LOAD_FAILED} description={NOTHING_SHARED} retry={retry} />}
    </div>
  );
}
