import { describe, expect, it } from 'vitest';
import type { ServiceHandler } from '@ax/core';
import type { OpenSessionInput } from '@ax/sandbox-protocol';
import type {
  MountSpec,
  NfsMountSpec,
  LocalDirMountSpec,
  ResolveMountsInput,
  ResolveMountsOutput,
  ResolveMountsHandler,
} from '../index.js';

// This package is pure TS types — the contract IS the type (no zod, no runtime).
// `sandbox:resolve-mounts` is a HOST-INTERNAL service hook consumed as a
// `registerService<In,Out>` / `bus.call<In,Out>` generic; it never crosses the
// sandbox edge, so there is no untrusted wire to validate here (mirrors
// @ax/workspace-bundle-protocol — ARCH-3 / invariant I1). These tests pin the
// contract: a typed literal must satisfy each member of the union, the
// discriminator must be the ONLY safe key to branch on, and the hook signature
// must line up with @ax/core's ServiceHandler and @ax/sandbox-protocol's owner.

describe('MountSpec — nfs member', () => {
  it('carries the Filestore/NFS backend fields per design §4', () => {
    const nfs: NfsMountSpec = {
      kind: 'nfs',
      mountPath: '/workspace',
      server: '10.0.0.2',
      exportPath: '/vol1/agents',
      subPath: 'agent-abc',
      readOnly: false,
      role: 'user-files',
    };
    expect(nfs.kind).toBe('nfs');
    expect(nfs.mountPath).toBe('/workspace');
    expect(nfs.server).toBe('10.0.0.2');
    expect(nfs.exportPath).toBe('/vol1/agents');
    expect(nfs.subPath).toBe('agent-abc');
    expect(nfs.readOnly).toBe(false);
    expect(nfs.role).toBe('user-files');
  });

  it('makes role optional (host-read realization may omit it)', () => {
    const nfs: NfsMountSpec = {
      kind: 'nfs',
      mountPath: '/workspace',
      server: '10.0.0.2',
      exportPath: '/vol1/agents',
      subPath: 'agent-abc',
      readOnly: true,
    };
    expect(nfs.role).toBeUndefined();
    expect(nfs.readOnly).toBe(true);
  });

  it('is assignable to the MountSpec union', () => {
    const spec: MountSpec = {
      kind: 'nfs',
      mountPath: '/workspace',
      server: '10.0.0.2',
      exportPath: '/vol1/agents',
      subPath: 'agent-abc',
      readOnly: false,
      role: 'user-files',
    };
    expect(spec.kind).toBe('nfs');
  });
});

describe('MountSpec — localDir member', () => {
  it('carries the dev-host backend fields per design §4', () => {
    const local: LocalDirMountSpec = {
      kind: 'localDir',
      mountPath: '/workspace',
      hostPath: '/var/lib/ax/userfiles/agent-abc',
      readOnly: false,
      role: 'user-files',
    };
    expect(local.kind).toBe('localDir');
    expect(local.mountPath).toBe('/workspace');
    expect(local.hostPath).toBe('/var/lib/ax/userfiles/agent-abc');
    expect(local.readOnly).toBe(false);
    expect(local.role).toBe('user-files');
  });

  it('is assignable to the MountSpec union', () => {
    const spec: MountSpec = {
      kind: 'localDir',
      mountPath: '/workspace',
      hostPath: '/tmp/ax/agent-abc',
      readOnly: false,
    };
    expect(spec.kind).toBe('localDir');
  });
});

describe('MountSpec — opaque discriminated union', () => {
  it('narrows on kind and never exposes one member backend fields on the other', () => {
    // A consumer MUST switch on `kind`. After narrowing to 'nfs', the NFS
    // fields are present; after narrowing to 'localDir', `hostPath` is. The
    // narrowing functions below would NOT type-check if a consumer tried to
    // read `spec.server` without first checking `kind === 'nfs'`.
    const describeMount = (spec: MountSpec): string => {
      switch (spec.kind) {
        case 'nfs':
          return `${spec.server}:${spec.exportPath}/${spec.subPath} -> ${spec.mountPath}`;
        case 'localDir':
          return `${spec.hostPath} -> ${spec.mountPath}`;
        default: {
          // Exhaustiveness: a future `kind` makes this assignment fail to
          // compile, forcing every consumer to handle the new member.
          const _exhaustive: never = spec;
          return _exhaustive;
        }
      }
    };

    expect(
      describeMount({
        kind: 'nfs',
        mountPath: '/workspace',
        server: '10.0.0.2',
        exportPath: '/vol1/agents',
        subPath: 'agent-abc',
        readOnly: false,
      }),
    ).toBe('10.0.0.2:/vol1/agents/agent-abc -> /workspace');

    expect(
      describeMount({
        kind: 'localDir',
        mountPath: '/workspace',
        hostPath: '/tmp/ax/agent-abc',
        readOnly: false,
      }),
    ).toBe('/tmp/ax/agent-abc -> /workspace');
  });
});

describe('sandbox:resolve-mounts signature', () => {
  it('input carries the session owner (reused from @ax/sandbox-protocol)', () => {
    const owner: NonNullable<OpenSessionInput['owner']> = {
      userId: 'user-1',
      agentId: 'agent-abc',
      agentConfig: {
        displayName: 'A',
        systemPromptAugment: '',
        allowedTools: [],
        mcpConfigIds: [],
        model: 'claude',
      },
    };
    const input: ResolveMountsInput = { owner };
    expect(input.owner.agentId).toBe('agent-abc');
    expect(input.owner.userId).toBe('user-1');
  });

  it('output is { mounts: MountSpec[] } and may be empty (ownerless / no-mount)', () => {
    const out: ResolveMountsOutput = { mounts: [] };
    expect(out.mounts).toEqual([]);

    const withMount: ResolveMountsOutput = {
      mounts: [
        {
          kind: 'nfs',
          mountPath: '/workspace',
          server: '10.0.0.2',
          exportPath: '/vol1/agents',
          subPath: 'agent-abc',
          readOnly: false,
          role: 'user-files',
        },
      ],
    };
    expect(withMount.mounts).toHaveLength(1);
    expect(withMount.mounts[0]?.kind).toBe('nfs');
  });

  it('ResolveMountsHandler is a @ax/core ServiceHandler over the in/out pair', () => {
    // Assignability proves the alias holds: a handler typed against the raw
    // ServiceHandler generic must be assignable to ResolveMountsHandler and
    // back. This is the contract a provider's `bus.call` / a plugin's
    // `registerService` keys off.
    const raw: ServiceHandler<ResolveMountsInput, ResolveMountsOutput> = async (
      _ctx,
      input,
    ) => ({ mounts: input.owner.agentId ? [] : [] });
    const handler: ResolveMountsHandler = raw;
    const back: ServiceHandler<ResolveMountsInput, ResolveMountsOutput> = handler;
    expect(typeof back).toBe('function');
  });
});
