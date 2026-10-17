/**
 * The file-serving helpers every file route on this surface shares: the
 * agent's two tiers (routes-workspace.ts) and a project's folder
 * (routes-projects.ts).
 *
 * Moved here out of routes-workspace.ts (W3b) so the project routes answer in
 * the SAME shape, with the SAME fences and the SAME download headers, rather
 * than a copy that drifts. routes-workspace.ts re-exports every name it used to
 * export, so its importers are unchanged.
 */
import { stripSurfaceRewritersFromDocument } from '@ax/core/surface-text';
import { fenceLine } from '../lib/fence-line.js';
import { sanitizeContentDispositionFilename } from './content-disposition.js';
import type { RouteResponse } from './routes-chat.js';

/**
 * `GET /api/workspace/agents/:agentId/user-files[/*]` — the DURABLE tier.
 *
 * A different tier from `/files`, and the distinction is the whole
 * reason this exists. `/files` reads `workspace:*`, which is the git-backed
 * `/agent` tier — AX's own machinery plus whatever the agent committed. THIS
 * reads the agent's durable user-files tier, which since TASK-164 is the
 * agent's cwd and HOME: it is where a deliverable lands when nobody said
 * otherwise, and until now it was invisible in the UI.
 *
 * It is a TREE, not a list, because that is what the backing hook answers:
 * `sandbox:read-user-files` returns one directory's immediate children, not a
 * recursive walk. So one shape covers both answers and the client navigates.
 *
 * `path` / `name` keep the same split as `WorkspaceFileSummary`, for the same
 * reason: `path` is the raw key the client puts back on the wire and is never
 * rendered; `name` is the fenced label. On this tier the filenames are, if
 * anything, MORE agent-authored than on the other one — nothing here has been
 * through a git commit — so the Trojan-source fence (CVE-2021-42574) is not
 * optional.
 *
 * `GET /api/workspace/projects/:projectId/files[/*]` (W3b) answers in this
 * same shape, plus the optional `size` / `updatedAt` / `downloadable` fields
 * a project folder's reader can supply.
 */
export interface UserFileEntry {
  /** RAW key, relative to the tier root. `docs/note.md`. Never rendered. */
  path: string;
  /** The fenced label — one path segment. */
  name: string;
  kind: 'file' | 'dir';
  /**
   * Bytes on disk, files only. Present when the backing reader reports it
   * (a project folder does; the agent's durable tier does not yet), absent
   * otherwise — never a guessed `0`.
   */
  size?: number;
  /** ISO-8601 last-modified time, under the same rule as `size`. */
  updatedAt?: string;
}

export type AgentUserFilesResponse =
  | {
      kind: 'dir';
      /** The raw key this answers for. `''` is the tier root. */
      path: string;
      /** The fenced label — the last segment, or `''` at the root. */
      name: string;
      entries: UserFileEntry[];
      /**
       * `true` when the directory holds more children than one response
       * carries. Said out loud for the same reason the other listing says it:
       * a list that silently stops is a list that claims the agent has that
       * many files and no more.
       */
      truncated: boolean;
    }
  | {
      kind: 'file';
      path: string;
      name: string;
      body: string | null;
      clipped: 'binary' | 'too-large' | null;
      /**
       * The whole file's size in bytes, when the reader reports it (project
       * folders do). Lets the UI say "12.3 MB" for a file it won't preview.
       */
      size?: number;
      /**
       * Whether the matching download route will serve this file. Present only
       * where the server KNOWS (project files: `size` ≤ the 10 MiB download
       * cap); absent means "try it" — the agent tiers learn it from the 413.
       * The download route still decides: this is a hint for what to offer,
       * never the gate.
       */
      downloadable?: boolean;
    };

/**
 * How much of a filename this surface will carry as a LABEL. Longer than a
 * feed row's 60 because a path is legitimately `notes/2026/q3-summary.md` and
 * chopping it at 60 turns two distinct files into the same row.
 */
export const FILE_LABEL_MAX_CHARS = 120;

/**
 * How many rows one listing will carry, and how much of one file we will send.
 *
 * Both are bounds on somebody else's output. An agent can write a hundred
 * thousand files and a gigabyte into one of them; neither number is a reason
 * for this process to build a hundred-megabyte JSON string. When either bound
 * bites, the response SAYS SO rather than quietly serving less than it claims.
 */
export const WORKSPACE_FILES_MAX = 500;
export const FILE_BODY_MAX_BYTES = 128 * 1024;

/** How far in we look for a NUL before calling a file "not text". */
const BINARY_PROBE_BYTES = 8000;

/** What a row says when the agent's filename fences down to nothing legible. */
export const UNREADABLE_FILE_NAME = 'A file with no readable name';

/**
 * A file's text, with the characters that rewrite a surface removed.
 *
 * The sibling of `fenceLine`, and different from it on purpose. `fenceLine`
 * flattens all whitespace because it is producing a LABEL — one row, one line.
 * A body is a document: newlines and tabs are its structure, and collapsing
 * them would turn a markdown file into one long paragraph. So this strips the
 * same bidi / zero-width / control family MINUS tab, newline and carriage
 * return.
 *
 * They are removed rather than replaced with a space, because in a document
 * the separators that do real work are the ones we are keeping anyway.
 */
export function fenceBody(text: string): string {
  return stripSurfaceRewritersFromDocument(text);
}

