import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { editableDefinition } from '@ax/routines-contract';
import { RoutineApiError } from '@/lib/routines';
import { useRoutineDraft } from '../use-routine-draft';
import { routineFixture } from './routine-fixture';

describe('useRoutineDraft', () => {
  it('forgets the refusal code whenever it forgets the refusal', async () => {
    const save = vi.fn().mockRejectedValue(new RoutineApiError(409, 'busy'));
    const { result } = renderHook(() => useRoutineDraft({
      initial: editableDefinition(routineFixture), mode: 'edit', canEdit: true, save, onSaved: vi.fn(),
    }));
    act(() => result.current.update('name', 'Renamed'));
    await act(() => result.current.submit());
    expect(result.current.errorCode).toBe('busy');
    act(() => result.current.update('name', 'Renamed again'));
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
  });
});
