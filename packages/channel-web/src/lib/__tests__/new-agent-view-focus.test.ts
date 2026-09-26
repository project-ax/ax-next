/**
 * TASK-533 — after a finished create, focus goes to the NEW agent's
 * conversation, found by id.
 *
 * The id matters because the workspace that comes back first paints whatever
 * route it was on, which can be ANOTHER agent's conversation. These tests pin
 * that the restore waits for the new one rather than taking the first region
 * it sees, and that an id that is not a plain token still selects correctly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_CONVERSATION_ATTR,
  AGENT_LOADING_ATTR,
  focusNewAgentViewWhenReady,
  refocusNewAgentViewWhenReady,
} from '../new-agent-return-focus';

function region(agentId: string): HTMLElement {
  const el = document.createElement('div');
  el.tabIndex = -1;
  el.setAttribute(AGENT_CONVERSATION_ATTR, agentId);
  return el;
}

function loadingPane(agentId: string): HTMLElement {
  const el = document.createElement('div');
  el.tabIndex = -1;
  el.setAttribute(AGENT_LOADING_ATTR, agentId);
  return el;
}

/** Let the MutationObserver's microtask run. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe('focusNewAgentViewWhenReady (TASK-533)', () => {
  it('passes over another agent\'s conversation and lands on the new one when it arrives', async () => {
    const other = region('a1');
    document.body.append(other);

    const stop = focusNewAgentViewWhenReady('a2', document, 1_000);
    expect(document.activeElement).not.toBe(other);

    const created = region('a2');
    document.body.append(created);
    await flush();

    expect(document.activeElement).toBe(created);
    stop();
  });

  it('selects an id carrying quotes and backslashes as a literal value', () => {
    const id = 'a"] , [x\\y';
    const decoy = region('a');
    const created = region(id);
    document.body.append(decoy, created);

    const stop = focusNewAgentViewWhenReady(id, document, 1_000);

    expect(document.activeElement).toBe(created);
    stop();
  });

  describe('the loading pane (TASK-539)', () => {
    it('lands on the new agent\'s loading pane when its conversation is not there yet', async () => {
      const stop = focusNewAgentViewWhenReady('a2', document, 1_000);

      const pane = loadingPane('a2');
      document.body.append(pane);
      await flush();

      expect(document.activeElement).toBe(pane);
      stop();
    });

    it('passes over ANOTHER agent\'s loading pane', async () => {
      const other = loadingPane('a1');
      document.body.append(other);

      const stop = focusNewAgentViewWhenReady('a2', document, 1_000);
      expect(document.activeElement).not.toBe(other);
      stop();
    });

    it('prefers the conversation when both are present', () => {
      const pane = loadingPane('a2');
      const created = region('a2');
      document.body.append(pane, created);

      const stop = focusNewAgentViewWhenReady('a2', document, 1_000);

      expect(document.activeElement).toBe(created);
      stop();
    });
  });
});

/*
  TASK-547 — the re-arm after a slow kickoff send. The view may ALREADY be
  painted when it runs, which is exactly when `focusFirstWhenReady`'s
  immediate try would take focus without asking whether anyone holds it.

  VACUITY: both "claimed" tests put the target on screen BEFORE the call, so
  the only thing that can keep focus where the person put it is the up-front
  check. Drop it (call `focusNewAgentViewWhenReady` straight through) and both
  go red. The third pins that the check is not a blanket no-op.
*/
describe('refocusNewAgentViewWhenReady (TASK-547)', () => {
  it('leaves a person where they are even when the new view is already painted', () => {
    const elsewhere = document.createElement('button');
    const created = region('a2');
    document.body.append(elsewhere, created);
    elsewhere.focus();

    const stop = refocusNewAgentViewWhenReady('a2', document, 1_000);

    expect(document.activeElement).toBe(elsewhere);
    stop();
  });

  it('does not re-take focus from the loading pane the first restore landed on', () => {
    const pane = loadingPane('a2');
    const created = region('a2');
    document.body.append(pane, created);
    pane.focus();

    const stop = refocusNewAgentViewWhenReady('a2', document, 1_000);

    // The pane's own hand-off (AgentView) owns the next step, not this.
    expect(document.activeElement).toBe(pane);
    stop();
  });

  it('with the keyboard unclaimed, waits for the new view and lands on it', async () => {
    const stop = refocusNewAgentViewWhenReady('a2', document, 1_000);

    const pane = loadingPane('a2');
    document.body.append(pane);
    await flush();

    expect(document.activeElement).toBe(pane);
    stop();
  });
});
