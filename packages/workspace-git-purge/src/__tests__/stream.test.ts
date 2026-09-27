import { describe, it, expect } from 'vitest';
import { filterFastExportStream, makePathMatcher, unquoteCPath } from '../stream.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const matcher = makePathMatcher(['memory/', 'permanent/memory/facts/'], ['memory/system/rules.md']);
const filter = (s: string | Buffer): string =>
  filterFastExportStream(typeof s === 'string' ? Buffer.from(s, 'utf8') : s, matcher).toString(
    'utf8',
  );

function commit(msg: string, body: string, from = ''): string {
  const len = Buffer.byteLength(msg, 'utf8');
  return (
    'commit refs/heads/main\nmark :1\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n' +
    `data ${len}\n${msg}\n${from}${body}\n`
  );
}

describe('makePathMatcher', () => {
  it('matches under a prefix, not the kept path, not sibling names', () => {
    const m = (p: string): boolean => matcher(Buffer.from(p, 'utf8'));
    expect(m('memory/docs/a.md')).toBe(true);
    expect(m('memory/system/user.md')).toBe(true);
    expect(m('permanent/memory/facts/profile.md')).toBe(true);
    expect(m('memory/system/rules.md')).toBe(false);
    expect(m('memory-notes.md')).toBe(false);
    expect(m('memorybank/x.md')).toBe(false);
    expect(m('memory')).toBe(false);
    expect(m('notes/memory/x.md')).toBe(false);
    expect(m('permanent/memory/other.md')).toBe(false);
  });
});

describe('unquoteCPath', () => {
  it('decodes the escapes git emits', () => {
    const q = Buffer.from('"memory/docs/caf\\303\\251 \\"x\\"\\n\\t\\\\.md"', 'latin1');
    expect(unquoteCPath(q).toString('utf8')).toBe('memory/docs/café "x"\n\t\\.md');
  });
  it('rejects malformed quoting', () => {
    expect(() => unquoteCPath(Buffer.from('"abc'))).toThrow();
    expect(() => unquoteCPath(Buffer.from('"a\\qb"'))).toThrow();
    expect(() => unquoteCPath(Buffer.from('"a\\40"'))).toThrow();
    expect(() => unquoteCPath(Buffer.from('"a"b"'))).toThrow();
  });
});

