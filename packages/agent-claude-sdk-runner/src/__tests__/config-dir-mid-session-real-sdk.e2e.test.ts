import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { assertConfigDirFresh } from '@ax/agent-runner-core';
import { createConfigChangeHook } from '../config-change.js';
import { createPreToolUseHook } from '../pre-tool-use.js';
import { readProjectedSkills } from '../projected-skills.js';
import { stripClaudeCodeEnv } from './real-sdk-env.js';
import {
  ENV_PROBE_COMMAND,
  HAVE_BINARY,
  makeSandboxDirs,
  mainFloors,
  openSession,
  plantSettingsCommand,
  printfMarker,
  projectLockedSkill,
  removeTree,
  sleep,
  startScriptedServer,
  stubIpcClient,
  toolResultsIn,
  waitUntil,
  type ScriptedServer,
  type Step,
} from './scripted-model.js';

// ---------------------------------------------------------------------------
// TASK-1217 item 1 — what the CLI does to its configuration MID-SESSION, on
// the REAL claude binary (no network, no key: a scripted local server records
// what the CLI sends to the model).
//
// Measured on CLI 2.1.119 (plan M3-M6):
//   - settings.json: the CLI watches the settings dir only if the file existed
//     when it started. Seed `{}` and a mid-session plant (env + hooks) goes
//     live on the next turn. A `ConfigChange` SDK hook returning
//     `{ decision: 'block' }` stops that.
//   - skills/: the CLI hot-reloads `$CLAUDE_CONFIG_DIR/skills` (there is no
//     switch to turn it off). The 0555 lock is a belt: the agent's shell can
//     `chmod -R u+w` it. A planted listing and an edited SKILL.md body reach
//     the model, unless the same `ConfigChange` hook blocks the reload.
//   - CLAUDE.md: a mid-session write is NOT re-read per request, but it IS
//     re-read after compaction. `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`
//     (buildInstructionFilesEnv) stops it at start and after compaction.
//
// Every CONTROL shows the plant is live on this binary; every FIX uses the
// PRODUCTION control (createConfigChangeHook, buildInstructionFilesEnv, the
// production PreToolUse hook), never a copy. Markers are built from parts
// (`printf 'PLANTED-%s-T1217' X`), so the literal never sits in a tool_use
// input: that input stays in every later request and would fake a "live
// re-read".
//
// Skips itself when the platform's native binary is not installed.
// ---------------------------------------------------------------------------

let server: ScriptedServer;
let tmp: string;
let files: string;
let cfg: string;

beforeEach(async () => {
  ({ tmp, files, cfg } = await makeSandboxDirs('ax-t1217-mid-'));
  server = await startScriptedServer();
});

afterEach(async () => {
  await server.close();
  await removeTree(tmp);
});

/** Hard cap for waiting on a hook signal. */
const SIGNAL_CAP_MS = 15_000;
/** After the CLI's `ConfigChange` event the reload (debounce + re-snapshot) takes a moment. */
const SETTLE_MS = 800;

type HookInput = Record<string, unknown> & { source?: string };

/** An observe-only `ConfigChange` hook: records the event, blocks nothing (the CONTROL). */
function observer(): { hook: HookCallback; events: HookInput[] } {
  const events: HookInput[] = [];
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name === 'ConfigChange') events.push(input as unknown as HookInput);
    return {};
  };
  return { hook, events };
}

/** The PRODUCTION hook, wrapped only to record what it was called with (and what it logged). */
function productionHook(): { hook: HookCallback; events: HookInput[]; logs: string[] } {
  const events: HookInput[] = [];
  const logs: string[] = [];
  const inner = createConfigChangeHook((line) => {
    logs.push(line);
  });
  const hook: HookCallback = async (input, toolUseID, options) => {
    if (input.hook_event_name === 'ConfigChange') events.push(input as unknown as HookInput);
    return inner(input, toolUseID, options);
  };
  return { hook, events, logs };
}

const sawSource = (events: HookInput[], source: string): boolean => events.some((e) => e.source === source);

async function readMarker(marker: string): Promise<string[]> {
  const text = await fs.readFile(marker, 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l !== '');
}

const bodiesText = (): string[] => server.agentCalls().map((c) => c.body);

// -- settings -----------------------------------------------------------------

