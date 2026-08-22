/**
 * Agent-workspace — board state.
 *
 * One fetch of `/state` feeds Today, the sidebar, and Activity, because they
 * are three views of the same collections rather than three feeds.
 *
 * Read-only on purpose. Every mutation that used to live here (approve,
 * dismiss, undo, stop-all, scenario switching) called a mock route that no
 * longer exists; they come back with the substrate that serves them (AW-11 for
 * decisions, AW-12 for pause/files, AW-13 for memory). Until then the only
 * write this surface makes is sending a message, and that goes straight to the
 * shipped chat wire — see `workspace-api.ts`.
 *
 * `loading` is separate from `board === null` on purpose: a surface has to be
 * able to tell "we are still fetching" from "we fetched and there is nothing
 * there". Collapsing them is how an honest empty state turns into a lie.
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
import { workspaceApi, type BoardState } from './workspace-api';

interface WorkspaceContextValue {
  board: BoardState | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [board, setBoard] = useState<BoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setBoard(await workspaceApi.board());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({ board, error, loading, refresh }),
    [board, error, loading, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkspace outside WorkspaceProvider');
  return v;
}
