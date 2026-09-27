// ---------------------------------------------------------------------------
// Byte-exact filter over a `git fast-export --no-data` stream.
//
// The stream is parsed as BYTES, command by command. Commit messages travel in
// `data <n>` blocks and are copied through untouched without being looked at —
// a message may legitimately contain a line such as `M 100644 <sha> memory/x`
// or `commit refs/heads/other`, and interpreting it would corrupt history.
//
// Anything this filter does not positively recognise is an error. The set we
// accept is exactly what `fast-export --no-data` of ONE branch emits for a
// history without tags, renames or copies (fast-export does not detect them
// unless asked): `feature done`, `reset`, `commit` with `mark`/`author`/
// `committer`/`encoding`/`data`/`from`/`merge`, the file commands `M` (with a
// full object id, which is what --no-data produces), `D` and `deleteall`, blank
// lines and `done`.
//
// Error messages name the problem and a byte offset, never a path or content:
// paths under the purge selector are exactly the data we are trying to erase.
// ---------------------------------------------------------------------------

export type PathMatcher = (path: Buffer) => boolean;

export const SOURCE_REF = 'refs/heads/main';
export const TEMP_REF = 'refs/ax-purge/main';

const LF = 0x0a;

/**
 * True when `path` lies under one of `prefixes` and is not exactly one of
 * `keep`. Compared as UTF-8 bytes so non-UTF-8 path bytes can never
 * accidentally decode into a match or a miss.
 */
export function makePathMatcher(prefixes: readonly string[], keep: readonly string[]): PathMatcher {
  const pre = prefixes.map((p) => Buffer.from(p, 'utf8'));
  const kept = keep.map((k) => Buffer.from(k, 'utf8'));
  return (path) => {
    if (!pre.some((p) => path.length > p.length && path.subarray(0, p.length).equals(p))) {
      return false;
    }
    return !kept.some((k) => k.equals(path));
  };
}

class StreamError extends Error {
  constructor(what: string, offset: number) {
    super(`purge rewrite: ${what} at stream byte ${offset}`);
    this.name = 'StreamError';
  }
}

const SIMPLE_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c,
};

/** Decode a git C-style quoted path (`"…"` with backslash escapes) to raw bytes. */
export function unquoteCPath(q: Buffer): Buffer {
  if (q.length < 2 || q[0] !== 0x22 || q[q.length - 1] !== 0x22) {
    throw new Error('purge rewrite: malformed quoted path');
  }
  const out: number[] = [];
  for (let i = 1; i < q.length - 1; i++) {
    const c = q[i]!;
    if (c === 0x22) throw new Error('purge rewrite: malformed quoted path');
    if (c !== 0x5c) {
      out.push(c);
      continue;
    }
    const n = q[i + 1];
    if (n === undefined || i + 1 >= q.length - 1) {
      throw new Error('purge rewrite: malformed quoted path');
    }
    const simple = SIMPLE_ESCAPES[String.fromCharCode(n)];
    if (simple !== undefined) {
      out.push(simple);
      i += 1;
      continue;
    }
    const oct = q.subarray(i + 1, i + 4).toString('latin1');
    if (i + 3 < q.length - 1 && /^[0-3][0-7]{2}$/.test(oct)) {
      out.push(parseInt(oct, 8));
      i += 3;
      continue;
    }
    throw new Error('purge rewrite: malformed quoted path');
  }
  return Buffer.from(out);
}

function pathBytes(raw: Buffer): Buffer {
  return raw[0] === 0x22 ? unquoteCPath(raw) : raw;
}

const MODE_RE = /^(100644|100755|120000|160000|040000)$/;
const OID_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const DATA_LEN_RE = /^data (0|[1-9][0-9]{0,11})$/;

export interface FilterResult {
  /** The rewritten stream, targeting `targetRef`. */
  stream: Buffer;
  /** Distinct raw path bytes (latin1-keyed) of every dropped `M`/`D` line. */
  dropped: Map<string, Buffer>;
}

/**
 * Rewrite a `fast-export --no-data <sourceRef>` stream: drop every `M`/`D`
 * whose path matches, and retarget the branch at `targetRef`. Throws on
 * anything it does not recognise.
 */
