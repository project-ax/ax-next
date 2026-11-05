import { expect, it, vi } from 'vitest';
import { HookBus, PluginError } from '@ax/core';
import { createRoutinesPlugin } from '../plugin.js';
import { REPEAT_DELIVERY_LIMITS } from '../repeat-limits.js';

const drain=vi.hoisted(()=>({pump:vi.fn(async()=>{}),renew:vi.fn(async()=>{})}));
vi.mock('../migrations.js',async original=>({...await original<typeof import('../migrations.js')>(),runRoutinesMigration:async()=>{}}));
vi.mock('../store.js',async original=>({...await original<typeof import('../store.js')>(),createRoutinesStore:()=>({interruptAbandonedDispatches:async()=>0,pendingCleanup:async()=>[]})}));
vi.mock('../repeat-runtime.js',async original=>({...await original<typeof import('../repeat-runtime.js')>(),createRepeatDeliveryPump:()=>drain.pump}));
vi.mock('../repeat-deliveries.js',async original=>({...await original<typeof import('../repeat-deliveries.js')>(),createRepeatDeliveryStore:()=>({renew:drain.renew,release:async()=>{}})}));
const loop=vi.hoisted(()=>({run:vi.fn(({signal}:{signal:AbortSignal})=>new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve())))}));
vi.mock('../tick.js',async original=>({...await original<typeof import('../tick.js')>(),runTickLoop:loop.run}));

it('starts no delivery timer when route registration prevents initialization',async()=>{
  const bus=new HookBus();
  bus.registerService('database:get-instance','test',async()=>({db:{}}));
  bus.registerService('tool:register','test',async()=>({}));
  bus.registerService('http:register-route','test',async()=>{throw new Error('route unavailable');});
  const interval=vi.spyOn(globalThis,'setInterval');
  try {
    const plugin=createRoutinesPlugin();
    await expect(plugin.init({bus} as Parameters<typeof plugin.init>[0])).rejects.toThrow('route unavailable');
    expect(interval).not.toHaveBeenCalled();
  } finally {
    for(const result of interval.mock.results)if(result.type==='return')clearInterval(result.value);
    interval.mockRestore();
  }
});

// TASK-1033: the delivery timer's drain logs the failure's code, as the webhook's 503s do, never its message.
it('logs a failed timer drain with its code and without its message',async()=>{
  const bus=new HookBus();
  bus.registerService('database:get-instance','test',async()=>({db:{}}));
  bus.registerService('tool:register','test',async()=>({}));
  bus.registerService('http:register-route','test',async()=>({unregister:()=>{}}));
  drain.pump.mockRejectedValue(new PluginError({plugin:'@ax/routines',code:'timeout',message:'PRIVATE drain detail'}));
  const lines:string[]=[];
  const stdout=vi.spyOn(process.stdout,'write').mockImplementation((chunk:unknown)=>{lines.push(String(chunk));return true;});
  const interval=vi.spyOn(globalThis,'setInterval');
  const plugin=createRoutinesPlugin();
  try {
    await plugin.init({bus} as Parameters<typeof plugin.init>[0]);
    const delivery=interval.mock.calls.filter(call=>call[1]===REPEAT_DELIVERY_LIMITS.drainMs);
    expect(delivery).toHaveLength(1);
    const tick=delivery[0]![0] as ()=>void;
    tick();
    const drained=()=>lines.join('').split('\n').filter(l=>l.startsWith('{"')).map(l=>JSON.parse(l) as Record<string,unknown>)
      .filter(entry=>entry.msg==='repeat_queue_drain_failed').map(({ts:_ts,reqId:_reqId,...entry})=>entry);
    await vi.waitFor(()=>expect(drained()).toStrictEqual([{msg:'repeat_queue_drain_failed',level:'warn',code:'timeout',name:'PluginError',plugin:'@ax/routines'}]));
    expect(lines.join('')).not.toContain('PRIVATE');
  } finally {
    await plugin.shutdown?.();
    for(const result of interval.mock.results)if(result.type==='return')clearInterval(result.value);
    interval.mockRestore();
    stdout.mockRestore();
  }
});

