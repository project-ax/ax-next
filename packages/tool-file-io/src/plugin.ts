import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PluginError, type Plugin } from '@ax/core';
import { safePath } from './safe-path.js';

const PLUGIN_NAME = '@ax/tool-file-io';

// 1 MiB cap applies to both read and write. We keep it as a byte count,
// not a character count, because the LLM thinks in characters but the
// filesystem (and any network it sits behind) thinks in bytes.
const MAX_FILE_BYTES = 1_048_576;

const ReadFileInputSchema = z.object({
  path: z.string().min(1).max(4096),
});

// I4: content is z.string() with no .max(). A Zod .max(N) on a string
// counts UTF-16 code units, NOT UTF-8 bytes — so '😀'.repeat(300_000) has
// length 600_000 (would pass .max(1_048_576)) but is 1_200_000 UTF-8 bytes.
// The byte cap is enforced below via Buffer.byteLength(content, 'utf8').
const WriteFileInputSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string(),
});

export function createToolFileIoPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['tool:execute:read_file', 'tool:execute:write_file'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService(
        'tool:execute:read_file',
        PLUGIN_NAME,
        async (ctx, raw) => {
          const parsed = ReadFileInputSchema.parse(raw);
          const resolved = await safePath(ctx.workspace.rootPath, parsed.path);
          // Pre-read stat: stream a 10 GB file through readFile and we OOM
          // before the cap ever fires. stat first, then read only if the
          // size is already under the cap.
          const stat = await fs.stat(resolved);
          if (stat.size > MAX_FILE_BYTES) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              hookName: 'tool:execute:read_file',
              message: `file exceeds ${MAX_FILE_BYTES} bytes (size=${stat.size})`,
            });
          }
          const content = await fs.readFile(resolved, 'utf8');
          return { path: parsed.path, content, bytes: stat.size };
        },
      );

      bus.registerService(
        'tool:execute:write_file',
        PLUGIN_NAME,
        async (ctx, raw) => {
          const parsed = WriteFileInputSchema.parse(raw);
          const bytes = Buffer.byteLength(parsed.content, 'utf8');
          if (bytes > MAX_FILE_BYTES) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              hookName: 'tool:execute:write_file',
              message: `write exceeds ${MAX_FILE_BYTES} bytes (got ${bytes})`,
            });
          }
          const resolved = await safePath(ctx.workspace.rootPath, parsed.path);
          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, parsed.content, 'utf8');
          return { path: parsed.path, bytes };
        },
      );
    },
  };
}
