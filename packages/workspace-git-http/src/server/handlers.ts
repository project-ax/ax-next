// Pod-side request handlers for the four workspace.* HTTP actions.
//
// Each handler decodes the wire request, calls the matching service hook
// on a per-repoRoot HookBus (registered with @ax/workspace-git-core), and
// encodes the response so it satisfies the wire schema. The HTTP listener
// (Task 9) wraps these in framing + auth + JSON parsing.
//
// IMPORTANT: handlers do NOT catch hook errors. PluginError must bubble up
// so the listener can translate it to the wire error envelope. (Catching
// here would lose the structured `code` that the host needs to re-throw a
// PluginError with the same shape on its side.)
//
// IMPORTANT: workspace deltas carry lazy `() => Promise<Bytes>` closures
// for contentBefore / contentAfter. JSON can't carry closures, and we
// deliberately don't want lazy-on-the-wire either — that would mean a
// round-trip per byte fetch. Instead we eagerly resolve the bytes here
// and ship them as base64; the host plugin (Task 12) re-wraps them as
// closures so subscribers see the same lazy shape regardless of transport.

import {
  HookBus,
  asWorkspaceVersion,
  makeChatContext,
  type FileChange,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceDiffInput,
  type WorkspaceDiffOutput,
  type WorkspaceDelta,
} from '@ax/core';
import { registerWorkspaceGitHooks } from '@ax/workspace-git-core';
import type { z } from 'zod';
import {
  base64ToBytes,
  bytesToBase64,
} from '@ax/workspace-protocol';
// Schema names imported as values via `typeof` — keeping them as a separate
// `import type` block makes it clear they don't survive emit (they're only
// referenced in `z.infer<typeof X>` positions to derive the wire types).
import type {
  WorkspaceApplyRequestSchema,
  WorkspaceApplyResponseSchema,
  WorkspaceReadRequestSchema,
  WorkspaceReadResponseSchema,
  WorkspaceListRequestSchema,
  WorkspaceListResponseSchema,
  WorkspaceDiffRequestSchema,
  WorkspaceDiffResponseSchema,
} from '@ax/workspace-protocol';

// ---------------------------------------------------------------------------
// One-bus-per-repoRoot cache.
//
// Today the git-server pod owns a single repoRoot for its lifetime (the chart
// wires `gitServer.storage` to one PVC), so this cache will hold exactly one
// entry. Keying by repoRoot is forward-compat with a future multi-tenant
// variant where one pod owns N repos.
//
// We MUST reuse the bus across requests for the same repoRoot — the impl's
// per-repo Mutex lives inside a closure created by `registerWorkspaceGitHooks`,
// so a fresh bus per request would defeat the parent-CAS mutex and let
// concurrent applies race.
// ---------------------------------------------------------------------------
const REGISTRY = new Map<string, HookBus>();

function busFor(repoRoot: string): HookBus {
  let bus = REGISTRY.get(repoRoot);
  if (bus !== undefined) return bus;
  bus = new HookBus();
  registerWorkspaceGitHooks(bus, { repoRoot });
  REGISTRY.set(repoRoot, bus);
  return bus;
}

// The git-server has no real session. It's an infrastructure component that
// proxies whatever session a client claims to have. Use synthetic identifiers
// that read as "obviously infra, not user data" so anyone reading the commit
// authors knows where the writes came from.
function serverCtx(repoRoot: string) {
  return makeChatContext({
    sessionId: 'git-server',
    agentId: 'git-server',
    userId: 'git-server',
    workspace: { rootPath: repoRoot },
  });
}

