// @vitest-environment jsdom
/**
 * `useWorkspaceAttachments()` — the agent-workspace composer's attachment
 * state (TASK-353).
 *
 * The workspace surface deliberately does not mount assistant-ui's
 * `AssistantRuntimeProvider`, so chat's `AttachmentAdapter` / `useAttachment`
 * machinery is unreachable there. This hook is the plain-React equivalent, and
 * the two behaviours worth guarding hardest are:
 *
 *  1. A file that did not upload MUST NOT be silently dropped from the send.
 *     `sendable` is asserted as an exact id array everywhere below, because
 *     a leaked-in id is how "we sent your message without your file" happens.
 *  2. The upload endpoint's JSON `{error}` string MUST NOT reach the DOM.
 *     `attachmentFailureSentence` maps through a fixed lookup; the
 *     `not.toContain('unsupported-media-type')` assertion is the guard, and it
 *     fails the moment somebody renders `err.message` instead.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  HTTP_FAILED,
  httpErrorMessage,
} from '@/lib/http';
import {
  AttachmentUploadError,
  uploadAttachment,
  type AttachmentUploadResult,
} from '@/lib/attachment-upload';
import {
  ATTACHMENT_FAILED_MALFORMED,
  ATTACHMENT_SEND_BLOCKED_FAILED,
  ATTACHMENT_SEND_BLOCKED_UPLOADING,
  attachmentFailureSentence,
  useWorkspaceAttachments,
} from '@/lib/workspace-attachments';

vi.mock('@/lib/attachment-upload', async (importOriginal) => {
  // Only `uploadAttachment` is faked. `AttachmentUploadError` stays the REAL
  // class so the hook's `instanceof` narrowing is exercised rather than
  // sidestepped by a look-alike.
  const actual =
    await importOriginal<typeof import('@/lib/attachment-upload')>();
  return { ...actual, uploadAttachment: vi.fn() };
});

const upload = vi.mocked(uploadAttachment);

/** One in-flight upload we drive by hand. */
interface Pending {
  file: File;
  resolve: (r: AttachmentUploadResult) => void;
  reject: (e: unknown) => void;
  progress: (fraction: number) => void;
}

/** Every upload the hook started, in call order. */
let pending: Pending[] = [];

function armUploads(): void {
  pending = [];
  // `mockReset` clears the call history as well as the implementation. Without
  // it the counts leak across tests and `toHaveBeenCalledTimes(1)` starts
  // reading the whole file's uploads.
  upload.mockReset();
  upload.mockImplementation((file, opts) => {
    let resolve!: (r: AttachmentUploadResult) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<AttachmentUploadResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pending.push({
      file,
      resolve,
      reject,
      progress: (fraction) => opts?.onProgress?.(fraction),
    });
    return promise;
  });
}

