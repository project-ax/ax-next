/**
 * Agent-workspace prototype — board state + actions.
 *
 * One fetch of `/state` feeds Today, the sidebar, and Activity, because they
 * are three views of the same two collections (decisions, events) rather than
 * three feeds. Every mutation re-reads the board: the prototype is small enough
 * that a refetch is honest and an optimistic cache would be a lie waiting to
 * drift.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  workspaceApi,
  type ApproveResponse,
  type BoardState,
  type DemoScenario,
  type WorkspacePrefs,
} from './workspace-api';

interface WorkspaceContextValue {
  board: BoardState | null;
  error: string | null;
  refresh: () => Promise<void>;
  approve: (id: string) => Promise<ApproveResponse | null>;
  dismiss: (id: string) => Promise<void>;
  undo: (id: string) => Promise<boolean>;
  stopAll: (stopped: boolean) => Promise<void>;
  setScenario: (s: DemoScenario) => Promise<void>;
  setPrefs: (patch: Partial<WorkspacePrefs>) => Promise<void>;
}

const Ctx = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [board, setBoard] = useState<BoardState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setBoard(await workspaceApi.board());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      board,
      error,
      refresh,
      approve: async (id) => {
        try {
          const r = await workspaceApi.approve(id);
          await refresh();
          return r;
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          return null;
        }
      },
      dismiss: async (id) => {
        await workspaceApi.dismiss(id);
        await refresh();
      },
      undo: async (id) => {
        const r = await workspaceApi.undo(id);
        await refresh();
        return r.undone;
      },
      stopAll: async (stopped) => {
        await workspaceApi.stopAll(stopped);
        await refresh();
      },
      setScenario: async (s) => {
        await workspaceApi.setScenario(s);
        await refresh();
      },
      setPrefs: async (patch) => {
        await workspaceApi.setPrefs(patch);
        await refresh();
      },
    }),
    [board, error, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkspace outside WorkspaceProvider');
  return v;
}
