import { readFile, writeFile, stat } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { PluginError, type ChatContext, type Plugin } from '@ax/core';
import { safePath } from './safe-path.js';

const PLUGIN_NAME = '@ax/tool-file-io';
const MAX_BYTES = 1_048_576; // 1 MiB

export const ReadFileInputSchema = z.object({
  path: z.string().min(1).max(4096),
});
export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export const WriteFileInputSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(MAX_BYTES),
});
export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;

export interface ReadFileResult {
  readonly content: string;
  readonly bytes: number;
}

export interface WriteFileResult {
  readonly bytes: number;
}

function workspaceRoot(_ctx: ChatContext): string {
  // TODO(workspace-abstraction): once ChatContext (or a dedicated workspace
  // service hook) exposes a canonical workspace root, read it here. For now
  // we fall back to process.cwd() — which is fine for the CLI happy path but
  // is the kind of implicit capability grant invariant #5 warns about.
  return process.cwd();
}

function parse<T>(schema: z.ZodType<T>, hookName: string, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `invalid ${hookName} payload: ${parsed.error.message}`,
    });
  }
  return parsed.data;
}

export function toolFileIoPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['tool:execute:read_file', 'tool:execute:write_file'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<unknown, ReadFileResult>(
        'tool:execute:read_file',
        PLUGIN_NAME,
        async (ctx, input) => {
          const { path } = parse(ReadFileInputSchema, 'tool:execute:read_file', input);
          const root = workspaceRoot(ctx);
          const resolved = await safePath(root, path);

          // Defense-in-depth: stat first so we don't slurp a 4 GiB file into
          // memory if somebody points read_file at one.
          const st = await stat(resolved);
          if (st.size > MAX_BYTES) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              hookName: 'tool:execute:read_file',
              message: `content too large: ${st.size} bytes (max ${MAX_BYTES})`,
            });
          }

          const content = await readFile(resolved, 'utf8');
          const bytes = Buffer.byteLength(content, 'utf8');
          if (bytes > MAX_BYTES) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              hookName: 'tool:execute:read_file',
              message: `content too large: ${bytes} bytes (max ${MAX_BYTES})`,
            });
          }
          return { content, bytes };
        },
      );

      bus.registerService<unknown, WriteFileResult>(
        'tool:execute:write_file',
        PLUGIN_NAME,
        async (ctx, input) => {
          const { path, content } = parse(
            WriteFileInputSchema,
            'tool:execute:write_file',
            input,
          );
          const root = workspaceRoot(ctx);
          const resolved = await safePath(root, path);
          await writeFile(resolved, content, 'utf8');
          return { bytes: Buffer.byteLength(content, 'utf8') };
        },
      );
    },
  };
}
