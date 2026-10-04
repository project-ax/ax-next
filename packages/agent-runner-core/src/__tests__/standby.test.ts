import { mkdtemp, writeFile, readFile, rename, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForAssignment } from '../standby.js';
import { scaffoldPythonVenv } from '../python-venv.js';

vi.mock('../python-venv.js', () => ({ scaffoldPythonVenv: vi.fn() }));
beforeEach(() => { vi.mocked(scaffoldPythonVenv).mockReset().mockResolvedValue(false); });

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ax-standby-')); roots.push(root);
  const env: NodeJS.ProcessEnv = { AX_STANDBY: '1', AX_INSTANCE_ID: randomUUID() };
  const assignment = { version: 1, assignmentId: randomUUID(), instanceId: env.AX_INSTANCE_ID,
    expiresAt: Date.now() + 60_000, env: { AX_SESSION_ID: 'session', AX_AUTH_TOKEN: 'private-token',
      AX_RUNNER_ENDPOINT: 'http://host:8080', AX_PROXY_ENDPOINT: 'http://proxy:8888',
      AX_PROXY_TOKEN: 'a'.repeat(32) } };
  // Publish the way the storage node does (storage-node/engine.ts): write a temp file, then
  // rename it into place. A plain writeFile creates session.json empty before the bytes land,
  // and a reader polling every 1ms can open it in that window — which the reader correctly
  // refuses (and consumes) as a torn assignment. That window was TASK-748's flake.
  const publish = async () => {
    const temp = join(root, 'session.tmp');
    await writeFile(temp, JSON.stringify(assignment), { mode: 0o600 });
    await rename(temp, join(root, 'session.json'));
  };
  return { root, env, assignment, publish };
}
describe('single-use standby activation', () => {
  it('leaves ordinary startup untouched', async () => {
    const env = { AX_AUTH_TOKEN: 'existing' }; await waitForAssignment({ env }); expect(env.AX_AUTH_TOKEN).toBe('existing');
    expect(scaffoldPythonVenv).not.toHaveBeenCalled();
  });
  it('prepares only the offline image template before accepting credentials', async () => {
    const f = await fixture();
    let finishCopy!: (ready: boolean) => void;
    vi.mocked(scaffoldPythonVenv).mockImplementation(() => new Promise(resolve => { finishCopy = resolve; }));
    const waiting = waitForAssignment({ ...f, pollMs: 1 });
    await f.publish();
    expect(scaffoldPythonVenv).toHaveBeenCalledWith('/ephemeral', { offlineOnly: true });
    expect(f.env.AX_AUTH_TOKEN).toBeUndefined();
    await expect(stat(join(f.root, 'accepted.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    finishCopy(true);
    await waiting;
    expect(f.env.AX_AUTH_TOKEN).toBe('private-token');
    await expect(stat(join(f.root, 'accepted.json'))).resolves.toBeDefined();
  });
  it('waits without credentials, consumes the file, and acknowledges only identity', async () => {
    const f = await fixture(); const waiting = waitForAssignment({ ...f, pollMs: 1 });
    expect(f.env.AX_AUTH_TOKEN).toBeUndefined(); await f.publish(); await waiting;
    expect(f.env.AX_AUTH_TOKEN).toBe('private-token'); expect(f.env.AX_STANDBY).toBeUndefined();
    await expect(stat(join(f.root, 'session.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const ack = await readFile(join(f.root, 'accepted.json'), 'utf8');
    expect(ack).not.toContain('private-token'); expect(JSON.parse(ack).assignmentId).toBe(f.assignment.assignmentId);
  });
  it.each(['identity', 'expiry', 'loader', 'git-command', 'mode', 'malformed'])('refuses %s and never installs credentials', async kind => {
    const f = await fixture();
    if (kind === 'identity') f.assignment.instanceId = randomUUID();
    if (kind === 'expiry') f.assignment.expiresAt = Date.now() - 1;
    if (kind === 'loader') Object.assign(f.assignment.env, { NODE_OPTIONS: '--import=/files/evil.js' });
    if (kind === 'git-command') Object.assign(f.assignment.env, { GIT_CONFIG_KEY_1: 'core.sshCommand', GIT_CONFIG_VALUE_1: 'evil' });
    await f.publish();
    if (kind === 'mode') { const { chmod } = await import('node:fs/promises'); await chmod(join(f.root, 'session.json'), 0o644); }
    if (kind === 'malformed') await writeFile(join(f.root, 'session.json'), '{private-token');
    await expect(waitForAssignment(f)).rejects.toThrow('standby activation failed');
    expect(f.env.AX_AUTH_TOKEN).toBeUndefined();
    await expect(stat(join(f.root, 'session.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('fails closed on a torn publish instead of waiting for the rest of the bytes', async () => {
    // Pins the contract the atomic publish above exists for: an assignment file seen before its
    // bytes land is never retried, it is consumed and refused. Publishers must rename into place.
    const f = await fixture(); await writeFile(join(f.root, 'session.json'), '', { mode: 0o600 });
    await expect(waitForAssignment({ ...f, pollMs: 1 })).rejects.toThrow('standby activation failed');
    expect(f.env.AX_AUTH_TOKEN).toBeUndefined();
    await expect(stat(join(f.root, 'session.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses a symlink to a secret file', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'elsewhere'), JSON.stringify(f.assignment), { mode: 0o600 });
    await symlink(join(f.root, 'elsewhere'), join(f.root, 'session.json'));
    await expect(waitForAssignment(f)).rejects.toThrow('unreadable'); expect(f.env.AX_AUTH_TOKEN).toBeUndefined();
  });
  it('can cancel a waiting standby without starting a session', async () => {
    const f = await fixture(); const c = new AbortController(); const waiting = waitForAssignment({ ...f, signal: c.signal });
    c.abort(); await expect(waiting).rejects.toThrow(); expect(f.env.AX_AUTH_TOKEN).toBeUndefined();
  });
  it('does not install credentials if the activation receipt cannot be published', async () => {
    const f = await fixture(); await f.publish();
    await writeFile(join(f.root, 'accepted.json.tmp'), 'existing');
    await expect(waitForAssignment(f)).rejects.toThrow('standby activation failed');
    expect(f.env.AX_AUTH_TOKEN).toBeUndefined(); expect(f.env.AX_STANDBY).toBe('1');
  });
});
