import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ wait: vi.fn(), run: vi.fn(async () => 0) }));
vi.mock('@ax/agent-runner-core', async importOriginal => ({
  ...await importOriginal<typeof import('@ax/agent-runner-core')>(),
  waitForAssignment: state.wait, runRunner: state.run,
}));
const { main } = await import('../main.js');
it('starts no runner work before standby activation completes', async () => {
  let activate!: () => void;
  state.wait.mockImplementationOnce(() => new Promise<void>(resolve => { activate = resolve; }));
  const pending = main();
  expect(state.run).not.toHaveBeenCalled();
  activate(); expect(await pending).toBe(0);
  expect(state.run).toHaveBeenCalledTimes(1); state.run.mockClear();
});
it('fails without starting runner work when activation is rejected', async () => {
  state.wait.mockRejectedValueOnce(new Error('standby activation failed'));
  await expect(main()).rejects.toThrow('standby activation failed');
  expect(state.run).not.toHaveBeenCalled();
});
