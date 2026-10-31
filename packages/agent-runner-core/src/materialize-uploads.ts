// ---------------------------------------------------------------------------
// Copy the bound conversation's uploads into the sandbox, flat, so the agent can
// open them: `<scratch>/uploads/report.pdf`, `report (2).pdf`, … (TASK-995).
//
// The bytes live in the host's content-addressed blob store; the sandbox only
// needs a readable working copy. Each call:
//   1. lists the conversation's uploads (`attachments.list`, oldest first),
//   2. skips every attachment id it already copied (`known`),
//   3. fetches each new one (`blob.get`, streamed to a temp file the IPC client
//      hands us), and
//   4. copies it to `<uploadsDir>/<name>` under the first free name.
//
// Nothing is ever deleted, overwritten or followed:
//   - Names come from the person's own file name, which is hostile input. The
//     sanitizer keeps only the last path segment and drops control characters,
//     so every name is one plain entry directly inside `uploadsDir`.
//   - `uploadsDir` sits in agent-writable scratch. The agent may already have
//     put a file, or a symlink, under the name we want. `COPYFILE_EXCL` creates
//     the destination exclusively — it fails on ANY existing entry, a symlink
//     included (dangling or not) — and we move on to the next free name.
//   - `uploadsDir` itself must be a real directory, not a symlink to one.
//   - There is no wipe. A later call writes only attachments it has not copied,
//     and keeps the names it already handed out.
//
// Names are deterministic: the list order is fixed (oldest first, then id) and
// names are assigned over the whole list in that order, a failed fetch still
// holding its name, so a fresh pod given the same list derives the same names
// and a resumed transcript's mentions still point at the right files.
//
// The copy is a convenience for the agent, not a trusted source: it is
// agent-writable. Translation (attachment-translation.ts) re-checks a copy's
// hash before handing its bytes to the model as the person's file.
//
// Best-effort: a list failure, a missing blob or a failed copy is logged and
// skipped, never fatal. A skipped upload stays out of `known`, so the next call
// tries it again (under the same name), and translation degrades it to a
// "could not be loaded" line until then.
// ---------------------------------------------------------------------------

import { constants as fsConstants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AttachmentsListResponseSchema, type IpcClient } from '@ax/ipc-protocol';

/**
 * Where a session's upload copies live: `uploads/` under its scratch root. The
 * one definition, so the directory the runner writes and the directory the
 * files note names to the model (`filesNote`) cannot drift.
 */
export function scratchUploadsDir(scratchRoot: string): string {
  return path.join(scratchRoot, 'uploads');
}

/** One upload copied into the sandbox, by attachment id. */
export interface MaterializedUpload {
  attachmentId: string;
  /** The person's name for the file, as the host listed it (display only). */
  filename: string;
  /** Absolute path of the copy inside the sandbox. */
  path: string;
  /** Content digest of the person's file, from the host's list. */
  sha256: string;
  mediaType: string;
  sizeBytes: number;
}

export interface MaterializeUploadsOptions {
  client: Pick<IpcClient, 'call' | 'callBinary'>;
  /** The conversation this session is bound to; the host lists no other. */
  conversationId: string;
  /** Absolute directory the copies land in: `<scratch>/uploads`. */
  uploadsDir: string;
  /** Uploads already copied, by attachment id. New entries are added in place. */
  known: Map<string, MaterializedUpload>;
  /** Runner stderr line. Never fatal. */
  warn: (msg: string) => void;
}

/** Longest name, in UTF-8 bytes, before any ` (n)` suffix. */
const NAME_MAX_BYTES = 200;
/** Longest extension (dot included), in UTF-8 bytes, that the length cap keeps. */
const EXTENSION_MAX_BYTES = 16;
/** Highest collision number tried: `name (999).ext`. */
const MAX_COLLISION = 999;
/** What an unusable name becomes. */
const FALLBACK_NAME = 'file';

/**
 * Remove characters that would split a name across lines or hide in a
 * terminal: C0 controls, DEL, C1 controls, and the Unicode line and paragraph
 * separators. A lone surrogate becomes U+FFFD, which is how it would be written
 * to disk anyway, so the name in memory is the name on disk.
 */
export function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) continue;
    out += cp >= 0xd800 && cp <= 0xdfff ? '�' : ch;
  }
  return out;
}

/** Split at the last dot, where that dot is neither the first nor the last character. */
function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** The longest prefix of `value` that fits in `maxBytes` of UTF-8, cut between code points. */
function truncateUtf8(value: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const ch of value) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

/**
 * The on-disk name for an upload: the last segment of `filename` (split on `/`
 * and `\`), control characters dropped, trimmed, and capped at 200 UTF-8 bytes
 * on a code-point boundary, keeping an extension of up to 16 bytes. Empty, `.`
 * and `..` become `file`. The result is always one plain directory entry.
 */
export function sanitizeUploadName(filename: string): string {
  const segments = filename.split(/[/\\]/);
  let name = stripControlChars(segments[segments.length - 1] ?? '').trim();
  if (Buffer.byteLength(name, 'utf8') > NAME_MAX_BYTES) {
    const { stem, ext } = splitExtension(name);
    const extBytes = Buffer.byteLength(ext, 'utf8');
    name =
      ext !== '' && extBytes <= EXTENSION_MAX_BYTES
        ? truncateUtf8(stem, NAME_MAX_BYTES - extBytes) + ext
        : truncateUtf8(name, NAME_MAX_BYTES);
    name = name.trim();
  }
  return name === '' || name === '.' || name === '..' ? FALLBACK_NAME : name;
}