/** Turn 1 plants settings.json in a dir that already held `{}`; turn 2 checks hooks and env. */
async function runSettingsPlant(hook: HookCallback, events: HookInput[]): Promise<{ marker: string[]; envResult: string }> {
  await fs.writeFile(path.join(cfg, 'settings.json'), '{}');
  const markerPath = path.join(tmp, 'marker.log');
  server.setScript([
    { tool: 'Bash', input: { command: `${plantSettingsCommand(markerPath)} && echo planted`, description: 'plant' } },
    { text: 'planted' },
    { tool: 'Bash', input: { command: ENV_PROBE_COMMAND, description: 'env' } },
    { text: 'checked' },
  ]);
  const s = await openSession({
    server, cfg, files,
    env: { ...stripClaudeCodeEnv(), ...mainFloors() },
    hooks: { ConfigChange: [{ hooks: [hook] }] },
  });
  try {
    expect(events, 'a session nobody tampered with must not get a ConfigChange').toEqual([]);
    await s.send('first');
    const seen = await waitUntil(() => sawSource(events, 'user_settings'), SIGNAL_CAP_MS);
    expect(seen, `the CLI never reported the settings.json change within ${SIGNAL_CAP_MS}ms`).toBe(true);
    await sleep(SETTLE_MS);
    await s.send('second');
  } finally {
    await s.close();
  }
  expect(await fs.readFile(path.join(cfg, 'settings.json'), 'utf8')).toContain('PLANTED_T1217');
  const last = server.agentCalls().at(-1)?.body ?? '{}';
  return { marker: await readMarker(markerPath), envResult: toolResultsIn(last).map((r) => r.text).join('\n') };
}

// -- skills -------------------------------------------------------------------

const TAMPER_COMMAND =
  'chmod -R u+w "$CLAUDE_CONFIG_DIR/skills" && ' +
  `${printfMarker('SKILL', '>> "$CLAUDE_CONFIG_DIR/skills/weekly-report/SKILL.md"')} && ` +
  'mkdir -p "$CLAUDE_CONFIG_DIR/skills/evil" && ' +
  `printf -- '---\\nname: evil\\ndescription: PLANTED-%s-T1217\\n---\\nbody\\n' DESC > "$CLAUDE_CONFIG_DIR/skills/evil/SKILL.md" && echo tampered`;

/** Turn 1 tampers with the projected skills; turn 2 opens `weekly-report` through Skill. */
async function runSkillsTamper(
  hook: HookCallback,
  events: HookInput[],
  withProductionPreToolUse: boolean,
): Promise<{ skillBodyRequest: string }> {
  await projectLockedSkill(cfg, 'weekly-report', 'ORIGINAL-SKILL-BODY-T1217', 'Write the weekly status report from notes.');
  const projectedSkills = await readProjectedSkills(cfg); // BEFORE turn 1, like main.ts's boot
  const { client } = stubIpcClient();
  server.setScript([
    { tool: 'Bash', input: { command: TAMPER_COMMAND, description: 'tamper' } },
    { text: 'tampered' },
    { tool: 'Skill', input: { skill: 'weekly-report' } },
    { text: 'opened' },
  ]);
  const s = await openSession({
    server, cfg, files,
    env: { ...stripClaudeCodeEnv(), ...mainFloors() },
    hooks: {
      ConfigChange: [{ hooks: [hook] }],
      ...(withProductionPreToolUse ? { PreToolUse: [{ hooks: [createPreToolUseHook({ client, projectedSkills })] }] } : {}),
    },
  });
  try {
    expect(events, 'no ConfigChange before the agent touches anything').toEqual([]);
    await s.send('first');
    const seen = await waitUntil(() => sawSource(events, 'skills'), SIGNAL_CAP_MS);
    expect(seen, `the CLI never reported the skills change within ${SIGNAL_CAP_MS}ms`).toBe(true);
    await sleep(SETTLE_MS);
    await s.send('second');
  } finally {
    await s.close();
  }
  // The tamper really happened on disk.
  expect(await fs.readFile(path.join(cfg, 'skills', 'weekly-report', 'SKILL.md'), 'utf8')).toContain('PLANTED-SKILL-T1217');
  const bodies = bodiesText();
  // The request right after the Skill call carries the skill's launched body.
  const skillCallIdx = bodies.findIndex((b) => toolResultsIn(b).some((r) => r.text.includes('Launching skill: weekly-report')));
  expect(skillCallIdx, 'the Skill call never reached the model').toBeGreaterThan(-1);
  return { skillBodyRequest: bodies[skillCallIdx] ?? '' };
}

