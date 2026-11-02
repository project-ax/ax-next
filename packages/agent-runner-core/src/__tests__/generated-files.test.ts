import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolCall } from '@ax/ipc-protocol';
import { MAX_ARTIFACT_BYTES } from '@ax/tool-artifact-publish';
import {
  agentFileReference,
  autoAttachResolvedNote,
  trackGeneratedFiles,
  publishedAttachments,
  type GateVerdict,
} from '../generated-files.js';

const roots: string[] = [];
async function root() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-generated-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

/** A tracker over `dir`, with spies on the gate, the post-call report and the warning. */
async function track(
  dir: string,
  gate: (call: ToolCall) => Promise<GateVerdict> = async () => ({ kind: 'allow' }),
  opts: { maxEntries?: number } = {},
) {
  const admit = vi.fn(gate);
  const attached = vi.fn(async (_call: ToolCall, _chip: unknown) => {});
  const warn = vi.fn();
  const tracker = await trackGeneratedFiles({ root: dir, admit, attached, warn, ...opts });
  return { tracker, admit, attached, warn, dir };
}

const NOT_NAMEABLE = {
  type: 'text',
  text: "Some new files have names we can't link to here (for example, ones with a colon). Ask the agent to rename them.",
};

const NOT_ATTACHED = {
  type: 'text',
  text: 'Some new files could not be attached. Ask the agent to attach them again.',
};

const HELD = {
  type: 'text',
  text: 'Some new files are waiting for your approval before we attach them.',
};

const SCAN_FAILED = {
  type: 'text',
  text: 'We could not check for new files to attach. Ask the agent to attach the files again.',
};

