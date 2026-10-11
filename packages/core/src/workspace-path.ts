import { PluginError } from './errors.js';

/** Workspace paths are canonical relative POSIX paths; aliases are rejected, never normalized. */
export function validateWorkspacePath(
  path: string,
  attribution: { plugin: string; hookName: string } = { plugin: '@ax/core', hookName: 'workspace:apply' },
): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new PluginError({
      code: 'invalid-path',
      plugin: attribution.plugin,
      hookName: attribution.hookName,
      message: 'path must be a non-empty string',
    });
  }
  if (path.includes('\0')) {
    throw new PluginError({
      code: 'invalid-path',
      plugin: attribution.plugin,
      hookName: attribution.hookName,
      message: `path contains NUL byte: ${JSON.stringify(path)}`,
    });
  }
  if (path.startsWith('/')) {
    throw new PluginError({
      code: 'invalid-path',
      plugin: attribution.plugin,
      hookName: attribution.hookName,
      message: `path must be relative, got: ${JSON.stringify(path)}`,
    });
  }
  if (path.includes('\\')) {
    throw new PluginError({
      code: 'invalid-path',
      plugin: attribution.plugin,
      hookName: attribution.hookName,
      message: `path must use POSIX separators, got: ${JSON.stringify(path)}`,
    });
  }
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new PluginError({
        code: 'invalid-path',
        plugin: attribution.plugin,
        hookName: attribution.hookName,
        message: `path contains forbidden segment: ${JSON.stringify(path)}`,
      });
    }
    if (seg === '.git') {
      throw new PluginError({
        code: 'invalid-path',
        plugin: attribution.plugin,
        hookName: attribution.hookName,
        message: `path may not include a .git segment: ${JSON.stringify(path)}`,
      });
    }
  }
}
