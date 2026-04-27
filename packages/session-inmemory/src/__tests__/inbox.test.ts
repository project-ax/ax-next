import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@ax/core';
import { createInbox } from '../inbox.js';

const userMsg = (
  content: string,
  reqId = 'r-test',
): { type: 'user-message'; payload: ChatMessage; reqId: string } => ({
  type: 'user-message',
  payload: { role: 'user', content },
  reqId,
});

describe('@ax/session-inmemory inbox', () => {
  it('queue then claim: claim returns the entry with cursor advanced to next', async () => {
    const inbox = createInbox();
    const { cursor: queuedAt } = inbox.queue('s-1', userMsg('hi'));
    expect(queuedAt).toBe(0);
    const result = await inbox.claim('s-1', 0, 1000);
    expect(result).toEqual({
      type: 'user-message',
      payload: { role: 'user', content: 'hi' },
      reqId: 'r-test',
      cursor: 1,
    });
  });

  it('claim on empty inbox blocks then times out with echo cursor', async () => {
    const inbox = createInbox();
    const start = Date.now();
    const result = await inbox.claim('s-1', 0, 80);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(70); // allow a little jitter
    expect(result).toEqual({ type: 'timeout', cursor: 0 });
  });

  it('claim wakes when a new entry is queued during the wait', async () => {
    const inbox = createInbox();
    const claimP = inbox.claim('s-1', 0, 500);
    // Queue shortly after the claim has registered as a waiter.
    setTimeout(() => {
      inbox.queue('s-1', userMsg('wake me'));
    }, 30);
    const start = Date.now();
    const result = await claimP;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(450); // well before timeout
    expect(result).toEqual({
      type: 'user-message',
      payload: { role: 'user', content: 'wake me' },
      reqId: 'r-test',
      cursor: 1,
    });
  });

  it('cursor advances monotonically across multiple queues (0, 1, 2)', () => {
    const inbox = createInbox();
    expect(inbox.queue('s-1', userMsg('a')).cursor).toBe(0);
    expect(inbox.queue('s-1', userMsg('b')).cursor).toBe(1);
    expect(inbox.queue('s-1', userMsg('c')).cursor).toBe(2);
  });

  it('claim at a cursor beyond the end waits; the matching queue wakes it', async () => {
    const inbox = createInbox();
    inbox.queue('s-1', userMsg('a')); // cursor 0 already present
    const claimP = inbox.claim('s-1', 1, 500); // waits — cursor 1 not yet there
    setTimeout(() => inbox.queue('s-1', userMsg('b')), 30);
    const result = await claimP;
    expect(result).toEqual({
      type: 'user-message',
      payload: { role: 'user', content: 'b' },
      reqId: 'r-test',
      cursor: 2,
    });
  });

  it("claim of a 'cancel' entry returns { type: 'cancel', cursor: <next> }", async () => {
    const inbox = createInbox();
    inbox.queue('s-1', { type: 'cancel' });
    const result = await inbox.claim('s-1', 0, 500);
    expect(result).toEqual({ type: 'cancel', cursor: 1 });
  });

  it('terminate() during a blocked claim: claim resolves as timeout with echo cursor', async () => {
    const inbox = createInbox();
    const claimP = inbox.claim('s-1', 0, 5000);
    setTimeout(() => inbox.terminate('s-1'), 20);
    const start = Date.now();
    const result = await claimP;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // not waiting the full timeout
    expect(result).toEqual({ type: 'timeout', cursor: 0 });
  });

  it('terminate on an unknown session is a no-op — later queue/claim work normally', async () => {
    const inbox = createInbox();
    // Regression: early impl lazy-created a terminated marker here, which
    // poisoned a subsequent queue/claim on the same sessionId (e.g. after
    // the caller recreated the session through the store). Terminating an
    // inbox that has no state should leave the inbox empty, not marked.
    inbox.terminate('s-unknown');
    const { cursor } = inbox.queue('s-unknown', userMsg('hello'));
    expect(cursor).toBe(0);
    const result = await inbox.claim('s-unknown', 0, 500);
    expect(result).toEqual({
      type: 'user-message',
      payload: { role: 'user', content: 'hello' },
      reqId: 'r-test',
      cursor: 1,
    });
  });

  it('claim on a terminated session (known-but-terminated) resolves immediately as timeout', async () => {
    const inbox = createInbox();
    // Materialize the per-session state first (via a benign queue+claim),
    // then terminate. A subsequent claim should fast-path on the flag.
    inbox.queue('s-1', userMsg('seed'));
    await inbox.claim('s-1', 0, 500);
    inbox.terminate('s-1');
    const start = Date.now();
    const result = await inbox.claim('s-1', 1, 5000);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(result).toEqual({ type: 'timeout', cursor: 1 });
  });
});
