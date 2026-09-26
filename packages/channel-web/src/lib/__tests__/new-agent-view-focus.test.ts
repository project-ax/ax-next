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
