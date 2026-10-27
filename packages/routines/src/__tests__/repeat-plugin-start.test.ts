import { expect, it, vi } from 'vitest';
import { HookBus } from '@ax/core';
import { createRoutinesPlugin } from '../plugin.js';

vi.mock('../migrations.js',async original=>({...await original<typeof import('../migrations.js')>(),runRoutinesMigration:async()=>{}}));
vi.mock('../store.js',async original=>({...await original<typeof import('../store.js')>(),createRoutinesStore:()=>({interruptAbandonedDispatches:async()=>0,pendingCleanup:async()=>[]})}));

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
