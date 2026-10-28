import { describe, expect, it } from 'vitest';
import { RoutineDefinitionSchema, RoutineReadUpdateInputSchema, RoutineReadUpdateToolInputSchema, RoutineReadUpdateOutputSchema, RoutineToolInputSchemas } from '../index.js';
const definition={name:'Support',promptBody:'Keep tickets answered.',goodWhen:'No ticket waits.',kind:'stay-on-top',schedule:{kind:'interval',every:'1h'},webhook:{kind:'webhook',path:'/support'}};
describe('task app-update authoring',()=>{
  it.each(['stay-on-top','get-done'])('accepts %s with app updates while keeping its required safety schedule',kind=>{
    const parsed=RoutineDefinitionSchema.parse({...definition,kind});expect(parsed.webhook).not.toHaveProperty('respondWithin');
    expect(RoutineDefinitionSchema.safeParse({...definition,kind,schedule:null}).success).toBe(false);
  });
  it.each(['60s','1m','5m','24h','1d'])('accepts response interval%s without changing its representation',respondWithin=>{
    expect(RoutineDefinitionSchema.parse({...definition,webhook:{...definition.webhook,respondWithin}}).webhook?.respondWithin).toBe(respondWithin);
  });
  it.each(['1s','59s','0m','25h','2d','5minutes','',60,null])('refuses invalid response interval%s',respondWithin=>{
    expect(RoutineDefinitionSchema.safeParse({...definition,webhook:{...definition.webhook,respondWithin}}).success).toBe(false);
  });
  it('keeps Repeat free of batched response controls',()=>{
    expect(RoutineDefinitionSchema.safeParse({...definition,kind:'repeat',goodWhen:null,webhook:{...definition.webhook,respondWithin:'5m'}}).success).toBe(false);
  });
  it('full-read arguments name only the update while service agent identity is separate',()=>{
    expect(RoutineToolInputSchemas.routine_read_update).toBe(RoutineReadUpdateToolInputSchema);
    expect(RoutineReadUpdateToolInputSchema.parse({eventId:'update_1'})).toEqual({eventId:'update_1'});
    for(const extra of [{conversationId:'other'},{routineId:'other'},{agentId:'other'},{actorUserId:'other'}]) expect(RoutineReadUpdateToolInputSchema.safeParse({eventId:'update_1',...extra}).success).toBe(false);
    expect(RoutineReadUpdateInputSchema.parse({agentId:'a',eventId:'update_1'})).toEqual({agentId:'a',eventId:'update_1'});
    expect(RoutineReadUpdateOutputSchema.parse({eventId:'update_1',receivedAt:'2031-01-01T00:00:00.000Z',payload:'outside content'})).not.toHaveProperty('blobRef');
  });
});