// ---------------------------------------------------------------------------
// Wire-shape conversion for WorkspaceDelta.
// Reused by apply and diff (both return a delta).
// ---------------------------------------------------------------------------
async function wireDelta(
  d: WorkspaceDelta,
): Promise<z.infer<typeof WorkspaceApplyResponseSchema>['delta']> {
  // Eagerly resolve every contentBefore/contentAfter so the wire response
  // carries plain base64. The HOST plugin re-wraps each as a closure so
  // subscribers see the same lazy shape they'd get from the in-process
  // backend (laziness lives in the adapter, not on the wire).
  const wireChanges = await Promise.all(
    d.changes.map(async (c) => {
      if (c.kind === 'added') {
        const bytes = await c.contentAfter!();
        return {
          path: c.path,
          kind: 'added' as const,
          contentAfterBase64: bytesToBase64(bytes),
        };
      }
      if (c.kind === 'modified') {
        const before = await c.contentBefore!();
        const after = await c.contentAfter!();
        return {
          path: c.path,
          kind: 'modified' as const,
          contentBeforeBase64: bytesToBase64(before),
          contentAfterBase64: bytesToBase64(after),
        };
      }
      // deleted
      const before = await c.contentBefore!();
      return {
        path: c.path,
        kind: 'deleted' as const,
        contentBeforeBase64: bytesToBase64(before),
      };
    }),
  );
  // `WorkspaceVersion` is a branded string at the type level but a plain
  // string at runtime. The wire schema is plain `z.string()`, so the cast
  // strips the brand.
  const wire: z.infer<typeof WorkspaceApplyResponseSchema>['delta'] = {
    before: d.before === null ? null : (d.before as string),
    after: d.after as string,
    changes: wireChanges,
  };
  if (d.reason !== undefined) wire.reason = d.reason;
  if (d.author !== undefined) wire.author = d.author as { agentId: string; userId: string; sessionId: string };
  return wire;
}

// ---------------------------------------------------------------------------
// workspace.apply
// ---------------------------------------------------------------------------
export async function handleApply(
  repoRoot: string,
  req: z.infer<typeof WorkspaceApplyRequestSchema>,
): Promise<z.infer<typeof WorkspaceApplyResponseSchema>> {
  const bus = busFor(repoRoot);
  const changes: FileChange[] = req.changes.map((c) =>
    c.kind === 'put'
      ? { path: c.path, kind: 'put', content: base64ToBytes(c.contentBase64) }
      : { path: c.path, kind: 'delete' },
  );
  const input: WorkspaceApplyInput = {
    changes,
    parent: req.parent === null ? null : asWorkspaceVersion(req.parent),
  };
  if (req.reason !== undefined) input.reason = req.reason;
  const out = await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
    'workspace:apply',
    serverCtx(repoRoot),
    input,
  );
  return { version: out.version as string, delta: await wireDelta(out.delta) };
}

// ---------------------------------------------------------------------------
// workspace.read
// ---------------------------------------------------------------------------
export async function handleRead(
  repoRoot: string,
  req: z.infer<typeof WorkspaceReadRequestSchema>,
): Promise<z.infer<typeof WorkspaceReadResponseSchema>> {
  const bus = busFor(repoRoot);
  const input: WorkspaceReadInput = { path: req.path };
  if (req.version !== undefined) input.version = asWorkspaceVersion(req.version);
  const out = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
    'workspace:read',
    serverCtx(repoRoot),
    input,
  );
  if (out.found) {
    return { found: true, bytesBase64: bytesToBase64(out.bytes) };
  }
  return { found: false };
}

// ---------------------------------------------------------------------------
// workspace.list
// ---------------------------------------------------------------------------
export async function handleList(
  repoRoot: string,
  req: z.infer<typeof WorkspaceListRequestSchema>,
): Promise<z.infer<typeof WorkspaceListResponseSchema>> {
  const bus = busFor(repoRoot);
  const input: WorkspaceListInput = {};
  if (req.pathGlob !== undefined) input.pathGlob = req.pathGlob;
  if (req.version !== undefined) input.version = asWorkspaceVersion(req.version);
  const out = await bus.call<WorkspaceListInput, WorkspaceListOutput>(
    'workspace:list',
    serverCtx(repoRoot),
    input,
  );
  return { paths: out.paths };
}

// ---------------------------------------------------------------------------
// workspace.diff
// ---------------------------------------------------------------------------
export async function handleDiff(
  repoRoot: string,
  req: z.infer<typeof WorkspaceDiffRequestSchema>,
): Promise<z.infer<typeof WorkspaceDiffResponseSchema>> {
  const bus = busFor(repoRoot);
  const input: WorkspaceDiffInput = {
    from: req.from === null ? null : asWorkspaceVersion(req.from),
    to: asWorkspaceVersion(req.to),
  };
  const out = await bus.call<WorkspaceDiffInput, WorkspaceDiffOutput>(
    'workspace:diff',
    serverCtx(repoRoot),
    input,
  );
  return { delta: await wireDelta(out.delta) };
}
