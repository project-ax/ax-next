import { isAbsolute, parse, posix, resolve, sep } from 'node:path';

import type { Plugin } from '@ax/core';
import {
  createK8sPlugins,
  loadK8sConfigFromEnv,
  type K8sPresetConfig,
} from '@ax/preset-k8s';
import {
  createMemoryPlugin,
  validateVolumeConfig,
  type MemoryVolumeConfig,
} from '@ax/memory';
import { createMemoryFactsSqlitePlugin } from '@ax/memory-facts-sqlite';
import {
  createEmbeddingsPlugin,
  EMBED_HOOK,
  RERANK_HOOK,
} from '@ax/embeddings';
import { createChannelWebServerPlugin } from '@ax/channel-web/server';

/**
 * The ONE provider credential the memory preset needs (TASK-523). The
 * observer's extraction model, embeddings and reranking all run through
 * OpenRouter on this ref, which the admin Provider keys screen writes — a
 * long-lived key with a validate-and-save path, replacing a ~1 h Vertex bearer
 * token and a Cohere key that had no product write path at all.
 */
export const MEMORY_CREDENTIAL_REF = 'provider:openrouter';

/**
 * The embedding model, pinned on the FACT STORE's embedder ref rather than
 * left to the producer's default. The store records this string as the
 * fingerprint of the vectors it holds and sends it in every embed payload, so
 * changing it here is what makes the store drop the old vectors and re-embed —
 * two models' vectors are never compared. 384 dims is native for this model.
 */
export const MEMORY_EMBED_MODEL = 'google/gemini-embedding-001:nitro';

/** The rerank model — `voyageai/rerank-2.5` on OpenRouter's fastest route. */
export const MEMORY_RERANK_MODEL = 'voyageai/rerank-2.5:nitro';

export interface MemoryPresetConfig extends K8sPresetConfig {
  factsDatabasePath: string;
  memoryExportVolume: MemoryVolumeConfig;
  /** Test seam: the fetch the embed/rerank drivers use. Production leaves it unset. */
  memoryEmbeddings?: {
    fetchImpl?: typeof fetch;
  };
  onObserverDetached?: (work: Promise<void>) => void;
}

function posixPathsOverlap(a: string, b: string): boolean {
  const ra = posix.resolve('/', a);
  const rb = posix.resolve('/', b);
  return ra === '/' || rb === '/' || ra === rb || ra.startsWith(rb + '/') || rb.startsWith(ra + '/');
}

function hostPathsOverlap(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  const root = parse(ra).root;
  return ra === rb || ra === root || rb === root || ra.startsWith(rb + sep) || rb.startsWith(ra + sep);
}

function validateMemoryPresetConfig(config: MemoryPresetConfig): void {
  const dbPath = config.factsDatabasePath;
  if (
    typeof dbPath !== 'string' ||
    !isAbsolute(dbPath) ||
    resolve(dbPath) === parse(resolve(dbPath)).root
  ) {
    throw new Error(
      'memory preset requires an absolute, non-root factsDatabasePath',
    );
  }

  validateVolumeConfig(config.memoryExportVolume);

  const hostRoot = config.memoryExportVolume.hostRoot;
  const repoRoot =
    config.workspace.backend === 'local' ? config.workspace.repoRoot : undefined;
  const userFilesRoot = config.sandbox?.userFilesHostReadRoot;
  if (repoRoot !== undefined && hostPathsOverlap(hostRoot, repoRoot)) {
    throw new Error(
      'memory export hostRoot must not equal or overlap the workspace repoRoot',
    );
  }
  if (userFilesRoot !== undefined && hostPathsOverlap(hostRoot, userFilesRoot)) {
    throw new Error(
      'memory export hostRoot must not equal or overlap sandbox.userFilesHostReadRoot',
    );
  }
  if (hostPathsOverlap(dbPath, hostRoot)) {
    throw new Error(
      'factsDatabasePath must not equal or overlap the memory export hostRoot',
    );
  }
  if (repoRoot !== undefined && hostPathsOverlap(dbPath, repoRoot)) {
    throw new Error(
      'factsDatabasePath must not equal or overlap the workspace repoRoot',
    );
  }
  if (userFilesRoot !== undefined && hostPathsOverlap(dbPath, userFilesRoot)) {
    throw new Error(
      'factsDatabasePath must not equal or overlap sandbox.userFilesHostReadRoot',
    );
  }

  const filestore = config.filestore;
  if (filestore !== undefined) {
    if (posixPathsOverlap(config.memoryExportVolume.backing.exportPath, filestore.exportPath)) {
      throw new Error(
        'memory export backing exportPath must not equal or overlap the filestore exportPath',
      );
    }
    const filestoreMount = filestore.mountPath ?? '/files';
    if (posixPathsOverlap(filestoreMount, '/memory')) {
      throw new Error(
        'filestore mountPath must not equal or overlap the memory mount path',
      );
    }
  }
}

