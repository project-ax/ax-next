// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AxAttachmentAdapter } from '../lib/ax-attachment-adapter';

const ORIG_XHR = globalThis.XMLHttpRequest;

class MockXhr {
  upload = { onprogress: null as null | ((e: ProgressEvent) => void) };
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;
  responseText = '';
  status = 0;
  withCredentials = false;
  private headers: Record<string, string> = {};
  open(_method: string, _url: string) { /* noop */ }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(_body: unknown) {
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 } as ProgressEvent);
      this.status = 200;
      this.responseText = JSON.stringify({
        attachmentId: 'att-123',
        sizeBytes: 100,
        mediaType: 'application/pdf',
        displayName: 'report.pdf',
        expiresAt: '2026-05-18T12:00:00Z',
      });
      this.onload?.();
    }, 0);
  }
}

beforeEach(() => {
  (globalThis as unknown as { XMLHttpRequest: typeof MockXhr }).XMLHttpRequest =
    MockXhr;
});
afterEach(() => {
  (globalThis as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest =
    ORIG_XHR;
});

describe('AxAttachmentAdapter', () => {
  it('keeps the same id across both yields so assistant-ui sees one attachment, not two', async () => {
    const adapter = new AxAttachmentAdapter();
    const file = new File(['fake bytes'], 'report.pdf', { type: 'application/pdf' });
    const states: Array<{ id: string; status: { type: string } }> = [];
    for await (const state of adapter.add({ file })) {
      states.push(state as { id: string; status: { type: string } });
    }
    expect(states).toHaveLength(2);
    expect(states[0]!.id).toBe(states[1]!.id);
    expect(states[0]!.status.type).toBe('running');
    expect(states[1]!.status.type).toBe('requires-action');
  });

  it('send() rewrites pending.id to the server attachmentId in the ax:// URL', async () => {
    const adapter = new AxAttachmentAdapter();
    const file = new File(['fake bytes'], 'report.pdf', { type: 'application/pdf' });
    const states: Array<{ id: string; status: { type: string } }> = [];
    for await (const state of adapter.add({ file })) {
      states.push(state as { id: string; status: { type: string } });
    }
    const last = states[states.length - 1]!;
    const result = await adapter.send({
      id: last.id,
      type: 'document',
      name: 'report.pdf',
      contentType: 'application/pdf',
      file,
      status: { type: 'requires-action', reason: 'composer-send' },
    });
    expect(result.id).toBe(last.id); // assistant-ui's identity stays on the client-side tempId
    expect(result.status.type).toBe('complete');
    expect(result.content).toHaveLength(1);
    const part = result.content[0] as {
      type: string;
      data: string;
      mimeType: string;
      filename: string;
    };
    expect(part.type).toBe('file');
    // The wire URL carries the server-minted attachmentId (att-123), NOT the tempId.
    expect(part.data).toBe('ax://attachment/att-123');
    expect(part.mimeType).toBe('application/pdf');
    expect(part.filename).toBe('report.pdf');
  });

  it('send() falls back to pending.id when no server id was recorded (defensive)', async () => {
    const adapter = new AxAttachmentAdapter();
    const result = await adapter.send({
      id: 'detached-id',
      type: 'document',
      name: 'x.pdf',
      contentType: 'application/pdf',
      file: new File(['x'], 'x.pdf', { type: 'application/pdf' }),
      status: { type: 'requires-action', reason: 'composer-send' },
    });
    const part = result.content[0] as { data: string };
    expect(part.data).toBe('ax://attachment/detached-id');
  });

  it('remove() is a no-op', async () => {
    const adapter = new AxAttachmentAdapter();
    await expect(adapter.remove({} as never)).resolves.toBeUndefined();
  });
});