describe('filterFastExportStream', () => {
  it('drops matching M/D lines, keeps the rest, and renames the ref', () => {
    const input =
      'feature done\nreset refs/heads/main\n' +
      commit(
        'c1\n',
        `M 100644 ${SHA} memory/docs/a.md\nM 100644 ${SHA} memory/system/rules.md\n` +
          `M 100644 ${SHA} memory-notes.md\nM 100644 ${SHA} notes/a b.md\n` +
          `M 100644 ${SHA} permanent/memory/facts/profile.md\nD memory/inbox/x.md\nD notes/old.md\n` +
          `M 160000 ${SHA2} vendor/sub\n`,
      ) +
      'done\n';
    const out = filter(input);
    expect(out).not.toContain('memory/docs/a.md');
    expect(out).not.toContain('memory/inbox/x.md');
    expect(out).not.toContain('permanent/memory/facts/profile.md');
    expect(out).toContain(`M 100644 ${SHA} memory/system/rules.md\n`);
    expect(out).toContain(`M 100644 ${SHA} memory-notes.md\n`);
    expect(out).toContain(`M 100644 ${SHA} notes/a b.md\n`);
    expect(out).toContain('D notes/old.md\n');
    expect(out).toContain(`M 160000 ${SHA2} vendor/sub\n`);
    expect(out).not.toContain('refs/heads/main');
    expect(out).toContain('reset refs/ax-purge/main\n');
    expect(out).toContain('commit refs/ax-purge/main\n');
    expect(out.startsWith('feature done\n')).toBe(true);
    expect(out.endsWith('done\n')).toBe(true);
  });

  it('copies commit-message bytes verbatim, even lines that look like commands', () => {
    const msg =
      `evil\nM 100644 ${SHA} memory/docs/x.md\nD memory/x\ncommit refs/heads/evil\ndata 5\ntag v1\n`;
    const input =
      commit(msg, `M 100644 ${SHA} memory/docs/y.md\nM 100644 ${SHA} notes/b.md\n`) + 'done\n';
    const out = filter(input);
    expect(out).toContain(`data ${Buffer.byteLength(msg)}\n${msg}\n`);
    expect(out).not.toContain('memory/docs/y.md');
    expect(out).toContain(`M 100644 ${SHA} notes/b.md\n`);
  });

  it('copies non-UTF-8 message bytes verbatim', () => {
    const msgBytes = Buffer.from([0x63, 0xe9, 0xff, 0x0a]);
    const head = Buffer.from(
      'commit refs/heads/main\nmark :1\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\nencoding ISO-8859-1\ndata 4\n',
    );
    const tail = Buffer.from(`\nM 100644 ${SHA} notes/a.md\n\ndone\n`);
    const out = filterFastExportStream(Buffer.concat([head, msgBytes, tail]), matcher);
    expect(out.includes(Buffer.concat([Buffer.from('data 4\n'), msgBytes]))).toBe(true);
  });

  it('handles a data block with no trailing LF', () => {
    const input =
      'commit refs/heads/main\nmark :1\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n' +
      `data 2\nhiM 100644 ${SHA} memory/docs/a.md\nM 100644 ${SHA} notes/a.md\n\ndone\n`;
    const out = filter(input);
    expect(out).toContain('data 2\nhi');
    expect(out).not.toContain('memory/docs/a.md');
    expect(out).toContain(`M 100644 ${SHA} notes/a.md\n`);
  });

  it('drops C-quoted matching paths and keeps C-quoted non-matching ones verbatim', () => {
    const input =
      commit(
        'c\n',
        `M 100644 ${SHA} "memory/docs/caf\\303\\251 \\"x\\".md"\n` +
          `M 100644 ${SHA} "memory/docs/new\\nline.md"\n` +
          `D "memory/docs/caf\\303\\251 \\"x\\".md"\n` +
          `M 100644 ${SHA} "notes/\\303\\274 \\"q\\".md"\n` +
          `M 100644 ${SHA} "memory/system/rules.md"\n`,
      ) + 'done\n';
    const out = filter(input);
    expect(out).not.toContain('caf');
    expect(out).not.toContain('new\\nline');
    expect(out).toContain(`M 100644 ${SHA} "notes/\\303\\274 \\"q\\".md"\n`);
    expect(out).toContain(`M 100644 ${SHA} "memory/system/rules.md"\n`);
  });

  it('passes merge / from / deleteall through', () => {
    const input =
      commit('m\n', `merge :2\ndeleteall\nM 100644 ${SHA} memory/a.md\nM 100644 ${SHA} n.md\n`, 'from :1\n') +
      'done\n';
    const out = filter(input);
    expect(out).toContain('from :1\nmerge :2\ndeleteall\n');
    expect(out).not.toContain('memory/a.md');
  });

  it.each([
    ['a delimited data block', 'commit refs/heads/main\nmark :1\ndata <<EOF\nx\nEOF\n'],
    ['a copy', commit('c\n', 'C notes/a notes/b\n')],
    ['a rename', commit('c\n', 'R notes/a notes/b\n')],
    ['a note', commit('c\n', `N ${SHA} :1\n`)],
    ['an inline modify', commit('c\n', 'M 100644 inline notes/a\n')],
    ['a mark dataref', commit('c\n', 'M 100644 :3 notes/a\n')],
    ['a bad mode', commit('c\n', `M 10064 ${SHA} notes/a\n`)],
    ['another commit ref', 'commit refs/heads/other\n'],
    ['another reset ref', 'reset refs/heads/other\n'],
    ['a tag', 'tag v1\n'],
    ['a blob', 'blob\nmark :1\ndata 1\nx\n'],
    ['an unknown header', 'commit refs/heads/main\nmark :1\ngpgsig sha1 openpgp\n'],
    ['an unknown command', 'progress 1\n'],
    ['a file command outside a commit', `M 100644 ${SHA} notes/a\n`],
    ['a truncated data block', 'commit refs/heads/main\nmark :1\ndata 50\nshort\n'],
    ['a non-decimal data length', 'commit refs/heads/main\nmark :1\ndata 0x5\nhello\n'],
    ['a stream without a final LF', 'feature done'],
  ])('throws on %s', (_label, input) => {
    expect(() => filter(input)).toThrow();
  });

  it('never echoes file content or paths in its errors', () => {
    try {
      filter(commit('c\n', 'R memory/docs/secret-name.md notes/b\n'));
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('secret-name');
    }
  });
});
