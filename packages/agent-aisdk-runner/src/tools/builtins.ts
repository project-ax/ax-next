// ---------------------------------------------------------------------------
// The six in-sandbox built-in tools: Bash, Read, Write, Edit, Glob, Grep.
//
// The claude-sdk runner gets these from the Claude Agent SDK. This runner has
// no SDK, so it implements them — which means we also inherit the SDK's job of
// making them SAFE to hand a model. Three properties do that work:
//
//   1. EVERY `execute` comes out of `wrapWithPolicy`. There is no other path to
//      an executor here (see policy-wrap.ts). `assertAllToolsWrapped` re-checks
//      the assembled set at boot, and the test enumerates it.
//
//   2. THE INPUT FIELD NAMES ARE NOT OURS TO CHOOSE. `resolveGovernedPaths` in
//      @ax/agent-runner-core re-roots governed paths by keying on exactly
//      `file_path`, `path` and `notebook_path` (its `PATH_INPUT_KEYS`). Spell a
//      file target `filePath` and the re-rooter silently stops firing: a write
//      to `.ax/SOUL.md` lands on the ungoverned tier, outside the validator and
//      outside the per-turn git bundle, and NOTHING fails loudly. So: Read /
//      Write / Edit take `file_path`; Glob / Grep take `path` + `pattern`.
//
//   3. EVERY INPUT VALUE IS MODEL OUTPUT — untrusted at every hop (invariant 5).
//      Bash is the ONLY tool here that reaches a shell, and it reaches it as
//      `spawn('bash', ['-lc', command])`: one argv element, no interpolation,
//      no `sh -c "..."` string building anywhere. The file tools use `node:fs`
//      directly and never hand a path to a shell. Path CONFINEMENT is not this
//      module's job — the sandbox is the boundary and the policy is the gate;
//      duplicating a half-baked path jail here would just be a second source of
//      truth to drift (invariant 4).
//
// Everything is bounded, because "the model asked for it" is not a resource
// budget: output size, line counts, line lengths, match counts, files scanned,
// bytes read per file, and wall-clock per search all have caps, and every cap
// announces itself in the result so the model knows it saw a partial answer
// rather than an empty one.
//
// Deliberately ABSENT (I₄): AskUserQuestion, WebFetch, WebSearch, Task,
// TodoWrite. Not denied — not registered. Web capability arrives separately as
// host tools (@ax/web-tools).
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import type { Dirent, Stats } from 'node:fs';
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { jsonSchema, tool, type Tool } from 'ai';
import type { HoldLatch, ToolPolicy } from '@ax/agent-runner-core';
import { wrapWithPolicy } from './policy-wrap.js';

// --- Bounds ----------------------------------------------------------------

/** Default wall-clock for a Bash call, matching the Claude built-in. */
const BASH_DEFAULT_TIMEOUT_MS = 120_000;
/** Hard ceiling, whatever the model asks for. Ten minutes of a turn is plenty. */
const BASH_MAX_TIMEOUT_MS = 600_000;
/** Floor, so a `timeout: 0` can't turn every command into an instant kill. */
const BASH_MIN_TIMEOUT_MS = 1_000;
/** Per-stream characters handed to the model. Beyond this we truncate loudly. */
const BASH_MAX_OUTPUT_CHARS = 30_000;
/**
 * Characters actually held in memory per stream. Everything past this is
 * counted but dropped, so a runaway `yes` can't grow the runner's heap while
 * we still report an honest truncated-by-N figure.
 */
const BASH_MAX_CAPTURE_CHARS = 1_000_000;

/** Lines returned by a single Read, matching the Claude built-in's default. */
const READ_MAX_LINES = 2_000;
/** Per-line characters; a minified bundle is one 4 MB "line" otherwise. */
const READ_MAX_LINE_CHARS = 2_000;
/** Bytes pulled off disk for a Read, before line/limit trimming. */
const READ_MAX_BYTES = 5 * 1024 * 1024;
/** Bytes sniffed for a NUL when deciding "is this text?". */
const BINARY_SNIFF_BYTES = 4_096;

/** Matches returned by a single Glob or Grep. */
const SEARCH_MAX_RESULTS = 200;
/** Files a single Grep will open. */
const GREP_MAX_FILES = 2_000;
/** Bytes a single Grep will read from one file; bigger files are skipped. */
const GREP_MAX_FILE_BYTES = 1024 * 1024;
/** Characters of one line fed to the model's regex — see `compilePattern`. */
const GREP_MAX_LINE_CHARS = 2_000;
/** Wall-clock budget for one search, checked between files. */
const SEARCH_BUDGET_MS = 15_000;

