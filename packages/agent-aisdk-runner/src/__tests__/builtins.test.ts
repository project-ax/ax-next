import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import { createHoldLatch, type PreToolVerdict, type ToolPolicy } from '@ax/agent-runner-core';
import { POLICY_WRAPPED, type WrappedExecute } from '../tools/policy-wrap.js';
import { buildBuiltinTools, resolveBashTimeoutMs } from '../tools/builtins.js';

// Same shape as policy-wrap.test.ts's fake — an allow-everything policy, so
// these tests exercise the tool bodies rather than re-testing the gate.
function fakePolicy(over: Partial<ToolPolicy> = {}): ToolPolicy & {
  preToolUse: ReturnType<typeof vi.fn>;
  postToolUse: ReturnType<typeof vi.fn>;
} {
  const policy = {
    preToolUse: vi.fn(
      async (): Promise<PreToolVerdict> => ({ decision: 'allow' }),
    ),
    postToolUse: vi.fn(async () => ({})),
    ...over,
  };
  return policy as never;
}

let home: string;
let policy: ReturnType<typeof fakePolicy>;
let tools: Record<string, Tool>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ax-builtins-'));
  policy = fakePolicy();
  tools = buildBuiltinTools({
    policy,
    homeDir: home,
    env: { PATH: process.env['PATH'] ?? '', HOME: home },
    holdLatch: createHoldLatch(), onHold: () => {},
  });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Invoke a built tool the way `ai@7` would, and get its string result. */
async function run(name: string, input: unknown): Promise<string> {
  const entry = tools[name];
  if (entry === undefined) throw new Error(`no such tool: ${name}`);
  const execute = entry.execute as unknown as (
    input: unknown,
    options: { toolCallId: string; messages: [] },
  ) => Promise<string>;
  return execute(input, { toolCallId: 'call-1', messages: [] });
}

/** The declared JSON Schema of a built tool, as the model will see it. */
function schemaOf(name: string): {
  type?: string;
  properties: Record<string, unknown>;
  required: string[];
} {
  const entry = tools[name];
  if (entry === undefined) throw new Error(`no such tool: ${name}`);
  const wrapper = entry.inputSchema as unknown as {
    jsonSchema: {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
  };
  return {
    ...(wrapper.jsonSchema.type === undefined
      ? {}
      : { type: wrapper.jsonSchema.type }),
    properties: wrapper.jsonSchema.properties ?? {},
    required: wrapper.jsonSchema.required ?? [],
  };
}

describe('buildBuiltinTools — the registered set', () => {
  it('registers exactly the six built-ins and nothing else', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'Write',
    ]);
  });

  // I₄: these are simply not registered on this runner. A future "let's port
  // TodoWrite back" has to land here first.
  it.each(['AskUserQuestion', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'])(
    'does not register %s',
    (name) => {
      expect(tools[name]).toBeUndefined();
    },
  );

  // Enumerated, not spot-checked: the gate is only as good as its weakest
  // entry, so every tool in the set is asserted individually.
  it('routes EVERY tool through wrapWithPolicy', () => {
    const entries = Object.entries(tools);
    expect(entries.length).toBe(6);
    for (const [name, entry] of entries) {
      const execute = entry.execute as WrappedExecute | undefined;
      expect(typeof execute, `${name}.execute`).toBe('function');
      expect(execute?.[POLICY_WRAPPED], `${name} is policy-wrapped`).toBe(true);
    }
  });

  it('actually consults the policy before running a tool body', async () => {
    await run('Write', { file_path: join(home, 'a.txt'), content: 'hi' });
    expect(policy.preToolUse).toHaveBeenCalledWith(
      'Write',
      { file_path: join(home, 'a.txt'), content: 'hi' },
      'call-1',
    );
  });

  it('gives every tool a real description for the model to choose on', () => {
    for (const [name, entry] of Object.entries(tools)) {
      expect((entry.description ?? '').length, `${name}.description`).toBeGreaterThan(
        60,
      );
    }
  });
});