// TASK-1035: the delivery timer's heartbeat logs its failure's codes too, never its message.
it('logs a failed heartbeat with its codes and without its message',async()=>{
  const bus=new HookBus();
  bus.registerService('database:get-instance','test',async()=>({db:{}}));
  bus.registerService('tool:register','test',async()=>({}));
  bus.registerService('http:register-route','test',async()=>({unregister:()=>{}}));
  drain.renew.mockRejectedValueOnce(Object.assign(new Error('PRIVATE renew detail at 10.0.0.7'),{code:'57P01'}));
  const lines:string[]=[];
  const stdout=vi.spyOn(process.stdout,'write').mockImplementation((chunk:unknown)=>{lines.push(String(chunk));return true;});
  const interval=vi.spyOn(globalThis,'setInterval');
  const plugin=createRoutinesPlugin();
  try {
    await plugin.init({bus} as Parameters<typeof plugin.init>[0]);
    const delivery=interval.mock.calls.filter(call=>call[1]===REPEAT_DELIVERY_LIMITS.drainMs);
    expect(delivery).toHaveLength(1);
    const tick=delivery[0]![0] as ()=>void;
    tick();
    const beats=()=>lines.join('').split('\n').filter(l=>l.startsWith('{"')).map(l=>JSON.parse(l) as Record<string,unknown>)
      .filter(entry=>entry.msg==='repeat_heartbeat_failed').map(({ts:_ts,reqId:_reqId,...entry})=>entry);
    await vi.waitFor(()=>expect(beats()).toStrictEqual([{msg:'repeat_heartbeat_failed',level:'warn',code:'57P01',name:'Error'}]));
    expect(lines.join('')).not.toContain('PRIVATE');
  } finally {
    await plugin.shutdown?.();
    for(const result of interval.mock.results)if(result.type==='return')clearInterval(result.value);
    interval.mockRestore();
    stdout.mockRestore();
  }
});

// TASK-1041: runTickLoop rides out its own failures; if it ever ends on one, the line says so with codes, never its message.
it('logs a scheduler loop that ends with its codes and without its message',async()=>{
  const bus=new HookBus();
  bus.registerService('database:get-instance','test',async()=>({db:{}}));
  bus.registerService('tool:register','test',async()=>({}));
  bus.registerService('http:register-route','test',async()=>({unregister:()=>{}}));
  loop.run.mockImplementationOnce(async()=>{throw Object.assign(new Error('PRIVATE loop detail at 10.0.0.7'),{code:'57P01'});});
  const lines:string[]=[];
  const capture=(chunk:unknown)=>{lines.push(String(chunk));return true;};
  const stdout=vi.spyOn(process.stdout,'write').mockImplementation(capture);
  const stderr=vi.spyOn(process.stderr,'write').mockImplementation(capture);
  const interval=vi.spyOn(globalThis,'setInterval');
  const plugin=createRoutinesPlugin();
  try {
    await plugin.init({bus} as Parameters<typeof plugin.init>[0]);
    const died=()=>lines.join('').split('\n').filter(l=>l.startsWith('{"')).map(l=>JSON.parse(l) as Record<string,unknown>)
      .filter(entry=>entry.msg==='routines_tick_loop_died').map(({ts:_ts,reqId:_reqId,...entry})=>entry);
    await vi.waitFor(()=>expect(died()).toStrictEqual([{msg:'routines_tick_loop_died',level:'error',code:'57P01',name:'Error'}]));
    expect(lines.join('')).not.toContain('PRIVATE');
  } finally {
    await plugin.shutdown?.();
    for(const result of interval.mock.results)if(result.type==='return')clearInterval(result.value);
    interval.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
