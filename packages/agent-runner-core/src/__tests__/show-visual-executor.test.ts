import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@ax/ipc-protocol';
import { createShowVisualExecutor } from '../show-visual-executor.js';

// The executor's input is model output. Every refusal below must happen before
// a single byte crosses to the host, so each case also asserts blob.put was
// never called.

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const ID = 'f'.repeat(32);
const client = () => ({
  callBinaryUpload: vi.fn(async (_a: string, b: Uint8Array) => ({
    sha256: sha(Buffer.from(b).toString('utf8')),
    size: b.byteLength,
  })),
  call: vi.fn(async () => ({ artifactId: ID, downloadUrl: `ax://artifact/${ID}` })),
});
const run = (c: ReturnType<typeof client>, input: unknown, conversationId: string | null = 'conv-1') =>
  createShowVisualExecutor({ client: c, conversationId })({
    id: 'toolu_v',
    name: 'show_visual',
    input,
  } as ToolCall);
const HTML =
  '<canvas id="c"></canvas><script>new Chart(c,{type:"bar",data:{labels:["a"],datasets:[{data:[1]}]}})</script>';

describe('createShowVisualExecutor', () => {
  it('publishes the html as a text/html artifact and returns only id, title and summary', async () => {
    const c = client();
    expect(
      await run(c, { title: ' Issues per cycle ', summary: 'Down 12% over 20 cycles.', html: HTML }),
    ).toStrictEqual({ artifactId: ID, title: 'Issues per cycle', summary: 'Down 12% over 20 cycles.' });
    expect(c.callBinaryUpload).toHaveBeenCalledWith('blob.put', Buffer.from(HTML, 'utf8'));
    expect(c.call).toHaveBeenCalledWith('artifact.publish', {
      conversationId: 'conv-1',
      sha256: sha(HTML),
      path: `visuals/${sha(HTML)}.html`,
      displayName: 'visual.html',
      mediaType: 'text/html',
      size: Buffer.byteLength(HTML),
    });
  });

  it('accepts exactly 102400 bytes and refuses 102401 before any IPC', async () => {
    await expect(run(client(), { title: 't', summary: 's', html: 'a'.repeat(102_400) })).resolves.toBeDefined();
    const c = client();
    await expect(run(c, { title: 't', summary: 's', html: 'a'.repeat(102_401) })).rejects.toThrow(
      /102401 bytes, over the 100 KB limit/,
    );
    expect(c.callBinaryUpload).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes, not characters', async () => {
    await expect(run(client(), { title: 't', summary: 's', html: '€'.repeat(34_134) })).rejects.toThrow(
      /over the 100 KB limit/,
    );
  });

  it.each([
    [{ summary: 's', html: 'h' }, /title is required/],
    [{ title: '  ', summary: 's', html: 'h' }, /title is required/],
    [{ title: 'a\nb', summary: 's', html: 'h' }, /single line/],
    [{ title: 'x'.repeat(121), summary: 's', html: 'h' }, /title is too long/],
    [{ title: 't', html: 'h' }, /summary is required/],
    [{ title: 't', summary: 'x'.repeat(1001), html: 'h' }, /summary is too long/],
    [{ title: 't', summary: 's', html: '   ' }, /html is required/],
    [{ title: 't', summary: 's', html: 7 }, /html is required/],
  ])('refuses %j before any IPC', async (input, msg) => {
    const c = client();
    await expect(run(c, input)).rejects.toThrow(msg);
    expect(c.callBinaryUpload).not.toHaveBeenCalled();
  });

  it('refuses when the session has no conversation', async () => {
    const c = client();
    await expect(run(c, { title: 't', summary: 's', html: 'h' }, null)).rejects.toThrow(
      /not attached to a conversation/,
    );
    expect(c.callBinaryUpload).not.toHaveBeenCalled();
  });
});