export function filterFastExportStream(
  input: Buffer,
  matches: PathMatcher,
  refs: { sourceRef: string; targetRef: string } = { sourceRef: SOURCE_REF, targetRef: TEMP_REF },
): Buffer {
  return filterFastExportStreamDetailed(input, matches, refs).stream;
}

export function filterFastExportStreamDetailed(
  input: Buffer,
  matches: PathMatcher,
  refs: { sourceRef: string; targetRef: string } = { sourceRef: SOURCE_REF, targetRef: TEMP_REF },
): FilterResult {
  const dropped = new Map<string, Buffer>();
  const out: Buffer[] = [];
  const keepOrDrop = (lineWithLf: Buffer, rawPath: Buffer): void => {
    const p = pathBytes(rawPath);
    if (matches(p)) dropped.set(p.toString('latin1'), p);
    else out.push(lineWithLf);
  };
  let pos = 0;
  let inCommit = false;

  while (pos < input.length) {
    const lineStart = pos;
    const nl = input.indexOf(LF, pos);
    if (nl < 0) throw new StreamError('unterminated line', lineStart);
    const line = input.subarray(pos, nl);
    const lineWithLf = input.subarray(pos, nl + 1);
    pos = nl + 1;
    // Command words are ASCII; latin1 decodes byte-for-byte so a stray high
    // byte can never be mistaken for anything we accept.
    const text = line.toString('latin1');

    if (text.startsWith('data ')) {
      if (!inCommit) throw new StreamError('data outside a commit', lineStart);
      if (text.startsWith('data <<')) throw new StreamError('delimited data block', lineStart);
      const m = DATA_LEN_RE.exec(text);
      if (!m) throw new StreamError('malformed data length', lineStart);
      const len = Number(m[1]);
      if (pos + len > input.length) throw new StreamError('truncated data block', lineStart);
      out.push(lineWithLf, input.subarray(pos, pos + len));
      pos += len;
      if (input[pos] === LF) {
        out.push(input.subarray(pos, pos + 1));
        pos += 1;
      }
      continue;
    }

    if (text === '') {
      out.push(lineWithLf);
      continue;
    }
    if (text === 'feature done' || text === 'done') {
      inCommit = false;
      out.push(lineWithLf);
      continue;
    }
    if (text.startsWith('commit ') || text.startsWith('reset ')) {
      const cmd = text.startsWith('commit ') ? 'commit' : 'reset';
      if (text !== `${cmd} ${refs.sourceRef}`) throw new StreamError('unexpected ref', lineStart);
      out.push(Buffer.from(`${cmd} ${refs.targetRef}\n`, 'latin1'));
      inCommit = cmd === 'commit';
      continue;
    }
    if (!inCommit) throw new StreamError('unrecognised command', lineStart);

    if (
      /^mark :[1-9][0-9]*$/.test(text) ||
      text.startsWith('author ') ||
      text.startsWith('committer ') ||
      text.startsWith('encoding ') ||
      /^(from|merge) (:[1-9][0-9]*|[0-9a-f]{40}|[0-9a-f]{64})$/.test(text) ||
      text === 'deleteall'
    ) {
      out.push(lineWithLf);
      continue;
    }
    if (text.startsWith('M ')) {
      const sp1 = line.indexOf(0x20, 2);
      const sp2 = sp1 < 0 ? -1 : line.indexOf(0x20, sp1 + 1);
      if (sp1 < 0 || sp2 < 0 || sp2 + 1 >= line.length) {
        throw new StreamError('malformed modify', lineStart);
      }
      const mode = line.subarray(2, sp1).toString('latin1');
      const oid = line.subarray(sp1 + 1, sp2).toString('latin1');
      if (!MODE_RE.test(mode)) throw new StreamError('unexpected file mode', lineStart);
      if (!OID_RE.test(oid)) throw new StreamError('unexpected data reference', lineStart);
      keepOrDrop(lineWithLf, line.subarray(sp2 + 1));
      continue;
    }
    if (text.startsWith('D ')) {
      if (line.length <= 2) throw new StreamError('malformed delete', lineStart);
      keepOrDrop(lineWithLf, line.subarray(2));
      continue;
    }
    throw new StreamError('unrecognised command', lineStart);
  }
  return { stream: Buffer.concat(out), dropped };
}
