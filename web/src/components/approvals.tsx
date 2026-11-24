import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, streamApprovals, type ApprovalRequestRecord } from '../api';

interface ApprovalsState {
  pending: ApprovalRequestRecord[];
  connected: boolean;
  decide: (id: string, decision: 'approved' | 'denied', note?: string) => Promise<void>;
}

const ApprovalsContext = createContext<ApprovalsState | null>(null);

/** One live SSE connection shared by the nav badge, the overview alert, and the queue. */
export function ApprovalsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [pending, setPending] = useState<ApprovalRequestRecord[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setPending([]);
      setConnected(false);
      return;
    }
    const controller = new AbortController();
    void streamApprovals(
      {
        onSnapshot: (approvals) => setPending(approvals.filter((a) => a.status === 'pending')),
        onEvent: ({ approval }) =>
          setPending((current) => {
            const rest = current.filter((a) => a.id !== approval.id);
            return approval.status === 'pending' ? [approval, ...rest] : rest;
          }),
        onConnection: setConnected,
      },
      controller.signal,
    );
    return () => controller.abort();
  }, [enabled]);

  const decide = useCallback(
    async (id: string, decision: 'approved' | 'denied', note?: string) => {
      const updated = await api.decideApproval(id, decision, note);
      setPending((current) => current.filter((a) => a.id !== updated.id));
    },
    [],
  );

  const value = useMemo(() => ({ pending, connected, decide }), [pending, connected, decide]);
  return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>;
}

export function useApprovals(): ApprovalsState {
  const context = useContext(ApprovalsContext);
  if (!context) throw new Error('useApprovals must be used inside ApprovalsProvider');
  return context;
}
