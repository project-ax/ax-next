/**
 * `streamReply` and the `permissionRequest` frame (TASK-350).
 *
 * THIS IS THE BUG THE CARD IS ABOUT, and it had no test. The reader handled
 * `done`, `error`, text and `decisionRaised`; a `permissionRequest` frame was
 * parsed and then fell through to `continue`. The wall held server-side, so it
 * failed closed — but the person was never asked, and the turn dead-ended.
 *
 * The store, the row and the queue were each covered in isolation. The wire
 * between a frame and a row was not, which meant deleting the branch under test
 * here left the whole suite green.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceApi } from '../workspace-api';
import type { PermissionRequest } from '../../server/types';

function sseResponse(frames: unknown[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function run(frames: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => sseResponse(frames)),
  );
  const seen: PermissionRequest[] = [];
  const text: string[] = [];
  let done = false;
  let error: string | null = null;
  await workspaceApi.streamReply('r1', {
    onText: (t) => {
      text.push(t);
    },
    onDone: () => {
      done = true;
    },
    onError: (m) => {
      error = m;
    },
    onPermissionRequest: (r) => {
      seen.push(r);
    },
  });
  return { seen, text, done, error };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a permissionRequest frame reaches the caller', () => {
  it('forwards a host wall', async () => {
    const { seen } = await run([
      { reqId: 'r1', permissionRequest: { kind: 'host', host: 'example.org', sessionId: 's-1' } },
      { reqId: 'r1', done: true },
    ]);

    expect(seen).toEqual([{ kind: 'host', host: 'example.org', sessionId: 's-1' }]);
  });

  it('forwards a skill card verbatim, slots and all', async () => {
    // Forwarded, not reshaped: the row renders every field, and a reader that
    // dropped `haveExisting` would ask for a key the person already saved.
    const card = {
      kind: 'skill' as const,
      skillId: 'linear',
      description: 'File and read Linear issues',
      hosts: ['api.linear.app'],
      slots: [{ slot: 'api_key', kind: 'api-key' as const, account: 'linear', haveExisting: true }],
      authored: true,
      packages: { npm: ['linear-sdk'], pypi: [] },
    };
    const { seen } = await run([
      { reqId: 'r1', permissionRequest: card },
      { reqId: 'r1', done: true },
    ]);

    expect(seen).toEqual([card]);
  });

  it('forwards a connector card', async () => {
    const card = {
      kind: 'connector' as const,
      connectorId: 'linear',
      name: 'Linear',
      hosts: ['api.linear.app'],
      slots: [],
    };
    const { seen } = await run([
      { reqId: 'r1', permissionRequest: card },
      { reqId: 'r1', done: true },
    ]);

    expect(seen).toEqual([card]);
  });

  it('is NON-TERMINAL — the turn carries on around it', async () => {
    // The wall parks the turn, it does not end it. If this frame stopped the
    // read, the text after it would never arrive and the turn would look failed.
    const { seen, text, done, error } = await run([
      { reqId: 'r1', kind: 'text', text: 'checking' },
      { reqId: 'r1', permissionRequest: { kind: 'host', host: 'example.org', sessionId: 's-1' } },
      { reqId: 'r1', kind: 'text', text: ' and continuing' },
      { reqId: 'r1', done: true },
    ]);

    expect(seen).toHaveLength(1);
    expect(text.join('')).toBe('checking and continuing');
    expect(done).toBe(true);
    expect(error).toBeNull();
  });

  it('does not throw when no handler is supplied', async () => {
    // `onPermissionRequest` is optional — a caller that renders no grants (a
    // future surface, or a test) must not crash on the frame.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          { reqId: 'r1', permissionRequest: { kind: 'host', host: 'e.org', sessionId: 's' } },
          { reqId: 'r1', done: true },
        ]),
      ),
    );
    let done = false;
    await workspaceApi.streamReply('r1', {
      onText: () => undefined,
      onDone: () => {
        done = true;
      },
      onError: () => undefined,
    });

    expect(done).toBe(true);
  });
});