// resolveGovernedPaths (@ax/agent-runner-core) re-roots ONLY the keys in its
// PATH_INPUT_KEYS set — `file_path`, `path`, `notebook_path`. Rename a field
// here and the re-rooter silently stops firing: governed writes land on the
// ungoverned tier and nothing else fails. Hence this test.
describe('input field names — the path re-rooter contract', () => {
  it.each(['Read', 'Write', 'Edit'])(
    '%s takes its target as `file_path` (required)',
    (name) => {
      const { properties, required } = schemaOf(name);
      expect(Object.keys(properties)).toContain('file_path');
      expect(required).toContain('file_path');
      // `path` would be re-rooted too, but the Claude built-ins spell a file
      // target `file_path`; two spellings for one concept is invariant-4 rot.
      expect(Object.keys(properties)).not.toContain('path');
    },
  );

  it.each(['Glob', 'Grep'])(
    '%s takes its search root as `path` and its pattern as `pattern`',
    (name) => {
      const { properties, required } = schemaOf(name);
      expect(Object.keys(properties)).toContain('path');
      expect(Object.keys(properties)).toContain('pattern');
      expect(required).toEqual(['pattern']);
    },
  );

  it('Bash takes `command` and an optional `timeout`', () => {
    const { properties, required } = schemaOf('Bash');
    expect(Object.keys(properties)).toContain('command');
    expect(Object.keys(properties)).toContain('timeout');
    expect(required).toEqual(['command']);
  });

  it('Edit declares old_string/new_string/replace_all', () => {
    const { properties, required } = schemaOf('Edit');
    expect(Object.keys(properties).sort()).toEqual([
      'file_path',
      'new_string',
      'old_string',
      'replace_all',
    ]);
    expect([...required].sort()).toEqual([
      'file_path',
      'new_string',
      'old_string',
    ]);
  });

  it('every declared schema is an object schema (what the models emit)', () => {
    for (const name of Object.keys(tools)) {
      expect(schemaOf(name).type, name).toBe('object');
    }
  });
});

