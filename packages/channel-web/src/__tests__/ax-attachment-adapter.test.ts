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
  it('yields a running-pending and then a requires-action state on success', async () => {
    const adapter = new AxAttachmentAdapter();
    const file = new File(['fake bytes'], 'report.pdf', { type: 'application/pdf' });
    const states: unknown[] = [];
    for await (const state of adapter.add({ file })) {
      states.push(state);
    }
    expect(states.length).toBeGreaterThanOrEqual(2);
    const last = states[states.length - 1] as { id: string; status: { type: string } };
    expect(last.id).toBe('att-123');
    expect(last.status.type).toBe('requires-action');
  });

  it('send() returns a CompleteAttachment with an ax://attachment URL', async () => {
    const adapter = new AxAttachmentAdapter();
    const pending = {
      id: 'att-123',
      type: 'document' as const,
      name: 'report.pdf',
      contentType: 'application/pdf',
      file: new File(['x'], 'report.pdf', { type: 'application/pdf' }),
      status: { type: 'requires-action' as const, reason: 'composer-send' as const },
    };
    const result = await adapter.send(pending);
    expect(result.id).toBe('att-123');
    expect(result.status.type).toBe('complete');
    expect(result.content).toHaveLength(1);
    const part = result.content[0] as {
      type: string;
      data: string;
      mimeType: string;
      filename: string;
    };
    expect(part.type).toBe('file');
    expect(part.data).toBe('ax://attachment/att-123');
    expect(part.mimeType).toBe('application/pdf');
    expect(part.filename).toBe('report.pdf');
  });

  it('remove() is a no-op', async () => {
    const adapter = new AxAttachmentAdapter();
    await expect(adapter.remove({} as never)).resolves.toBeUndefined();
  });
});
