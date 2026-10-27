import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createRoutinesStore } from '../store.js';
import { request as httpRequest } from 'node:http';
import { createTestHarness } from '@ax/test-harness';
import { createHttpServerPlugin } from '@ax/http-server';
import { createHmac } from 'node:crypto';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import type { HttpRequest, HttpResponse } from '@ax/http-server';
import { captureExpectedStderr } from './support/expected-diagnostics.js';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { runTickOnce } from '../tick.js';
import { systemClock } from '../clock.js';
let h: RoutineHarness;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); });
const definition = (hmac?: {
  header: string;
  algorithm: 'sha256' | 'sha1';
  prefix?: string;
}) => RoutineDefinitionSchema.parse({ name: 'Hook', promptBody: 'Review {{payload.title}}', trigger: { kind: 'webhook', path: '/hook', events: ['push'], ...(hmac ? { hmac } : {}) } });
async function setup(hmac?: Parameters<typeof definition>[0]) {
  h = await createRoutineHarness({ invoke: async (ctx, bus) => { await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] }); return { kind: 'complete' }; } });
  const row = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, { agentId: h.agentId, requestId: 'create', definition: definition(hmac) });
  const { token } = await h.bus.call<unknown, {
    token: string;
  }>('agents:ensure-webhook-token', h.owner, { agentId: h.agentId, actor: { userId: h.owner.userId, isAdmin: false } });
  return { row, token };
}
async function request(token: string, options: {
  rawPath?: string;
  splat?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
} = {}) {
  const route = h.routes.find(r => r.path === '/webhooks/:token/*')!;
  expect(route).toBeDefined();
  expect(route.bypassCsrf).toBe(true);
  let code = 200;
  const splat = options.splat ?? 'hook';
  await route.handler({ path: `/webhooks/${token}/${splat}`, rawPath: options.rawPath ?? `/webhooks/${token}/${splat}`, params: { token, '*': splat }, headers: { 'content-type': 'application/json', ...options.headers }, body: Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body ?? '{"title":"test"}') } as HttpRequest, { status(value: number) { code = value; return this; }, end() { }, json() { } } as HttpResponse);
  return code;
}
describe('single registered request-time DB webhook route', () => {
  it('keeps the original signed URL after adding a schedule, restart and work-hour deferral', async () => {
    const time = new Date('2031-01-01T12:00:00Z');
    h = await createRoutineHarness({ clock: { now: () => time, sleep: systemClock.sleep }, invoke: async (ctx, bus) => {
      await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] });
      return { kind: 'complete' };
    } });
    let row = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, {
      agentId: h.agentId, requestId: 'create-hook', definition: definition({ header: 'X-Signature', algorithm: 'sha256' }),
    });
    const { token } = await h.bus.call<unknown, { token: string }>('agents:ensure-webhook-token', h.owner, { agentId: h.agentId, actor: { userId: h.owner.userId, isAdmin: false } });
    row = await h.bus.call<unknown, RoutineView>('routines:update', h.owner, {
      agentId: h.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: 'add-schedule',
      patch: { schedule: { kind: 'interval', every: '60s' }, activeHours: { start: '09:00', end: '10:00', tz: 'UTC' } },
    });
    const scheduledFire = vi.fn(async () => ({ status: 'ok' as const, error: null, renderedPrompt: 'done' }));
    await runTickOnce({ store: createRoutinesStore(h.db), fire: scheduledFire, now: new Date(time.getTime() + 60_000), claimBatchSize: 50, claimWindowMinutes: 5 });
    expect(scheduledFire).not.toHaveBeenCalled();
    expect((await createRoutinesStore(h.db).findOne(row))?.nextRunAt).toEqual(new Date('2031-01-02T09:00:00Z'));
    h = await h.restart();
    const body = '{"title":"arrival outside work hours"}';
    const signature = createHmac('sha256', 'test-secret').update(body).digest('hex');
    expect(await request(token, { body, headers: { 'x-signature': signature, 'x-github-event': 'push' } })).toBe(202);
    expect(h.invokeCalls).toHaveLength(1);
    expect((await createRoutinesStore(h.db).findOne(row))?.nextRunAt).toEqual(new Date('2031-01-02T09:00:00Z'));
  });
  it('registers once and dispatches JSON and forms through the current DB definition', async () => {
    const { row, token } = await setup();
    expect(await request(token)).toBe(202);
    expect(await request(token, { body: 'title=form', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).toBe(202);
    await expect.poll(async () => (await h.bus.call<unknown, {
      fires: unknown[];
    }>('routines:recent-fires', h.owner, { agentId: row.agentId, routineId: row.routineId })).fires.length).toBe(2);
    expect(h.invokeCalls).toHaveLength(2);
    expect(h.routes.filter(r => r.path.startsWith('/webhooks/'))).toHaveLength(1);
  });
  it.each([{ algorithm: 'sha256', prefix: 'sha256=' }, { algorithm: 'sha1', prefix: 'sha1=' }, { algorithm: 'sha256', prefix: undefined }] as const)('checks raw $algorithm HMAC with prefix $prefix before accepting', async ({ algorithm, prefix }) => {
    const { token } = await setup({ header: 'X-Signature', algorithm, ...(prefix === undefined ? {} : { prefix }) });
    const body = '{"title": "signed"}';
    const signature = createHmac(algorithm, 'test-secret').update(body).digest('hex');
    expect(await request(token, { body, headers: { 'x-signature': `${prefix ?? ''}${signature}` } })).toBe(202);
    expect(await request(token, { body: body + ' ', headers: { 'x-signature': signature } })).toBe(401);
    expect(await request(token)).toBe(401);
    expect(h.invokeCalls).toHaveLength(1);
  });
  it('rejects invalid tokens, raw splat paths, bodies and filtered events', async () => {
    const { token } = await setup();
    expect(await request('wrong')).toBe(404);
    for (const splat of ['../hook', '%68ook', 'a//hook', 'hook/', 'hook?x', ''])
      expect(await request(token, { splat })).toBe(404);
    expect(await request(token, { body: 'broken' })).toBe(400);
    expect(await request(token, { body: Buffer.alloc(1024 * 1024 + 1) })).toBe(413);
    expect(await request(token, { headers: { 'content-type': 'text/plain' } })).toBe(415);
    expect(await request(token, { headers: { 'x-github-event': 'ping' } })).toBe(204);
    expect(h.invokeCalls).toHaveLength(0);
    expect(await request(token, { headers: { 'x-github-event': 'push' } })).toBe(202);
  });
  it('rechecks disable, path edits, deletion and token rotation without registering new routes', async () => {
    let { row, token } = await setup();
    const count = h.routes.length;
    const update = async (patch: object) => { row = await h.bus.call<unknown, RoutineView>('routines:update', h.owner, { agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: crypto.randomUUID(), patch }); };
    await update({ enabled: false });
    expect(await request(token)).toBe(404);
    await update({ enabled: true, trigger: { kind: 'webhook', path: '/renamed' } });
    expect(await request(token)).toBe(404);
    expect(await request(token, { splat: 'renamed' })).toBe(202);
    const rotated = await h.bus.call<unknown, {
      token: string;
    }>('agents:rotate-webhook-token', h.owner, { agentId: h.agentId, actor: { userId: h.owner.userId, isAdmin: false } });
    expect(await request(token, { splat: 'renamed' })).toBe(404);
    token = rotated.token;
    expect(await request(token, { splat: 'renamed' })).toBe(202);
    await h.bus.call('routines:delete', h.owner, { agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: 'delete' });
    expect(await request(token, { splat: 'renamed' })).toBe(404);
    expect(h.routes.length).toBe(count);
  });
  it('routes the persisted definition after handler restart', async () => {
    const { token } = await setup();
    h = await h.restart();
    expect(await request(token)).toBe(202);
    expect(h.invokeCalls).toHaveLength(1);
    expect(h.routes.filter(r => r.path === '/webhooks/:token/*')).toHaveLength(1);
  });
  it('fails closed on a missing configured HMAC secret and rejects encoded token spelling', async () => {
    const { token } = await setup({ header: 'sig', algorithm: 'sha256' });
    const call = h.bus.call.bind(h.bus);
    const warnings: string[] = [];
    vi.spyOn(h.bus, 'call').mockImplementation(async (name, ctx, input) => {
      if (name === 'credentials:get') {
        const warn = ctx.logger.warn.bind(ctx.logger);
        ctx.logger.warn = (message, fields) => {
          if (message === 'routines_webhook_secret_fetch_failed') warnings.push(message);
          else warn(message, fields);
        };
        throw new Error('missing');
      }
      return call(name, ctx, input);
    });
    expect(await request(token)).toBe(401);
    expect(warnings).toEqual(['routines_webhook_secret_fetch_failed']);
    expect(h.invokeCalls).toHaveLength(0);
    expect(await request(token, { rawPath: `/webhooks/%${token.charCodeAt(0).toString(16)}${token.slice(1)}/hook` })).toBe(404);
  });
  it('resolves execution as the stored owner and records forbidden without deleting the definition', async () => {
    const { row, token } = await setup();
    await sql `UPDATE agents_v1_agents SET owner_id='someone-else' WHERE agent_id=${h.agentId}`.execute(h.db);
    expect(await request(token)).toBe(202);
    expect(h.invokeCalls).toHaveLength(0);
    const store = createRoutinesStore(h.db);
    expect(await store.findOne(row)).not.toBeNull();
    expect((await store.recentFires(row))[0]?.status).toBe('error');
  });
  it('keeps a team routine but refuses execution after the creator loses membership', async () => {
    await setup();
    const row = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, { agentId: h.teamAgentId, requestId: 'team', definition: definition() });
    const { token } = await h.bus.call<unknown, {
      token: string;
    }>('agents:ensure-webhook-token', h.owner, { agentId: h.teamAgentId, actor: { userId: h.owner.userId, isAdmin: false } });
    const warnings: string[] = [];
    const call = h.bus.call.bind(h.bus);
    vi.spyOn(h.bus, 'call').mockImplementation(async (name, ctx, input) => {
      if (name === 'agents:resolve') {
        const warn = ctx.logger.warn.bind(ctx.logger);
        ctx.logger.warn = (message, fields) => {
          if (message === 'agents_acl_team_check_unavailable') warnings.push(message);
          else warn(message, fields);
        };
      }
      return call(name, ctx, input);
    });
    h.setTeamFailure('missing');
    expect(await request(token)).toBe(202);
    expect(warnings).toEqual(['agents_acl_team_check_unavailable']);
    expect(h.invokeCalls).toHaveLength(0);
    const store = createRoutinesStore(h.db);
    expect(await store.findOne(row)).not.toBeNull();
    expect((await store.recentFires(row))[0]?.status).toBe('error');
  });
  it('rejects literal and encoded dot aliases through the actual HTTP socket adapter',async()=>{
    const {token}=await setup({header:'sig',algorithm:'sha256'});
    const listening = captureExpectedStderr(message => message.startsWith('[ax/http-server] listening on http://127.0.0.1:'));
    const server=createHttpServerPlugin({host:'127.0.0.1',port:0,cookieKey:Buffer.alloc(32,1),allowedOrigins:['http://localhost']});
    const serverHarness=await createTestHarness({plugins:[server]});
    await serverHarness.bus.call('http:register-route',serverHarness.ctx(),h.routes.find(r=>r.path==='/webhooks/:token/*')!);
    const body='{"title":"signed"}';const sig=createHmac('sha256','test-secret').update(body).digest('hex');
    const post=(path:string)=>new Promise<number>((resolve,reject)=>{
      const req=httpRequest({hostname:'127.0.0.1',port:server.boundPort(),method:'POST',path,headers:{'content-type':'application/json',sig,'x-original-url':`/webhooks/${token}/hook`}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end(body);
    });
    try {
      for(const alias of ['a/../hook','./hook','%2e/hook','a/%2e%2e/hook']) expect(await post(`/webhooks/${token}/${alias}`)).toBe(404);
      expect(h.invokeCalls).toHaveLength(0);expect(await post(`/webhooks/${token}/hook`)).toBe(202);expect(h.invokeCalls).toHaveLength(1);
      expect(listening.messages).toHaveLength(1);
    } finally {await serverHarness.close(); listening.restore();}
  });

});

describe('durable signed repeat-delivery canary', () => {
  it('keeps queue counts private and refuses a removed creator when waiting work reaches runtime',async()=>{
    h=await createRoutineHarness();
    const row=await h.bus.call<unknown,RoutineView>('routines:create',h.teamMember,{agentId:h.teamAgentId,requestId:'member-queued',definition:definition()});
    const {token}=await h.bus.call<unknown,{token:string}>('agents:ensure-webhook-token',h.teamAdmin,{agentId:h.teamAgentId,actor:{userId:h.teamAdmin.userId,isAdmin:false}});
    const store=createRoutinesStore(h.db),active=[];
    for(let i=0;i<3;i++)active.push((await store.acceptDispatch({...row,actorUserId:'member',expectedRevision:row.revision,requestId:`hold-${i}`,source:'manual',now:new Date()}))!);
    expect(await request(token,{body:'{"title":"PRIVATE removed member"}',headers:{'x-github-event':'push','x-github-delivery':'member-private'}})).toBe(202);
    const key={agentId:row.agentId,routineId:row.routineId};
    expect((await h.bus.call<unknown,RoutineView>('routines:get',h.teamMember,key)).delivery).toEqual({active:3,waiting:1});
    expect((await h.bus.call<unknown,RoutineView>('routines:get',h.teamAdmin,key)).delivery).toBeNull();
    h.setTeamRole('member',null);
    for(const accepted of active)await store.finishDispatch({dispatchId:accepted.accepted.dispatchId,outcome:{status:'ok',error:null,conversationId:null,renderedPrompt:null,warning:null}});
    await expect.poll(async()=>(await sql<{n:number}>`SELECT count(*)::int AS n FROM routines_v1_deliveries WHERE routine_id=${row.routineId} AND completed_at IS NOT NULL AND blob_ref IS NULL`.execute(h.db)).rows[0]!.n).toBe(1);
    expect(h.invokeCalls).toHaveLength(0);
    const fire=(await sql`SELECT run_as_user_id,status,error,rendered_prompt FROM routines_v1_fires WHERE routine_id=${row.routineId} AND trigger_source='webhook'`.execute(h.db)).rows;
    expect(fire).toEqual([{run_as_user_id:'member',status:'error',error:'This app update could not run.',rendered_prompt:null}]);
  });
  it('deduplicates only authenticated accepted IDs, survives restart, and drains queued private payloads once', async () => {
    const messages: string[] = [], owners: string[] = [];
    h=await createRoutineHarness({strictCredentials:true,invoke:async(ctx,bus,input)=>{
      owners.push(ctx.userId);messages.push((input as {message:{content:string}}).message.content);
      await bus.fire('chat:turn-end',ctx,{reqId:ctx.reqId,contentBlocks:[{type:'text',text:'done'}]});return{kind:'complete'};
    }});
    const row=await h.bus.call<unknown,RoutineView>('routines:create',h.owner,{agentId:h.agentId,requestId:'bounded-hook',definition:definition({header:'sig',algorithm:'sha256'})});
    await h.bus.call('routines:set-webhook-secret',h.owner,{agentId:h.agentId,routineId:row.routineId,expectedRevision:row.revision,operation:'set',secret:new TextEncoder().encode('signed-fixture-key')});
    const {token}=await h.bus.call<unknown,{token:string}>('agents:ensure-webhook-token',h.owner,{agentId:h.agentId,actor:{userId:h.owner.userId,isAdmin:false}});
    const store=createRoutinesStore(h.db);
    for(let i=0;i<3;i++)await store.acceptDispatch({...row,actorUserId:h.owner.userId,expectedRevision:row.revision,requestId:`occupied-${i}`,source:'manual',now:new Date('2026-10-09T12:00:00Z')});
    const server=createHttpServerPlugin({host:'127.0.0.1',port:0,cookieKey:Buffer.alloc(32,1),allowedOrigins:['http://localhost']});
    const transport=await createTestHarness({plugins:[server]});
    const route=h.routes.find(r=>r.path==='/webhooks/:token/*')!;
    await transport.bus.call('http:register-route',h.owner,{...route,handler:(req:HttpRequest,res:HttpResponse)=>h.routes.find(r=>r.path==='/webhooks/:token/*')!.handler(req,res)});
    const send=(id:string,body:string,event='push',valid=true)=>new Promise<number>((resolve,reject)=>{
      const req=httpRequest({hostname:'127.0.0.1',port:server.boundPort(),method:'POST',path:`/webhooks/${token}/hook`,headers:{'content-type':'application/json','x-github-delivery':id,'x-github-event':event,sig:valid?createHmac('sha256','signed-fixture-key').update(body).digest('hex'):'invalid'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end(body);
    });
    try {
      const first=JSON.stringify({title:'PRIVATE first'}),second=JSON.stringify({title:'PRIVATE second'}),third=JSON.stringify({title:'PRIVATE third'});
      expect(await Promise.all([send('one',first),send('one',first)])).toEqual([202,202]);
      expect(await send('two',second)).toBe(202);
      expect(await send('three',third,'push',false)).toBe(401);
      expect(await send('three',third,'ignored')).toBe(204);
      expect(await send('three',third)).toBe(202);
      expect(messages).toHaveLength(0);
      expect((await h.bus.call<unknown,RoutineView>('routines:get',h.owner,{agentId:row.agentId,routineId:row.routineId})).delivery).toEqual({active:3,waiting:3});
      const refs=(await sql<{blob_ref:string}>`SELECT blob_ref FROM routines_v1_deliveries WHERE blob_ref IS NOT NULL`.execute(h.db)).rows.map(x=>x.blob_ref);
      const collected=await h.bus.fire<{candidates:string[];answers:Array<{holder:string;ok:boolean;refs:Array<{sha256:string;userIds:string[]}>}>}>('blob:collect-refs',h.owner,{candidates:refs,answers:[]});
      const held=collected.payload.answers.find(x=>x.holder==='@ax/routines');
      expect(held?.ok).toBe(true);expect(held?.refs).toHaveLength(3);expect(held?.refs.every(x=>x.userIds.includes('owner'))).toBe(true);
      h=await h.restart();
      await expect.poll(()=>messages.length).toBe(3);
      expect(messages[0]).toContain('PRIVATE first');expect(messages[1]).toContain('PRIVATE second');expect(messages[2]).toContain('PRIVATE third');expect(owners).toEqual(['owner','owner','owner']);
      expect(await send('one',first)).toBe(202);expect(messages).toHaveLength(3);
      const history=await createRoutinesStore(h.db).recentFires({...row,actorUserId:'owner'});
      expect(history.filter(x=>x.triggerSource==='webhook')).toHaveLength(3);
      expect(JSON.stringify(history)).not.toContain('PRIVATE');
      expect((await sql<{n:number}>`SELECT count(*)::int AS n FROM routines_v1_deliveries WHERE blob_ref IS NOT NULL`.execute(h.db)).rows[0]!.n).toBe(0);
    } finally {await transport.close();}
  });
});