/**
 * Never walked into. `node_modules` is the expensive one; `.git` is expensive
 * AND useless (packed objects are binary). Other dot-directories need no rule:
 * the matcher's dot rule already stops `*` and `**` from crossing a dot segment,
 * while an EXPLICIT `.ax/**` still resolves — which is what we want, since
 * `.ax/` and `.claude/` are governed state the agent legitimately edits.
 */
const SEARCH_EXCLUDED_DIRS = new Set(['node_modules', '.git']);

/**
 * Extensions we treat as binary regardless of content, so a Read of a PNG can't
 * dump megabytes of mojibake into the transcript on the strength of the first
 * 4 KB happening to be NUL-free.
 */
const BINARY_EXTENSIONS = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.tiff', 'image/tiff'],
  ['.pdf', 'application/pdf'],
  ['.zip', 'application/zip'],
  ['.gz', 'application/gzip'],
  ['.tar', 'application/x-tar'],
  ['.bz2', 'application/x-bzip2'],
  ['.xz', 'application/x-xz'],
  ['.7z', 'application/x-7z-compressed'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.wasm', 'application/wasm'],
  ['.so', 'application/x-sharedlib'],
  ['.dylib', 'application/x-sharedlib'],
  ['.exe', 'application/x-msdownload'],
  ['.jar', 'application/java-archive'],
  ['.class', 'application/java-vm'],
  ['.sqlite', 'application/vnd.sqlite3'],
  ['.db', 'application/octet-stream'],
]);

// --- Public surface --------------------------------------------------------

export interface BuiltinToolsOptions {
  policy: ToolPolicy;
  /** cwd + HOME for Bash, and the root relative paths resolve against. */
  homeDir: string;
  /** Env for the Bash child — already composed by the caller (proxy + venv + PATH). */
  env: Record<string, string>;
  /** The one latch shared by every tool this turn — see WrapWithPolicyOptions. */
  holdLatch: HoldLatch;
}

/**
 * Build the six built-ins. The returned object is a `ToolSet` for `ai@7`; the
 * loop merges it with the host/sandbox catalog tools and `Skill`, then runs
 * `assertAllToolsWrapped` over the union.
 */
