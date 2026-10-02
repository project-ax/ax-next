import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInterruptProcesses } from '../interrupt-processes.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), read: vi.fn(), list: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({ readFileSync: mocks.read, readdirSync: mocks.list }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let table: Map<number, { parent: number; started: string }>;
let child: EventEmitter;
let kill: ReturnType<typeof vi.spyOn>;
function stat(pid: number, parent: number, started: string) {
  const fields = Array<string>(20).fill('0');
  fields[0] = 'S'; fields[1] = String(parent); fields[19] = started;
  return `${pid} (a command ) with spaces) ${fields.join(' ')}`;
}
const options = { command: '/trusted/claude', args: ['--stdio'], env: {}, signal: new AbortController().signal };

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  table = new Map([[1, { parent: 0, started: '1' }], [100, { parent: 1, started: '10' }],
    [200, { parent: 100, started: '20' }], [300, { parent: 200, started: '30' }],
    [400, { parent: 1, started: '40' }]]);
  child = Object.assign(new EventEmitter(), { pid: 100 });
  mocks.spawn.mockReturnValue(child);
  mocks.list.mockImplementation(() => [...table.keys()].map(String));
  mocks.read.mockImplementation((path: string) => {
    const pid = Number(path.split('/')[2]); const proc = table.get(pid);
    if (!proc) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return stat(pid, proc.parent, proc.started);
  });
  kill = vi.spyOn(process, 'kill').mockReturnValue(true);
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks(); vi.clearAllMocks(); });

function arm(owner: ReturnType<typeof createInterruptProcesses>) {
  const tools = [...table].filter(([pid]) => pid === 200 || pid === 300 || pid === 301);
  for (const [pid] of tools) table.delete(pid);
  owner.preserveStartupProcesses();
  for (const [pid, proc] of tools) table.set(pid, proc);
}

describe('Linux SDK process ownership', () => {
  it('freezes parents before children, kills descendants, and preserves SDK and unrelated processes', () => {
    const owner = createInterruptProcesses(); owner.spawn(options); arm(owner); owner.killTools();
    expect(kill.mock.calls).toEqual([[200, 'SIGSTOP'], [300, 'SIGSTOP'], [300, 'SIGKILL'], [200, 'SIGKILL']]);
    expect(mocks.spawn).toHaveBeenCalledWith(options.command, options.args,
      expect.objectContaining({ shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: {}, signal: options.signal }));
  });
  it('discovers a child forked while its parent is being frozen', () => {
    kill.mockImplementation((pid: number, signal: string) => {
      if (pid === 200 && signal === 'SIGSTOP') table.set(301, { parent: 200, started: '31' });
      return true;
    });
    const owner = createInterruptProcesses(); owner.spawn(options); arm(owner); owner.killTools();
    expect(kill).toHaveBeenCalledWith(301, 'SIGSTOP');
    expect(kill).toHaveBeenCalledWith(301, 'SIGKILL');
  });
  it('preserves startup MCP servers and their later workers', () => {
    table.set(500, { parent: 100, started: '50' });
    const owner = createInterruptProcesses(); owner.spawn(options); arm(owner);
    table.set(501, { parent: 500, started: '51' }); owner.killTools();
    expect(kill).not.toHaveBeenCalledWith(500, 'SIGSTOP');
    expect(kill).not.toHaveBeenCalledWith(501, 'SIGSTOP');
    expect(kill).toHaveBeenCalledWith(200, 'SIGKILL');
  });
  it('does not terminate startup processes before any prompt was submitted', () => {
    const owner = createInterruptProcesses(); owner.spawn(options); owner.killTools();
    expect(kill).not.toHaveBeenCalled();
  });
  it('ignores a root PID reused after the SDK exits', () => {
    const owner = createInterruptProcesses(); owner.spawn(options); arm(owner);
    table.set(100, { parent: 1, started: '999' }); owner.killTools();
    expect(kill).not.toHaveBeenCalled();
  });
  it('does not signal a descendant PID reused after the snapshot', () => {
    const owner = createInterruptProcesses(); owner.spawn(options); arm(owner);
    kill.mockImplementation((pid: number, signal: string) => {
      if (pid === 300 && signal === 'SIGSTOP') table.set(300, { parent: 1, started: '999' });
      return true;
    });
    owner.killTools(); expect(kill).not.toHaveBeenCalledWith(300, 'SIGKILL');
  });
  it('kills frozen tools even if a later process-table read fails', () => {
    const owner = createInterruptProcesses(); owner.spawn(options); arm(owner);
    mocks.list.mockReturnValueOnce([...table.keys()].map(String))
      .mockImplementationOnce(() => { throw new Error('proc read failed'); });
    expect(() => owner.killTools()).toThrow('proc read failed');
    expect(kill).toHaveBeenCalledWith(200, 'SIGSTOP');
    expect(kill).toHaveBeenCalledWith(200, 'SIGKILL');
  });
  it('rechecks root identity after reading the process table', () => {
    const owner = createInterruptProcesses(); owner.spawn(options); arm(owner);
    mocks.list.mockImplementation(() => {
      table.set(100, { parent: 1, started: '999' });
      return [...table.keys()].map(String);
    });
    owner.killTools(); expect(kill).not.toHaveBeenCalled();
  });
  it('clears ownership on exit and does no process scanning outside Linux', () => {
    const owner = createInterruptProcesses(); owner.spawn(options); child.emit('exit'); owner.killTools();
    expect(kill).not.toHaveBeenCalled();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mocks.read.mockClear(); mocks.list.mockClear();
    const other = createInterruptProcesses(); other.spawn(options); other.killTools();
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
  });
});
