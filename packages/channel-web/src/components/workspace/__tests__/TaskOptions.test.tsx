import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDeleteDialog } from '../TaskOptions';
import { routineApi, RoutineApiError } from '@/lib/routines';
vi.mock('@/lib/routines', async original => ({...(await original<typeof import('@/lib/routines')>()), routineApi:{remove:vi.fn()}}));
beforeEach(()=>{vi.resetAllMocks();vi.spyOn(console,'warn').mockImplementation(()=>{});vi.mocked(routineApi.remove).mockResolvedValue({deleted:true,cleanupPending:false});});
function show(over: { canPauseInstead?: boolean; repeat?: boolean; revision?: string } = {}) {
 const handlers={onWriteSucceeded:vi.fn(),onDeleted:vi.fn(),onRefresh:vi.fn(),onPauseInstead:vi.fn(),onOpenChange:vi.fn()};
 const tree=(revision:string)=> <TaskDeleteDialog open agentId="a" routineId="opaque-r1" name="Tidy <b>notes</b>" revision={revision}
  repeat={over.repeat ?? false} canPauseInstead={over.canPauseInstead ?? true} {...handlers} />;
 const view=render(tree(over.revision ?? 'rev-1'));
 return {...view,...handlers,rerenderRevision:(revision:string)=>view.rerender(tree(revision))};
}
const deleteButton=()=>screen.getByRole('button',{name:'Delete task'});
describe('the task delete confirm (⋯ › Delete task…)',()=>{
 it('asks once, by name, as text, and offers Pause instead',()=>{
  const h=show();
  expect(screen.getByRole('dialog',{name:'Delete “Tidy <b>notes</b>”?'})).toBeInTheDocument();
  expect(document.querySelector('[role="dialog"] b')).toBeNull();
  expect(screen.getByText('It leaves Tasks and no new check-ins will start. A check-in that’s already running may finish.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Pause instead'}));
  expect(h.onPauseInstead).toHaveBeenCalledOnce();
  expect(routineApi.remove).not.toHaveBeenCalled();
 });
 it('a task that isn’t running has no Pause instead; a Repeat job speaks of runs',()=>{
  show({canPauseInstead:false,repeat:true});
  expect(screen.queryByRole('button',{name:'Pause instead'})).toBeNull();
  expect(screen.getByText('It leaves Tasks and no new runs will start. A run that’s already going may finish.')).toBeInTheDocument();
 });
 it('retries an uncertain deletion with the same request and announces the landed write',async()=>{
  const h=show(); vi.mocked(routineApi.remove).mockRejectedValueOnce(new RoutineApiError(500));
  fireEvent.click(deleteButton());
  expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t confirm the task was deleted. Try again, and it won’t happen twice.');
  expect(h.onDeleted).not.toHaveBeenCalled();
  // A newer read doesn't change a request that may already have landed.
  h.rerenderRevision('rev-2');
  fireEvent.click(deleteButton());
  await waitFor(()=>expect(h.onDeleted).toHaveBeenCalledOnce());
  expect(vi.mocked(routineApi.remove).mock.calls[0]![0]).toEqual(vi.mocked(routineApi.remove).mock.calls[1]![0]);
  expect(vi.mocked(routineApi.remove).mock.calls[0]![0]).toMatchObject({agentId:'a',routineId:'opaque-r1',expectedRevision:'rev-1'});
  expect(h.onWriteSucceeded).toHaveBeenCalledOnce();
 });
 it('allows Cancel after a confirmed refusal and never announces a deletion',async()=>{
  const h=show();vi.mocked(routineApi.remove).mockRejectedValueOnce(new RoutineApiError(403));
  fireEvent.click(deleteButton());
  expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t delete this task.');
  expect(screen.getByRole('button',{name:'Cancel'})).toBeEnabled();
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(h.onOpenChange).toHaveBeenCalledWith(false);
  expect(h.onDeleted).not.toHaveBeenCalled();expect(h.onWriteSucceeded).not.toHaveBeenCalled();
 });
 it('a revision conflict asks for a re-read, and the next press is a new request against it',async()=>{
  const h=show();vi.mocked(routineApi.remove).mockRejectedValueOnce(new RoutineApiError(409,'revision-conflict'));
  fireEvent.click(deleteButton());
  expect(await screen.findByRole('alert')).toHaveTextContent('This task changed while you had it open.');
  expect(h.onRefresh).toHaveBeenCalledOnce();
  h.rerenderRevision('rev-2');
  fireEvent.click(deleteButton());
  await waitFor(()=>expect(h.onDeleted).toHaveBeenCalledOnce());
  const [first,second]=vi.mocked(routineApi.remove).mock.calls.map(call=>call[0]);
  expect(second!.expectedRevision).toBe('rev-2');
  expect(second!.requestId).not.toBe(first!.requestId);
 });
 it('can’t be dismissed while the delete is on its way',async()=>{
  let resolve!:()=>void;vi.mocked(routineApi.remove).mockImplementationOnce(()=>new Promise(r=>{resolve=()=>r({deleted:true,cleanupPending:false});}));
  const h=show();
  fireEvent.click(deleteButton());
  expect(deleteButton()).toBeDisabled();
  expect(screen.getByRole('button',{name:'Cancel'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Pause instead'})).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});
  expect(h.onOpenChange).not.toHaveBeenCalled();
  await act(async()=>resolve());
  expect(h.onDeleted).toHaveBeenCalledOnce();
 });
 it('announces success after unmount without navigating the former page',async()=>{
  const h=show();let resolve!:()=>void;vi.mocked(routineApi.remove).mockImplementationOnce(()=>new Promise(r=>{resolve=()=>r({deleted:true,cleanupPending:false});}));
  fireEvent.click(deleteButton());h.unmount();
  await act(async()=>resolve());expect(h.onWriteSucceeded).toHaveBeenCalledOnce();expect(h.onDeleted).not.toHaveBeenCalled();
 });
});