export function buildBuiltinTools(
  opts: BuiltinToolsOptions,
): Record<string, Tool> {
  const wrap = (
    name: string,
    run: (input: Record<string, unknown>, ctx: { abortSignal?: AbortSignal | undefined }) => Promise<string>,
  ): ReturnType<typeof wrapWithPolicy> =>
    wrapWithPolicy({ policy: opts.policy, name, isBuiltin: true, holdLatch: opts.holdLatch }, (input, ctx) =>
      run(input, { abortSignal: ctx.abortSignal }),
    );

  return {
    Bash: tool({
      description:
        'Run a shell command inside the agent sandbox with `bash -lc`, from the ' +
        "agent's home directory. Returns the command's stdout and stderr; a " +
        'non-zero exit is reported with its exit code rather than hidden. Use ' +
        'this for builds, tests, package managers and git — but prefer Read, ' +
        'Glob and Grep over cat/find/grep, which return better-shaped results.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          timeout: {
            type: 'number',
            description: `Timeout in milliseconds. Defaults to ${BASH_DEFAULT_TIMEOUT_MS}, maximum ${BASH_MAX_TIMEOUT_MS}.`,
          },
          description: {
            type: 'string',
            description:
              'A 5-10 word description of what this command does, in active voice.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      }),
      execute: wrap('Bash', (input, ctx) =>
        runBashTool(input, opts, ctx.abortSignal),
      ),
    }),

    Read: tool({
      description:
        'Read a file from the sandbox filesystem and return it with cat -n style ' +
        'line numbers, so you can quote exact lines back to Edit. Long files are ' +
        `truncated to ${READ_MAX_LINES} lines — use offset and limit to page ` +
        'through the rest. Images and other binary files come back as a short ' +
        'descriptor instead of their bytes.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description:
              'Path to the file. Relative paths resolve against the working directory.',
          },
          offset: {
            type: 'number',
            description: 'First line to read, 1-based. Defaults to 1.',
          },
          limit: {
            type: 'number',
            description: `How many lines to read. Defaults to and is capped at ${READ_MAX_LINES}.`,
          },
        },
        required: ['file_path'],
        additionalProperties: false,
      }),
      execute: wrap('Read', (input) => runReadTool(input, opts)),
    }),

    Write: tool({
      description:
        'Write a file to the sandbox filesystem, creating any missing parent ' +
        'directories and overwriting the file if it already exists. Prefer Edit ' +
        'for changing part of an existing file — Write replaces the whole thing.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description:
              'Path to the file. Relative paths resolve against the working directory.',
          },
          content: {
            type: 'string',
            description: 'The complete new contents of the file.',
          },
        },
        required: ['file_path', 'content'],
        additionalProperties: false,
      }),
      execute: wrap('Write', (input) => runWriteTool(input, opts)),
    }),

    Edit: tool({
      description:
        'Replace an exact string in a file. old_string must appear exactly once ' +
        'unless replace_all is true — if it appears more than once the edit is ' +
        'refused, so include surrounding lines to make it unique. Read the file ' +
        'first: old_string has to match the file byte for byte, without the line ' +
        'numbers Read adds.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description:
              'Path to the file. Relative paths resolve against the working directory.',
          },
          old_string: {
            type: 'string',
            description: 'The exact text to replace.',
          },
          new_string: {
            type: 'string',
            description: 'The replacement text. May be empty to delete.',
          },
          replace_all: {
            type: 'boolean',
            description:
              'Replace every occurrence instead of requiring exactly one.',
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
        additionalProperties: false,
      }),
      execute: wrap('Edit', (input) => runEditTool(input, opts)),
    }),

    Glob: tool({
      description:
        'Find files by glob pattern (for example "**/*.ts" or "src/**/test_*.py") ' +
        'and return their absolute paths. Fast on any repo size, and it never ' +
        `descends into node_modules or .git. Capped at ${SEARCH_MAX_RESULTS} ` +
        'results — narrow the pattern if you hit the cap.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The glob pattern to match against.',
          },
          path: {
            type: 'string',
            description:
              'Directory to search in. Defaults to the working directory.',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      }),
      execute: wrap('Glob', (input) => runGlobTool(input, opts)),
    }),

    Grep: tool({
      description:
        'Search file contents with a JavaScript regular expression and return ' +
        'matching lines as file:line:text. Optionally restrict the files with a ' +
        'glob. Skips node_modules, .git and binary files, and is capped at ' +
        `${SEARCH_MAX_RESULTS} matches — narrow the pattern or the glob if you ` +
        'hit the cap.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'JavaScript regular expression to search for.',
          },
          path: {
            type: 'string',
            description:
              'File or directory to search. Defaults to the working directory.',
          },
          glob: {
            type: 'string',
            description:
              'Restrict the search to files matching this glob, e.g. "**/*.ts".',
          },
          case_insensitive: {
            type: 'boolean',
            description: 'Match case-insensitively.',
          },
          show_line_numbers: {
            type: 'boolean',
            description:
              'Include line numbers in the output. Defaults to true.',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      }),
      execute: wrap('Grep', (input) => runGrepTool(input, opts)),
    }),
  };
}

// --- Bash ------------------------------------------------------------------

/**
 * Exported for the test, which is the only way to prove the clamp: the ceiling
 * is otherwise only observable by waiting ten minutes.
 */
export function resolveBashTimeoutMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return BASH_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(BASH_MAX_TIMEOUT_MS, Math.max(BASH_MIN_TIMEOUT_MS, raw));
}

interface BashOutcome {
  stdout: BoundedCapture;
  stderr: BoundedCapture;
  /** null when the child died on a signal rather than exiting. */
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Keeps the first `BASH_MAX_CAPTURE_CHARS` of a stream and counts the rest.
 * Counting the discarded tail is the point: it lets the truncation marker tell
 * the model how much it did NOT see, instead of quietly ending mid-sentence.
 */
class BoundedCapture {
  private readonly chunks: string[] = [];
  private kept = 0;
  total = 0;

  push(chunk: string): void {
    this.total += chunk.length;
    if (this.kept >= BASH_MAX_CAPTURE_CHARS) return;
    const room = BASH_MAX_CAPTURE_CHARS - this.kept;
    const take = chunk.length <= room ? chunk : chunk.slice(0, room);
    this.chunks.push(take);
    this.kept += take.length;
  }

