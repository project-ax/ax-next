import { PluginError } from './errors.js';
import { validateWorkspacePath } from './workspace-path.js';
import type { FileChange } from './workspace.js';

/** Host hard veto, before subscribers: retired files may be removed but never authored. */
export function assertNoRetiredRoutinePuts(changes: readonly FileChange[]): void {
  for (const change of changes) validateWorkspacePath(change.path);
  if (changes.some(change => change.kind === 'put' && change.path.startsWith('.ax/routines/'))) {
    throw new PluginError({ code: 'rejected', plugin: '@ax/core',
      reasonCode: 'routine-files-retired',
      message: 'Routine files are no longer supported. Use the routine tools.' });
  }
}
