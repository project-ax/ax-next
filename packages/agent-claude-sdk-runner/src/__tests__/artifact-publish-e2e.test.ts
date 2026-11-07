import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLocalDispatcher, createArtifactPublishExecutor } from '@ax/agent-runner-core';
import { buildSandboxToolEntries } from '../sandbox-mcp-server.js';
import { ARTIFACT_PUBLISH_DESCRIPTOR } from '@ax/tool-artifact-publish';

// The executor validates against the session's REAL files root, so the fixture
// root IS the agent's files folder — the same thing the sandbox provider stamps
// as AX_USERFILES_ROOT and the operating notes hand to the model.
let userFilesRoot: string;

beforeEach(async () => {
  userFilesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-e2e-'));
});

afterEach(async () => {
  await fs.rm(userFilesRoot, { recursive: true, force: true });
});

/** A host that stores the bytes and answers `artifact.publish` like the real one. */
const host = {
  callBinaryUpload: async () => ({ sha256: 'a'.repeat(64), size: 6 }),
  call: async (_action: string, payload: unknown) => ({
    artifactId: 'art_q4',
    version: 1,
    title: (payload as { title: string }).title,
    kind: 'document',
    extension: 'PDF',
  }),
} as never;

function sandboxEntry() {
  const dispatcher = createLocalDispatcher();
  dispatcher.register(
    ARTIFACT_PUBLISH_DESCRIPTOR.name,
    createArtifactPublishExecutor({ userFilesRoot, client: host, conversationId: 'conv-1' }),
  );
  const [entry] = buildSandboxToolEntries(dispatcher, [ARTIFACT_PUBLISH_DESCRIPTOR]);
  return entry!;
}

/** The text of a tool_result's first content block. */
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  expect(first?.type).toBe('text');
  return first?.text ?? '';
}

describe('artifact_publish end-to-end (sandbox dispatch)', () => {
  it('produces a tool_result with the design-spec JSON shape', async () => {
    // 1. Fixture: a deliverable in the agent's own files folder.
    const rel = 'reports/Q4.pdf';
    const abs = path.join(userFilesRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from('REPORT'));

    // 2. Simulate the SDK invoking the tool with the model's args — the real
    //    absolute path, which is what the model is told and what it writes to.
    const result = await sandboxEntry().handler(
      { path: abs, title: 'Quarter 4 Report' },
      { signal: undefined } as never,
    );

    // 3. Assert the tool_result envelope shape.
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(firstText(result))).toEqual({
      artifactId: 'art_q4',
      version: 1,
      title: 'Quarter 4 Report',
      kind: 'document',
      extension: 'PDF',
      url: 'ax://artifact/art_q4',
      path: rel,
    });
  });

  it('surfaces an error envelope when the path is outside the allowlist', async () => {
    // Not merely absent from an allowlist, but on a root the executor was
    // never handed.
    const result = await sandboxEntry().handler(
      { path: '/srv/another-agent/notes/leak.jsonl', title: 'Leak' },
      { signal: undefined } as never,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/artifact-path-not-publishable/);
  });
});
