import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { setAdminToken } from "./api.ts";

type AdminTokenStore = {
  token: string;
  setToken: (value: string) => void;
  hasToken: boolean;
};

const AdminTokenContext = createContext<AdminTokenStore | null>(null);

export function AdminTokenProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState("");

  const setToken = useCallback((value: string) => {
    setTokenState(value);
    setAdminToken(value);
  }, []);

  const value = useMemo(
    () => ({
      token,
      setToken,
      hasToken: Boolean(token.trim()),
    }),
    [token, setToken],
  );

  return (
    <AdminTokenContext.Provider value={value}>
      {children}
    </AdminTokenContext.Provider>
  );
}

export function useAdminToken(): AdminTokenStore {
  const ctx = useContext(AdminTokenContext);
  if (!ctx) {
    throw new Error("useAdminToken must be used within AdminTokenProvider");
  }
  return ctx;
}
