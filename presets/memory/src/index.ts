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

export const DEFAULT_VERTEX_CREDENTIAL_REF = 'provider:vertex';
export const DEFAULT_COHERE_CREDENTIAL_REF = 'provider:cohere';

export interface MemoryPresetConfig extends K8sPresetConfig {
  factsDatabasePath: string;
  memoryExportVolume: MemoryVolumeConfig;
  memoryEmbeddings: {
    projectId: string;
    embedCredentialRef?: string;
    rerankCredentialRef?: string;
    fetchImpl?: typeof fetch;
  };
  agentWorkspacePreview?: boolean;
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

  const embeddings = config.memoryEmbeddings;
  if (
    embeddings === null ||
    typeof embeddings !== 'object' ||
    typeof embeddings.projectId !== 'string' ||
    embeddings.projectId.trim() === ''
  ) {
    throw new Error('memory preset requires a non-empty vertex projectId');
  }
  for (const [name, ref] of [
    ['embedCredentialRef', embeddings.embedCredentialRef],
    ['rerankCredentialRef', embeddings.rerankCredentialRef],
  ] as const) {
    if (ref !== undefined && (typeof ref !== 'string' || ref.trim() === '')) {
      throw new Error(`memory preset ${name} must be a non-empty credential ref`);
    }
  }
  if (
    config.agentWorkspacePreview !== undefined &&
    typeof config.agentWorkspacePreview !== 'boolean'
  ) {
    throw new Error('memory preset agentWorkspacePreview must be a boolean');
  }

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
      embedder: { hook: EMBED_HOOK },
      reranker: { hook: RERANK_HOOK },
    }),
    createEmbeddingsPlugin({
      embed: {
        provider: 'vertex',
        projectId: config.memoryEmbeddings.projectId,
        credentialRef:
          config.memoryEmbeddings.embedCredentialRef ?? DEFAULT_VERTEX_CREDENTIAL_REF,
      },
      rerank: {
        provider: 'cohere',
        credentialRef:
          config.memoryEmbeddings.rerankCredentialRef ?? DEFAULT_COHERE_CREDENTIAL_REF,
      },
      ...(config.memoryEmbeddings.fetchImpl !== undefined
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
    createChannelWebServerPlugin({
      chatTimeoutMs,
      agentWorkspacePreview: config.agentWorkspacePreview === true,
    }),
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
  const vertexProject = env.AX_MEMORY_VERTEX_PROJECT;
  if (vertexProject === undefined || vertexProject === '') {
    throw new Error('AX_MEMORY_VERTEX_PROJECT is required');
  }
  const embedCredentialRef =
    env.AX_MEMORY_VERTEX_CREDENTIAL_REF !== undefined &&
    env.AX_MEMORY_VERTEX_CREDENTIAL_REF !== ''
      ? env.AX_MEMORY_VERTEX_CREDENTIAL_REF
      : DEFAULT_VERTEX_CREDENTIAL_REF;
  const rerankCredentialRef =
    env.AX_MEMORY_COHERE_CREDENTIAL_REF !== undefined &&
    env.AX_MEMORY_COHERE_CREDENTIAL_REF !== ''
      ? env.AX_MEMORY_COHERE_CREDENTIAL_REF
      : DEFAULT_COHERE_CREDENTIAL_REF;

  const previewRaw = env.AX_AGENT_WORKSPACE_PREVIEW;
  let agentWorkspacePreview = false;
  if (previewRaw !== undefined && previewRaw !== '') {
    if (previewRaw === '1' || previewRaw === 'true') {
      agentWorkspacePreview = true;
    } else if (previewRaw === '0' || previewRaw === 'false') {
      agentWorkspacePreview = false;
    } else {
      throw new Error('AX_AGENT_WORKSPACE_PREVIEW must be 1/true or 0/false');
    }
  }

  const config: MemoryPresetConfig = {
    ...base,
    factsDatabasePath,
    memoryExportVolume: {
      hostRoot: exportHostRoot,
      backing: { server: nfsServer, exportPath: nfsExportPath },
    },
    memoryEmbeddings: {
      projectId: vertexProject,
      embedCredentialRef,
      rerankCredentialRef,
    },
    agentWorkspacePreview,
  };
  validateMemoryPresetConfig(config);
  return config;
}