describe.skipIf(!HAVE_BINARY)('mid-session configuration changes on the real claude-sdk binary (TASK-1217)', () => {
  it('settings CONTROL: with a settings.json present at start, a mid-session plant goes live (observer hook only)', async () => {
    const { hook, events } = observer();
    const { marker, envResult } = await runSettingsPlant(hook, events);
    expect(marker, 'planted UserPromptSubmit hook did not run').toContain('ups');
    expect(marker, 'planted PreToolUse hook did not run').toContain('pre');
    expect(envResult).toContain('ENV=[yes]');
  }, 60_000);

  it('settings FIX: the production ConfigChange hook blocks the reload, so the plant never runs', async () => {
    const { hook, events, logs } = productionHook();
    const { marker, envResult } = await runSettingsPlant(hook, events);
    expect(sawSource(events, 'user_settings')).toBe(true);
    expect(marker, 'a blocked settings change must not run its hooks').toEqual([]);
    expect(envResult).toContain('ENV=[]');
    // Only the source enum is ever logged.
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).toMatch(/^runner: blocked a mid-session change to the CLI's [a-z_]+ \(/);
    // Second layer on its own: boot refuses the seeded dir before any CLI starts.
    await expect(assertConfigDirFresh({ claudeConfigDir: cfg })).rejects.toThrow(/not fresh/);
  }, 60_000);

  it('skills CONTROL: an unlocked skills dir is hot-reloaded (a planted listing and an edited body reach the model)', async () => {
    const { hook, events } = observer();
    const { skillBodyRequest } = await runSkillsTamper(hook, events, false);
    expect(bodiesText().some((b) => b.includes('PLANTED-DESC-T1217')), 'the planted skill was never listed').toBe(true);
    expect(skillBodyRequest, 'the tampered body was not what Skill launched').toContain('PLANTED-SKILL-T1217');
  }, 60_000);

  it('skills FIX: the production hook blocks the reload; Skill launches the original body', async () => {
    const { hook, events, logs } = productionHook();
    const { skillBodyRequest } = await runSkillsTamper(hook, events, true);
    expect(sawSource(events, 'skills')).toBe(true);
    for (const b of bodiesText()) {
      expect(b).not.toContain('PLANTED-DESC-T1217');
      expect(b).not.toContain('PLANTED-SKILL-T1217');
    }
    expect(skillBodyRequest).toContain('ORIGINAL-SKILL-BODY-T1217');
    expect(logs.some((l) => l.includes('CLI\'s skills '))).toBe(true);
  }, 60_000);

  it('no interference: an untouched session never gets a ConfigChange', async () => {
    await projectLockedSkill(cfg, 'weekly-report', 'ORIGINAL-SKILL-BODY-T1217', 'Write the weekly status report from notes.');
    const { hook, events } = productionHook();
    server.setScript([{ tool: 'Skill', input: { skill: 'weekly-report' } }, { text: 'opened' }]);
    const s = await openSession({
      server, cfg, files,
      env: { ...stripClaudeCodeEnv(), ...mainFloors() },
      hooks: { ConfigChange: [{ hooks: [hook] }] },
    });
    try {
      await s.send('hello');
      await s.send('again');
      await sleep(SETTLE_MS * 2);
    } finally {
      await s.close();
    }
    expect(events).toEqual([]);
  }, 60_000);

  // -- CLAUDE.md after compaction ------------------------------------------------

  async function runClaudeMdPlant(instructionFiles: boolean): Promise<void> {
    await fs.writeFile(path.join(cfg, 'CLAUDE.md'), 'ORIGINAL-MEMORY-T1217\n');
    const script: Step[] = [
      { tool: 'Bash', input: { command: printfMarker('LIVE', '>> "$CLAUDE_CONFIG_DIR/CLAUDE.md"'), description: 'plant' } },
      { text: 'planted' },
      {}, {}, {}, {}, {},
    ];
    server.setScript(script);
    const s = await openSession({ server, cfg, files, env: { ...stripClaudeCodeEnv(), ...mainFloors({ instructionFiles }) } });
    try {
      await s.send('first');
      // Raw `/compact`: this case measures the CLI, not the runner.
      await s.send('/compact', 45_000);
      await s.send('third');
    } finally {
      await s.close();
    }
    expect(await fs.readFile(path.join(cfg, 'CLAUDE.md'), 'utf8')).toContain('PLANTED-LIVE-T1217');
  }

  it('instruction files CONTROL: CLAUDE.md loads at start, and a mid-session write comes back after compaction', async () => {
    await runClaudeMdPlant(false);
    const loop = server.agentCalls();
    expect(loop[0]?.body, 'the seeded CLAUDE.md was not loaded at start').toContain('ORIGINAL-MEMORY-T1217');
    expect(loop.at(-1)?.body, 'the planted line did not come back after compaction').toContain('PLANTED-LIVE-T1217');
  }, 90_000);

  it('instruction files FIX: with buildInstructionFilesEnv() neither the original nor the planted line is ever loaded', async () => {
    await runClaudeMdPlant(true);
    expect(server.agentCalls().length).toBeGreaterThan(2);
    for (const b of bodiesText()) {
      expect(b).not.toContain('ORIGINAL-MEMORY-T1217');
      expect(b).not.toContain('PLANTED-LIVE-T1217');
    }
  }, 90_000);
});