  /** What the model sees: bounded, and loud about what was cut. */
  render(): string {
    const text = this.chunks.join('');
    if (this.total <= BASH_MAX_OUTPUT_CHARS) return text;
    return `${text.slice(0, BASH_MAX_OUTPUT_CHARS)}\n[... truncated ${this.total - BASH_MAX_OUTPUT_CHARS} chars]`;
  }
}

async function runBashTool(
  input: Record<string, unknown>,
  opts: BuiltinToolsOptions,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  const command = requireString(input, 'command', 'Bash');
  const timeoutMs = resolveBashTimeoutMs(input['timeout']);
  const outcome = await spawnBash(command, opts, timeoutMs, abortSignal);
  return formatBashOutcome(outcome, timeoutMs);
}

/**
 * `spawn`, not `execFile`, and the difference is load-bearing rather than
 * stylistic: `execFile` whitelists the spawn options it forwards and `detached`
 * is not among them, so its child never gets its own process group. Killing
 * only the shell then leaves the grandchildren holding the stdout pipe open,
 * and the exec callback — which waits for stdio EOF, not just process exit —
 * never fires. A `Bash` call with `sleep 30` and a 400 ms timeout hangs for the
 * full 30 s. (Found by the timeout test, which is why it exists.) The argv is
 * identical either way: `bash`, `-lc`, and the command as ONE element.
 */
function spawnBash(
  command: string,
  opts: BuiltinToolsOptions,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
): Promise<BashOutcome> {
  return new Promise<BashOutcome>((resolvePromise, rejectPromise) => {
    const stdout = new BoundedCapture();
    const stderr = new BoundedCapture();
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn('bash', ['-lc', command], {
      cwd: opts.homeDir,
      // HOME is filled in only if the caller's composed env doesn't set it;
      // the caller's value wins, since it composed the whole frame.
      env: { HOME: opts.homeDir, ...opts.env },
      // Own process group, so the timeout below can kill the whole tree.
      detached: true,
      // stdin is /dev/null: an interactive prompt the agent didn't expect
      // should EOF immediately rather than block until the timeout.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk));

    const killTree = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        // Negative pid = "the whole process group" (see `detached` above).
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone — nothing to do */
        }
      }
    };

    function onAbort(): void {
      aborted = true;
      killTree();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    // A signal that aborted BEFORE we subscribed never fires the listener, so
    // check the flag once rather than running a command the turn already gave
    // up on.
    if (abortSignal?.aborted === true) onAbort();

    const cleanup = (): void => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new Error(`Bash: failed to run the command — ${err.message}`));
    });

    // 'close' rather than 'exit': it fires once the pipes are drained too, so
    // we never truncate the tail of a command's output by racing its exit.
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ stdout, stderr, exitCode: code, timedOut, aborted });
    });
  });
}

/**
 * A failing command is a RESULT, not an error. The model needs to read the
 * compiler output of the build it just broke; throwing would replace it with an
 * opaque `error-text`. Same for a timeout — the partial output is often the
 * whole point (which line did the test hang on?).
 */
function formatBashOutcome(outcome: BashOutcome, timeoutMs: number): string {
  const sections: string[] = [];
  const stdout = outcome.stdout.render();
  const stderr = outcome.stderr.render();
  if (stdout.length > 0) sections.push(stdout);
  if (stderr.length > 0) sections.push(`[stderr]\n${stderr}`);

  if (outcome.timedOut) {
    sections.push(`[command timed out after ${timeoutMs}ms and was killed]`);
  } else if (outcome.aborted) {
    sections.push('[command was cancelled and killed]');
  }

  if (outcome.exitCode !== null && outcome.exitCode !== 0) {
    sections.push(`exit code: ${outcome.exitCode}`);
  }
  return sections.length === 0
    ? '(command produced no output; exit code: 0)'
    : sections.join('\n');
}

// --- Read ------------------------------------------------------------------

