import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateCsrf } from '@ax/http-server';
import { conversationControls } from '../conversation-controls';

// Exercise the actual client through the real CSRF rule. The unit route
// harness alone cannot catch requests refused before the handler runs.
afterEach(() => vi.unstubAllGlobals());

describe('conversation controls through the CSRF guard', () => {
  it.each(['create', 'rename', 'delete'] as const)(
    '%s supplies the required write headers on an authenticated request',
    async (action) => {
      const fetchMock = vi.fn(async (_path: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        headers.set('origin', 'http://localhost:9090');
        const rejection = evaluateCsrf(init.method!, Object.fromEntries(headers), { allowedOrigins: [] });
        if (rejection) return new Response(JSON.stringify({ error: rejection.reason }), { status: 403 });
        if (action === 'create') return new Response(JSON.stringify({ conversationId: 'new-conversation' }), { status: 201 });
        return new Response(null, { status: 204 });
      });
      vi.stubGlobal('fetch', fetchMock);
      if (action === 'create') {
        await expect(conversationControls.create('inbox')).resolves.toEqual({ conversationId: 'new-conversation' });
      } else if (action === 'rename') {
        await expect(conversationControls.rename('conversation', 'A useful name')).resolves.toBeUndefined();
      } else {
        await expect(conversationControls.delete('conversation')).resolves.toBeUndefined();
      }
      const [, init] = fetchMock.mock.calls[0]!;
      expect(init.credentials).toBe('include');
      expect(new Headers(init.headers).get('x-requested-with')).toBe('ax-admin');
      if (action !== 'delete') {
        expect(new Headers(init.headers).get('content-type')).toBe('application/json');
        expect(JSON.parse(init.body as string)).toEqual(action === 'create'
          ? { agentId: 'inbox' } : { title: 'A useful name' });
      }
    },
  );
});