const EXCLUDED_PLUGINS = new Set([
  '@ax/memory-strata',
  '@ax/memory-strata-index-postgres',
  '@ax/memory-facts-postgres',
  '@ax/channel-web',
]);

export function createMemoryPlugins(config: MemoryPresetConfig): Plugin[] {
  validateMemoryPresetConfig(config);
  const chatTimeoutMs = config.chat?.chatTimeoutMs ?? 10 * 60_000;
  const base = createK8sPlugins({
    ...config,
    chat: { ...config.chat, chatTimeoutMs },
  }).filter((p) => !EXCLUDED_PLUGINS.has(p.manifest.name));
  return [
    ...base,
    createMemoryFactsSqlitePlugin({
      databasePath: config.factsDatabasePath,
      embedder: { hook: EMBED_HOOK, model: MEMORY_EMBED_MODEL },
      reranker: { hook: RERANK_HOOK, model: MEMORY_RERANK_MODEL },
    }),
    createEmbeddingsPlugin({
      embed: {
        provider: 'openrouter',
        credentialRef: MEMORY_CREDENTIAL_REF,
        model: MEMORY_EMBED_MODEL,
      },
      rerank: {
        provider: 'openrouter',
        credentialRef: MEMORY_CREDENTIAL_REF,
        model: MEMORY_RERANK_MODEL,
      },
      ...(config.memoryEmbeddings?.fetchImpl !== undefined
        ? { fetchImpl: config.memoryEmbeddings.fetchImpl }
        : {}),
    }),
    createMemoryPlugin({
      rules: true,
      exports: { volume: config.memoryExportVolume },
      ...(config.onObserverDetached !== undefined
        ? { onObserverDetached: config.onObserverDetached }
        : {}),
    }),
    createChannelWebServerPlugin({ chatTimeoutMs }),
  ];
}

export function loadMemoryConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MemoryPresetConfig {
  const base = loadK8sConfigFromEnv(env);
  const factsDatabasePath = env.AX_MEMORY_FACTS_DB_PATH;
  if (factsDatabasePath === undefined || factsDatabasePath === '') {
    throw new Error('AX_MEMORY_FACTS_DB_PATH is required');
  }
  const exportHostRoot = env.AX_MEMORY_EXPORT_HOST_ROOT;
  if (exportHostRoot === undefined || exportHostRoot === '') {
    throw new Error('AX_MEMORY_EXPORT_HOST_ROOT is required');
  }
  const nfsServer = env.AX_MEMORY_EXPORT_NFS_SERVER;
  if (nfsServer === undefined || nfsServer === '') {
    throw new Error('AX_MEMORY_EXPORT_NFS_SERVER is required');
  }
  const nfsExportPath = env.AX_MEMORY_EXPORT_NFS_PATH;
  if (nfsExportPath === undefined || nfsExportPath === '') {
    throw new Error('AX_MEMORY_EXPORT_NFS_PATH is required');
  }
  const config: MemoryPresetConfig = {
    ...base,
    factsDatabasePath,
    memoryExportVolume: {
      hostRoot: exportHostRoot,
      backing: { server: nfsServer, exportPath: nfsExportPath },
    },
  };
  validateMemoryPresetConfig(config);
  return config;
}
