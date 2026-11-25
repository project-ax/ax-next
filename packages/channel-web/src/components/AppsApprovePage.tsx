/**
 * The apps approve page, `/apps/approve/<platformId>/<appId>/<connectorId>`:
 * the link an external app shows one of its viewers. Signed in, it asks
 * "**{appName}** wants to use {connector} as you", shows the tools it's
 * asking for, and lets the viewer pick which of their own agents lends the
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
 *   - Allow ignores a press for `ARM_DELAY_MS` after the card appears, and
 *     again after the tab becomes visible or the window gains focus. An app
 *     that opens this link in a popup can't time a double-click so that its
 *     second half lands on an Allow that is already live (one eligible agent
 *     is picked for the viewer, so nothing else stands in the way).
 *   - The headline's bold name is the app's own choosing, and a line under it
 *     says so.
 *   - While a refusal makes it read the prompt again, Allow stays off and the
 *     reason shows at once, so nothing is sent against the old page.
 *   - The ids reach the server only through `lib/agent-apps`, which checks
 *     each against its grammar first; a bad one makes no request.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalPrompt, ApprovePageIds } from '@ax/apps-bridge-contract';
import { AsyncState, Button as AxButton, EmptyState, Notice } from '@project-ax/ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { WORKSPACE_ROOT_PATH } from '@/lib/workspace-route';
import {
  AgentAppsError,
  agentAppsErrorCopy,
  agentAppsStale,
  approveApp,
  fetchApprovalPrompt,
} from '@/lib/agent-apps';

export const APPROVE_DONE = 'Done. You can close this tab and go back to the app.';
export const TOOLS_ASKED = "It's asking to use:";
/**
 * Allow here is the viewer's yes, not the agent's: each call still checks the
 * chosen agent's own tool policy, and connector tools (write tools above all)
 * usually start at Ask first, which an app has nobody to ask. So the page
 * says what else it takes, rather than promise the tools will work.
 */
export const TOOLS_NEED_ALLOW = 'Each tool also has to be set to Allow on the agent you pick, under Connectors.';
const NOT_FOUND = "This link doesn't work any more";
const NOTHING_SHARED = 'Nothing was shared.';
const LOAD_FAILED = "We couldn't load this just now.";
const FRAMED = 'Open this link in its own tab to continue.';
const CHANGED = 'Something changed while this page was open, so nothing was shared. Have another look.';
export const APP_NAMED_ITSELF = 'The app chose this name.';
/** How long Allow ignores a press after the card appears, or after the tab comes back into view or focus. */
export const ARM_DELAY_MS = 500;

type PageState =
  | { status: 'framed' }
  | { status: 'loading' }
  | {
      status: 'ready';
      prompt: ApprovalPrompt;
      /** Bumped per successful read: a fresh prompt is a fresh card (its own choice). */
      load: number;
      /** What went wrong last, shown on the card until the next Allow. */
      message: string | null;
      /** A refusal sent us to read the prompt again, and the answer isn't in yet. */
      refreshing: boolean;
    }
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

/** A finished or refused page: one line of what happened, no way forward from here. */
function Outcome({ title, description }: { title: string; description?: string }) {
  return (
    <EmptyState title={title} {...(description !== undefined ? { description } : {})} />
  );
}

/**
 * When Allow may next be pressed: `ARM_DELAY_MS` after the card appeared, and
 * pushed out again whenever the tab becomes visible or the window gains focus.
 */
function useArmedAt(): { current: number } {
  const armedAt = useRef(Date.now() + ARM_DELAY_MS);
  useEffect(() => {
    const rearm = () => {
      armedAt.current = Date.now() + ARM_DELAY_MS;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') rearm();
    };
    rearm();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', rearm);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', rearm);
    };
  }, []);
  return armedAt;
}

