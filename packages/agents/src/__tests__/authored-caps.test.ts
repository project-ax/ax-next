import { describe, it, expect } from 'vitest';
import type { SkillCapabilities } from '@ax/skills-parser';
import {
  intersectProposalWithApproved,
  EMPTY_CAPABILITIES,
  type ApprovedCapEntry,
} from '../authored-caps.js';

function proposal(over: Partial<SkillCapabilities> = {}): SkillCapabilities {
  return {
    allowedHosts: ['api.linear.app'],
    credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key', account: 'linear' }],
    mcpServers: [],
    packages: { npm: ['@linear/sdk'], pypi: [] },
    ...over,
  };
}

describe('intersectProposalWithApproved', () => {
  it('with NO approvals: capabilities is empty, delta is the full proposal', () => {
    const { capabilities, delta } = intersectProposalWithApproved(proposal(), []);
    expect(capabilities).toEqual(EMPTY_CAPABILITIES);
    expect(delta).toEqual(proposal());
  });

  it('approving the host moves only the host into capabilities; the rest stays in delta', () => {
    const approved: ApprovedCapEntry[] = [{ kind: 'host', value: 'api.linear.app' }];
    const { capabilities, delta } = intersectProposalWithApproved(proposal(), approved);
    expect(capabilities.allowedHosts).toEqual(['api.linear.app']);
    expect(capabilities.credentials).toEqual([]);
    expect(capabilities.packages.npm).toEqual([]);
    expect(delta.allowedHosts).toEqual([]);
    expect(delta.credentials).toEqual([{ slot: 'LINEAR_API_KEY', kind: 'api-key', account: 'linear' }]);
    expect(delta.packages.npm).toEqual(['@linear/sdk']);
  });

  it('approving a slot matches by slot NAME and carries the proposal slot detail', () => {
    const approved: ApprovedCapEntry[] = [{ kind: 'slot', value: 'LINEAR_API_KEY' }];
    const { capabilities, delta } = intersectProposalWithApproved(proposal(), approved);
    expect(capabilities.credentials).toEqual([
      { slot: 'LINEAR_API_KEY', kind: 'api-key', account: 'linear' },
    ]);
    expect(delta.credentials).toEqual([]);
  });

  it('approving an npm package matches by package name', () => {
    const approved: ApprovedCapEntry[] = [{ kind: 'npm', value: '@linear/sdk' }];
    const { capabilities } = intersectProposalWithApproved(proposal(), approved);
    expect(capabilities.packages.npm).toEqual(['@linear/sdk']);
  });

  it('approving an mcp server matches by server name and carries its spec', () => {
    const mcp = {
      name: 'linear-mcp',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', 'linear-mcp'],
      allowedHosts: ['api.linear.app'],
      credentials: [],
    };
    const p = proposal({ mcpServers: [mcp] });
    const approved: ApprovedCapEntry[] = [{ kind: 'mcp', value: 'linear-mcp' }];
    const { capabilities, delta } = intersectProposalWithApproved(p, approved);
    expect(capabilities.mcpServers).toEqual([mcp]);
    expect(delta.mcpServers).toEqual([]);
  });

  it('an approval that is not in the proposal is ignored (no phantom grant)', () => {
    const approved: ApprovedCapEntry[] = [{ kind: 'host', value: 'evil.test' }];
    const { capabilities } = intersectProposalWithApproved(proposal(), approved);
    expect(capabilities.allowedHosts).toEqual([]);
  });
});
