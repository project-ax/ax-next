import { describe, it, expect } from 'vitest';
import {
  AUTOMATIC_TOOLS,
  groupAgentTools,
  setTools,
  unknownTools,
  type ToolCatalogState,
} from '../agent-tool-areas';
import { PROD_TOOL_CATALOG } from './agent-tool-catalog.fixture';

const ok: ToolCatalogState = { status: 'ok', ...PROD_TOOL_CATALOG };

describe('groupAgentTools', () => {
  it('groups the production catalog into five areas and hides what the orchestrator adds itself', () => {
    const areas = groupAgentTools(PROD_TOOL_CATALOG);
    expect(areas.map((a) => [a.id, a.tools])).toEqual([
      ['basics', ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']],
      [
        'routines',
        ['routine_list', 'routine_get', 'routine_create', 'routine_update', 'routine_delete', 'routine_fire_now'],
      ],
      ['memory', ['memory_recall', 'memory_use', 'memory_note']],
      ['web', ['web_search', 'web_extract']],
      ['sharing', ['artifact_publish', 'show_visual']],
    ]);
    for (const a of areas) for (const t of a.tools) expect(AUTOMATIC_TOOLS.has(t)).toBe(false);
  });

  it('a tool no area claims lands in Other tools', () => {
    expect(groupAgentTools({ tools: ['calendar_add'], builtins: [] })).toEqual([
      {
        id: 'other',
        label: 'Other tools',
        hint: 'Tools that don’t fit a group above.',
        tools: ['calendar_add'],
      },
    ]);
  });

  it('omits empty areas', () => {
    const areas = groupAgentTools({ tools: ['routine_get'], builtins: ['Bash'] });
    expect(areas.map((a) => a.id)).toEqual(['basics', 'routines']);
  });
});

describe('unknownTools', () => {
  it('names only what neither list has, matching exactly like the dispatcher', () => {
    expect(
      unknownTools(['Bash', 'routines', 'routine_create', 'search_catalog', 'bash', 'read_file', 'routines'], ok),
    ).toEqual(['routines', 'bash', 'read_file']);
  });

  it('proves nothing while loading or after a failed read', () => {
    expect(unknownTools(['routines'], { status: 'loading' })).toEqual([]);
    expect(unknownTools(['routines'], { status: 'failed' })).toEqual([]);
  });
});

describe('setTools', () => {
  it('adds in order without duplicates and removes without touching other entries', () => {
    expect(setTools(['routines', 'Bash'], ['routine_list', 'Bash', 'routine_get'], true)).toEqual([
      'routines',
      'Bash',
      'routine_list',
      'routine_get',
    ]);
    expect(
      setTools(['routines', 'routine_list', 'Bash', 'routine_get'], ['routine_list', 'routine_get'], false),
    ).toEqual(['routines', 'Bash']);
  });
});
