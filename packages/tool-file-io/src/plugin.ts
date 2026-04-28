import { makeAgentContext, type Plugin, type ToolDescriptor } from '@ax/core';
import { readFileToolDescriptor, writeFileToolDescriptor } from './descriptors.js';

const PLUGIN_NAME = '@ax/tool-file-io';

/**
 * Descriptor-only plugin: declares `read_file` and `write_file` tools to
 * the dispatcher. The actual execution lives sandbox-side in
 * `@ax/tool-file-io-impl` (Task 10) along with the `safePath`
 * canonicalization module — kept in this package for now (unused here,
 * still tested) and moved alongside the impl when it lands.
 *
 * Manifest `registers: []`: no host-side service hooks. `calls:
 * ['tool:register']`: we announce ourselves to the catalog during init().
 */
export function createToolFileIoPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: ['tool:register'],
      subscribes: [],
    },
    async init({ bus }) {
      const ctx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'init',
      });
      await bus.call<ToolDescriptor, { ok: true }>(
        'tool:register',
        ctx,
        readFileToolDescriptor,
      );
      await bus.call<ToolDescriptor, { ok: true }>(
        'tool:register',
        ctx,
        writeFileToolDescriptor,
      );
    },
  };
}
