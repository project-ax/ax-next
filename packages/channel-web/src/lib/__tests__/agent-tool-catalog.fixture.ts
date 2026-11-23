import type { AgentToolCatalog } from '../admin';

/** The deployed memory preset's tool catalog as of 2026-11-23. */
export const PROD_TOOL_CATALOG: AgentToolCatalog = {
  tools: [
    'search_catalog',
    'request_capability',
    'skill_propose',
    'connector_propose',
    'artifact_publish',
    'show_visual',
    'web_search',
    'web_extract',
    'update_identity',
    'complete_bootstrap',
    'routine_list',
    'routine_get',
    'routine_create',
    'routine_update',
    'routine_delete',
    'routine_fire_now',
    'routine_report',
    'routine_read_update',
    'memory_recall',
    'memory_use',
    'memory_note',
  ],
  builtins: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
};
