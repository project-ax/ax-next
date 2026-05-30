import { describe, expect, it } from 'vitest';
import { parseFrontmatter, parseFrontmatterBytes } from '../frontmatter.js';

describe('parseFrontmatter', () => {
  it('accepts well-formed frontmatter with name + description', () => {
    const md = '---\nname: foo\ndescription: a thing\n---\n# Body\n';
    const r = parseFrontmatter(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields).toEqual({ name: 'foo', description: 'a thing' });
    }
  });

  it('accepts frontmatter with extra fields (only name + description required)', () => {
    const md =
      '---\nname: foo\ndescription: a thing\nversion: 1.0\ncategory: util\n---\n';
    const r = parseFrontmatter(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.name).toBe('foo');
      expect(r.fields.description).toBe('a thing');
    }
  });

  it('rejects when no frontmatter fence is present', () => {
    const r = parseFrontmatter('# Just a heading, no frontmatter');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('no frontmatter block');
  });

  it('rejects when only the opening fence is present (no closing)', () => {
    const r = parseFrontmatter('---\nname: foo\n# never closes');
    expect(r.ok).toBe(false);
  });

  it('rejects missing required name', () => {
    const r = parseFrontmatter('---\ndescription: x\n---\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('name');
  });

  it('rejects missing required description', () => {
    const r = parseFrontmatter('---\nname: x\n---\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('description');
  });

  it('rejects empty name', () => {
    const r = parseFrontmatter('---\nname: ""\ndescription: x\n---\n');
    expect(r.ok).toBe(false);
  });

  it('rejects empty description', () => {
    const r = parseFrontmatter('---\nname: foo\ndescription: ""\n---\n');
    expect(r.ok).toBe(false);
  });

  it('rejects non-string name (number)', () => {
    const r = parseFrontmatter('---\nname: 42\ndescription: x\n---\n');
    expect(r.ok).toBe(false);
  });

  it('rejects non-string description (boolean)', () => {
    const r = parseFrontmatter('---\nname: foo\ndescription: true\n---\n');
    expect(r.ok).toBe(false);
  });

  it('rejects invalid YAML body', () => {
    // `: bad` is a mapping with no key — js-yaml throws.
    const r = parseFrontmatter('---\n: bad\n---\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/yaml|frontmatter/i);
  });

  it('rejects YAML array (must be a mapping)', () => {
    const r = parseFrontmatter('---\n- one\n- two\n---\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mapping/i);
  });

  it('rejects YAML scalar (must be a mapping)', () => {
    const r = parseFrontmatter('---\nplain string\n---\n');
    expect(r.ok).toBe(false);
  });

  it('handles frontmatter with trailing content correctly (does not require trailing newline)', () => {
    // The fence regex accepts either \n or end-of-string after the
    // closing `---`. A SKILL.md with no body after the fence is valid.
    const r = parseFrontmatter('---\nname: foo\ndescription: x\n---');
    expect(r.ok).toBe(true);
  });

  it('handles UTF-8 content in fields', () => {
    const r = parseFrontmatter(
      '---\nname: 雨\ndescription: 日本語の説明\n---\n',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.name).toBe('雨');
      expect(r.fields.description).toBe('日本語の説明');
    }
  });
});

describe('parseFrontmatterBytes', () => {
  it('decodes valid UTF-8 bytes and parses', () => {
    const bytes = new TextEncoder().encode(
      '---\nname: foo\ndescription: x\n---\n',
    );
    const r = parseFrontmatterBytes(bytes);
    expect(r.ok).toBe(true);
  });

  it('rejects non-UTF-8 bytes cleanly (no replacement chars)', () => {
    // Lone high-bit bytes that aren't valid UTF-8 sequence starters.
    const bytes = new Uint8Array([0xff, 0xfe, 0x00]);
    const r = parseFrontmatterBytes(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('UTF-8');
  });

  it('rejects truncated UTF-8 multi-byte sequences', () => {
    // 0xC3 starts a 2-byte sequence; without the continuation byte
    // it is invalid.
    const bytes = new Uint8Array([0xc3]);
    const r = parseFrontmatterBytes(bytes);
    expect(r.ok).toBe(false);
  });

  it('rejects empty input', () => {
    const r = parseFrontmatterBytes(new Uint8Array());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('frontmatter');
  });
});
