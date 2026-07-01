import { describe, expect, it, vi } from 'vitest';
import {
  makeOpenRouterOrchestratorClient,
  makeXaiOrchestratorClient,
} from '../orchestrator-client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const OK_BODY = {
  choices: [{ message: { content: '<load doc="entity/luna"/>' } }],
  usage: { prompt_tokens: 42, completion_tokens: 7 },
};

describe('makeXaiOrchestratorClient', () => {
  it('posts to api.x.ai with a Bearer header and the correct model/body, and parses text/usage', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_BODY));
    const client = makeXaiOrchestratorClient('xai-secret', undefined, { fetchImpl });

    const result = await client.complete({ system: 'sys', user: 'usr' });

    expect(result).toEqual({ text: '<load doc="entity/luna"/>', usage: { in: 42, out: 7 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer xai-secret',
    });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'grok-4-fast-non-reasoning',
      max_tokens: 512,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
    });
  });

  it('honors a custom model', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_BODY));
    const client = makeXaiOrchestratorClient('xai-secret', 'grok-custom', { fetchImpl });
    await client.complete({ system: 'sys', user: 'usr' });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.model).toBe('grok-custom');
  });

  it('retries once after a 503 then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
    const client = makeXaiOrchestratorClient('xai-secret', undefined, {
      fetchImpl,
      maxRetries: 2,
    });

    const result = await client.complete({ system: 'sys', user: 'usr' });

    expect(result).toEqual({ text: '<load doc="entity/luna"/>', usage: { in: 42, out: 7 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries on a persistent 503', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: 'unavailable' }));
    const client = makeXaiOrchestratorClient('xai-secret', undefined, {
      fetchImpl,
      maxRetries: 2,
    });

    await expect(client.complete({ system: 'sys', user: 'usr' })).rejects.toThrow(
      /orchestrator http 503/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('throws immediately on a non-retryable 400, no retries', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: 'bad request' }));
    const client = makeXaiOrchestratorClient('xai-secret', undefined, {
      fetchImpl,
      maxRetries: 2,
    });

    await expect(client.complete({ system: 'sys', user: 'usr' })).rejects.toThrow(
      /orchestrator http 400/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('makeOpenRouterOrchestratorClient', () => {
  it('posts to openrouter.ai with the default model and no provider override', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_BODY));
    const client = makeOpenRouterOrchestratorClient('or-secret', undefined, undefined, {
      fetchImpl,
    });

    await client.complete({ system: 'sys', user: 'usr' });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers).toMatchObject({ authorization: 'Bearer or-secret' });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('x-ai/grok-4-fast');
    expect(body).not.toHaveProperty('provider');
  });

  it('includes provider routing when forceProvider is set', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_BODY));
    const client = makeOpenRouterOrchestratorClient('or-secret', undefined, 'baseten', {
      fetchImpl,
    });

    await client.complete({ system: 'sys', user: 'usr' });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.provider).toEqual({ order: ['baseten'], allow_fallbacks: false });
  });

  it('retries on one 503 then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
    const client = makeOpenRouterOrchestratorClient('or-secret', undefined, undefined, {
      fetchImpl,
      maxRetries: 2,
    });

    const result = await client.complete({ system: 'sys', user: 'usr' });
    expect(result.text).toBe('<load doc="entity/luna"/>');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries on persistent 503', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
    const client = makeOpenRouterOrchestratorClient('or-secret', undefined, undefined, {
      fetchImpl,
      maxRetries: 1,
    });

    await expect(client.complete({ system: 'sys', user: 'usr' })).rejects.toThrow(
      /orchestrator http 503/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });

  it('retries on a network throw', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
    const client = makeOpenRouterOrchestratorClient('or-secret', undefined, undefined, {
      fetchImpl,
      maxRetries: 1,
    });

    const result = await client.complete({ system: 'sys', user: 'usr' });
    expect(result.text).toBe('<load doc="entity/luna"/>');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
