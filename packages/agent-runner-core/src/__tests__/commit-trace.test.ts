import { afterEach, expect, it, vi } from 'vitest';
import { commitTrace } from '../commit-trace.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it('honors a trace flag delivered after the standby process imports runner modules', () => {
  const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.stubEnv('AX_COMMIT_TRACE', '1');
  commitTrace('activated trace\n');
  expect(write).toHaveBeenCalledWith('activated trace\n');
  vi.stubEnv('AX_COMMIT_TRACE', '0'); commitTrace('disabled\n');
  expect(write).toHaveBeenCalledTimes(1);
});
