import { describe, it, expect } from 'vitest';
import type { ToolDescriptor } from '@ax/core';
import { filterByAgentScope } from '../scope.js';

// ---------------------------------------------------------------------------
// scope.test — pure-function tests for the per-agent filter.
//
// `filterByAgentScope` is the only place tool-dispatcher decides "is this
// tool visible to this agent?". The bus wiring happens in plugin.ts; here
// we just exercise the rules:
//
//   - Native tools survive iff their name appears in `allowedTools`.
//   - MCP tools (name starts with `mcp.<configId>.`) survive iff
//     `<configId>` appears in `mcpConfigIds`.
//   - Anything else (defensively-malformed `mcp.` names, etc.) is filtered.
//
// This file does NOT touch the bus — keeping it I/O-free means the rule
// is testable in isolation, and a regression in the rule shows up here
// instead of behind a fixture.
// ---------------------------------------------------------------------------

const native = (name: string): ToolDescriptor => ({
  name,
  inputSchema: { type: 'object' },
  executesIn: 'sandbox',
});

const mcp = (name: string): ToolDescriptor => ({
  name,
  inputSchema: { type: 'object' },
  executesIn: 'host',
});

describe('filterByAgentScope', () => {
  it('empty allowedTools AND empty mcpConfigIds → wildcard pass-through (dev-stub contract)', () => {
    // The @ax/cli dev-agents-stub ships defaults of empty-empty and its
    // file comment locks the dispatcher's interpretation as "wildcard:
    // every tool visible." If you change this, also update the stub
    // doc and the CLI e2e in packages/cli/src/__tests__/claude-sdk-runner.e2e.test.ts.
    const out = filterByAgentScope(
      [native('bash'), native('read_file'), mcp('mcp.alpha.echo')],
      { allowedTools: [], mcpConfigIds: [] },
    );
    expect(out.map((d) => d.name)).toEqual([
      'bash',
      'read_file',
      'mcp.alpha.echo',
    ]);
  });

  it('empty allowedTools with non-empty mcpConfigIds → only that MCP server, no natives', () => {
    const out = filterByAgentScope(
      [native('bash'), native('read_file'), mcp('mcp.alpha.echo'), mcp('mcp.beta.echo')],
      { allowedTools: [], mcpConfigIds: ['alpha'] },
    );
    expect(out.map((d) => d.name)).toEqual(['mcp.alpha.echo']);
  });

  it('non-empty allowedTools with empty mcpConfigIds → only those natives, no MCP', () => {
    const out = filterByAgentScope(
      [native('bash'), native('read_file'), mcp('mcp.alpha.echo')],
      { allowedTools: ['bash'], mcpConfigIds: [] },
    );
    expect(out.map((d) => d.name)).toEqual(['bash']);
  });

  it('keeps native tools listed in allowedTools', () => {
    const out = filterByAgentScope(
      [native('bash'), native('read_file'), native('write_file')],
      { allowedTools: ['bash', 'read_file'], mcpConfigIds: [] },
    );
    expect(out.map((d) => d.name)).toEqual(['bash', 'read_file']);
  });

  it('drops native tools missing from allowedTools', () => {
    const out = filterByAgentScope(
      [native('bash'), native('rm_rf')],
      { allowedTools: ['bash'], mcpConfigIds: [] },
    );
    expect(out.map((d) => d.name)).toEqual(['bash']);
  });

  it('keeps MCP tools whose configId is in mcpConfigIds', () => {
    const out = filterByAgentScope(
      [mcp('mcp.alpha.read_file'), mcp('mcp.alpha.write_file')],
      { allowedTools: [], mcpConfigIds: ['alpha'] },
    );
    expect(out.map((d) => d.name)).toEqual([
      'mcp.alpha.read_file',
      'mcp.alpha.write_file',
    ]);
  });

  it('drops MCP tools whose configId is NOT in mcpConfigIds', () => {
    const out = filterByAgentScope(
      [mcp('mcp.alpha.read_file'), mcp('mcp.beta.read_file')],
      { allowedTools: [], mcpConfigIds: ['alpha'] },
    );
    expect(out.map((d) => d.name)).toEqual(['mcp.alpha.read_file']);
  });

  it('cross-tenant: agent allowing alpha only sees mcp.alpha.* never mcp.beta.*', () => {
    const all = [
      mcp('mcp.alpha.read_file'),
      mcp('mcp.beta.read_file'),
      mcp('mcp.alpha.write_file'),
      mcp('mcp.beta.write_file'),
    ];
    const out = filterByAgentScope(all, {
      allowedTools: [],
      mcpConfigIds: ['alpha'],
    });
    expect(out.map((d) => d.name)).toEqual([
      'mcp.alpha.read_file',
      'mcp.alpha.write_file',
    ]);
  });

  it('keeps native + MCP together when both lists allow', () => {
    const out = filterByAgentScope(
      [
        native('bash'),
        native('read_file'),
        mcp('mcp.alpha.search'),
        mcp('mcp.beta.search'),
      ],
      { allowedTools: ['bash'], mcpConfigIds: ['beta'] },
    );
    expect(out.map((d) => d.name)).toEqual(['bash', 'mcp.beta.search']);
  });

  it('drops malformed mcp-prefixed names defensively', () => {
    // `mcp.foo` has no second dot — there is no parseable configId. We
    // bias toward dropping rather than guessing; an attacker who can
    // register a tool named `mcp.foo` shouldn't be able to leak it
    // across tenants by virtue of the prefix alone.
    const out = filterByAgentScope(
      [
        { name: 'mcp.foo', inputSchema: { type: 'object' }, executesIn: 'host' },
        { name: 'mcp.', inputSchema: { type: 'object' }, executesIn: 'host' },
      ],
      { allowedTools: [], mcpConfigIds: ['foo'] },
    );
    expect(out).toEqual([]);
  });

  it('preserves descriptor identity (no clone) and registration order', () => {
    const a = native('bash');
    const b = mcp('mcp.alpha.echo');
    const c = native('read_file');
    const out = filterByAgentScope([a, b, c], {
      allowedTools: ['bash', 'read_file'],
      mcpConfigIds: ['alpha'],
    });
    // Same objects, same order.
    expect(out).toEqual([a, b, c]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
    expect(out[2]).toBe(c);
  });
});