async function runReadTool(
  input: Record<string, unknown>,
  opts: BuiltinToolsOptions,
): Promise<string> {
  const filePath = resolvePath(requireString(input, 'file_path', 'Read'), opts);
  const info = await statOrThrow(filePath, 'Read');
  if (info.isDirectory()) {
    throw new Error(`Read: ${filePath} is a directory, not a file.`);
  }
  if (info.size === 0) return `(${filePath} is empty — 0 bytes)`;

  const capped = Math.min(info.size, READ_MAX_BYTES);
  const handle = await open(filePath, 'r');
  let text: string;
  let bytesRead: number;
  try {
    const buffer = Buffer.alloc(capped);
    ({ bytesRead } = await handle.read(buffer, 0, capped, 0));
    const view = buffer.subarray(0, bytesRead);
    const binaryType = detectBinaryType(filePath, view);
    if (binaryType !== null) {
      // A short descriptor, never the bytes: raw binary in the transcript is
      // both useless to the model and a fast way to blow the context window.
      return `[binary file] ${filePath} — ${info.size} bytes, detected type: ${binaryType}`;
    }
    text = view.toString('utf8');
  } finally {
    await handle.close();
  }

  const lines = text.split('\n');
  // `split` on a trailing newline leaves a phantom empty final element.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const offset = Math.max(1, toPositiveInt(input['offset'], 1));
  const limit = Math.min(
    READ_MAX_LINES,
    Math.max(1, toPositiveInt(input['limit'], READ_MAX_LINES)),
  );
  if (offset > lines.length) {
    return `(offset ${offset} is past the end of ${filePath} — the file has ${lines.length} line(s))`;
  }

  const end = Math.min(lines.length, offset - 1 + limit);
  const rendered: string[] = [];
  for (let i = offset - 1; i < end; i += 1) {
    rendered.push(`${String(i + 1).padStart(6, ' ')}\t${clampLine(lines[i] ?? '')}`);
  }
  if (end < lines.length) {
    rendered.push(
      `[... ${lines.length - end} more lines; pass offset=${end + 1} to continue]`,
    );
  }
  if (bytesRead < info.size) {
    rendered.push(
      `[... ${info.size - bytesRead} more bytes not read; this file exceeds the ${READ_MAX_BYTES}-byte Read cap]`,
    );
  }
  return rendered.join('\n');
}

function clampLine(line: string): string {
  return line.length <= READ_MAX_LINE_CHARS
    ? line
    : `${line.slice(0, READ_MAX_LINE_CHARS)} ... [line truncated, ${line.length - READ_MAX_LINE_CHARS} more chars]`;
}

/** Crude on purpose: extension first, then a NUL in the first few KB. */
function detectBinaryType(filePath: string, head: Buffer): string | null {
  const byExtension = BINARY_EXTENSIONS.get(extname(filePath).toLowerCase());
  if (byExtension !== undefined) return byExtension;
  return head.subarray(0, BINARY_SNIFF_BYTES).includes(0)
    ? 'application/octet-stream'
    : null;
}

// --- Write -----------------------------------------------------------------

async function runWriteTool(
  input: Record<string, unknown>,
  opts: BuiltinToolsOptions,
): Promise<string> {
  const filePath = resolvePath(requireString(input, 'file_path', 'Write'), opts);
  const content = requireStringAllowingEmpty(input, 'content', 'Write');
  const existed = await exists(filePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return `${existed ? 'Overwrote' : 'Created'} ${filePath} (${Buffer.byteLength(content, 'utf8')} bytes).`;
}

// --- Edit ------------------------------------------------------------------

async function runEditTool(
  input: Record<string, unknown>,
  opts: BuiltinToolsOptions,
): Promise<string> {
  const filePath = resolvePath(requireString(input, 'file_path', 'Edit'), opts);
  const oldString = requireString(input, 'old_string', 'Edit');
  const newString = requireStringAllowingEmpty(input, 'new_string', 'Edit');
  const replaceAll = input['replace_all'] === true;

  const before = await readTextOrThrow(filePath, 'Edit');
  const occurrences = before.split(oldString).length - 1;

  if (occurrences === 0) {
    throw new Error(
      `Edit: old_string was not found in ${filePath}. Read the file and copy the text exactly (without the line numbers Read adds).`,
    );
  }
  // The ambiguity guard. Silently editing the first of several matches is how
  // an agent "fixes" the wrong call site and reports success.
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `Edit: old_string appears ${occurrences} times in ${filePath}, so the edit is ambiguous. Add surrounding lines to make it unique, or pass replace_all: true to change all ${occurrences}.`,
    );
  }

  const after = replaceAll
    ? before.split(oldString).join(newString)
    : before.replace(oldString, newString);
  await writeFile(filePath, after, 'utf8');
  const count = replaceAll ? occurrences : 1;
  return `Edited ${filePath} (${count} replacement${count === 1 ? '' : 's'}).`;
}