/** Shared so a clipped read and a whole read decode identically. */
const FILE_DECODER = new TextDecoder('utf-8');

/**
 * Bytes → what the Files tab can honestly show.
 *
 * A workspace holds whatever the agent put in it, which includes PNGs, PDFs
 * and sqlite files. Decoding one of those as UTF-8 produces a page of
 * replacement characters that LOOKS like a corrupted document — so we say
 * "this is not a text file" instead, and let the tab render that.
 */
export function decodeFileBody(bytes: Uint8Array): {
  body: string | null;
  clipped: 'binary' | 'too-large' | null;
} {
  const probe = bytes.subarray(0, Math.min(bytes.length, BINARY_PROBE_BYTES));
  if (probe.includes(0)) return { body: null, clipped: 'binary' };
  if (bytes.length > FILE_BODY_MAX_BYTES) {
    return {
      body: fenceBody(FILE_DECODER.decode(bytes.subarray(0, FILE_BODY_MAX_BYTES))),
      clipped: 'too-large',
    };
  }
  return { body: fenceBody(FILE_DECODER.decode(bytes)), clipped: null };
}

/**
 * The response adapter a DOWNLOAD needs, on top of the one every other route
 * on this surface uses.
 *
 * `RouteResponse` (routes-chat.ts) is deliberately tiny — status, json, text,
 * end — because that is all a JSON surface needs, and every test in this
 * package builds one by hand. Widening it would make every one of those fakes
 * a compile error for the benefit of two routes. So the two routes declare the
 * extra shape they use, and it is still the same duck-typed mirror of
 * `@ax/http-server`'s `HttpResponse` (invariant I2 — no cross-plugin import).
 */
export interface DownloadRouteResponse extends RouteResponse {
  status(n: number): DownloadRouteResponse;
  header(name: string, value: string): DownloadRouteResponse;
  /** Raw bytes. Single-shot, like every other terminator on this adapter. */
  body(buf: Buffer, contentType?: string): void;
}

/**
 * THE content type of every download this surface serves.
 *
 * Not derived from the bytes, not read off the file's extension, and — most of
 * all — never taken from anything the caller sent. Every one of those is a way
 * for the file's own content to decide how a browser treats it, and the file
 * was written by an agent. `text/html` on an agent-authored file is stored XSS
 * on our origin; `image/svg+xml` is the same thing wearing a picture.
 *
 * `application/octet-stream` plus `nosniff` plus `Content-Disposition:
 * attachment` is the boring combination that means "save this, do not run it".
 * The cost is that a PNG will not preview in a tab. That is the intended
 * trade: this is a download affordance, and previewing is what the Files tab
 * already does, in a renderer we control.
 */
const DOWNLOAD_CONTENT_TYPE = 'application/octet-stream';

/**
 * One file's bytes, as a download, with the headers that keep it one.
 *
 * `path` is the RAW workspace key. Only its last segment reaches the header,
 * and only after `sanitizeContentDispositionFilename` — the name is
 * agent-authored, and `Content-Disposition` is a header a newline can end.
 */
export function sendFileDownload(
  res: DownloadRouteResponse,
  path: string,
  bytes: Uint8Array,
): void {
  // A view over the same memory, not a copy: these files are already as big as
  // this process is willing to hold, and doubling that to add a header would
  // be a strange way to spend a megabyte.
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const filename = sanitizeContentDispositionFilename(basenameOf(path));
  res.status(200);
  // Stated, not defaulted. `body()` would fall back to the same value, but a
  // route that serves somebody else's bytes should say what it is serving them
  // as rather than inherit it — and the day the framework's default changes,
  // this one does not.
  res.header('content-type', DOWNLOAD_CONTENT_TYPE);
  res.header('content-disposition', `attachment; filename="${filename}"`);
  res.header('x-content-type-options', 'nosniff');
  // No `content-length` here: `@ax/http-server` pins it from the buffer it is
  // about to write. A second copy computed here could only ever agree with it
  // or be wrong, and the framework's would win either way (invariant 4).
  res.body(buf);
}

/**
 * How many children of one durable-tier directory a response will carry.
 *
 * Smaller than the reader's own cap on purpose: the reader bounds what this
 * PROCESS reads off an NFS mount, this bounds what one HTTP response carries.
 * Two different resources, two different numbers, and the response says when
 * this one bites.
 */
export const USER_FILES_ENTRIES_MAX = 500;

/** The last segment of a raw key — the label the viewer heads a file with. */
export function basenameOf(rawPath: string): string {
  const cut = rawPath.lastIndexOf('/');
  return cut === -1 ? rawPath : rawPath.slice(cut + 1);
}

/**
 * One directory child → one row. The key raw and joined, the label fenced.
 * `size` / `updatedAt` are carried through only when the reader supplied
 * them, so a reader that doesn't (the agent's durable tier) answers exactly
 * the rows it always did.
 */
export function toUserFileEntry(
  parentPath: string,
  entry: { name: string; kind: 'file' | 'dir'; size?: number; updatedAt?: string },
): UserFileEntry {
  return {
    path: parentPath === '' ? entry.name : `${parentPath}/${entry.name}`,
    name: fenceLine(entry.name, FILE_LABEL_MAX_CHARS) ?? UNREADABLE_FILE_NAME,
    kind: entry.kind,
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
  };
}