function serverResult(attachmentId: string): AttachmentUploadResult {
  return {
    attachmentId,
    sizeBytes: 12,
    mediaType: 'text/plain',
    displayName: 'notes.txt',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

const textFile = (name = 'notes.txt') =>
  new File(['hello'], name, { type: 'text/plain' });

/**
 * A stand-in for the `FileList` an `<input type="file">` hands over. jsdom
 * does not let us build a real one (no working `DataTransfer.items.add`), and
 * the shape is all the hook is allowed to depend on: `length` plus indices.
 */
function fileList(...files: File[]): FileList {
  const list: Record<number | string, unknown> = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
  };
  files.forEach((f, i) => {
    list[i] = f;
  });
  return list as unknown as FileList;
}

/** Flush the microtask that a resolved/rejected upload continues on. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  armUploads();
});

/**
 * The ids `sendable` carries, in order. TASK-424 widened that list from bare
 * ids to `{ attachmentId, displayName, mediaType }` — the composer's chips are
 * gone by the time the transcript has to name the file, so the name travels
 * with the id. Every assertion below is about WHICH files are sendable and in
 * what order, which is the ids, so they read through this rather than being
 * rewritten into object literals that would hide the ordering they pin.
 */
function sendableIds(v: { sendable: readonly { attachmentId: string }[] }): string[] {
  return v.sendable.map((a) => a.attachmentId);
}

describe('useWorkspaceAttachments — the happy path', () => {
  it('shows an uploading chip immediately, then the server-minted id', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    const file = textFile();

    act(() => result.current.add([file]));

    expect(result.current.attachments).toHaveLength(1);
    const chip = result.current.attachments[0]!;
    expect(chip.status).toBe('uploading');
    expect(chip.progress).toBe(0);
    expect(chip.name).toBe('notes.txt');
    expect(chip.contentType).toBe('text/plain');
    expect(chip.attachmentId).toBeNull();
    expect(chip.message).toBeNull();
    // Nothing is sendable yet — an id here would be an id for a file the
    // server has not acknowledged.
    expect(sendableIds(result.current)).toEqual([]);
    expect(result.current.sendBlock).toBe(ATTACHMENT_SEND_BLOCKED_UPLOADING);

    await act(async () => {
      pending[0]!.resolve(serverResult('att-1'));
    });

    await waitFor(() =>
      expect(result.current.attachments[0]!.status).toBe('uploaded'),
    );
    expect(result.current.attachments[0]!.attachmentId).toBe('att-1');
    expect(result.current.attachments[0]!.message).toBeNull();
    expect(sendableIds(result.current)).toEqual(['att-1']);
    expect(result.current.sendBlock).toBeNull();
  });

  it('keeps a file with no MIME type sendable as a generic binary', () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([new File(['x'], 'mystery', { type: '' })]));
    expect(result.current.attachments[0]!.contentType).toBe(
      'application/octet-stream',
    );
  });

  it('moves progress as the upload reports it', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile()]));
    expect(result.current.attachments[0]!.progress).toBe(0);

    act(() => pending[0]!.progress(0.42));
    expect(result.current.attachments[0]!.progress).toBeCloseTo(0.42, 5);

    act(() => pending[0]!.progress(0.9));
    expect(result.current.attachments[0]!.progress).toBeCloseTo(0.9, 5);
  });

  it('sends ids in pick order, not upload-completion order', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile('first.txt'), textFile('second.txt')]));
    expect(result.current.attachments.map((a) => a.name)).toEqual([
      'first.txt',
      'second.txt',
    ]);

    // Second finishes FIRST. Order must still follow the picker.
    await act(async () => {
      pending[1]!.resolve(serverResult('att-second'));
      pending[0]!.resolve(serverResult('att-first'));
    });
    await waitFor(() =>
      expect(sendableIds(result.current)).toHaveLength(2),
    );
    expect(sendableIds(result.current)).toEqual(['att-first', 'att-second']);
  });

  it('accepts a FileList, which is what a real <input type=file> hands over', () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add(fileList(textFile('picked.txt'))));
    expect(result.current.attachments.map((a) => a.name)).toEqual([
      'picked.txt',
    ]);
  });
});

describe('useWorkspaceAttachments — a failed upload', () => {
  it('marks the chip failed and keeps its id out of the send', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile()]));

    await act(async () => {
      pending[0]!.reject(
        new AttachmentUploadError('unsupported-media-type', 'http', 415),
      );
    });

    await waitFor(() =>
      expect(result.current.attachments[0]!.status).toBe('failed'),
    );
    const chip = result.current.attachments[0]!;
    expect(chip.attachmentId).toBeNull();
    expect(chip.message).toBe(
      "We can't send that kind of file. Try a PDF, an image, a text or CSV file, or a zip.",
    );
    // THE assertion: an exact empty array. `toHaveLength(0)` would pass for a
    // hook that had already dropped the chip entirely; this pins both.
    expect(sendableIds(result.current)).toEqual([]);
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.sendBlock).toBe(ATTACHMENT_SEND_BLOCKED_FAILED);
  });

  it('never puts the server’s own error string on the chip', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile()]));
    await act(async () => {
      pending[0]!.reject(
        new AttachmentUploadError('unsupported-media-type', 'http', 415),
      );
    });
    await waitFor(() =>
      expect(result.current.attachments[0]!.message).toBeTruthy(),
    );
    expect(result.current.attachments[0]!.message).not.toContain(
      'unsupported-media-type',
    );
  });
});

