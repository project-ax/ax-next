// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { makeAgentContext, type Plugin } from '@ax/core';
import { createHttpServerPlugin } from '@ax/http-server';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import {
  downloadContentType,
  registerAttachmentsRoutes,
} from '../../server/routes-attachments.js';

// ---------------------------------------------------------------------------
// GET /api/files serves agent-authored bytes on the app origin. Anything a
// browser would run as a document (html, xhtml, svg, xml) must come back as
// an opaque octet-stream download, never as itself.
//
// No Postgres here: attachments:download is a stub, so this file runs without
// Docker (routes-attachments.test.ts boots a container in beforeAll).
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
const ALLOWED_ORIGIN = 'https://app.example.com';
const PLUGIN_NAME = '@ax/channel-web-tests';

const harnesses: TestHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
});

function authMockPlugin(user: { id: string; isAdmin: boolean }): Plugin {
  return {
    manifest: {
      name: 'mock-auth',
      version: '0.0.0',
      registers: ['auth:require-user'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('auth:require-user', 'mock-auth', async () => ({ user }));
    },
  };
}

function downloadStubPlugin(out: {
  bytes: Buffer;
  mediaType: string;
  sizeBytes: number;
  displayName: string;
}): Plugin {
  return {
    manifest: {
      name: 'test-download-stub',
      version: '0.0.0',
      registers: ['attachments:download'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('attachments:download', 'test-download-stub', async () => out);
    },
  };
}

async function bootWithDownload(out: {
  bytes: Buffer;
  mediaType: string;
  sizeBytes: number;
  displayName: string;
}): Promise<number> {
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [ALLOWED_ORIGIN],
  });
  const harness = await createTestHarness({
    plugins: [http, authMockPlugin({ id: 'u1', isAdmin: false }), downloadStubPlugin(out)],
  });
  harnesses.push(harness);
  await registerAttachmentsRoutes(
    harness.bus,
    makeAgentContext({ sessionId: 'test-init', agentId: PLUGIN_NAME, userId: 'system' }),
  );
  return http.boundPort();
}

describe('downloadContentType', () => {
  it.each([
    ['text/html', 'application/octet-stream'],
    ['TEXT/HTML; charset=utf-8', 'application/octet-stream'],
    ['application/xhtml+xml', 'application/octet-stream'],
    ['image/svg+xml', 'application/octet-stream'],
    ['text/xml', 'application/octet-stream'],
    ['application/xml', 'application/octet-stream'],
    ['text/plain', 'text/plain'],
    ['application/pdf', 'application/pdf'],
    ['image/png', 'image/png'],
  ])('%s → %s', (input, expected) => expect(downloadContentType(input)).toBe(expected));
});

describe('@ax/channel-web GET /api/files — active content', () => {
  it('(VISUALS-1) GET /api/files serves a text/html row as an octet-stream attachment', async () => {
    const port = await bootWithDownload({
      bytes: Buffer.from('<p>x</p>'),
      mediaType: 'text/html',
      sizeBytes: 8,
      displayName: 'visual.html',
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/files?conversationId=c1&id=att-1`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^application\/octet-stream(;|$)/);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="visual.html"');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await r.text()).toBe('<p>x</p>');
  });

  it('keeps a passive media type as itself', async () => {
    const port = await bootWithDownload({
      bytes: Buffer.from('hello'),
      mediaType: 'text/plain',
      sizeBytes: 5,
      displayName: 'hi.txt',
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/files?conversationId=c1&id=att-1`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/plain(;|$)/);
    expect(await r.text()).toBe('hello');
  });
});

