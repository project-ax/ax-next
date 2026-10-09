import { describe, expect, it } from 'vitest';
import { assertNoRetiredRoutinePuts } from '../retired-routine-path.js';
import { validateWorkspacePath } from '../workspace-path.js';
import type { FileChange } from '../workspace.js';

const put = (path: string): FileChange => ({ path, kind: 'put', content: new Uint8Array() });
describe('retired routine hard veto', () => {
  it('returns an authored refusal and stable reason code for puts', () => {
    expect(() => assertNoRetiredRoutinePuts([put('.ax/routines/nested/routine.md')])).toThrowError(expect.objectContaining({ code: 'rejected', reasonCode: 'routine-files-retired', plugin: '@ax/core', message: 'Routine files are no longer supported. Use the routine tools.' }));
  });
  it('allows empty batches, deletes, and similarly named paths', () => {
    expect(() => assertNoRetiredRoutinePuts([])).not.toThrow();
    expect(() => assertNoRetiredRoutinePuts([{ kind: 'delete', path: '.ax/routines/a.md' }, put('.ax/routines-other/a.md')])).not.toThrow();
  });
  it.each(['', '/absolute', 'a\\b', 'a/./b', 'a/../b', 'a//b', 'a/', '.git/config', 'a/.git/config', 'a\0b'])('retains the existing canonical discipline for %j', (path) => {
    expect(() => assertNoRetiredRoutinePuts([put(path)])).toThrowError(expect.objectContaining({ code: 'invalid-path' }));
  });
  it('validates the whole batch before applying the retired-prefix rule', () => {
    expect(() => assertNoRetiredRoutinePuts([put('.ax/routines/a.md'), put('./other')])).toThrowError(expect.objectContaining({ code: 'invalid-path' }));
  });
  it('lets a backend preserve its existing error attribution', () => {
    expect(() => validateWorkspacePath('./bad', { plugin: '@ax/workspace-git-core', hookName: 'workspace:apply-internal' })).toThrowError(expect.objectContaining({ code: 'invalid-path', plugin: '@ax/workspace-git-core', hookName: 'workspace:apply-internal', message: 'path contains forbidden segment: "./bad"' }));
  });
});