describe('attachmentFailureSentence', () => {
  const http = (status: number, message = 'unsupported-media-type') =>
    new AttachmentUploadError(message, 'http', status);

  it('415 explains which kinds of file work', () => {
    const sentence = attachmentFailureSentence(http(415));
    expect(sentence).toBe(
      "We can't send that kind of file. Try a PDF, an image, a text or CSV file, or a zip.",
    );
    // The security guard. A hook that returned `err.message` would pass every
    // other assertion in this file and fail exactly here.
    expect(sentence).not.toContain('unsupported-media-type');
  });

  it('413 names the limit', () => {
    expect(attachmentFailureSentence(http(413, 'payload-too-large'))).toBe(
      'That file is too big to send. The limit is 25 MB.',
    );
  });

  it('429 says what to do about it', () => {
    expect(attachmentFailureSentence(http(429, 'rate-limited'))).toBe(
      'There are too many uploads waiting. Send or remove one of these first, then try again.',
    );
  });

  it('reuses the shared HTTP copy for every other status', () => {
    // Not a second set of 5xx/401/403 sentences — the same ones the rest of
    // the SPA already prints.
    expect(attachmentFailureSentence(http(500, 'kaboom'))).toBe(
      httpErrorMessage(500),
    );
    expect(attachmentFailureSentence(http(401))).toBe(httpErrorMessage(401));
    expect(attachmentFailureSentence(http(403))).toBe(httpErrorMessage(403));
  });

  it('timeout and abort read differently, because they are different events', () => {
    expect(
      attachmentFailureSentence(
        new AttachmentUploadError('upload timed out', 'timeout', null),
      ),
    ).toBe('That upload took too long and stopped. Try again.');
    expect(
      attachmentFailureSentence(
        new AttachmentUploadError('upload aborted', 'aborted', null),
      ),
    ).toBe('That upload stopped before it finished. Try again.');
  });

  it('a malformed answer says the bytes went up', () => {
    expect(
      attachmentFailureSentence(
        new AttachmentUploadError('Unexpected token <', 'malformed', 200),
      ),
    ).toBe(
      "The file went up, but we could not read the server's answer. Try again.",
    );
  });

  it('a network failure, and anything we do not recognise, fall back to the shared sentence', () => {
    expect(
      attachmentFailureSentence(
        new AttachmentUploadError('upload failed', 'network', null),
      ),
    ).toBe(HTTP_FAILED);
    expect(attachmentFailureSentence(new Error('boom'))).toBe(HTTP_FAILED);
    expect(attachmentFailureSentence(new Error('boom'))).not.toContain('boom');
    expect(attachmentFailureSentence(undefined)).toBe(HTTP_FAILED);
    expect(attachmentFailureSentence('a bare string')).toBe(HTTP_FAILED);
  });
});

describe('useWorkspaceAttachments — retry', () => {
  it('re-uploads the same File under the same id and clears the message', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    const file = textFile();
    act(() => result.current.add([file]));
    const id = result.current.attachments[0]!.id;

    await act(async () => {
      pending[0]!.reject(
        new AttachmentUploadError('upload failed', 'network', null),
      );
    });
    await waitFor(() =>
      expect(result.current.attachments[0]!.status).toBe('failed'),
    );
    expect(upload).toHaveBeenCalledTimes(1);

    act(() => result.current.retry(id));

    expect(upload).toHaveBeenCalledTimes(2);
    // Same bytes — the person does not re-pick the file. Identity, not a
    // reconstructed stand-in.
    expect(pending[1]!.file).toBe(file);
    const chip = result.current.attachments[0]!;
    expect(chip.id).toBe(id); // stable, so the chip does not jump
    expect(chip.status).toBe('uploading');
    expect(chip.progress).toBe(0);
    expect(chip.message).toBeNull();

    await act(async () => pending[1]!.resolve(serverResult('att-retry')));
    await waitFor(() =>
      expect(sendableIds(result.current)).toEqual(['att-retry']),
    );
  });

  it('is a no-op for an id that is not failed', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile()]));
    const id = result.current.attachments[0]!.id;
    act(() => result.current.retry(id)); // still uploading
    expect(upload).toHaveBeenCalledTimes(1);
    act(() => result.current.retry('no-such-id'));
    expect(upload).toHaveBeenCalledTimes(1);
  });
});