describe('Bash', () => {
  it('returns stdout on success', async () => {
    const out = await run('Bash', { command: 'echo hello-from-bash' });
    expect(out).toContain('hello-from-bash');
    expect(out).not.toContain('exit code:');
  });

  it('runs in the agent home dir', async () => {
    await writeFile(join(home, 'marker.txt'), 'x');
    const out = await run('Bash', { command: 'ls' });
    expect(out).toContain('marker.txt');
  });

  it('uses the composed env, not the runner process env', async () => {
    tools = buildBuiltinTools({
      policy,
      homeDir: home,
      env: { PATH: process.env['PATH'] ?? '', AX_TEST_MARKER: 'composed' },
      holdLatch: createHoldLatch(), onHold: () => {},
    });
    const out = await run('Bash', { command: 'echo "[$AX_TEST_MARKER]"' });
    expect(out).toContain('[composed]');
  });

  // The model must be able to READ a failing command's output — turning a
  // non-zero exit into a throw would hand it an opaque error instead.
  it('returns a non-zero exit as a NORMAL result carrying stdout+stderr', async () => {
    const out = await run('Bash', {
      command: 'echo out-line; echo err-line 1>&2; exit 3',
    });
    expect(out).toContain('out-line');
    expect(out).toContain('err-line');
    expect(out).toContain('exit code: 3');
    // Normal result, not an executor error: postToolUse saw a plain string.
    expect(policy.postToolUse).toHaveBeenCalled();
  });

  it('reports an empty successful command rather than returning ""', async () => {
    const out = await run('Bash', { command: 'true' });
    expect(out.trim().length).toBeGreaterThan(0);
  });

  it('truncates oversized output with an explicit marker', async () => {
    const out = await run('Bash', { command: 'yes x | head -c 40000' });
    expect(out).toMatch(/\[\.\.\. truncated \d+ chars\]/);
    // Bounded: the model never sees all 40 000.
    expect(out.length).toBeLessThan(35_000);
  });

  it(
    'kills the child on timeout and says so',
    async () => {
      const started = Date.now();
      const out = await run('Bash', {
        command: 'echo before-sleep; sleep 30',
        timeout: 400,
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(out).toContain('timed out');
      // Partial output survives — that is why a timeout is a result, not a throw.
      expect(out).toContain('before-sleep');
    },
    20_000,
  );

  it(
    'really kills the process, not just the promise',
    async () => {
      const pidFile = join(home, 'pid');
      await run('Bash', {
        command: `echo $$ > ${JSON.stringify(pidFile)}; sleep 30`,
        timeout: 400,
      });
      const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
      expect(Number.isFinite(pid)).toBe(true);
      // Give the kernel a beat to reap it.
      await new Promise((r) => setTimeout(r, 250));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    },
    20_000,
  );

  // Constraint 3: the command is the ONLY thing that reaches a shell, and it
  // reaches it as a single argv element. Nothing else is interpolated.
  it('passes the command as one argv element to bash -lc', async () => {
    const out = await run('Bash', { command: 'printf "%s\\n" "$0" "$1"' });
    // Under `bash -lc <cmd>`, $0 is the shell and there is no $1. A second
    // non-empty line would mean our own arguments leaked into the invocation.
    expect(out.split('\n').filter((l) => l.trim().length > 0).length).toBe(1);
  });

  it('rejects a missing command with a clear executor error', async () => {
    await expect(run('Bash', {})).rejects.toThrow(/command/i);
  });
});

describe('resolveBashTimeoutMs', () => {
  it('defaults to 120s when the model does not ask', () => {
    expect(resolveBashTimeoutMs(undefined)).toBe(120_000);
    expect(resolveBashTimeoutMs('not a number')).toBe(120_000);
  });

  it('honours a sane caller-supplied timeout', () => {
    expect(resolveBashTimeoutMs(5_000)).toBe(5_000);
  });

  it('caps an absurd timeout at 10 minutes', () => {
    expect(resolveBashTimeoutMs(999_999_999)).toBe(600_000);
  });

  it('floors a zero/negative timeout instead of killing instantly', () => {
    expect(resolveBashTimeoutMs(0)).toBe(1_000);
    expect(resolveBashTimeoutMs(-5)).toBe(1_000);
  });
});

describe('Read', () => {
  it('numbers lines cat -n style', async () => {
    const p = join(home, 'f.txt');
    await writeFile(p, 'alpha\nbeta\ngamma\n');
    const out = await run('Read', { file_path: p });
    expect(out).toContain('     1\talpha');
    expect(out).toContain('     2\tbeta');
    expect(out).toContain('     3\tgamma');
  });

  it('honours offset and limit, and says how much is left', async () => {
    const p = join(home, 'many.txt');
    await writeFile(
      p,
      Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join('\n'),
    );
    const out = await run('Read', { file_path: p, offset: 10, limit: 2 });
    expect(out).toContain('    10\tline10');
    expect(out).toContain('    11\tline11');
    expect(out).not.toContain('line12');
    expect(out).toMatch(/more lines/);
  });

  it('applies a default line limit to a huge file', async () => {
    const p = join(home, 'huge.txt');
    await writeFile(
      p,
      Array.from({ length: 5000 }, (_, i) => `l${i + 1}`).join('\n'),
    );
    const out = await run('Read', { file_path: p });
    expect(out).toContain('  2000\tl2000');
    expect(out).not.toContain('\tl2001');
    expect(out).toMatch(/more lines/);
  });

  it('truncates a pathologically long line', async () => {
    const p = join(home, 'long.txt');
    await writeFile(p, `${'z'.repeat(9000)}\n`);
    const out = await run('Read', { file_path: p });
    expect(out).toMatch(/line truncated/);
    expect(out.length).toBeLessThan(4000);
  });

  it('returns a descriptor for a binary file, never its bytes', async () => {
    const p = join(home, 'blob.bin');
    await writeFile(p, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x41]));
    const out = await run('Read', { file_path: p });
    expect(out).toContain('binary');
    expect(out).toContain(p);
    expect(out).toContain('6 bytes');
    expect(out).not.toContain('\u0000');
    expect(out).not.toMatch(/^\s+1\t/m);
  });

  it('returns a descriptor for an image by extension even without NUL bytes', async () => {
    const p = join(home, 'pic.png');
    await writeFile(p, 'not really a png but the extension says image');
    const out = await run('Read', { file_path: p });
    expect(out).toContain('image/png');
    expect(out).not.toContain('not really a png');
  });

  it('is an executor error for a missing file', async () => {
    await expect(
      run('Read', { file_path: join(home, 'nope.txt') }),
    ).rejects.toThrow(/not found|ENOENT/i);
  });

  it('is an executor error for a directory', async () => {
    await expect(run('Read', { file_path: home })).rejects.toThrow(/director/i);
  });

  it('says so for an empty file instead of returning ""', async () => {
    const p = join(home, 'empty.txt');
    await writeFile(p, '');
    const out = await run('Read', { file_path: p });
    expect(out).toMatch(/empty/i);
  });

  it('resolves a relative path against the agent home dir', async () => {
    await writeFile(join(home, 'rel.txt'), 'relative-content\n');
    const out = await run('Read', { file_path: 'rel.txt' });
    expect(out).toContain('relative-content');
  });
});

