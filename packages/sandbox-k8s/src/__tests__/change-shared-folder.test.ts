import { describe, expect, it, vi } from 'vitest';
import { makeAgentContext, PluginError } from '@ax/core';
import { WalkChangeError } from '@ax/user-files-read';
import type { ChangeSharedFolderInput } from '@ax/sandbox-mount-protocol';
import { resolveConfig, type SharedPoolConfig } from '../config.js';
import { changeSharedFolder } from '../change-shared-folder.js';
import type { StorageClient } from '../storage-client.js';

// W3c — sandbox:change-shared-folder for the k8s provider: validation, the
// bytes → base64 hand-off to the storage client, and refusal mapping.

const pool: SharedPoolConfig = { replicas: 1, prefix: 'pool', storageNamespace: 'storage', tlsDirectory: '/tls',
  serverName: 'storage.storage.svc', runnerBinaries: { 'claude-sdk': '/runner.js' }, userFiles: { server: '10.0.0.9', exportPath: '/files' } };
const base = resolveConfig({ hostIpcUrl: 'http://h:80', namespace: 'ax-test' });
const config = { ...base, sharedPool: pool };
const log = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' }).logger;

function client(reply: Awaited<ReturnType<StorageClient['changeShared']>> = { kind: 'done', results: [] }) {
  return { assign: vi.fn(), status: vi.fn(), release: vi.fn(), changeShared: vi.fn(async () => reply) };
}

describe('changeSharedFolder (k8s)', () => {
  it('answers unavailable without a shared pool, whatever the input', async () => {
    const c = client();
    expect(await changeSharedFolder(base, c, { folderId: '../x', changes: [] }, log)).toEqual({ kind: 'unavailable' });
    expect(await changeSharedFolder(base, undefined, { folderId: 'sf_a', changes: [] }, log)).toEqual({ kind: 'unavailable' });
    expect(c.changeShared).not.toHaveBeenCalled();
  });
  it('sends content as base64, only the known fields, and returns the results', async () => {
    const c = client({ kind: 'done', results: [{ path: 'a.md', outcome: 'written' }, { path: 'w', outcome: 'created' }, { path: 'x', outcome: 'deleted' }] });
    // A view into a larger buffer: only its own bytes may be sent.
    const backing = new Uint8Array([0, 104, 105, 0]);
    const input = { folderId: 'sf_a', createFolder: true, changes: [
      { op: 'write', path: 'a.md', content: backing.subarray(1, 3), ifMatch: 'a'.repeat(64), extra: 'dropped' },
      { op: 'mkdir', path: 'w', ifAbsent: true },
      { op: 'delete', path: 'x' },
    ] } as unknown as ChangeSharedFolderInput;
    const out = await changeSharedFolder(config, c, input, log);
    expect(out).toEqual({ kind: 'done', results: [{ path: 'a.md', outcome: 'written' }, { path: 'w', outcome: 'created' }, { path: 'x', outcome: 'deleted' }] });
    expect(c.changeShared).toHaveBeenCalledWith({ folderId: 'sf_a', createFolder: true, changes: [
      { op: 'write', path: 'a.md', content: Buffer.from('hi').toString('base64'), ifMatch: 'a'.repeat(64) },
      { op: 'mkdir', path: 'w', ifAbsent: true },
      { op: 'delete', path: 'x' },
    ] });
  });
  it.each([
    ['a bad folder id', { folderId: 'sf_../x', changes: [] }, 'invalid-change'],
    ['too many changes', { folderId: 'sf_a', changes: Array.from({ length: 65 }, () => ({ op: 'mkdir', path: 'a' })) }, 'too-many-changes'],
    ['a file over 10 MiB', { folderId: 'sf_a', changes: [{ op: 'write', path: 'a', content: new Uint8Array(10 * 1024 * 1024 + 1) }] }, 'too-large'],
    ['over 25 MiB in all', { folderId: 'sf_a', changes: [10, 10, 6].map(n => ({ op: 'write', path: 'a', content: new Uint8Array(n * 1024 * 1024) })) }, 'too-large'],
    ['string content', { folderId: 'sf_a', changes: [{ op: 'write', path: 'a', content: 'hi' }] }, 'invalid-change'],
    ['an unknown op', { folderId: 'sf_a', changes: [{ op: 'chmod', path: 'a' }] }, 'invalid-change'],
  ])('refuses %s before calling the node', async (_name, input, reasonCode) => {
    const c = client();
    await expect(changeSharedFolder(config, c, input as unknown as ChangeSharedFolderInput, log))
      .rejects.toMatchObject({ code: 'invalid-payload', reasonCode });
    expect(c.changeShared).not.toHaveBeenCalled();
  });
  it('maps a node refusal to invalid-payload with the code as reasonCode and the applied changes on the cause', async () => {
    const c = client({ kind: 'refused', refused: 'link-or-not-dir', results: [{ path: 'a', outcome: 'created' }] });
    const err = await changeSharedFolder(config, c, { folderId: 'sf_a', changes: [{ op: 'mkdir', path: 'a' }, { op: 'mkdir', path: 'l/b' }] }, log)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err).toMatchObject({ code: 'invalid-payload', reasonCode: 'link-or-not-dir', hookName: 'sandbox:change-shared-folder' });
    const cause = (err as PluginError).cause;
    expect(cause).toBeInstanceOf(WalkChangeError);
    expect((cause as WalkChangeError).applied).toEqual([{ path: 'a', outcome: 'created' }]);
  });
  it('maps invalid-path, a missing folder and a transport failure', async () => {
    await expect(changeSharedFolder(config, client({ kind: 'refused', refused: 'invalid-path', results: [] }),
      { folderId: 'sf_a', changes: [{ op: 'delete', path: '../x' }] }, log)).rejects.toMatchObject({ code: 'invalid-payload', reasonCode: 'invalid-path' });
    await expect(changeSharedFolder(config, client({ kind: 'refused', refused: 'missing-folder', results: [] }),
      { folderId: 'sf_a', changes: [] }, log)).rejects.toMatchObject({ code: 'shared-folder-missing', reasonCode: 'missing-folder' });
    const c = client(); c.changeShared.mockRejectedValueOnce(new Error('storage node is unavailable'));
    await expect(changeSharedFolder(config, c, { folderId: 'sf_a', changes: [] }, log))
      .rejects.toMatchObject({ code: 'shared-folder-change-failed' });
  });
});