describe('useWorkspaceAttachments — remove', () => {
  it('drops the chip', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile()]));
    const id = result.current.attachments[0]!.id;
    act(() => result.current.remove(id));
    expect(result.current.attachments).toEqual([]);
    expect(sendableIds(result.current)).toEqual([]);
    expect(result.current.sendBlock).toBeNull();
  });

  it('a late upload for a removed chip does not resurrect it', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile()]));
    const id = result.current.attachments[0]!.id;
    act(() => result.current.remove(id));

    await act(async () => pending[0]!.resolve(serverResult('att-ghost')));
    await settle();

    expect(result.current.attachments).toEqual([]);
    expect(sendableIds(result.current)).toEqual([]);
  });

  it('a late upload for a removed chip does not clobber a surviving one', async () => {
    // The discriminating version: a positional write (`next[i] = …`) rather
    // than an id lookup survives the single-chip case above and dies here.
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile('doomed.txt'), textFile('kept.txt')]));
    const doomedId = result.current.attachments[0]!.id;
    const keptId = result.current.attachments[1]!.id;

    act(() => result.current.remove(doomedId));
    await act(async () => pending[0]!.resolve(serverResult('att-ghost')));
    await settle();

    expect(result.current.attachments.map((a) => a.id)).toEqual([keptId]);
    expect(result.current.attachments[0]!.name).toBe('kept.txt');
    expect(result.current.attachments[0]!.status).toBe('uploading');
    expect(sendableIds(result.current)).toEqual([]);

    await act(async () => pending[1]!.resolve(serverResult('att-kept')));
    await waitFor(() =>
      expect(sendableIds(result.current)).toEqual(['att-kept']),
    );
  });

  it('a late FAILURE for a removed chip does not resurrect it either', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile()]));
    const id = result.current.attachments[0]!.id;
    act(() => result.current.remove(id));

    await act(async () => {
      pending[0]!.reject(
        new AttachmentUploadError('upload failed', 'network', null),
      );
    });
    await settle();

    expect(result.current.attachments).toEqual([]);
    expect(result.current.sendBlock).toBeNull();
  });
});

describe('useWorkspaceAttachments — sendBlock', () => {
  it('is null with nothing attached', () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    expect(result.current.sendBlock).toBeNull();
  });

  it('reports the wait while an upload is in flight', () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile()]));
    expect(result.current.sendBlock).toBe(ATTACHMENT_SEND_BLOCKED_UPLOADING);
  });

  it('prefers the failure over the wait, because the failure needs a decision', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile('bad.txt'), textFile('slow.txt')]));

    await act(async () => {
      pending[0]!.reject(
        new AttachmentUploadError('unsupported-media-type', 'http', 415),
      );
    });
    await waitFor(() =>
      expect(result.current.attachments[0]!.status).toBe('failed'),
    );
    // Second is still uploading — the failure still wins.
    expect(result.current.attachments[1]!.status).toBe('uploading');
    expect(result.current.sendBlock).toBe(ATTACHMENT_SEND_BLOCKED_FAILED);
  });

  it('clears once everything has landed', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile('a.txt'), textFile('b.txt')]));
    await act(async () => {
      pending[0]!.resolve(serverResult('att-a'));
      pending[1]!.resolve(serverResult('att-b'));
    });
    await waitFor(() =>
      expect(sendableIds(result.current)).toEqual(['att-a', 'att-b']),
    );
    expect(result.current.sendBlock).toBeNull();
  });

  it('the two sentences are distinct and say what to do', () => {
    // Exported so the composer's own tests can match them without copying the
    // prose — a copy is how the two drift.
    expect(ATTACHMENT_SEND_BLOCKED_FAILED).not.toBe(
      ATTACHMENT_SEND_BLOCKED_UPLOADING,
    );
    expect(ATTACHMENT_SEND_BLOCKED_FAILED).toBe(
      'One of these files did not upload. Retry it or remove it before sending — otherwise we would send your message without the file.',
    );
    expect(ATTACHMENT_SEND_BLOCKED_UPLOADING).toBe(
      'Still uploading. Give it a second so your file goes with the message.',
    );
  });
});

