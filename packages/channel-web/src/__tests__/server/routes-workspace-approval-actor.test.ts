// @vitest-environment node
import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { makeAgentContext, type ToolCall } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  createDecisionsPlugin,
  type Decision,
  type DecisionsApproveOutput,
} from '@ax/decisions';
import {
  createTestHarness,
  startTestContainer,
  stopPostgresContainer,
  type TestHarness,
} from '@ax/test-harness';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { makeWorkspaceHandlers } from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

let container: StartedPostgreSqlContainer;
const harnesses: TestHarness[] = [];
const initCtx = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});
const actor = makeAgentContext({
  sessionId: 'turn',
  agentId: 'a1',
  userId: 'u1',
});
beforeAll(async () => {
  container = await startTestContainer(
    new PostgreSqlContainer('postgres:16-alpine'),
  );
}, 120_000);
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

// Real decisions service and Postgres; only auth/directory and tool effect are inert fixtures.
describe('workspace approve adapter with the actual decisions service', () => {
  it.each([
    ['gmail_send', 'once'],
    ['routine_update', 'once'],
    ['routine_update', 'agent-routines'],
  ] as const)(
    'passes the authenticated actor for %s with %s approval',
    async (name, scope) => {
      let grants = 0;
      const h = await createTestHarness({
        plugins: [
          createDatabasePostgresPlugin({
            connectionString: container.getConnectionUri(),
          }),
          createDecisionsPlugin({
            sweepIntervalMs: 0,
            attendanceFor: () => 'unattended',
          }),
        ],
        services: {
          'auth:require-user': async () => ({
            user: { id: 'u1', isAdmin: false },
          }),
          'agents:resolve': async (_ctx, input) => {
            expect(input).toMatchObject({ agentId: 'a1', userId: 'u1' });
            return { agent: { id: 'a1', displayName: 'Agent' } };
          },
          'agents:can-manage-routines': async (ctx) => ({
            allowed: ctx.userId === 'u1' && ctx.agentId === 'a1',
          }),
          'tool-policy:get-routine-consent': async (ctx) => {
            expect(ctx.userId).toBe('u1');
            return { enabled: grants > 0, revision: grants > 0 ? 'v2' : 'v1' };
          },
          'tool-policy:grant-routine-consent': async (ctx, input) => {
            expect(ctx.agentId).toBe('a1');
            expect(ctx.userId).toBe('u1');
            expect(
              ctx.state.get('decisions:routine-consent-grant'),
            ).toMatchObject({
              agentId: 'a1',
              userId: 'u1',
              expectedRevision: 'v1',
            });
            expect(input).toMatchObject({ expectedRevision: 'v1' });
            grants++;
            return { enabled: true, revision: 'v2', delivered: true };
          },
          'tool-policy:evaluate': async () => ({
            verdict: 'hold',
            ruleId: null,
            capability: null,
          }),
        },
      });
      harnesses.push(h);
      let executions = 0;
      h.bus.registerService(
        `tool:execute:${name}`,
        '@ax/test-effect',
        async (ctx) => {
          expect(ctx.userId).toBe('u1');
          expect(ctx.agentId).toBe('a1');
          executions++;
          return { ok: true };
        },
      );
      const call: ToolCall = {
        id: `call-${name}`,
        name,
        input:
          name === 'routine_update'
            ? {
                requestId: `edit-${scope}`,
                routineId: 'r1',
                expectedRevision: 'v1',
                patch: { name: 'New' },
              }
            : { body: 'A reviewed message' },
      };
      await h.bus.fire('tool:pre-call', actor, call);
      const { decisions } = await h.bus.call<
        unknown,
        { decisions: Decision[] }
      >('decisions:list', actor, { userId: 'u1' });
      const held = decisions.find((d) => d.call.name === name)!;
      const req: RouteRequest = {
        headers: {},
        body:
          scope === 'agent-routines'
            ? Buffer.from(JSON.stringify({ approvalScope: scope }))
            : Buffer.alloc(0),
        cookies: {},
        query: {},
        params: { decisionId: held.id },
        signedCookie: () => null,
      };
      let status = 0;
      let body: unknown;
      const res: RouteResponse = {
        status(code) {
          status = code;
          return res;
        },
        json(value) {
          body = value;
        },
        text() {},
        end() {},
      };
      await makeWorkspaceHandlers({ bus: h.bus, initCtx }).approveDecision(
        req,
        res,
      );
      expect(status).toBe(200);
      expect((body as DecisionsApproveOutput).executed).toBe(true);
      expect(executions).toBe(1);
      const reread = await h.bus.call<unknown, { decision: Decision }>(
        'decisions:get',
        actor,
        {
          decisionId: held.id,
          userId: 'u1',
        },
      );
      expect(reread.decision.status).toBe('executed');
      if (name === 'routine_update')
        expect(reread.decision.routineOutcome).toBe('succeeded');
      if (scope === 'agent-routines') {
        expect(reread.decision).toMatchObject({
          approvalScope: scope,
          consentDeliveryState: 'delivered',
          routineOutcome: 'succeeded',
        });
        // Simulate losing the first response: resend the exact POST to the real service.
        await makeWorkspaceHandlers({ bus: h.bus, initCtx }).approveDecision(
          req,
          res,
        );
        expect(status).toBe(200);
        expect(executions).toBe(1);
        expect(grants).toBe(1);
        expect((body as DecisionsApproveOutput).decision).toMatchObject({
          approvalScope: scope,
          consentDeliveryState: 'delivered',
          routineOutcome: 'succeeded',
        });
      }
      expect(initCtx.userId).toBe('system');
      expect(initCtx.agentId).toBe('@ax/channel-web');
    },
  );
});


