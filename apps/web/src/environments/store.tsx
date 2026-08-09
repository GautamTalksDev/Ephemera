import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  fetchEnvironmentDetail,
  fetchEnvironments,
  type EnvironmentEvent,
  type EnvironmentItem,
} from "../api.ts";

function isNewer(next: EnvironmentItem, prev: EnvironmentItem | undefined): boolean {
  if (!prev) {
    return true;
  }
  const nextTs = Date.parse(next.updatedAt);
  const prevTs = Date.parse(prev.updatedAt);
  if (Number.isFinite(nextTs) && Number.isFinite(prevTs)) {
    if (nextTs !== prevTs) {
      return nextTs > prevTs;
    }
  }
  // Same updatedAt (or unparseable): accept the incoming snapshot.
  return true;
}

type EnvironmentsStore = {
  byId: Record<string, EnvironmentItem>;
  listIds: string[] | null;
  eventsById: Record<string, EnvironmentEvent[]>;
  listError: string | null;
  upsert: (env: EnvironmentItem) => void;
  upsertMany: (envs: EnvironmentItem[]) => void;
  refreshList: () => Promise<void>;
  refreshOne: (
    id: string,
  ) => Promise<{ environment: EnvironmentItem; events: EnvironmentEvent[] }>;
  getEnvironment: (id: string) => EnvironmentItem | undefined;
  listEnvironments: () => EnvironmentItem[];
};

const EnvironmentsContext = createContext<EnvironmentsStore | null>(null);

export function EnvironmentsProvider({ children }: { children: ReactNode }) {
  const [byId, setById] = useState<Record<string, EnvironmentItem>>({});
  const [listIds, setListIds] = useState<string[] | null>(null);
  const [eventsById, setEventsById] = useState<
    Record<string, EnvironmentEvent[]>
  >({});
  const [listError, setListError] = useState<string | null>(null);

  const upsert = useCallback((env: EnvironmentItem) => {
    setById((prev) => {
      if (!isNewer(env, prev[env.id])) {
        return prev;
      }
      return { ...prev, [env.id]: env };
    });
  }, []);

  const upsertMany = useCallback((envs: EnvironmentItem[]) => {
    setById((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const env of envs) {
        if (isNewer(env, next[env.id])) {
          next[env.id] = env;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setListIds(envs.map((e) => e.id));
  }, []);

  const refreshList = useCallback(async () => {
    try {
      const rows = await fetchEnvironments();
      upsertMany(rows);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "failed to load");
    }
  }, [upsertMany]);

  const refreshOne = useCallback(
    async (id: string) => {
      const data = await fetchEnvironmentDetail(id);
      upsert(data.environment);
      setEventsById((prev) => ({ ...prev, [id]: data.events }));
      return data;
    },
    [upsert],
  );

  const getEnvironment = useCallback(
    (id: string) => byId[id],
    [byId],
  );

  const listEnvironments = useCallback(() => {
    if (!listIds) {
      return Object.values(byId);
    }
    return listIds.map((id) => byId[id]).filter((e): e is EnvironmentItem => Boolean(e));
  }, [byId, listIds]);

  const value = useMemo(
    () => ({
      byId,
      listIds,
      eventsById,
      listError,
      upsert,
      upsertMany,
      refreshList,
      refreshOne,
      getEnvironment,
      listEnvironments,
    }),
    [
      byId,
      listIds,
      eventsById,
      listError,
      upsert,
      upsertMany,
      refreshList,
      refreshOne,
      getEnvironment,
      listEnvironments,
    ],
  );

  return (
    <EnvironmentsContext.Provider value={value}>
      {children}
    </EnvironmentsContext.Provider>
  );
}

export function useEnvironments(): EnvironmentsStore {
  const ctx = useContext(EnvironmentsContext);
  if (!ctx) {
    throw new Error("useEnvironments must be used within EnvironmentsProvider");
  }
  return ctx;
}
