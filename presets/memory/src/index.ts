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
import { createRoutinesPlugin, SKILL_REFLECTION_ROUTINE_NAME } from '@ax/routines';

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
  /**
   * The NFS-backed read-only `/memory` view for runners. Optional: without it
   * the memory plugin still exports each agent's facts into the workspace
   * (`permanent/memory/facts/**`), recall and the Memory tab work, but runners
   * get no `/memory` mount (`sandbox:memory-mounts` is not registered).
   */
  memoryExportVolume?: MemoryVolumeConfig;
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

  const repoRoot =
    config.workspace.backend === 'local' ? config.workspace.repoRoot : undefined;
  const userFilesRoot = config.sandbox?.userFilesHostReadRoot;
  const volume = config.memoryExportVolume;
  if (volume !== undefined) {
    validateVolumeConfig(volume);
    const hostRoot = volume.hostRoot;
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
    if (
      volume !== undefined &&
      posixPathsOverlap(volume.backing.exportPath, filestore.exportPath)
    ) {
      throw new Error(
        'memory export backing exportPath must not equal or overlap the filestore exportPath',
      );
    }
    // Checked even without the export volume: `/memory` stays reserved so
    // turning the volume on later can never collide with an existing mount.
    const filestoreMount = filestore.mountPath ?? '/files';
    if (posixPathsOverlap(filestoreMount, '/memory')) {
      throw new Error(
        'filestore mountPath must not equal or overlap the memory mount path',
      );
    }
  }
}

const EXCLUDED_PLUGINS = new Set([
  '@ax/memory-facts-postgres',
  '@ax/channel-web',
  // Re-added below with skill-reflection forced OFF (TASK-609).
  '@ax/routines',
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
      // Always export: the workspace facts view (permanent/memory/facts/**)
      // needs no volume. The volume only adds the runner's /memory mount.
      exports:
        config.memoryExportVolume !== undefined
          ? { volume: config.memoryExportVolume }
          : {},
      ...(config.onObserverDetached !== undefined
        ? { onObserverDetached: config.onObserverDetached }
        : {}),
    }),
    createChannelWebServerPlugin({ chatTimeoutMs }),
    // TASK-609: skill-reflection's recurrence gate reads the old Strata
    // `memory/docs/**` `source_conversations` frontmatter, which facts memory
    // does not have — so under this preset it stays OFF (existing deployments
    // included). Strata itself is gone (TASK-608); the override stays until
    // TASK-611 gives reflection a recurrence signal facts memory can supply.
    // Everything else about routines is the k8s preset's
    // `createRoutinesPlugin()` default.
    createRoutinesPlugin({ forceDisabledDefaults: [SKILL_REFLECTION_ROUTINE_NAME] }),
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
  const memoryExportVolume = loadMemoryExportVolumeFromEnv(env);
  const config: MemoryPresetConfig = {
    ...base,
    factsDatabasePath,
    ...(memoryExportVolume !== undefined ? { memoryExportVolume } : {}),
  };
  validateMemoryPresetConfig(config);
  return config;
}

const MEMORY_EXPORT_ENV = [
  'AX_MEMORY_EXPORT_HOST_ROOT',
  'AX_MEMORY_EXPORT_NFS_SERVER',
  'AX_MEMORY_EXPORT_NFS_PATH',
] as const;

/**
 * The three export vars are all-or-none: none set means no `/memory` mount for
 * runners (a supported shape); a partial set is a misconfiguration we refuse
 * to boot with rather than silently dropping the mount.
 */
function loadMemoryExportVolumeFromEnv(
  env: NodeJS.ProcessEnv,
): MemoryVolumeConfig | undefined {
  const present = MEMORY_EXPORT_ENV.filter((name) => {
    const v = env[name];
    return v !== undefined && v !== '';
  });
  if (present.length === 0) return undefined;
  if (present.length < MEMORY_EXPORT_ENV.length) {
    const missing = MEMORY_EXPORT_ENV.filter((name) => !present.includes(name));
    throw new Error(
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required when ` +
        `${present.join(', ')} ${present.length === 1 ? 'is' : 'are'} set ` +
        '(the memory export vars are all-or-none)',
    );
  }
  return {
    hostRoot: env.AX_MEMORY_EXPORT_HOST_ROOT as string,
    backing: {
      server: env.AX_MEMORY_EXPORT_NFS_SERVER as string,
      exportPath: env.AX_MEMORY_EXPORT_NFS_PATH as string,
    },
  };
}