describe('Write', () => {
  it('creates missing parent directories', async () => {
    const p = join(home, 'a', 'b', 'c', 'new.txt');
    const out = await run('Write', { file_path: p, content: 'deep' });
    expect(await readFile(p, 'utf8')).toBe('deep');
    expect(out).toContain(p);
  });

  it('overwrites an existing file', async () => {
    const p = join(home, 'over.txt');
    await writeFile(p, 'old content that is much longer');
    await run('Write', { file_path: p, content: 'new' });
    expect(await readFile(p, 'utf8')).toBe('new');
  });

  it('accepts empty content', async () => {
    const p = join(home, 'blank.txt');
    await run('Write', { file_path: p, content: '' });
    expect(await readFile(p, 'utf8')).toBe('');
  });

  it('is an executor error when content is missing', async () => {
    await expect(
      run('Write', { file_path: join(home, 'x.txt') }),
    ).rejects.toThrow(/content/i);
  });
});

describe('Edit', () => {
  const seed = async (body: string): Promise<string> => {
    const p = join(home, 'edit.txt');
    await writeFile(p, body);
    return p;
  };

  it('replaces an exactly-once match', async () => {
    const p = await seed('one\ntwo\nthree\n');
    const out = await run('Edit', {
      file_path: p,
      old_string: 'two',
      new_string: 'TWO',
    });
    expect(await readFile(p, 'utf8')).toBe('one\nTWO\nthree\n');
    expect(out).toContain('1 replacement');
  });

  it('is an executor error when old_string is not found', async () => {
    const p = await seed('one\ntwo\n');
    await expect(
      run('Edit', { file_path: p, old_string: 'missing', new_string: 'x' }),
    ).rejects.toThrow(/not found/i);
    // The file is untouched on failure.
    expect(await readFile(p, 'utf8')).toBe('one\ntwo\n');
  });

  it('is an executor error on multiple matches, and names the count', async () => {
    const p = await seed('dup\ndup\ndup\n');
    await expect(
      run('Edit', { file_path: p, old_string: 'dup', new_string: 'x' }),
    ).rejects.toThrow(/3 times/);
    await expect(
      run('Edit', { file_path: p, old_string: 'dup', new_string: 'x' }),
    ).rejects.toThrow(/replace_all/);
    expect(await readFile(p, 'utf8')).toBe('dup\ndup\ndup\n');
  });

  it('replaces every match with replace_all', async () => {
    const p = await seed('dup\ndup\ndup\n');
    const out = await run('Edit', {
      file_path: p,
      old_string: 'dup',
      new_string: 'x',
      replace_all: true,
    });
    expect(await readFile(p, 'utf8')).toBe('x\nx\nx\n');
    expect(out).toContain('3 replacement');
  });

  it('allows an empty new_string (deleting text)', async () => {
    const p = await seed('keep-DELETEME-keep');
    await run('Edit', { file_path: p, old_string: 'DELETEME', new_string: '' });
    expect(await readFile(p, 'utf8')).toBe('keep--keep');
  });

  it('refuses an empty old_string rather than corrupting the file', async () => {
    const p = await seed('body');
    await expect(
      run('Edit', { file_path: p, old_string: '', new_string: 'x' }),
    ).rejects.toThrow(/old_string/i);
    expect(await readFile(p, 'utf8')).toBe('body');
  });

  it('is an executor error on a missing file', async () => {
    await expect(
      run('Edit', {
        file_path: join(home, 'ghost.txt'),
        old_string: 'a',
        new_string: 'b',
      }),
    ).rejects.toThrow(/not found|ENOENT/i);
  });
});

