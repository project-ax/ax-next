import { describe, it, expect } from 'vitest';
import { describeMediaType, downloadFilename, mediaTypeForPath } from '../artifacts/media.js';

// One table drives both directions: a published file's path names its media
// type, and a stored media type names its kind, preview and download extension.
describe('artifact media types', () => {
  it.each([
    ['a/report.html', 'text/html', 'web', 'html', 'HTML'],
    ['page.HTM', 'text/html', 'web', 'html', 'HTML'],
    ['notes.md', 'text/markdown', 'document', 'markdown', 'MD'],
    ['q3.pdf', 'application/pdf', 'document', 'pdf', 'PDF'],
    ['memo.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document', 'none', 'DOCX'],
    ['readme.txt', 'text/plain', 'document', 'text', 'TXT'],
    ['t.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'spreadsheet', 'none', 'XLSX'],
    ['data.csv', 'text/csv', 'spreadsheet', 'text', 'CSV'],
    ['p.png', 'image/png', 'image', 'image', 'PNG'],
    ['p.jpeg', 'image/jpeg', 'image', 'image', 'JPG'],
    ['c.svg', 'image/svg+xml', 'image', 'image', 'SVG'],
    ['d.json', 'application/json', 'code', 'text', 'JSON'],
    ['x.py', 'text/x-python', 'code', 'text', 'PY'],
    ['x.ts', 'text/x-typescript', 'code', 'text', 'TS'],
    ['c.yml', 'application/yaml', 'code', 'text', 'YAML'],
    ['blob.bin', 'application/octet-stream', 'file', 'none', ''],
    ['Makefile', 'application/octet-stream', 'file', 'none', ''],
    ['.html', 'application/octet-stream', 'file', 'none', ''],
  ])('maps %s', (p, mt, kind, preview, ext) => {
    expect(mediaTypeForPath(p)).toBe(mt);
    expect(describeMediaType(mt)).toEqual({ kind, preview, extension: ext });
  });

  it('describes a media type with parameters or odd case by its bare type', () => {
    expect(describeMediaType('Text/HTML; charset=utf-8')).toEqual({ kind: 'web', preview: 'html', extension: 'HTML' });
    expect(describeMediaType('application/x-unknown')).toEqual({ kind: 'file', preview: 'none', extension: '' });
  });

  it('names downloads from the title plus extension, once', () => {
    expect(downloadFilename('Q3 report', 'PDF')).toBe('Q3 report.pdf');
    expect(downloadFilename('chart.PNG', 'PNG')).toBe('chart.PNG');
    expect(downloadFilename('notes', '')).toBe('notes');
  });
});