// --- Glob ------------------------------------------------------------------

async function runGlobTool(
  input: Record<string, unknown>,
  opts: BuiltinToolsOptions,
): Promise<string> {
  const pattern = requireString(input, 'pattern', 'Glob');
  const root = await resolveSearchRoot(input['path'], opts, 'Glob');
  if (root.kind === 'file') {
    throw new Error(`Glob: path ${root.path} is a file, not a directory.`);
  }

  const { matches, truncated } = await collectGlobMatches(
    root.path,
    pattern,
    SEARCH_MAX_RESULTS,
  );
  if (matches.length === 0) {
    return `No files matched ${JSON.stringify(pattern)} under ${root.path}.`;
  }
  // Sorted for a stable, diffable result. Note the sort happens AFTER the cap,
  // so a truncated answer is "200 of the matches", not "the first 200 in
  // sorted order" — the marker says as much.
  matches.sort();
  const lines = [...matches];
  if (truncated) {
    lines.push(
      `[... truncated at ${SEARCH_MAX_RESULTS} matches; narrow the pattern or pass a more specific path]`,
    );
  }
  return lines.join('\n');
}

async function collectGlobMatches(
  root: string,
  pattern: string,
  limit: number,
): Promise<{ matches: string[]; truncated: boolean }> {
  const segments = compileGlob(pattern);
  // A Set, not an array: two globstars in one pattern (`**/a/**/*.ts`) can
  // reach the same file by different splits, and the model should see one hit.
  const matches = new Set<string>();
  const state: WalkState = {
    truncated: false,
    deadline: Date.now() + SEARCH_BUDGET_MS,
  };
  await walkGlob(root, root, segments, 0, matches, limit, state);
  return { matches: [...matches], truncated: state.truncated };
}

interface WalkState {
  truncated: boolean;
  deadline: number;
}

/**
 * Recursive descent over the directory tree, matching one pattern segment per
 * level. Originally hand-rolled because `fs/promises.glob` landed in Node 22
 * while `container/agent/Dockerfile` still pinned **Node 20**: importing it
 * there was a module-load `SyntaxError` that killed the runner before it could
 * report anything, so every turn failed as `sandbox-terminated` while the
 * in-process suite stayed green on the developer's Node 24.
 *
 * The container is on Node 24 now, so `fs.glob` would work — this stays anyway.
 * It is tested, and its pruning is STRONGER than the `exclude` predicate it
 * replaced (see below), so swapping back would trade a known-good walker for
 * churn. The Node-floor guard in `__tests__/node-floor.test.ts` reads the
 * pinned major straight out of the Dockerfile, so it follows the base image
 * rather than needing this comment to stay true.
 *
 * Semantics kept identical to the `fs.glob` call this replaces:
 *
 * - `*` / `?` match within one segment; `**` matches zero or more segments.
 * - Dot rule (`dot: false`): a wildcard segment never matches a name starting
 *   with `.`, but an explicitly-written `.ax/**` still resolves — which is what
 *   we want, since `.ax/` and `.claude/` are governed state the agent edits.
 * - Only real files are emitted and only real directories are descended, so a
 *   symlink is never followed out of the tree (`fs.glob`'s `follow: false`).
 *
 * Pruning is stronger here than `exclude` was: an excluded directory is never
 * read, whatever segment named it, so `node_modules/**` cannot route around it
 * by resolving the leading literal by path.
 */