describe('Glob', () => {
  beforeEach(async () => {
    await mkdir(join(home, 'src', 'deep'), { recursive: true });
    await mkdir(join(home, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(home, '.git', 'objects'), { recursive: true });
    await writeFile(join(home, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(home, 'src', 'deep', 'b.ts'), 'export const b = 2;\n');
    await writeFile(join(home, 'node_modules', 'pkg', 'c.ts'), 'noise\n');
    await writeFile(join(home, '.git', 'objects', 'd.ts'), 'noise\n');
  });

  it('finds matching files under the search root', async () => {
    const out = await run('Glob', { pattern: '**/*.ts' });
    expect(out).toContain(join(home, 'src', 'a.ts'));
    expect(out).toContain(join(home, 'src', 'deep', 'b.ts'));
  });

  it('skips node_modules and .git', async () => {
    const out = await run('Glob', { pattern: '**/*.ts' });
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('.git');
  });

  // The real assertion: an explicitly-named excluded dir must stay excluded.
  // With a bare `**` the dot-segment rule alone would hide `.git`, so that
  // case cannot tell a working exclude from a missing one.
  it('does not descend into node_modules or .git even when named explicitly', async () => {
    expect(await run('Glob', { pattern: 'node_modules/**/*.ts' })).toMatch(
      /no files matched/i,
    );
    expect(await run('Glob', { pattern: '.git/**/*.ts' })).toMatch(
      /no files matched/i,
    );
  });

  it('honours an explicit search root', async () => {
    const out = await run('Glob', {
      pattern: '*.ts',
      path: join(home, 'src', 'deep'),
    });
    expect(out).toContain('b.ts');
    expect(out).not.toContain(join(home, 'src', 'a.ts'));
  });

  it('resolves a relative search root against the agent home dir', async () => {
    const out = await run('Glob', { pattern: '*.ts', path: 'src' });
    expect(out).toContain(join(home, 'src', 'a.ts'));
  });

  it('caps the result count with a truncation marker', async () => {
    await mkdir(join(home, 'many'), { recursive: true });
    await Promise.all(
      Array.from({ length: 260 }, (_, i) =>
        writeFile(join(home, 'many', `f${i}.md`), 'x'),
      ),
    );
    const out = await run('Glob', { pattern: 'many/*.md' });
    const lines = out.split('\n').filter((l) => l.endsWith('.md'));
    expect(lines.length).toBe(200);
    expect(out).toMatch(/truncated at 200 matches/);
  });

  it('says plainly when nothing matched', async () => {
    const out = await run('Glob', { pattern: '**/*.nope' });
    expect(out).toMatch(/no files matched/i);
  });

  it('is an executor error for a missing search root', async () => {
    await expect(
      run('Glob', { pattern: '*', path: join(home, 'ghost-dir') }),
    ).rejects.toThrow(/not found|ENOENT/i);
  });
});

describe('Grep', () => {
  beforeEach(async () => {
    await mkdir(join(home, 'src'), { recursive: true });
    await mkdir(join(home, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(home, '.git'), { recursive: true });
    await writeFile(join(home, 'src', 'a.ts'), 'const x = 1;\nNEEDLE here\n');
    await writeFile(join(home, 'src', 'b.md'), 'nothing\nNEEDLE in markdown\n');
    await writeFile(join(home, 'node_modules', 'pkg', 'c.ts'), 'NEEDLE noise\n');
    await writeFile(join(home, '.git', 'config'), 'NEEDLE noise\n');
  });

  it('returns file:line:text for each match', async () => {
    const out = await run('Grep', { pattern: 'NEEDLE' });
    expect(out).toContain(`${join(home, 'src', 'a.ts')}:2:NEEDLE here`);
    expect(out).toContain(`${join(home, 'src', 'b.md')}:2:NEEDLE in markdown`);
  });

  it('omits line numbers when show_line_numbers is false', async () => {
    const out = await run('Grep', {
      pattern: 'NEEDLE',
      show_line_numbers: false,
    });
    expect(out).toContain(`${join(home, 'src', 'a.ts')}:NEEDLE here`);
    expect(out).not.toContain(':2:');
  });

  it('skips node_modules and .git even when the glob names them', async () => {
    expect(await run('Grep', { pattern: 'NEEDLE' })).not.toContain(
      'node_modules',
    );
    expect(
      await run('Grep', { pattern: 'NEEDLE', glob: 'node_modules/**/*' }),
    ).toMatch(/no matches/i);
    expect(await run('Grep', { pattern: 'NEEDLE', glob: '.git/**' })).toMatch(
      /no matches/i,
    );
  });

  it('honours a glob filter', async () => {
    const out = await run('Grep', { pattern: 'NEEDLE', glob: '**/*.ts' });
    expect(out).toContain('a.ts');
    expect(out).not.toContain('b.md');
  });

  it('is case-sensitive by default and case-insensitive on request', async () => {
    expect(await run('Grep', { pattern: 'needle' })).toMatch(/no matches/i);
    const out = await run('Grep', { pattern: 'needle', case_insensitive: true });
    expect(out).toContain('NEEDLE here');
  });

  it('treats the pattern as a regex', async () => {
    const out = await run('Grep', { pattern: '^const\\s+\\w+ = \\d' });
    expect(out).toContain('const x = 1;');
  });

  // Anchored on OUR message, not the engine's: V8's own SyntaxError also says
  // "Invalid regular expression", so a laxer matcher would still pass if the
  // try/catch were deleted and the raw throw escaped.
  it('turns a malformed regex into a clean executor error', async () => {
    await expect(run('Grep', { pattern: '(' })).rejects.toThrow(
      /^Grep: invalid regular expression/,
    );
  });

  it('caps matches with a truncation marker', async () => {
    await writeFile(
      join(home, 'src', 'wide.txt'),
      Array.from({ length: 300 }, (_, i) => `NEEDLE ${i}`).join('\n'),
    );
    const out = await run('Grep', { pattern: 'NEEDLE', glob: '**/*.txt' });
    const lines = out.split('\n').filter((l) => l.includes('NEEDLE'));
    expect(lines.length).toBe(200);
    expect(out).toMatch(/truncated at 200 matches/);
  });

  it('skips binary files rather than dumping bytes', async () => {
    await writeFile(
      join(home, 'src', 'blob.bin'),
      Buffer.concat([Buffer.from('NEEDLE'), Buffer.from([0x00, 0x01])]),
    );
    const out = await run('Grep', { pattern: 'NEEDLE', glob: '**/*.bin' });
    expect(out).toMatch(/no matches/i);
  });

  it('says plainly when nothing matched', async () => {
    const out = await run('Grep', { pattern: 'ZZZ-not-here' });
    expect(out).toMatch(/no matches/i);
  });

  it('is an executor error for a missing search root', async () => {
    await expect(
      run('Grep', { pattern: 'x', path: join(home, 'ghost-dir') }),
    ).rejects.toThrow(/not found|ENOENT/i);
  });

  it('searches a single file when path names one', async () => {
    const out = await run('Grep', {
      pattern: 'NEEDLE',
      path: join(home, 'src', 'a.ts'),
    });
    expect(out).toContain('a.ts:2:NEEDLE here');
    expect(out).not.toContain('b.md');
  });
});

// A sanity check that the harness itself is honest: `bash` must exist, or
// every Bash assertion above would be checking a spawn failure.
describe('test harness', () => {
  it('has a real bash', async () => {
    const { stdout } = await promisify(execFile)('bash', ['-c', 'echo ok']);
    expect(stdout.trim()).toBe('ok');
  });
});
