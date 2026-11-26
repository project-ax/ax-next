import { Code2, File, FileText, Globe, Image, Sheet } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { formatFileSize } from '../index.js';
import { fileIcon, splitFileName } from '../internal/file.js';

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

// The one size formatter: the file chips and the Storage tab both read sizes through it. These cases came over from
// channel-web's storage-copy `formatBytes` when it was folded in here.
describe('formatFileSize', () => {
  it('has one bucket per unit', () => {
    expect(formatFileSize(812)).toBe('812 B');
    expect(formatFileSize(1.2 * KB)).toBe('1.2 KB');
    expect(formatFileSize(3.4 * MB)).toBe('3.4 MB');
    expect(formatFileSize(1.1 * GB)).toBe('1.1 GB');
  });

  it('counts in 1024s, with one decimal only when there is one to show', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1)).toBe('1 B');
    expect(formatFileSize(1023)).toBe('1023 B');
    expect(formatFileSize(KB)).toBe('1 KB');
    expect(formatFileSize(1.5 * KB)).toBe('1.5 KB');
    expect(formatFileSize(MB)).toBe('1 MB');
    expect(formatFileSize(123.4 * MB)).toBe('123.4 MB');
    expect(formatFileSize(GB)).toBe('1 GB');
    expect(formatFileSize(2.3 * GB)).toBe('2.3 GB');
    expect(formatFileSize(5 * GB)).toBe('5 GB');
    expect(formatFileSize(3 * 1024 * GB)).toBe('3 TB');
  });

  it('trims a ".0" that rounding leaves behind', () => {
    expect(formatFileSize(1.04 * MB)).toBe('1 MB');
    expect(formatFileSize(2.04 * GB)).toBe('2 GB');
  });

  it('rolls over to the next unit instead of printing "1024 KB"', () => {
    expect(formatFileSize(1024 * KB - 1)).toBe('1 MB');
    expect(formatFileSize(1024 * MB - 1)).toBe('1 GB');
  });

  it('never prints nonsense for input that is not a size', () => {
    expect(formatFileSize(-5)).toBe('0 B');
    expect(formatFileSize(Number.NaN)).toBe('0 B');
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe('0 B');
  });

  it('stops at TB rather than inventing a unit', () => {
    expect(formatFileSize(2048 * 1024 * GB)).toBe('2048 TB');
  });
});

describe('splitFileName', () => {
  it('splits at the last dot: the stem truncates, the extension stays', () => {
    expect(splitFileName('report.final.csv')).toEqual(['report.final', '.csv']);
    expect(splitFileName('Q3 plan #1.pdf')).toEqual(['Q3 plan #1', '.pdf']);
  });

  it('a name with no extension is all stem', () => {
    expect(splitFileName('README')).toEqual(['README', '']);
    expect(splitFileName('Q3 report')).toEqual(['Q3 report', '']);
  });

  it('a dotfile is all stem, not an empty stem and an extension', () => {
    expect(splitFileName('.env')).toEqual(['.env', '']);
  });

  it('a trailing dot or a long tail after the last dot is not an extension', () => {
    expect(splitFileName('notes.')).toEqual(['notes.', '']);
    // An "extension" longer than any real one is a sentence with a dot in it: keeping it whole would eat the stem.
    expect(splitFileName('Meeting notes. Draft for the leadership offsite review')).toEqual([
      'Meeting notes. Draft for the leadership offsite review',
      '',
    ]);
    expect(splitFileName('archive.tar gz')).toEqual(['archive.tar gz', '']);
  });

  it('a clamped name (ending in an ellipsis) is all stem', () => {
    expect(splitFileName(`${'a'.repeat(20)}…`)).toEqual([`${'a'.repeat(20)}…`, '']);
  });
});

describe('fileIcon', () => {
  it('maps media types', () => {
    expect(fileIcon('image/png')).toBe(Image);
    expect(fileIcon('application/pdf')).toBe(FileText);
    expect(fileIcon('text/csv')).toBe(Sheet);
    expect(fileIcon('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(Sheet);
    expect(fileIcon('text/html')).toBe(Globe);
    expect(fileIcon('application/json')).toBe(Code2);
    expect(fileIcon('text/plain')).toBe(FileText);
    expect(fileIcon('text/plain; charset=utf-8')).toBe(FileText);
    expect(fileIcon('application/zip')).toBe(File);
  });

  it('maps extensions, with or without the dot, in any case', () => {
    expect(fileIcon('PNG')).toBe(Image);
    expect(fileIcon('.jpg')).toBe(Image);
    expect(fileIcon('pdf')).toBe(FileText);
    expect(fileIcon('CSV')).toBe(Sheet);
    expect(fileIcon('xlsx')).toBe(Sheet);
    expect(fileIcon('HTML')).toBe(Globe);
    expect(fileIcon('py')).toBe(Code2);
    expect(fileIcon('MD')).toBe(FileText);
  });

  it('anything unknown, or nothing, is a plain file', () => {
    expect(fileIcon('xyz')).toBe(File);
    expect(fileIcon('')).toBe(File);
    expect(fileIcon(undefined)).toBe(File);
  });
});