async function walkGlob(
  dir: string,
  root: string,
  segments: readonly GlobSegment[],
  index: number,
  out: Set<string>,
  limit: number,
  state: WalkState,
): Promise<void> {
  if (state.truncated) return;
  if (Date.now() > state.deadline) {
    state.truncated = true;
    return;
  }
  const segment = segments[index];
  if (segment === undefined) return;

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A directory that vanished or is unreadable mid-walk is not a search
    // failure — the caller already proved the ROOT exists.
    return;
  }
  // Sorted so a truncated result set is stable across runs rather than
  // whatever order the filesystem handed back.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const record = (full: string): void => {
    if (isUnderExcludedDir(root, full)) return;
    if (out.size >= limit || Date.now() > state.deadline) {
      state.truncated = true;
      return;
    }
    out.add(full);
  };

  const isLast = index === segments.length - 1;

  if (segment.kind === 'globstar') {
    // Zero segments consumed: try the rest of the pattern right here.
    if (!isLast) {
      await walkGlob(dir, root, segments, index + 1, out, limit, state);
    }
    for (const entry of entries) {
      if (state.truncated) return;
      if (entry.isDirectory()) {
        if (SEARCH_EXCLUDED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        // Consume this segment and keep the globstar active one level down.
        await walkGlob(join(dir, entry.name), root, segments, index, out, limit, state);
      } else if (isLast && entry.isFile() && !entry.name.startsWith('.')) {
        record(join(dir, entry.name));
      }
    }
    return;
  }

  for (const entry of entries) {
    if (state.truncated) return;
    if (entry.name.startsWith('.') && !segment.literalDot) continue;
    if (!segment.re.test(entry.name)) continue;
    if (isLast) {
      if (entry.isFile()) record(join(dir, entry.name));
    } else if (entry.isDirectory()) {
      if (SEARCH_EXCLUDED_DIRS.has(entry.name)) continue;
      await walkGlob(join(dir, entry.name), root, segments, index + 1, out, limit, state);
    }
  }
}

type GlobSegment =
  | { kind: 'globstar' }
  /** `literalDot` records that the segment was WRITTEN with a leading dot, which
   *  is what lets `.ax/**` through while `*` keeps skipping dot entries. */
  | { kind: 'match'; re: RegExp; literalDot: boolean };

/** Bound on a model-supplied pattern. Segment regexes are `[^/]*`-shaped and
 *  run against filesystem names (<=255 bytes), so backtracking is bounded — but
 *  an unbounded pattern length is free ammunition, and no real glob is longer
 *  than this. */
const GLOB_MAX_PATTERN_CHARS = 1_024;

function compileGlob(pattern: string): GlobSegment[] {
  if (pattern.length > GLOB_MAX_PATTERN_CHARS) {
    throw new Error(
      `Glob: pattern is longer than ${GLOB_MAX_PATTERN_CHARS} characters.`,
    );
  }
  const out: GlobSegment[] = [];
  for (const raw of pattern.split('/')) {
    if (raw.length === 0 || raw === '.') continue;
    if (raw === '**') {
      // Collapse `**/**` — two adjacent globstars mean what one does, and the
      // zero-consume branch would otherwise recurse on an unchanged directory.
      if (out[out.length - 1]?.kind === 'globstar') continue;
      out.push({ kind: 'globstar' });
      continue;
    }
    out.push({
      kind: 'match',
      re: segmentRegExp(raw),
      literalDot: raw.startsWith('.'),
    });
  }
  return out;
}

/** One pattern segment -> an anchored RegExp over a single path name. */
function segmentRegExp(segment: string): RegExp {
  let source = '';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] as string;
    if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else if (ch === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close === -1) {
        // An unterminated class is a literal bracket, not a syntax error —
        // same forgiving read every shell glob takes.
        source += '\\[';
      } else {
        const body = segment.slice(i + 1, close);
        const negated = body.startsWith('!') || body.startsWith('^');
        // Escape only what would break OUT of the class; ranges stay ranges.
        const inner = (negated ? body.slice(1) : body).replace(/[\\\]]/g, '\\$&');
        source += `[${negated ? '^' : ''}${inner}]`;
        i = close;
      }
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * The exclusion GUARANTEE, as opposed to the optimisation above. `exclude` is
 * only consulted for directories the walker actually reads: a pattern whose
 * leading segment is a literal (`.git/**`) resolves that segment by path and
 * the predicate is never asked about it — so relying on `exclude` alone lets an
 * explicitly-named excluded directory straight through. Checked here on the
 * resolved path, where nothing can route around it.
 */
function isUnderExcludedDir(root: string, full: string): boolean {
  return relative(root, full)
    .split(sep)
    .some((segment) => SEARCH_EXCLUDED_DIRS.has(segment));
}

// --- Grep ------------------------------------------------------------------