/**
 * The `n`th name for `name` (n ≥ 2): ` (n)` goes before the last extension
 * dot — `report (2).pdf`, `notes (2)`, `.bashrc (2)`, `archive.tar (2).gz`.
 */
export function collisionName(name: string, n: number): string {
  const { stem, ext } = splitExtension(name);
  return `${stem} (${n})${ext}`;
}

/**
 * `<dir>/<name>` for a resolved `dir`, refusing any name that is not exactly
 * one entry inside it. The sanitizer already guarantees that; this is the
 * containment check that does not depend on it.
 */
function entryPath(dir: string, name: string): string {
  const dest = path.join(dir, name);
  if (path.dirname(dest) !== dir || path.basename(dest) !== name) {
    throw new Error('upload name is not a single directory entry');
  }
  return dest;
}

/**
 * The first name for `base`, from collision number `from` on, that no upload
 * has claimed: `base` itself for n = 1, then `collisionName(base, n)`. Null
 * when every number up to MAX_COLLISION is taken.
 */
function nextUnclaimedName(
  base: string,
  claimed: ReadonlySet<string>,
  from: number,
): { name: string; n: number } | null {
  for (let n = from; n <= MAX_COLLISION; n += 1) {
    const name = n === 1 ? base : collisionName(base, n);
    if (!claimed.has(name)) return { name, n };
  }
  return null;
}

/**
 * Copy `src` into `dir` under `slot`, or, when that entry already exists on
 * disk, under the next unclaimed name. Every name tried is added to `claimed`.
 * Null if none is free.
 */
async function copyUnderFreeName(
  src: string,
  dir: string,
  base: string,
  slot: { name: string; n: number },
  claimed: Set<string>,
): Promise<string | null> {
  let current: { name: string; n: number } | null = slot;
  while (current !== null) {
    const dest = entryPath(dir, current.name);
    try {
      // Exclusive create: fails with EEXIST on any existing entry, including a
      // symlink, so a planted link is never followed and nothing is replaced.
      await fs.copyFile(src, dest, fsConstants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    current = nextUnclaimedName(base, claimed, current.n + 1);
    if (current !== null) claimed.add(current.name);
  }
  return null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Copy the conversation's uploads that `known` does not have yet into
 * `uploadsDir`, recording each in `known`. Best-effort; never throws.
 */
export async function materializeUploads(opts: MaterializeUploadsOptions): Promise<void> {
  let files;
  try {
    const raw = await opts.client.call('attachments.list', { conversationId: opts.conversationId });
    files = AttachmentsListResponseSchema.parse(raw).files;
  } catch (err) {
    opts.warn(`runner: attachments.list failed; no uploads copied into the sandbox: ${message(err)}`);
    return;
  }
  if (files.every((file) => opts.known.has(file.attachmentId))) return;

  // Normalized once: `lstat("dir/")` would resolve a symlinked `dir` before
  // looking, so a trailing slash must never reach the check below.
  const dir = path.resolve(opts.uploadsDir);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await fs.lstat(dir);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch (err) {
    opts.warn(`runner: ${dir} is not a usable directory; no uploads copied: ${message(err)}`);
    return;
  }

  // Names are handed out over the whole list, in list order, from one set of
  // claimed names: every name a copy already holds, plus the name each earlier
  // file in this list was given. A file claims its name BEFORE its bytes are
  // fetched and keeps the claim when the fetch fails, so a missing blob never
  // shifts the names after it: B gets the name it gets on a fresh pod that has
  // every blob, and A's later retry gets A's. (The only deviation is a name the
  // agent has since taken on disk: the exclusive create refuses it and the
  // copy moves on to the next unclaimed name.)
  const claimed = new Set<string>();
  for (const upload of opts.known.values()) claimed.add(path.basename(upload.path));

  for (const file of files) {
    if (opts.known.has(file.attachmentId)) continue;
    const base = sanitizeUploadName(file.filename);
    const slot = nextUnclaimedName(base, claimed, 1);
    if (slot === null) {
      opts.warn(`runner: no free name for upload ${file.attachmentId} in ${dir}`);
      continue;
    }
    claimed.add(slot.name);
    let tempPath: string | undefined;
    try {
      const got = await opts.client.callBinary('blob.get', { sha256: file.sha256 });
      tempPath = got.path;
      const dest = await copyUnderFreeName(tempPath, dir, base, slot, claimed);
      if (dest === null) {
        opts.warn(`runner: no free name for upload ${file.attachmentId} in ${dir}`);
        continue;
      }
      opts.known.set(file.attachmentId, {
        attachmentId: file.attachmentId,
        filename: file.filename,
        path: dest,
        sha256: file.sha256,
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes,
      });
    } catch (err) {
      opts.warn(`runner: could not copy upload ${file.attachmentId} into the sandbox: ${message(err)}`);
    } finally {
      if (tempPath !== undefined) {
        await fs.unlink(tempPath).catch(() => {
          /* best-effort: the blob.get temp file is ours to remove */
        });
      }
    }
  }
}