describe('useWorkspaceAttachments — clear', () => {
  it('empties the chips and the ids', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile('a.txt'), textFile('b.txt')]));
    await act(async () => {
      pending[0]!.resolve(serverResult('att-a'));
      pending[1]!.resolve(serverResult('att-b'));
    });
    await waitFor(() =>
      expect(sendableIds(result.current)).toEqual(['att-a', 'att-b']),
    );

    act(() => result.current.clear());

    expect(result.current.attachments).toEqual([]);
    expect(sendableIds(result.current)).toEqual([]);
    expect(result.current.sendBlock).toBeNull();
  });

  it('leaves nothing behind that a later retry could re-upload', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add([textFile()]));
    const id = result.current.attachments[0]!.id;
    act(() => result.current.clear());
    act(() => result.current.retry(id));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(result.current.attachments).toEqual([]);
  });
});

/*
  A 200 THAT DOES NOT CARRY AN ID IS A FAILED UPLOAD, not a ready one.

  The SHAPE CHECK LIVES IN `uploadAttachment` (both surfaces share it, so a
  guard in this hook alone would have left chat's adapter holding the unchecked
  body — see `attachment-upload.test.ts` for the body shapes it refuses). What
  is pinned here is what this hook does with the resulting rejection: tolerating
  a missing id is only allowed if what renders is still something a person can
  act on, and "Ready to send" over nothing to send is the opposite.

  Against a hook that ignored `kind: 'malformed'` — or reported it as a generic
  failure — the message assertion fails; against one that let the chip settle as
  `uploaded`, all four do.
*/
describe('useWorkspaceAttachments — a response with no attachment id', () => {
  it('fails the chip instead of calling it ready, and keeps the id off the wire', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add(fileList(textFile())));
    await waitFor(() => expect(pending).toHaveLength(1));

    act(() => {
      pending[0]!.reject(
        new AttachmentUploadError('missing attachmentId', 'malformed', 200),
      );
    });
    await settle();

    await waitFor(() =>
      expect(result.current.attachments[0]?.status).toBe('failed'),
    );
    expect(result.current.attachments[0]?.message).toBe(
      ATTACHMENT_FAILED_MALFORMED,
    );
    expect(sendableIds(result.current)).toEqual([]);
    // And the send is held, so the message cannot leave without it.
    expect(result.current.sendBlock).toBe(ATTACHMENT_SEND_BLOCKED_FAILED);
  });

  /*
    THE LAST LINE BEFORE THE WIRE, kept even though `uploadAttachment` now
    refuses these bodies upstream. `attachmentIds` is what the composer posts,
    and `!== null` would wave an `undefined` through — so this asserts the
    filter is a type check rather than a null check, independently of whoever
    is guarding above it.
  */
  it('never puts a non-string id on the wire, whatever settled the chip', async () => {
    const { result } = renderHook(() => useWorkspaceAttachments());
    act(() => result.current.add(fileList(textFile())));
    await waitFor(() => expect(pending).toHaveLength(1));

    act(() => {
      pending[0]!.resolve({
        ...serverResult('ignored'),
        attachmentId: undefined as unknown as string,
      });
    });
    await settle();

    expect(sendableIds(result.current)).toEqual([]);
  });
});