async function runGrepTool(
  input: Record<string, unknown>,
  opts: BuiltinToolsOptions,
): Promise<string> {
  const pattern = requireString(input, 'pattern', 'Grep');
  const regex = compilePattern(pattern, input['case_insensitive'] === true);
  const showLineNumbers = input['show_line_numbers'] !== false;
  const root = await resolveSearchRoot(input['path'], opts, 'Grep');
  const globPattern = optionalString(input, 'glob') ?? '**/*';

  const files =
    root.kind === 'file'
      ? { matches: [root.path], truncated: false }
      : await collectGlobMatches(root.path, globPattern, GREP_MAX_FILES);

  const results: string[] = [];
  let truncated = files.truncated;
  const deadline = Date.now() + SEARCH_BUDGET_MS;

  for (const file of files.matches) {
    if (results.length >= SEARCH_MAX_RESULTS || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const text = await readSearchableText(file);
    if (text === null) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (results.length >= SEARCH_MAX_RESULTS) {
        truncated = true;
        break;
      }
      const line = lines[i] ?? '';
      // The regex is MODEL-SUPPLIED, so it may be catastrophically
      // backtracking (`(a+)+$` and friends) and JS has no regex timeout. We
      // can't make the pattern safe, so we bound its INPUT instead: at most
      // GREP_MAX_FILES files, at most GREP_MAX_FILE_BYTES per file, and at
      // most GREP_MAX_LINE_CHARS per match attempt. Together with the
      // between-files wall-clock check that caps the damage at "one slow
      // tool call" rather than a wedged turn.
      const probe =
        line.length > GREP_MAX_LINE_CHARS
          ? line.slice(0, GREP_MAX_LINE_CHARS)
          : line;
      if (!regex.test(probe)) continue;
      results.push(
        showLineNumbers
          ? `${file}:${i + 1}:${probe}`
          : `${file}:${probe}`,
      );
    }
  }

  if (results.length === 0) {
    return `No matches for ${JSON.stringify(pattern)} under ${root.path}.`;
  }
  if (truncated) {
    results.push(
      `[... truncated at ${SEARCH_MAX_RESULTS} matches; narrow the pattern or pass a glob]`,
    );
  }
  return results.join('\n');
}

/**
 * A malformed regex is the model's mistake, not a crash. Surface it as a clean
 * executor error naming the pattern so it can fix the escaping and retry.
 */
function compilePattern(pattern: string, caseInsensitive: boolean): RegExp {
  try {
    // No `g` flag: a global regex carries `lastIndex` between `.test()` calls
    // and would silently skip every other match.
    return new RegExp(pattern, caseInsensitive ? 'i' : '');
  } catch (err) {
    throw new Error(
      `Grep: invalid regular expression ${JSON.stringify(pattern)} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Null for anything Grep should skip: too big, binary, or unreadable. */
async function readSearchableText(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > GREP_MAX_FILE_BYTES) return null;
    const bytes = await readFile(file);
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
    return bytes.toString('utf8');
  } catch {
    // A file that vanished or that we can't open mid-walk is not worth failing
    // the whole search over.
    return null;
  }
}

// --- Shared helpers --------------------------------------------------------

async function resolveSearchRoot(
  raw: unknown,
  opts: BuiltinToolsOptions,
  toolName: string,
): Promise<{ kind: 'dir' | 'file'; path: string }> {
  const path =
    typeof raw === 'string' && raw.length > 0
      ? resolvePath(raw, opts)
      : opts.homeDir;
  const info = await statOrThrow(path, toolName);
  return { kind: info.isDirectory() ? 'dir' : 'file', path };
}

/** Relative paths resolve against the agent's working frame, never process.cwd(). */
function resolvePath(value: string, opts: BuiltinToolsOptions): string {
  return isAbsolute(value) ? value : resolve(opts.homeDir, value);
}

async function statOrThrow(path: string, toolName: string): Promise<Stats> {
  try {
    return await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${toolName}: not found: ${path}`);
    }
    throw new Error(
      `${toolName}: cannot access ${path} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function readTextOrThrow(path: string, toolName: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${toolName}: not found: ${path}`);
    }
    throw new Error(
      `${toolName}: cannot read ${path} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function toPositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const rounded = Math.trunc(raw);
  return rounded > 0 ? rounded : fallback;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The model can emit anything, including a missing or wrongly-typed field. A
 * named executor error is far more repairable than a `TypeError` from three
 * frames deep.
 */
function requireString(
  input: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `${toolName}: '${key}' is required and must be a non-empty string.`,
    );
  }
  return value;
}

/** Same, but `''` is a legitimate value (deleting text, writing an empty file). */
function requireStringAllowingEmpty(
  input: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const value = input[key];
  if (typeof value !== 'string') {
    throw new Error(`${toolName}: '${key}' is required and must be a string.`);
  }
  return value;
}
