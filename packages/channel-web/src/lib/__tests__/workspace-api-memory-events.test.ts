/**
 * The client half of TASK-626's conversation memory stream, and the
 * conversation feed on the recall route (TASK-627).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseMemoryEventFrame,
  workspaceApi,
  type MemoryEventFrame,
} from '../workspace-api';

function sseResponse(lines: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseMemoryEventFrame', () => {
  it('reads the snapshot, the unknown snapshot and activity frames', () => {
    expect(
      parseMemoryEventFrame({ memoryStatus: { extraction: 'paused', conversation: 'idle' } }),
    ).toEqual({ kind: 'status', extraction: 'paused', conversation: 'idle' });
    expect(parseMemoryEventFrame({ memoryStatus: { readFailed: true } })).toEqual({
      kind: 'status-unknown',
    });
    expect(
      parseMemoryEventFrame({ memoryActivity: { state: 'recorded', statementIds: ['a', 7, ''] } }),
    ).toEqual({ kind: 'activity', state: 'recorded', statementIds: ['a'] });
    expect(parseMemoryEventFrame({ memoryActivity: { state: 'extracting' } })).toEqual({
      kind: 'activity',
      state: 'extracting',
      statementIds: [],
    });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['an unknown activity state', { memoryActivity: { state: 'thinking' } }],
    ['an unknown conversation state', { memoryStatus: { extraction: 'ok', conversation: 'busy' } }],
    ['a chat frame', { kind: 'text', text: 'hi', seq: 1 }],
  ])('drops %s', (_label, raw) => {
    expect(parseMemoryEventFrame(raw)).toBeNull();
  });
});

describe('workspaceApi.memoryEvents', () => {
  it('opens the conversation stream and hands over each valid frame in order', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        `data: ${JSON.stringify({ memoryStatus: { extraction: 'ok', conversation: 'extracting' } })}\n\n`,
        ':\n\n',
        `data: ${JSON.stringify({ memoryActivity: { state: 'nonsense' } })}\n\n`,
        `data: ${JSON.stringify({ memoryActivity: { state: 'recorded', statementIds: ['s1'] } })}\n\n`,
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const frames: MemoryEventFrame[] = [];
    const end = await workspaceApi.memoryEvents('c 1', (f) => frames.push(f));
    expect(end).toBe('ended');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain(
      '/api/chat/conversations/c%201/memory-events',
    );
    expect(frames).toEqual([
      { kind: 'status', extraction: 'ok', conversation: 'extracting' },
      { kind: 'activity', state: 'recorded', statementIds: ['s1'] },
    ]);
  });

  it('answers unavailable on 503 and failed on any other refusal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    expect(await workspaceApi.memoryEvents('c1', () => {})).toBe('unavailable');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    expect(await workspaceApi.memoryEvents('c1', () => {})).toBe('failed');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect(await workspaceApi.memoryEvents('c1', () => {})).toBe('failed');
  });
});

describe('recallMemory — the conversation feed', () => {
  it('sends conversationId and keeps each row’s sourceTurnId', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        statements: [
          {
            id: 's1',
            about: 'user',
            relation: 'lives_in',
            value: 'Boston',
            when: '2026-09-01T00:00:00.000Z',
            sourceTurnId: 't-9',
          },
        ],
        degraded: [],
      }),
    } as unknown as Response);
    const page = await workspaceApi.recallMemory('a1', { conversationId: 'c1' });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ conversationId: 'c1' }));
    expect(page.statements[0]?.sourceTurnId).toBe('t-9');
  });

  it('refuses a page whose sourceTurnId is not a string', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        statements: [
          { id: 's1', about: 'user', relation: 'r', value: 'v', when: 'w', sourceTurnId: 4 },
        ],
        degraded: [],
      }),
    } as unknown as Response);
    await expect(workspaceApi.recallMemory('a1', { conversationId: 'c1' })).rejects.toThrow();
  });
});