describe('generated files', () => {
  it('attaches new nested files by their key', async () => {
    const dir = await root();
    await fs.writeFile(path.join(dir, 'old.txt'), 'old');
    const { tracker, admit, attached } = await track(dir);
    const notes = '# notes\nmore\n';
    await fs.mkdir(path.join(dir, 'docs'));
    await fs.writeFile(path.join(dir, 'docs', 'new.md'), notes);
    for (const sub of ['.config', 'node_modules', 'venv', '__pycache__']) {
      await fs.mkdir(path.join(dir, sub));
      await fs.writeFile(path.join(dir, sub, 'result.txt'), 'hello');
    }
    await fs.writeFile(path.join(dir, 'docs', 'module.pyc'), 'bytecode');
    // The chip names the file by its key in the agent's files: no id, no copy,
    // and no sandbox path.
    const chip = { type: 'agent_file', path: 'docs/new.md', mediaType: 'text/markdown', sizeBytes: Buffer.byteLength(notes) };
    expect(await tracker.collect()).toEqual([chip]);
    // The gate saw the call that is then reported with the chip as its outcome.
    expect(admit).toHaveBeenCalledOnce();
    const call = admit.mock.calls[0]![0];
    expect(call).toMatchObject({ name: 'artifact_publish', input: { path: path.join(dir, 'docs', 'new.md') } });
    expect(attached).toHaveBeenCalledOnce();
    expect(attached).toHaveBeenCalledWith(call, chip);
    expect(await tracker.collect()).toEqual([]);
    // A fresh process (reload/resume) does not reattach the old outputs.
    const resumed = await track(dir);
    expect(await resumed.tracker.collect()).toEqual([]);
    expect(resumed.admit).not.toHaveBeenCalled();
  });

  it('attaches a file over the old publish cap without reading its bytes', async () => {
    // A reference copies nothing, so the 100 MiB copy cap does not apply. The
    // file is sparse and, for a non-root runner, unreadable: only its metadata
    // is looked at. The download route answers for size.
    const dir = await root();
    const { tracker } = await track(dir);
    const big = path.join(dir, 'video.mp4');
    await fs.writeFile(big, '');
    await fs.truncate(big, MAX_ARTIFACT_BYTES + 1);
    await fs.chmod(big, 0o000);
    expect(await tracker.collect()).toEqual([
      { type: 'agent_file', path: 'video.mp4', mediaType: 'video/mp4', sizeBytes: MAX_ARTIFACT_BYTES + 1 },
    ]);
  });

  it('never attaches file or directory symlinks', async () => {
    const dir = await root();
    const outside = await root();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    const { tracker, admit, attached } = await track(dir);
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'secret.txt'));
    await fs.symlink(outside, path.join(dir, 'outside'));
    expect(await tracker.collect()).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
    expect(attached).not.toHaveBeenCalled();
  });

  it('skips a file the model already published', async () => {
    const dir = await root();
    const { tracker, admit } = await track(dir);
    await fs.mkdir(path.join(dir, 'out'));
    await fs.writeFile(path.join(dir, 'out', 'a.txt'), 'a');
    const explicit = publishedAttachments(
      [{ type: 'tool_use', id: 'p', name: 'artifact_publish', input: {} }],
      [{ type: 'tool_result', tool_use_id: 'p', content: JSON.stringify(RESULT) }],
    );
    expect(await tracker.collect(explicit.paths)).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
  });

  it('a gate refusal attaches nothing and says so', async () => {
    const dir = await root();
    const { tracker, attached, warn } = await track(dir, async () => ({ kind: 'denied' }));
    await fs.writeFile(path.join(dir, 'refused.txt'), 'b');
    expect(await tracker.collect()).toEqual([NOT_ATTACHED]);
    expect(attached).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('a name the Files tab cannot address is reported, not attached', async () => {
    // A chip for `notes: q3.md` could only ever fail to download. The other
    // new file is still attached.
    const dir = await root();
    const { tracker, attached, warn } = await track(dir);
    await fs.writeFile(path.join(dir, 'notes: q3.md'), 'q3');
    await fs.writeFile(path.join(dir, 'fine.md'), 'ok');
    expect(await tracker.collect()).toEqual([
      { type: 'agent_file', path: 'fine.md', mediaType: 'text/markdown', sizeBytes: 2 },
      NOT_NAMEABLE,
    ]);
    expect(attached).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('an unaddressable name and a refused file each get their own note', async () => {
    const dir = await root();
    const { tracker } = await track(dir, async () => ({ kind: 'denied' }));
    await fs.writeFile(path.join(dir, 'notes: q3.md'), 'q3');
    await fs.writeFile(path.join(dir, 'refused.md'), 'r');
    expect(await tracker.collect()).toEqual([NOT_ATTACHED, NOT_NAMEABLE]);
  });

  it.skipIf(process.platform === 'win32')('a name the Files tab cannot address never reaches the policy gate', async () => {
    // Asking the gate first would park a held approval for a file that can
    // never be a chip.
    const dir = await root();
    const { tracker, admit, attached } = await track(dir);
    await fs.writeFile(path.join(dir, 'notes: q3.md'), 'q3');
    await tracker.collect();
    expect(admit).not.toHaveBeenCalled();
    expect(attached).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('warn gets a reason code for each failure, never a name', async () => {
    const refused = await track(await root(), async () => ({ kind: 'denied' }));
    await fs.writeFile(path.join(refused.dir, 'secret-plan.md'), 'r');
    await refused.tracker.collect();
    expect(refused.warn.mock.calls).toEqual([['denied']]);

    const unnameable = await track(await root());
    await fs.writeFile(path.join(unnameable.dir, 'notes: q3.md'), 'q3');
    await unnameable.tracker.collect();
    expect(unnameable.warn.mock.calls).toEqual([['unaddressable-name']]);
  });

  it('warn gets denied, held and unavailable for the three gate refusals', async () => {
    // `unavailable` is the gate failing closed (it never decided), `denied` a
    // rule that said no, `held` a call waiting on a person: three different
    // things for whoever reads the log.
    const cases: Array<[GateVerdict, string]> = [
      [{ kind: 'denied' }, 'denied'],
      [{ kind: 'held', decisionId: 'd1' }, 'held'],
      [{ kind: 'unavailable' }, 'unavailable'],
    ];
    for (const [verdict, reason] of cases) {
      const { tracker, attached, warn, dir } = await track(await root(), async () => verdict);
      await fs.writeFile(path.join(dir, 'secret-plan.md'), 'r');
      const blocks = await tracker.collect();
      expect(blocks.some(block => block.type === 'agent_file')).toBe(false);
      expect(attached).not.toHaveBeenCalled();
      expect(warn.mock.calls).toEqual([[reason]]);
    }
  });

  it('a held file gets the approval note, never the attach-again note', async () => {
    // "Ask the agent to attach them again" on a held file sends the person to
    // the explicit publish, which copies the file into the blob store.
    const { tracker, dir } = await track(await root(), async () => ({ kind: 'held', decisionId: 'd1' }));
    await fs.writeFile(path.join(dir, 'report.txt'), 'report');
    expect(await tracker.collect()).toEqual([HELD]);
  });

  it.skipIf(process.platform === 'win32')('notes follow the chips, once each, attach-again then approval then rename', async () => {
    const dir = await root();
    const { tracker } = await track(dir, async call => {
      const file = path.basename((call.input as { path: string }).path);
      return file.startsWith('denied') ? { kind: 'denied' }
        : file.startsWith('held') ? { kind: 'held', decisionId: `d-${file}` }
          : { kind: 'allow' };
    });
    for (const name of ['denied-1.md', 'denied-2.md', 'held-1.md', 'held-2.md', 'ok.md', 'notes: q3.md', 'notes: q4.md']) {
      await fs.writeFile(path.join(dir, name), 'x');
    }
    expect(await tracker.collect()).toEqual([
      { type: 'agent_file', path: 'ok.md', mediaType: 'text/markdown', sizeBytes: 1 },
      NOT_ATTACHED,
      HELD,
      NOT_NAMEABLE,
    ]);
  });

  it('a home over the entry limit warns scan-limit', async () => {
    // Too many entries to scan is not a broken scan: the operator needs to
    // tell the two apart. Both the baseline and a turn's scan say so.
    const dir = await root();
    for (const name of ['a.txt', 'b.txt', 'c.txt']) await fs.writeFile(path.join(dir, name), name);
    const { tracker, admit, warn } = await track(dir, undefined, { maxEntries: 2 });
    expect(warn.mock.calls).toEqual([['scan-limit']]);
    expect(await tracker.collect()).toEqual([SCAN_FAILED]);
    expect(admit).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([['scan-limit'], ['scan-limit']]);
    expect(warn.mock.calls).not.toContainEqual(['error']);
  });

  it('fails closed when the initial baseline is unavailable', async () => {
    const dir = path.join(await root(), 'missing');
    const { tracker, admit, warn } = await track(dir);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'old.txt'), 'old');
    expect(await tracker.collect()).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([['error']]);
  });

  it('reports a failed collect-time scan with the existing note and an error reason', async () => {
    const dir = await root();
    const { tracker, admit, warn } = await track(dir);
    await fs.rm(dir, { recursive: true, force: true });
    expect(await tracker.collect()).toEqual([SCAN_FAILED]);
    expect(admit).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([['error']]);
  });

  it('recognizes only successful publish results, including SDK text blocks', () => {
    expect(publishedAttachments([
      { type: 'tool_use', id: 'p', name: 'mcp__ax-sandbox-tools__artifact_publish', input: {} },
    ], [
      { type: 'tool_result', tool_use_id: 'p', content: [{ type: 'text', text: JSON.stringify(RESULT) }] },
      { type: 'tool_result', tool_use_id: 'unknown', content: JSON.stringify(RESULT) },
      { type: 'tool_result', tool_use_id: 'p', is_error: true, content: JSON.stringify(RESULT) },
    ])).toEqual({ blocks: [CHIP], paths: ['out/a.txt'] });
  });

  it('artifact chips carry the artifactId, not a path', () => {
    const { blocks } = publishedAttachments(
      [{ type: 'tool_use', id: 'p', name: 'artifact_publish', input: {} }],
      [{ type: 'tool_result', tool_use_id: 'p', content: JSON.stringify(RESULT) }],
    );
    expect(blocks).toEqual([CHIP]);
    expect(blocks.every(block => !('path' in block))).toBe(true);
  });

  it('a publish result that cannot name its artifact attaches nothing', () => {
    // The result rides a tool_result, so every field is checked again here.
    for (const bad of [{ ...RESULT, artifactId: '../x' }, { ...RESULT, displayName: '' }, { path: 'out/a.txt' }]) {
      expect(publishedAttachments(
        [{ type: 'tool_use', id: 'p', name: 'artifact_publish', input: {} }],
        [{ type: 'tool_result', tool_use_id: 'p', content: JSON.stringify(bad) }],
      )).toEqual({ blocks: [], paths: [] });
    }
  });
});

/** A gate that answers each call with the next scripted verdict. */
function scripted(...verdicts: GateVerdict[]) {
  return async (): Promise<GateVerdict> => {
    const next = verdicts.shift();
    if (next === undefined) throw new Error('the gate was asked more often than scripted');
    return next;
  };
}

describe('held automatic attaches (TASK-1017)', () => {
  // A held automatic attach is a call the runner made up, so it is not in the
  // model's transcript and the model cannot make it "again". The tracker
  // remembers its own holds and, when the person answers, sends the very same
  // call back to the gate itself.
  const CHIP = { type: 'agent_file', path: 'report.txt', mediaType: 'text/plain', sizeBytes: 6 };

  /** `report.txt` is new and the gate holds it as d1; `after` answers the calls that follow. */
  async function heldReport(...after: GateVerdict[]) {
    const t = await track(await root(), scripted({ kind: 'held', decisionId: 'd1' }, ...after));
    await fs.writeFile(path.join(t.dir, 'report.txt'), 'report');
    expect(await t.tracker.collect()).toEqual([HELD]);
    return t;
  }

  it('an approved hold attaches the file by reference after the gate allows the identical call', async () => {
    const { tracker, admit, attached } = await heldReport({ kind: 'allow' });
    expect(attached).not.toHaveBeenCalled();
    expect(await tracker.resolveHeld('d1', 'approved')).toBe(true);
    expect(admit).toHaveBeenCalledTimes(2);
    // The same call, not a look-alike: the standing approval is keyed on it.
    expect(admit.mock.calls[1]![0]).toBe(admit.mock.calls[0]![0]);
    expect(await tracker.collect()).toEqual([CHIP]);
    expect(attached).toHaveBeenCalledOnce();
    expect(attached).toHaveBeenCalledWith(admit.mock.calls[0]![0], CHIP);
  });

  it('counts the answered chips no turn-end has carried yet', async () => {
    const { tracker } = await heldReport({ kind: 'allow' });
    expect(tracker.undelivered()).toBe(0);
    expect(await tracker.resolveHeld('d1', 'approved')).toBe(true);
    // Spent at pull time: only a turn-end delivers it now.
    expect(tracker.undelivered()).toBe(1);
    expect(await tracker.collect()).toEqual([CHIP]);
    expect(tracker.undelivered()).toBe(0);
  });

  it('a dismissed or unanswered hold attaches nothing and is forgotten', async () => {
    for (const outcome of ['dismissed', undefined] as const) {
      const { tracker, admit, attached } = await heldReport({ kind: 'allow' });
      expect(await tracker.resolveHeld('d1', outcome)).toBe(true);
      // There is no yes to spend, so the gate is not asked again.
      expect(admit).toHaveBeenCalledOnce();
      expect(await tracker.collect()).toEqual([]);
      expect(await tracker.resolveHeld('d1', 'approved')).toBe(false);
      expect(admit).toHaveBeenCalledOnce();
      expect(attached).not.toHaveBeenCalled();
    }
  });

  it('a decision this tracker did not raise is not ours', async () => {
    const { tracker, admit } = await heldReport({ kind: 'allow' });
    expect(await tracker.resolveHeld('nope', 'approved')).toBe(false);
    // An unknown id never reaches the gate, and forgets nothing of ours.
    expect(admit).toHaveBeenCalledOnce();
    expect(await tracker.resolveHeld('d1', 'approved')).toBe(true);

    const fresh = await track(await root());
    expect(await fresh.tracker.resolveHeld('d1', 'approved')).toBe(false);
    expect(fresh.admit).not.toHaveBeenCalled();
  });

  it('the gate still decides: a re-held approval is remembered, a denied one attaches nothing', async () => {
    // Undo, expiry, or the yes already spent: the gate holds the call again.
    const reheld = await heldReport({ kind: 'held', decisionId: 'd2' }, { kind: 'allow' });
    expect(await reheld.tracker.resolveHeld('d1', 'approved')).toBe(true);
    expect(await reheld.tracker.collect()).toEqual([HELD]);
    expect(await reheld.tracker.resolveHeld('d1', 'approved')).toBe(false);
    expect(await reheld.tracker.resolveHeld('d2', 'approved')).toBe(true);
    expect(reheld.admit.mock.calls[2]![0]).toBe(reheld.admit.mock.calls[0]![0]);
    expect(await reheld.tracker.collect()).toEqual([CHIP]);

    for (const refusal of [{ kind: 'denied' }, { kind: 'unavailable' }] as const) {
      const refused = await heldReport(refusal);
      expect(await refused.tracker.resolveHeld('d1', 'approved')).toBe(true);
      expect(await refused.tracker.collect()).toEqual([NOT_ATTACHED]);
      expect(refused.attached).not.toHaveBeenCalled();
      expect(refused.warn.mock.calls).toEqual([['held'], [refusal.kind]]);
    }
  });

  it('a file gone or linked since the hold never spends the approval', async () => {
    // Nothing reaches the gate a second time, so the yes stays unspent.
    const gone = await heldReport({ kind: 'allow' });
    await fs.rm(path.join(gone.dir, 'report.txt'));
    expect(await gone.tracker.resolveHeld('d1', 'approved')).toBe(true);
    expect(gone.admit).toHaveBeenCalledOnce();
    expect(await gone.tracker.collect()).toEqual([NOT_ATTACHED]);
    expect(gone.attached).not.toHaveBeenCalled();

    // The sibling is there from the start, so only the link is new.
    const dir = await root();
    await fs.writeFile(path.join(dir, 'sibling.txt'), 'sibling');
    const linked = await track(dir, scripted({ kind: 'held', decisionId: 'd1' }, { kind: 'allow' }));
    await fs.writeFile(path.join(dir, 'report.txt'), 'report');
    expect(await linked.tracker.collect()).toEqual([HELD]);
    await fs.rm(path.join(dir, 'report.txt'));
    await fs.symlink(path.join(dir, 'sibling.txt'), path.join(dir, 'report.txt'));
    expect(await linked.tracker.resolveHeld('d1', 'approved')).toBe(true);
    expect(linked.admit).toHaveBeenCalledOnce();
    expect(await linked.tracker.collect()).toEqual([NOT_ATTACHED]);
    expect(linked.attached).not.toHaveBeenCalled();
    expect(linked.warn.mock.calls).toEqual([['held'], ['not-a-regular-file']]);
  });

  it('an approval answered while a turn runs lands once', async () => {
    const { tracker } = await heldReport({ kind: 'allow' });
    expect(await tracker.resolveHeld('d1', 'approved')).toBe(true);
    expect(await tracker.collect()).toEqual([CHIP]);
    expect(await tracker.collect()).toEqual([]);

    // The claude-sdk loop pulls ahead, so a turn can end while the gate is
    // still answering the re-sent call. The chip then rides the next one.
    let open!: () => void;
    const gateOpen = new Promise<void>(resolve => { open = resolve; });
    let calls = 0;
    const racing = await track(await root(), async () => {
      if (calls++ === 0) return { kind: 'held', decisionId: 'd1' };
      await gateOpen;
      return { kind: 'allow' };
    });
    await fs.writeFile(path.join(racing.dir, 'report.txt'), 'report');
    expect(await racing.tracker.collect()).toEqual([HELD]);
    const answering = racing.tracker.resolveHeld('d1', 'approved');
    expect(await racing.tracker.collect()).toEqual([]);
    open();
    expect(await answering).toBe(true);
    expect(await racing.tracker.collect()).toEqual([CHIP]);
    expect(await racing.tracker.collect()).toEqual([]);
  });

  it('a repeated delivery attaches once', async () => {
    // Both deliveries start before either reaches the gate.
    const { tracker, admit } = await heldReport({ kind: 'allow' });
    const answers = await Promise.all([tracker.resolveHeld('d1', 'approved'), tracker.resolveHeld('d1', 'approved')]);
    expect(answers).toEqual([true, false]);
    expect(admit).toHaveBeenCalledTimes(2);
    expect(await tracker.collect()).toEqual([CHIP]);
  });

  it('a scan that fails still releases what an approval attached', async () => {
    const { tracker, dir } = await heldReport({ kind: 'allow' });
    expect(await tracker.resolveHeld('d1', 'approved')).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
    expect(await tracker.collect()).toEqual([CHIP, SCAN_FAILED]);
    expect(await tracker.collect()).toEqual([SCAN_FAILED]);
  });

  it('remembers at most MAX_HELD_AUTO_ATTACH holds', async () => {
    const dir = await root();
    let held = 0;
    const { tracker } = await track(dir, async () => held < 257 ? { kind: 'held', decisionId: `d${held++}` } : { kind: 'allow' });
    for (let i = 0; i < 257; i++) await fs.writeFile(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x');
    expect(await tracker.collect()).toEqual([HELD]);
    // The oldest is forgotten first.
    expect(await tracker.resolveHeld('d0', 'approved')).toBe(false);
    expect(await tracker.resolveHeld('d1', 'approved')).toBe(true);
    expect(await tracker.resolveHeld('d256', 'approved')).toBe(true);
  });

  it('resolveHeld never rejects', async () => {
    let calls = 0;
    const { tracker, warn, dir } = await track(await root(), async () => {
      if (calls++ === 0) return { kind: 'held', decisionId: 'd1' };
      throw new Error('the gate broke');
    });
    await fs.writeFile(path.join(dir, 'report.txt'), 'report');
    expect(await tracker.collect()).toEqual([HELD]);
    await expect(tracker.resolveHeld('d1', 'approved')).resolves.toBe(true);
    expect(await tracker.collect()).toEqual([NOT_ATTACHED]);
    expect(warn.mock.calls).toEqual([['held'], ['error']]);
  });

  it('tells the model the answer is handled and the files are not its to publish', () => {
    expect(autoAttachResolvedNote('approved')).toBe(
      'A person approved attaching new files from earlier in this conversation. That is handled for you: ' +
        'do not publish them yourself. You do not need to reply.',
    );
    const declined =
      'A person chose not to attach new files from earlier in this conversation, so they were not attached. ' +
      'Do not publish them unless the user asks you to. You do not need to reply.';
    expect(autoAttachResolvedNote('dismissed')).toBe(declined);
    expect(autoAttachResolvedNote(undefined)).toBe(declined);
  });
});

describe('agentFileReference', () => {
  it('names a regular file by its key with / separators', async () => {
    const dir = await root();
    await fs.mkdir(path.join(dir, 'reports', 'q3'), { recursive: true });
    await fs.writeFile(path.join(dir, 'reports', 'q3', 'Q3 plan #1 (50%).pdf'), 'pdf!');
    expect(await agentFileReference(dir, path.join('reports', 'q3', 'Q3 plan #1 (50%).pdf'))).toEqual({
      type: 'agent_file', path: 'reports/q3/Q3 plan #1 (50%).pdf', mediaType: 'application/pdf', sizeBytes: 4,
    });
  });

  // Each case fails exactly one check: the link points INSIDE the root, so
  // only the symlink refusal stops it; the folder is inside the root and has a
  // valid key, so only the regular-file check does; the escaping folder link
  // reaches a regular file with a valid key, so only containment does.
  it('refuses a symlink even to a file inside the agent files', async () => {
    const dir = await root();
    await fs.writeFile(path.join(dir, 'real.txt'), 'real');
    await fs.symlink(path.join(dir, 'real.txt'), path.join(dir, 'link.txt'));
    await expect(agentFileReference(dir, 'link.txt')).rejects.toMatchObject({ reason: 'not-a-regular-file' });
  });

  it('refuses a folder', async () => {
    const dir = await root();
    await fs.mkdir(path.join(dir, 'folder'));
    await expect(agentFileReference(dir, 'folder')).rejects.toMatchObject({ reason: 'not-a-regular-file' });
  });

  it('refuses a file reached through a folder link that leaves the agent files', async () => {
    const dir = await root();
    const outside = await root();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, path.join(dir, 'escape'));
    await expect(agentFileReference(dir, path.join('escape', 'secret.txt'))).rejects.toMatchObject({ reason: 'outside-root' });
  });

  it('refuses a file that is gone', async () => {
    const dir = await root();
    await expect(agentFileReference(dir, 'missing.txt')).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('refuses a name the Files tab cannot address', async () => {
    const dir = await root();
    for (const name of ['notes: q3.md', 'a..b.txt']) {
      await fs.writeFile(path.join(dir, name), 'x');
      await expect(agentFileReference(dir, name)).rejects.toMatchObject({ reason: 'unaddressable-name' });
    }
  });
});

/** An `artifact_publish` result as the executor returns it. */
const RESULT = {
  artifactId: '0123456789abcdef',
  downloadUrl: 'ax://artifact/0123456789abcdef',
  path: 'out/a.txt',
  displayName: 'a.txt',
  mediaType: 'text/plain',
  sizeBytes: 1,
  sha256: 'a'.repeat(64),
};
const CHIP = {
  type: 'attachment',
  attachmentId: '0123456789abcdef',
  filename: 'a.txt',
  mediaType: 'text/plain',
  sizeBytes: 1,
};
