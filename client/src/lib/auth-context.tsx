import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { setAuthTokenGetter } from "@/lib/api";
import {
  clearStoredToken,
  getStoredToken,
  storeToken,
  storeUsername,
} from "@/lib/auth-token";

interface AuthContextValue {
  token: string | null;
  login: (token: string, username?: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Module-level ref so the fetch getter is live before any child effects run.
const tokenRef = { current: null as string | null };

// Register once at import time — avoids a race where dashboard queries fire
// before AuthProvider's useEffect and get 401, wiping the saved session.
setAuthTokenGetter(() => tokenRef.current);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getStoredToken());

  tokenRef.current = token;

  useEffect(() => {
    function handleUnauthorized() {
      clearStoredToken();
      setToken(null);
      tokenRef.current = null;
    }

    window.addEventListener("mushking:unauthorized", handleUnauthorized);
    return () =>
      window.removeEventListener("mushking:unauthorized", handleUnauthorized);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      login: (newToken: string, username?: string) => {
        storeToken(newToken);
        if (username) storeUsername(username);
        tokenRef.current = newToken;
        setToken(newToken);
      },
      logout: () => {
        clearStoredToken();
        tokenRef.current = null;
        setToken(null);
      },
    }),
    [token],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
