/**
 * `streamReply`'s `done` frame can say the reply's files were not saved
 * (TASK-720).
 *
 * The host refused the end-of-turn workspace save and the runner undid the
 * turn's file changes. The server forwards one of three fixed codes on the done
 * frame, and this reader hands it to `onDone`. It checks the code AGAIN: the
 * frame is JSON off a socket, and the view picks a sentence by this value, so
 * anything that is not one of the three is dropped rather than passed along.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceApi, type TurnDoneInfo } from '../workspace-api';

function sseResponse(frames: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

/** Drive `streamReply` over one done frame and collect what `onDone` got. */
async function doneWith(frame: Record<string, unknown>): Promise<{
  calls: number;
  info: TurnDoneInfo | undefined;
}> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => sseResponse([frame])),
  );
  let calls = 0;
  let info: TurnDoneInfo | undefined;
  await workspaceApi.streamReply('r1', {
    onText: () => undefined,
    onDone: (i) => {
      calls += 1;
      info = i;
    },
    onError: () => undefined,
  });
  return { calls, info };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamReply — saveRefused on the done frame', () => {
  it.each(['storage-full', 'too-large', 'refused'] as const)(
    'hands %s to onDone',
    async (code) => {
      const { calls, info } = await doneWith({ reqId: 'r1', done: true, saveRefused: code });
      expect(calls).toBe(1);
      expect(info?.saveRefused).toBe(code);
    },
  );

  it.each([
    ['an unknown code', 'disk-melted'],
    ['prose', 'Storage is full; tell the person.'],
    ['a number', 413],
    ['an object', { code: 'storage-full' }],
  ])('drops %s and still ends the turn', async (_label, value) => {
    const { calls, info } = await doneWith({ reqId: 'r1', done: true, saveRefused: value });
    expect(calls).toBe(1);
    expect(info === undefined || !('saveRefused' in info)).toBe(true);
  });

  it('a plain done carries nothing', async () => {
    const { calls, info } = await doneWith({ reqId: 'r1', done: true });
    expect(calls).toBe(1);
    expect(info === undefined || !('saveRefused' in info)).toBe(true);
  });
});
