/**
 * "Gmail isn’t signed in yet, so it’s off for this chat." (TASK-806)
 *
 * A connector this person has never signed in to — or never added a key for —
 * no longer stops the turn: the host leaves it out of that chat and runs the
 * rest. The reply simply won't use it, so the chat says so, once, above the
 * thread, with the one click that fixes it.
 *
 * NOT a failure, so none of the turn-error strip's register: the default
 * (non-destructive) `Alert`, and `role="note"` rather than shadcn's hard-coded
 * `role="alert"` — nothing went wrong and nothing needs an assertive
 * announcement, the same call `AgentConversation` makes for "you stopped this
 * reply". It never blocks sending; the composer is a sibling this component
 * knows nothing about.
 *
 * WHERE THE NAMES COME FROM. Not from a new wire frame: the agent's Connectors
 * list already marks exactly these connectors (`health: 'needs-sign-in'`, the
 * same stored-credentials presence read the host skips on, TASK-795), so this
 * reads that list and the rail and the notice cannot disagree. It is read on
 * mount, whenever `refreshKey` changes (the caller bumps it when a turn ends
 * and when the person moves between tabs, so signing in on the Connectors tab
 * clears the notice on the way back), and on an agent switch.
 *
 * A FAILED READ SAYS NOTHING. This is information, not a gate: if the list
 * can't be read the notice simply isn't drawn (and the failure is logged for
 * an operator), and a notice that was showing comes down rather than going
 * stale. The Connectors tab is where a read failure is told properly.
 *
 * DISMISSAL is remembered, in this component's state, for the SET of connectors
 * it was dismissed over. A different set — one more connector becoming
 * unsigned, or the same one lapsing again after a sign-in — is news, so the
 * notice returns. Nothing is persisted: reloading the page asks again.
 *
 * UNTRUSTED TEXT. A connector's name is authored by an admin or a person; it
 * is only ever interpolated into a string drawn as a React text node — never
 * markup, never markdown. `skippedConnectorsSentence` also folds control
 * characters and whitespace runs to single spaces and clamps the length, so a
 * name cannot start a second line, reorder the text, or push the buttons off
 * the strip.
 */
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { logRequestFailure } from '@/lib/http';
import { workspaceApi } from '@/lib/workspace-api';

/** Longest connector name drawn in the sentence, in characters. */
const MAX_NAME_CHARS = 40;

/** What a name with nothing left in it after cleaning is called. */
const UNNAMED = 'A connector';

function displayName(raw: string): string {
  // Control (\n, \t, …) and format characters (bidi overrides, zero-width) to a
  // space, then any run of whitespace to one — a name stays on one line, in
  // reading order.
  const folded = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (folded === '') return UNNAMED;
  const chars = Array.from(folded);
  return chars.length > MAX_NAME_CHARS ? `${chars.slice(0, MAX_NAME_CHARS - 1).join('')}…` : folded;
}

/**
 * The notice's one sentence. One name: "Gmail isn’t signed in yet, so it’s off
 * for this chat." Two: "Gmail and Linear aren’t signed in yet, so they’re
 * off for this chat." Three or more: "Gmail, Linear and Notion aren’t …".
 *
 * Returns a plain string for the caller to draw as text. Names are untrusted;
 * see the file comment.
 */
export function skippedConnectorsSentence(names: readonly string[]): string {
  const shown = names.map(displayName);
  const last = shown[shown.length - 1] ?? UNNAMED;
  const list = shown.length < 2 ? last : `${shown.slice(0, -1).join(', ')} and ${last}`;
  return shown.length < 2
    ? `${list} isn’t signed in yet, so it’s off for this chat.`
    : `${list} aren’t signed in yet, so they’re off for this chat.`;
}

interface Skipped {
  id: string;
  name: string;
}

/** The identity of a set of skipped connectors — what a dismissal is "over". */
function setKey(skipped: readonly Skipped[]): string {
  return skipped
    .map((c) => c.id)
    .sort()
    .join('\n');
}

interface Props {
  agentId: string;
  /**
   * Any value that changes when the answer may have changed. A change refetches.
   * The caller bumps it when a turn ends and when the person changes tab.
   */
  refreshKey: string | number;
  /** "Open Connectors" — the tab where each of these has Sign in / Add key. */
  onOpenConnectors: () => void;
  /**
   * Draw nothing for now, but stay mounted — so a dismissal survives. The
   * notice is about the CURRENT chat, so the caller suppresses it while a past
   * conversation is open and it is still dismissed when they come back.
   */
  suppressed?: boolean;
}

export function SkippedConnectorsNotice({
  agentId,
  refreshKey,
  onOpenConnectors,
  suppressed = false,
}: Props) {
  const [skipped, setSkipped] = useState<readonly Skipped[]>([]);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  // Another agent's connectors are not this agent's: drop the names at once
  // rather than showing them until the new read lands.
  useEffect(() => {
    setSkipped([]);
    setDismissedKey(null);
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: Skipped[] = [];
      try {
        const read = await workspaceApi.connectors(agentId);
        // An agent whose runner loads no connectors at all skips nothing — they
        // are all "off", and the Connectors tab says so itself.
        if (read.connectorsSupported !== false) {
          next = read.connectors
            .filter((c) => c.health === 'needs-sign-in')
            .map((c) => ({ id: c.id, name: c.name }));
        }
      } catch (e) {
        logRequestFailure(e, 'skipped-connectors');
      }
      if (cancelled) return;
      setSkipped(next);
      // A dismissal only covers the set it was made over.
      const key = setKey(next);
      setDismissedKey((prev) => (prev === key ? prev : null));
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, refreshKey]);

  const key = useMemo(() => setKey(skipped), [skipped]);
  const sentence = useMemo(() => skippedConnectorsSentence(skipped.map((c) => c.name)), [skipped]);

  if (suppressed || skipped.length === 0 || key === dismissedKey) return null;

  return (
    <div className="px-6 pt-4">
      <Alert role="note">
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 basis-56">{sentence}</span>
          <Button variant="outline" size="sm" onClick={onOpenConnectors}>
            Open Connectors
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="Dismiss"
            onClick={() => setDismissedKey(key)}
          >
            <X aria-hidden="true" />
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
