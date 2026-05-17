import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLocalDispatcher } from '../local-dispatcher.js';
import { buildSandboxToolEntries } from '../sandbox-mcp-server.js';
import { createArtifactPublishExecutor } from '../artifact-publish-executor.js';
import { ARTIFACT_PUBLISH_DESCRIPTOR } from '@ax/tool-artifact-publish';

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-e2e-'));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('artifact_publish end-to-end (sandbox dispatch)', () => {
  it('produces a tool_result with the design-spec JSON shape', async () => {
    // 1. Fixture: a publishable file lives under /permanent/workspace/.
    const rel = 'workspace/reports/Q4.pdf';
    const abs = path.join(workspaceRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from('REPORT'));

    // 2. Wire sandbox-MCP exactly as the runner does at startup.
    const dispatcher = createLocalDispatcher();
    dispatcher.register(
      ARTIFACT_PUBLISH_DESCRIPTOR.name,
      createArtifactPublishExecutor({ workspaceRoot }),
    );
    const [entry] = buildSandboxToolEntries(dispatcher, [ARTIFACT_PUBLISH_DESCRIPTOR]);

    // 3. Simulate the SDK invoking the tool with the model's args.
    const result = await entry.handler(
      { path: `/permanent/${rel}`, displayName: 'Quarter 4 Report' },
      { signal: undefined } as never,
    );

    // 4. Assert the tool_result envelope shape.
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.path).toBe(rel);
    expect(parsed.displayName).toBe('Quarter 4 Report');
    expect(parsed.mediaType).toBe('application/pdf');
    expect(parsed.sizeBytes).toBe(6);
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.artifactId).toHaveLength(16);
    expect(parsed.downloadUrl).toBe(`ax://artifact/${parsed.artifactId}`);
  });

  it('surfaces an error envelope when the path is outside the allowlist', async () => {
    const dispatcher = createLocalDispatcher();
    dispatcher.register(
      ARTIFACT_PUBLISH_DESCRIPTOR.name,
      createArtifactPublishExecutor({ workspaceRoot }),
    );
    const [entry] = buildSandboxToolEntries(dispatcher, [ARTIFACT_PUBLISH_DESCRIPTOR]);

    const result = await entry.handler(
      { path: '/permanent/.ax/sessions/leak.jsonl' },
      { signal: undefined } as never,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/artifact-path-not-publishable/);
  });
});