describe('durable late failure with real decisions and PostgreSQL', () => {
  it.each(['gmail_send','routine_update'])('retains %s failure after grace for a fresh conversation read', async name => {
    let clock=new Date('2026-10-26T12:00:00Z');
    const ctx=makeAgentContext({sessionId:'history-turn',agentId:'a1',userId:'u1',conversationId:'c1'});
    const h=await createTestHarness({plugins:[createDatabasePostgresPlugin({connectionString:container.getConnectionUri()}),createDecisionsPlugin({now:()=>clock,sweepIntervalMs:0,attendanceFor:()=> 'unattended'})],services:{
      'auth:require-user':async()=>({user:{id:'u1',isAdmin:false}}),
      'agents:resolve':async()=>({agent:{id:'a1',displayName:'Agent'}}),
      'agents:can-manage-routines':async()=>({allowed:true}),
      'tool-policy:get-routine-consent':async()=>({enabled:false,revision:'v1'}),
      'tool-policy:evaluate':async()=>({verdict:'hold',ruleId:null,capability:null,irreversible:true}),
      'conversations:get':async()=>({conversation:{agentId:'a1',userId:'u1',conversationId:'c1'}}),
    }}); harnesses.push(h);
    let executions=0;
    h.bus.registerService(`tool:execute:${name}`,'@ax/test-effect',async()=>{executions++;throw new Error('provider refused the operation');});
    await h.bus.fire('tool:pre-call',ctx,{id:`history-${name}`,name,input:name==='routine_update'?{requestId:'history-edit',routineId:'r1',expectedRevision:'v1',patch:{name:'Updated'}}:{body:'A reviewed message'}});
    const listed=await h.bus.call<unknown,{decisions:Decision[]}>('decisions:list',ctx,{userId:'u1',agentId:'a1'});
    const held=listed.decisions.find(d=>d.call.id===`history-${name}`)!; expect(held).toBeTruthy();
    const approved=await h.bus.call<unknown,DecisionsApproveOutput>('decisions:approve',ctx,{decisionId:held.id,userId:'u1'});
    expect(approved.decision?.status).toBe('executed'); expect(executions).toBe(0);
    clock=new Date(clock.getTime()+61000);
    await h.bus.call('decisions:sweep',ctx,{}); expect(executions).toBe(1);
    const request:RouteRequest={headers:{},body:Buffer.alloc(0),cookies:{},query:{},params:{agentId:'a1',conversationId:'c1'},signedCookie:()=>null};
    for(let visit=0;visit<2;visit++) {
      let status=0,body:unknown;
      const response:RouteResponse={status(n){status=n;return response;},json(value){body=value;},text(){},end(){}};
      await makeWorkspaceHandlers({bus:h.bus,initCtx}).conversationDecisions(request,response);
      expect(status).toBe(200);
      const row=(body as {decisions:Array<{id:string;status:string;routineOutcome?:string;undoable:boolean}>}).decisions.find(d=>d.id===held.id)!;
      expect(row).toBeTruthy(); expect(row.undoable).toBe(false);
      if(name==='routine_update') expect(row.routineOutcome).toBe('failed'); else expect(row.status).toBe('failed');
      const bytes=JSON.stringify(body); expect(bytes).not.toContain('A reviewed message'); expect(bytes).not.toContain('callFingerprint');
    }
    await expect(h.bus.call('decisions:recent-for-conversation',makeAgentContext({sessionId:'peer',agentId:'a1',userId:'peer'}),{userId:'u1',agentId:'a1',conversationId:'c1'})).rejects.toThrow(/scope/);
  });
});
