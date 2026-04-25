import { describe, expect, it } from 'vitest';
import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// Wiring smoke test for @ax/preset-k8s.
//
// This is a STATIC analysis of the plugin manifests — we never call init()
// on any of the plugins, so postgres / k8s / Anthropic don't have to exist.
// What we're catching:
//
//   1. The preset returns a non-empty plugin list.
//   2. Every service hook is registered by EXACTLY one plugin (Invariant 4:
//      one source of truth — duplicate registrants would throw at bootstrap
//      anyway, but failing fast in a unit test is cheaper).
//   3. Every `calls` entry is satisfied by some plugin's `registers` (no
//      `no-service` errors at boot).
//
// What this DOESN'T catch:
//   - Subscriber-side wiring issues.
//   - Real connectivity (pg, k8s, anthropic).
//   - Hook payload shape mismatches.
//
// Real end-to-end exercise lives in Task 20's CI acceptance test (postgres
// testcontainer + mocked k8s).
//
// Dynamic-hook caveat: a few plugins (mcp-client, ipc-server, tool-
// dispatcher) register hooks dynamically at runtime — `tool:execute:${name}`
// service hooks aren't enumerable until MCP servers connect or tool
// descriptors get registered. That's why those hooks are NOT in any
// manifest's `calls` list either: callers look them up via
// `bus.hasService()` rather than declaring them statically. So the
// "calls satisfied by registers" check is bounded to the static surface,
// which is the right scope for this test.
// ---------------------------------------------------------------------------

const stubConfig: K8sPresetConfig = {
  database: { connectionString: 'postgres://stub:5432/stub' },
  eventbus: { connectionString: 'postgres://stub:5432/stub' },
  session: { connectionString: 'postgres://stub:5432/stub' },
  workspace: { repoRoot: '/tmp/preset-k8s-stub' },
  sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
  anthropic: { model: 'claude-sonnet-4-6' },
  // Override the runner binary so resolution doesn't depend on whether
  // @ax/agent-claude-sdk-runner has been built. The chat-orchestrator
  // plugin doesn't validate this string at factory time — only at first
  // sandbox:open-session call — so any non-empty string is fine here.
  chat: { runnerBinary: '/tmp/stub-runner.js' },
};

describe('@ax/preset-k8s wiring', () => {
  it('returns a non-empty plugin array', () => {
    const plugins = createK8sPlugins(stubConfig);
    expect(plugins.length).toBeGreaterThan(0);
  });

  it('every required service hook has exactly one registrant', () => {
    const plugins = createK8sPlugins(stubConfig);
    const registrations = new Map<string, string[]>();
    for (const p of plugins) {
      for (const hook of p.manifest.registers) {
        const owners = registrations.get(hook) ?? [];
        owners.push(p.manifest.name);
        registrations.set(hook, owners);
      }
    }
    const duplicates = [...registrations.entries()].filter(
      ([, owners]) => owners.length > 1,
    );
    expect(duplicates).toEqual([]);
  });

  it('every "calls" entry is satisfied by some plugin\'s "registers"', () => {
    const plugins = createK8sPlugins(stubConfig);
    const allRegistered = new Set<string>(
      plugins.flatMap((p) => p.manifest.registers),
    );
    const allCalls = new Set<string>(plugins.flatMap((p) => p.manifest.calls));
    const unsatisfied = [...allCalls].filter((c) => !allRegistered.has(c));
    expect(unsatisfied).toEqual([]);
  });

  it('contains the expected production plugin set', () => {
    // Sanity check the preset hasn't silently dropped a plugin during a
    // refactor — this is the canary that says "k8s mode means THIS list."
    // If we add or remove a plugin from the preset, this list updates and
    // a reviewer sees the diff in PR.
    const plugins = createK8sPlugins(stubConfig);
    const names = plugins.map((p) => p.manifest.name).sort();
    expect(names).toEqual(
      [
        '@ax/audit-log',
        '@ax/chat-orchestrator',
        '@ax/credentials',
        '@ax/database-postgres',
        '@ax/eventbus-postgres',
        '@ax/ipc-server',
        '@ax/llm-anthropic',
        '@ax/llm-proxy-anthropic-format',
        '@ax/mcp-client',
        '@ax/sandbox-k8s',
        '@ax/session-postgres',
        '@ax/storage-postgres',
        '@ax/tool-bash',
        '@ax/tool-dispatcher',
        '@ax/tool-file-io',
        '@ax/workspace-git',
      ].sort(),
    );
  });

  it('does NOT include local-mode-only plugins', () => {
    // Belt-and-suspenders: sandbox-subprocess, storage-sqlite, session-
    // inmemory, eventbus-inprocess and llm-mock are for the local profile.
    // If they sneak into the k8s preset, two plugins would register the
    // same service hook and bootstrap would throw — but better to fail
    // here with a clear message than at runtime.
    const plugins = createK8sPlugins(stubConfig);
    const names = new Set(plugins.map((p) => p.manifest.name));
    for (const forbidden of [
      '@ax/sandbox-subprocess',
      '@ax/storage-sqlite',
      '@ax/session-inmemory',
      '@ax/eventbus-inprocess',
      '@ax/llm-mock',
    ]) {
      expect(names.has(forbidden)).toBe(false);
    }
  });
});
