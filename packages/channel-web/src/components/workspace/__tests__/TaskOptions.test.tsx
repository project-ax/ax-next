import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskOptions } from '../TaskOptions';
import { routineApi, RoutineApiError } from '@/lib/routines';
import { routineFixture } from '@/components/routines/__tests__/routine-fixture';
vi.mock('@/lib/routines', async original => ({...(await original<typeof import('@/lib/routines')>()), routineApi:{get:vi.fn(),remove:vi.fn()}}));
vi.mock('@/components/routines/RoutineConsentSection',()=>({RoutineConsentSection:()=> <p>Agent task permission</p>}));
vi.mock('@/components/credentials/CredentialSlotRow',()=>({CredentialSlotRow:({destination}:{destination:unknown})=> <p>{JSON.stringify(destination)}</p>}));
beforeEach(()=>{vi.resetAllMocks();vi.mocked(routineApi.get).mockResolvedValue(routineFixture);vi.mocked(routineApi.remove).mockResolvedValue({deleted:true,cleanupPending:false});});
async function show() {
 const onWriteSucceeded=vi.fn(),onDeleted=vi.fn();const view=render(<TaskOptions agentId="a" routineId="opaque-r1" agentName="Agent" onWriteSucceeded={onWriteSucceeded} onDeleted={onDeleted}/>);
 expect(routineApi.get).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Task options'}));
 fireEvent.click(await screen.findByRole('button',{name:'Delete task'}));
 return {...view,onWriteSucceeded,onDeleted};
}
describe('owned task options',()=>{
 it('retries an uncertain deletion with the same request and announces the landed write',async()=>{
  const h=await show(); vi.mocked(routineApi.remove).mockRejectedValueOnce(new RoutineApiError(500));
  fireEvent.click(screen.getByRole('button',{name:'Delete task'}));
  fireEvent.click(await screen.findByRole('button',{name:'Retry deletion'}));
  await waitFor(()=>expect(h.onDeleted).toHaveBeenCalledOnce());
  expect(vi.mocked(routineApi.remove).mock.calls[0]![0]).toEqual(vi.mocked(routineApi.remove).mock.calls[1]![0]);
  expect(h.onWriteSucceeded).toHaveBeenCalledOnce();
 });
 it('allows Cancel after a confirmed refusal and never announces a deletion',async()=>{
  const h=await show();vi.mocked(routineApi.remove).mockRejectedValueOnce(new RoutineApiError(403));
  fireEvent.click(screen.getByRole('button',{name:'Delete task'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be deleted');
  expect(screen.getByRole('button',{name:'Cancel'})).toBeEnabled();
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(h.onDeleted).not.toHaveBeenCalled();expect(h.onWriteSucceeded).not.toHaveBeenCalled();
 });
 it('announces success after unmount without navigating the former page',async()=>{
  const h=await show();let resolve!:()=>void;vi.mocked(routineApi.remove).mockImplementationOnce(()=>new Promise(r=>{resolve=()=>r({deleted:true,cleanupPending:false});}));
  fireEvent.click(screen.getByRole('button',{name:'Delete task'}));h.unmount();
  await act(async()=>resolve());expect(h.onWriteSucceeded).toHaveBeenCalledOnce();expect(h.onDeleted).not.toHaveBeenCalled();
 });
});
