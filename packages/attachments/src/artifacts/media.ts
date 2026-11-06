import type { z } from 'zod';
import type { ArtifactKindSchema } from '@ax/ipc-protocol';

/** What kind of thing an artifact is. The one definition lives in ipc-protocol. */
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/** How a viewer may show the bytes. `none` = download only. */
export type ArtifactPreview = 'html' | 'markdown' | 'image' | 'text' | 'pdf' | 'none';

interface MediaEntry {
  /** File extensions (lowercase, no dot). The first one names the download extension. */
  exts: readonly string[];
  mediaType: string;
  kind: ArtifactKind;
  preview: ArtifactPreview;
  /** Shown on the artifact and appended to a download name. */
  extension: string;
}

const OCTET_STREAM = 'application/octet-stream';

/**
 * One table drives both directions: a published file's path names its media
 * type (we never trust a caller-supplied type, and never sniff the bytes), and
 * a stored media type names its kind, preview and download extension.
 */
const TABLE: readonly MediaEntry[] = [
  { exts: ['html', 'htm'], mediaType: 'text/html', kind: 'web', preview: 'html', extension: 'HTML' },
  { exts: ['md', 'markdown'], mediaType: 'text/markdown', kind: 'document', preview: 'markdown', extension: 'MD' },
  { exts: ['pdf'], mediaType: 'application/pdf', kind: 'document', preview: 'pdf', extension: 'PDF' },
  {
    exts: ['docx'],
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
    preview: 'none',
    extension: 'DOCX',
  },
  { exts: ['txt'], mediaType: 'text/plain', kind: 'document', preview: 'text', extension: 'TXT' },
  {
    exts: ['xlsx'],
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    kind: 'spreadsheet',
    preview: 'none',
    extension: 'XLSX',
  },
  { exts: ['csv'], mediaType: 'text/csv', kind: 'spreadsheet', preview: 'text', extension: 'CSV' },
  { exts: ['png'], mediaType: 'image/png', kind: 'image', preview: 'image', extension: 'PNG' },
  { exts: ['jpg', 'jpeg'], mediaType: 'image/jpeg', kind: 'image', preview: 'image', extension: 'JPG' },
  { exts: ['gif'], mediaType: 'image/gif', kind: 'image', preview: 'image', extension: 'GIF' },
  { exts: ['webp'], mediaType: 'image/webp', kind: 'image', preview: 'image', extension: 'WEBP' },
  { exts: ['svg'], mediaType: 'image/svg+xml', kind: 'image', preview: 'image', extension: 'SVG' },
  { exts: ['json'], mediaType: 'application/json', kind: 'code', preview: 'text', extension: 'JSON' },
  ...(
    [
      ['py', 'text/x-python'],
      ['js', 'text/javascript'],
      ['ts', 'text/x-typescript'],
      ['sh', 'text/x-shellscript'],
      ['css', 'text/css'],
      ['yaml', 'application/yaml'],
      ['yml', 'application/yaml'],
      ['xml', 'application/xml'],
      ['sql', 'application/sql'],
    ] as const
  ).map(([ext, mediaType]): MediaEntry => ({
    exts: [ext],
    mediaType,
    kind: 'code',
    preview: 'text',
    extension: ext.toUpperCase(),
  })),
];

const BY_EXT = new Map<string, MediaEntry>();
const BY_MEDIA_TYPE = new Map<string, MediaEntry>();
for (const entry of TABLE) {
  for (const ext of entry.exts) BY_EXT.set(ext, entry);
  // First entry wins (yaml before yml), so a media type has one extension.
  if (!BY_MEDIA_TYPE.has(entry.mediaType)) BY_MEDIA_TYPE.set(entry.mediaType, entry);
}

/** The media type a published file is stored under, from its extension alone. */
export function mediaTypeForPath(sourcePath: string): string {
  const base = sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  // No extension, or a dotfile with nothing before the dot (`.html`).
  if (dot <= 0) return OCTET_STREAM;
  return BY_EXT.get(base.slice(dot + 1).toLowerCase())?.mediaType ?? OCTET_STREAM;
}

/** Kind, preview and download extension for a stored media type. */
export function describeMediaType(mediaType: string): {
  kind: ArtifactKind;
  preview: ArtifactPreview;
  extension: string;
} {
  const bare = (mediaType.split(';')[0] ?? '').trim().toLowerCase();
  const entry = BY_MEDIA_TYPE.get(bare);
  if (entry === undefined) return { kind: 'file', preview: 'none', extension: '' };
  return { kind: entry.kind, preview: entry.preview, extension: entry.extension };
}

/**
 * The name a download is saved under: the title, plus the extension unless
 * the title already ends with it (any case).
 */
export function downloadFilename(title: string, extension: string): string {
  if (extension === '') return title;
  const suffix = `.${extension.toLowerCase()}`;
  if (title.toLowerCase().endsWith(suffix)) return title;
  return `${title}${suffix}`;
}
