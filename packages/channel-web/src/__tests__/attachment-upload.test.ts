// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachmentRefBlock,
  AttachmentUploadError,
  uploadAttachment,
} from '../lib/attachment-upload';

const ORIG_XHR = globalThis.XMLHttpRequest;

interface MockXhrScript {
  status?: number;
  responseText?: string;
  outcome?: 'load' | 'error' | 'timeout' | 'abort';
}

let lastXhr: MockXhr | undefined;

class MockXhr {
  upload = { onprogress: null as null | ((e: ProgressEvent) => void) };
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;
  ontimeout: null | (() => void) = null;
  onabort: null | (() => void) = null;
  responseText = '';
  status = 0;
  withCredentials = false;
  timeout = 0;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  static script: MockXhrScript = { status: 200, responseText: '{}', outcome: 'load' };

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
    const script = MockXhr.script;
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
      this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 } as ProgressEvent);
      if (script.outcome === 'error') {
        this.onerror?.();
        return;
      }
      if (script.outcome === 'timeout') {
        this.ontimeout?.();
        return;
      }
      if (script.outcome === 'abort') {
        this.onabort?.();
        return;
      }
      this.status = script.status ?? 200;
      this.responseText = script.responseText ?? '{}';
      this.onload?.();
    }, 0);
  }
}

/*
 * The stub the code under test calls `new` on. A plain factory rather than
 * `MockXhr` itself, because recording the instance from inside the class
 * constructor would mean assigning `this` to an outer binding — which is what
 * `@typescript-eslint/no-this-alias` exists to stop. A constructor that
 * returns an object hands that object back from `new`, so this is the same
 * thing without the alias.
 */
const MockXhrCtor = function MockXhrCtor() {
  const instance = new MockXhr();
  lastXhr = instance;
  return instance;
} as unknown as { new (): MockXhr };

beforeEach(() => {
  (globalThis as unknown as { XMLHttpRequest: typeof MockXhr }).XMLHttpRequest =
    MockXhrCtor as unknown as typeof MockXhr;
  MockXhr.script = { status: 200, responseText: '{}', outcome: 'load' };
  lastXhr = undefined;
});
afterEach(() => {
  (globalThis as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest =
    ORIG_XHR;
});

function file(): File {
  return new File(['fake bytes'], 'report.pdf', { type: 'application/pdf' });
}

describe('uploadAttachment', () => {
  it('resolves to the exact AttachmentUploadResult fields on a 200 with valid JSON', async () => {
    MockXhr.script = {
      status: 200,
      responseText: JSON.stringify({
        attachmentId: 'att-123',
        sizeBytes: 100,
        mediaType: 'application/pdf',
        displayName: 'report.pdf',
        expiresAt: '2026-05-18T12:00:00Z',
      }),
      outcome: 'load',
    };
    const result = await uploadAttachment(file());
    expect(result).toEqual({
      attachmentId: 'att-123',
      sizeBytes: 100,
      mediaType: 'application/pdf',
      displayName: 'report.pdf',
      expiresAt: '2026-05-18T12:00:00Z',
    });
  });

  it('reports progress fractions via onProgress from upload.onprogress', async () => {
    MockXhr.script = {
      status: 200,
      responseText: JSON.stringify({
        attachmentId: 'att-1',
        sizeBytes: 1,
        mediaType: 'text/plain',
        displayName: 'x.txt',
        expiresAt: 't',
      }),
      outcome: 'load',
    };
    const fractions: number[] = [];
    await uploadAttachment(file(), { onProgress: (f) => fractions.push(f) });
    expect(fractions).toEqual([0.5, 1]);
  });

  it('rejects with kind=http, status=415, message from JSON error body on 415', async () => {
    MockXhr.script = {
      status: 415,
      responseText: JSON.stringify({ error: 'unsupported-media-type' }),
      outcome: 'load',
    };
    await expect(uploadAttachment(file())).rejects.toMatchObject({
      kind: 'http',
      status: 415,
      message: 'unsupported-media-type',
    });
    await expect(uploadAttachment(file())).rejects.toBeInstanceOf(
      AttachmentUploadError,
    );
  });

  it('rejects with kind=http, status=500, message="upload failed (500)" on non-JSON body', async () => {
    MockXhr.script = { status: 500, responseText: 'internal server error', outcome: 'load' };
    await expect(uploadAttachment(file())).rejects.toMatchObject({
      kind: 'http',
      status: 500,
      message: 'upload failed (500)',
    });
  });

  it('rejects with kind=malformed on a 200 with unparseable body', async () => {
    MockXhr.script = { status: 200, responseText: 'not json{{{', outcome: 'load' };
    let caught: unknown;
    try {
      await uploadAttachment(file());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AttachmentUploadError);
    const err = caught as AttachmentUploadError;
    expect(err.kind).toBe('malformed');
    expect(err.status).toBe(200);
    // message is preserved from the underlying JSON.parse error, not a fixed string.
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('rejects with kind=network, status=null, message="upload failed" on xhr.onerror', async () => {
    MockXhr.script = { outcome: 'error' };
    await expect(uploadAttachment(file())).rejects.toMatchObject({
      kind: 'network',
      status: null,
      message: 'upload failed',
    });
  });

  it('rejects with kind=timeout, status=null, message="upload timed out" on xhr.ontimeout', async () => {
    MockXhr.script = { outcome: 'timeout' };
    await expect(uploadAttachment(file())).rejects.toMatchObject({
      kind: 'timeout',
      status: null,
      message: 'upload timed out',
    });
  });

  it('rejects with kind=aborted, status=null, message="upload aborted" on xhr.onabort', async () => {
    MockXhr.script = { outcome: 'abort' };
    await expect(uploadAttachment(file())).rejects.toMatchObject({
      kind: 'aborted',
      status: null,
      message: 'upload aborted',
    });
  });

  it('POSTs to /api/attachments with a FormData body, withCredentials, and X-Requested-With', async () => {
    MockXhr.script = {
      status: 200,
      responseText: JSON.stringify({
        attachmentId: 'att-9',
        sizeBytes: 1,
        mediaType: 'application/pdf',
        displayName: 'report.pdf',
        expiresAt: 't',
      }),
      outcome: 'load',
    };
    await uploadAttachment(file());
    expect(lastXhr).toBeDefined();
    expect(lastXhr!.method).toBe('POST');
    expect(lastXhr!.url).toBe('/api/attachments');
    expect(lastXhr!.withCredentials).toBe(true);
    expect(lastXhr!.headers['X-Requested-With']).toBe('ax-admin');
    expect(lastXhr!.body).toBeInstanceOf(FormData);
  });
});

describe('attachmentRefBlock', () => {
  it('builds the single canonical attachment_ref block shape', () => {
    expect(attachmentRefBlock('a1')).toEqual({
      type: 'attachment_ref',
      attachmentId: 'a1',
    });
  });
});
