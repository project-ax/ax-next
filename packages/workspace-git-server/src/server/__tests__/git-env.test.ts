import { describe, it, expect } from 'vitest';
import { PARANOID_GIT_ENV } from '../git-env.js';

const EXPECTED_KEYS = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_TERMINAL_PROMPT',
  'HOME',
  'PATH',
] as const;

describe('PARANOID_GIT_ENV', () => {
  it('has exactly the 5 expected keys', () => {
    expect(Object.keys(PARANOID_GIT_ENV).sort()).toEqual([...EXPECTED_KEYS]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PARANOID_GIT_ENV)).toBe(true);
  });

  it('throws on mutation in strict mode', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (PARANOID_GIT_ENV as any).GIT_CONFIG_NOSYSTEM = '0';
    }).toThrow();
  });

  it('throws on adding a new key', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (PARANOID_GIT_ENV as any).GIT_DIR = '/tmp';
    }).toThrow();
  });

  it('does not leak unrelated GIT_* keys', () => {
    const keys = Object.keys(PARANOID_GIT_ENV);
    expect(keys).not.toContain('GIT_DIR');
    expect(keys).not.toContain('GIT_WORK_TREE');
    expect(keys).not.toContain('GIT_INDEX_FILE');
    expect(keys).not.toContain('GIT_OBJECT_DIRECTORY');
    expect(keys).not.toContain('GIT_ALTERNATE_OBJECT_DIRECTORIES');
    expect(keys).not.toContain('GIT_AUTHOR_NAME');
    expect(keys).not.toContain('GIT_AUTHOR_EMAIL');
    expect(keys).not.toContain('GIT_COMMITTER_NAME');
    expect(keys).not.toContain('GIT_COMMITTER_EMAIL');
    expect(keys).not.toContain('GIT_SSH');
    expect(keys).not.toContain('GIT_SSH_COMMAND');
    expect(keys).not.toContain('GIT_ASKPASS');
  });

  it('values match documented constants exactly', () => {
    expect(PARANOID_GIT_ENV.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(PARANOID_GIT_ENV.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(PARANOID_GIT_ENV.GIT_TERMINAL_PROMPT).toBe('0');
    expect(PARANOID_GIT_ENV.HOME).toBe('/nonexistent');
    expect(PARANOID_GIT_ENV.PATH).toBe('/usr/bin:/bin');
  });
});
