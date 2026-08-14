import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import type { CloudAuthState, CloudUser } from "@/types";

interface UseCloudAuthReturn {
  user: CloudUser | null;
  isLoggedIn: boolean;
  isLoading: boolean;
  loginWithPassword: (
    username: string,
    password: string,
  ) => Promise<CloudAuthState>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<CloudUser>;
}

export function useCloudAuth(): UseCloudAuthReturn {
  const [authState, setAuthState] = useState<CloudAuthState | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadUser = useCallback(async () => {
    try {
      const state = await invoke<CloudAuthState | null>("company_get_user");
      setAuthState(state);
    } catch (error) {
      console.error("Failed to load cloud auth state:", error);
      setAuthState(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUser();

    const unlistenExpired = listen("cloud-auth-expired", () => {
      setAuthState(null);
    });

    const unlistenChanged = listen("cloud-auth-changed", () => {
      void loadUser();
    });

    return () => {
      void unlistenExpired.then((unlisten) => {
        unlisten();
      });
      void unlistenChanged.then((unlisten) => {
        unlisten();
      });
    };
  }, [loadUser]);

  const logout = useCallback(async () => {
    await invoke("company_logout");
    setAuthState(null);
  }, []);

  const refreshProfile = useCallback(async (): Promise<CloudUser> => {
    const user = await invoke<CloudUser>("company_refresh");
    setAuthState((prev) =>
      prev
        ? { ...prev, user }
        : { user, logged_in_at: new Date().toISOString() },
    );
    return user;
  }, []);

  return {
    user: authState?.user ?? null,
    isLoggedIn: authState !== null,
    isLoading,
    loginWithPassword: async (username: string, password: string) => {
      const state = await invoke<CloudAuthState>("company_login", {
        username,
        password,
      });
      setAuthState(state);
      return state;
    },
    logout,
    refreshProfile,
  };
}
