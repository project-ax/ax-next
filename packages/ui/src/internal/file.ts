import { Code2, File, FileText, Globe, Image, Sheet, type LucideIcon } from 'lucide-react';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * "812 B", "1.2 KB", "3.4 MB", "1.1 GB". Counts in 1024s, shows one decimal only when there is one to show, and rolls
 * up a unit rather than print "1024 KB". Anything that is not a size (negative, NaN, infinite) reads as "0 B": a screen
 * that says "NaN GB" is worse than one that says nothing is there.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let unit = 0;
  let value = bytes;
  while (unit < UNITS.length - 1) {
    const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    if (rounded < 1024) break;
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : (Math.round(value * 10) / 10).toFixed(1);
  return `${text.replace(/\.0$/, '')} ${UNITS[unit]}`;
}

// A real extension: letters and digits, at most 12, after a dot that isn't the first character (a dotfile is all stem).
const EXTENSION = /\.[a-z0-9]{1,12}$/i;

/** `[stem, extension]`: the stem may truncate, the extension (with its dot) always shows. `''` when there is none. */
export function splitFileName(name: string): [string, string] {
  const match = EXTENSION.exec(name);
  if (match === null || match.index === 0) return [name, ''];
  return [name.slice(0, match.index), match[0]];
}

// The same six pictures as an artifact's kind (document, web page, spreadsheet, image, code, file), so a file and the
// artifact made from it look alike wherever they show up.
const BY_EXTENSION: ReadonlyMap<string, LucideIcon> = new Map(
  (
    [
      [Image, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif', 'avif', 'ico', 'tif', 'tiff']],
      [FileText, ['pdf', 'md', 'markdown', 'txt', 'doc', 'docx', 'rtf', 'odt', 'pages']],
      [Sheet, ['csv', 'tsv', 'xls', 'xlsx', 'ods', 'numbers']],
      [Globe, ['html', 'htm']],
      [Code2, ['json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'css', 'yaml', 'yml', 'xml', 'sql', 'go', 'rs', 'java', 'rb']],
    ] as const
  ).flatMap(([icon, exts]) => exts.map((ext): [string, LucideIcon] => [ext, icon])),
);

const SPREADSHEET_TYPES = new Set([
  'text/csv',
  'text/tab-separated-values',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
]);
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
]);
const CODE_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/xml',
  'application/yaml',
  'application/sql',
  'text/javascript',
  'text/css',
  'text/xml',
  'text/x-python',
  'text/x-typescript',
  'text/x-shellscript',
]);

function iconForMediaType(type: string): LucideIcon {
  if (type.startsWith('image/')) return Image;
  if (type === 'text/html') return Globe;
  if (SPREADSHEET_TYPES.has(type)) return Sheet;
  if (CODE_TYPES.has(type)) return Code2;
  if (DOCUMENT_TYPES.has(type) || type.startsWith('text/')) return FileText;
  return File;
}

/** The icon for a media type ("image/png") or an extension ("PDF", ".csv"). Anything unknown is a plain file. */
export function fileIcon(kind: string | undefined): LucideIcon {
  const k = (kind ?? '').split(';')[0]!.trim().toLowerCase();
  if (k.includes('/')) return iconForMediaType(k);
  return BY_EXTENSION.get(k.replace(/^\./, '')) ?? File;
}