function Approve({
  ids,
  prompt,
  message,
  refreshing,
  onMessage,
  onDone,
  onStale,
}: {
  ids: ApprovePageIds;
  prompt: ApprovalPrompt;
  message: string | null;
  refreshing: boolean;
  onMessage: (text: string | null) => void;
  onDone: () => void;
  onStale: (text: string) => void;
}) {
  const [choice, setChoice] = useState<string | null>(() => initialChoice(prompt));
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const armedAt = useArmedAt();

  const allow = useCallback(() => {
    if (choice === null || inFlight.current || refreshing) return;
    // Too soon after the card appeared or came back into view: not a choice.
    if (Date.now() < armedAt.current) return;
    inFlight.current = true;
    setSending(true);
    onMessage(null);
    void (async () => {
      try {
        await approveApp(ids.platformId, ids.appId, ids.connectorId, choice, prompt.tools);
        onDone();
      } catch (e) {
        // The error carries a status and a code, never an id or a name.
        console.warn('[apps-approve] approve failed', e);
        if (e instanceof AgentAppsError && e.code === 'agent-not-eligible') onStale(agentAppsErrorCopy(e));
        else if (agentAppsStale(e)) onStale(CHANGED);
        else onMessage(agentAppsErrorCopy(e));
      } finally {
        inFlight.current = false;
        setSending(false);
      }
    })();
  }, [choice, refreshing, armedAt, ids, prompt.tools, onMessage, onDone, onStale]);

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
        <CardDescription>{APP_NAMED_ITSELF}</CardDescription>
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
                {TOOLS_ASKED}
              </p>
              <ul aria-labelledby="apps-approve-tools" className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {prompt.tools.map((name) => (
                  <li key={name} className="break-all font-mono">
                    <bdi>{name}</bdi>
                  </li>
                ))}
              </ul>
            </div>
            <FieldSet disabled={sending || refreshing}>
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
              <FieldDescription>{TOOLS_NEED_ALLOW}</FieldDescription>
            </FieldSet>
          </>
        )}
        {message !== null && (
          <Notice tone="danger">{message}</Notice>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        {none ? (
          <Button asChild variant="outline">
            <a href={WORKSPACE_ROOT_PATH}>Go to your agents</a>
          </Button>
        ) : (
          <>
            <Button asChild variant="ghost">
              <a href={WORKSPACE_ROOT_PATH}>Not now</a>
            </Button>
            <AxButton intent="primary" busy={sending} disabled={choice === null || sending || refreshing} onClick={allow}>
              Allow
            </AxButton>
          </>
        )}
      </CardFooter>
    </Card>
  );
}

export function AppsApprovePage({ platformId, appId, connectorId }: ApprovePageIds) {
  const [state, setState] = useState<PageState>(() => (framed() ? { status: 'framed' } : { status: 'loading' }));
  const [attempt, setAttempt] = useState(0);
  const loads = useRef(0);
  const request = useRef(0);
  const isFramed = state.status === 'framed';

  useEffect(() => {
    if (isFramed) return;
    const id = ++request.current;
    fetchApprovalPrompt(platformId, appId, connectorId).then(
      (prompt) => {
        if (request.current !== id) return;
        // No tools means nothing to say yes to: the server would refuse it as gone.
        if (prompt.tools.length === 0) {
          setState({ status: 'not-found' });
          return;
        }
        const load = ++loads.current;
        // A re-read after a refusal keeps saying why on the fresh card.
        setState((prev) => ({
          status: 'ready',
          prompt,
          load,
          message: prev.status === 'ready' && prev.refreshing ? prev.message : null,
          refreshing: false,
        }));
      },
      (e: unknown) => {
        if (request.current !== id) return;
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
  /** Say `text` now, hold Allow off, and read the prompt again behind the current card. */
  const refresh = useCallback((text: string) => {
    setState((prev) => (prev.status === 'ready' ? { ...prev, message: text, refreshing: true } : prev));
    setAttempt((n) => n + 1);
  }, []);
  const showMessage = useCallback((text: string | null) => {
    setState((prev) => (prev.status === 'ready' ? { ...prev, message: text } : prev));
  }, []);
  const done = useCallback(() => setState({ status: 'done' }), []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-6 font-sans text-foreground">
      {state.status === 'loading' && (
        <div className="w-full max-w-md">
          <AsyncState status="loading" skeleton="block" loadingLabel="Loading this request" />
        </div>
      )}
      {state.status === 'ready' && (
        <Approve
          key={state.load}
          ids={{ platformId, appId, connectorId }}
          prompt={state.prompt}
          message={state.message}
          refreshing={state.refreshing}
          onMessage={showMessage}
          onDone={done}
          onStale={refresh}
        />
      )}
      {state.status === 'done' && <Outcome title={APPROVE_DONE} />}
      {state.status === 'framed' && <Outcome title={FRAMED} />}
      {state.status === 'not-found' && <Outcome title={NOT_FOUND} description={NOTHING_SHARED} />}
      {state.status === 'failed' && (
        <div className="w-full max-w-md">
          <Notice tone="danger" title={LOAD_FAILED} action={{ label: 'Try again', onClick: retry }}>
            {NOTHING_SHARED}
          </Notice>
        </div>
      )}
    </div>
  );
}
