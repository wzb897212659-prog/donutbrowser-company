import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { CompanyAdminOverview } from "@/types";

const EMPTY_OVERVIEW: CompanyAdminOverview = { users: [], profiles: [] };

export function useCompanyAdmin(enabled: boolean) {
  const [overview, setOverview] =
    useState<CompanyAdminOverview>(EMPTY_OVERVIEW);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setOverview(EMPTY_OVERVIEW);
      return;
    }
    setIsLoading(true);
    try {
      setOverview(
        await invoke<CompanyAdminOverview>("company_get_admin_overview"),
      );
    } finally {
      setIsLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh().catch((error) => {
      console.error("Failed to load company admin overview:", error);
    });
  }, [refresh]);

  const createAdmin = useCallback(
    async (username: string, password: string) => {
      await invoke("company_create_admin", { username, password });
      await refresh();
    },
    [refresh],
  );

  const setAdminStatus = useCallback(
    async (userId: string, active: boolean) => {
      await invoke("company_set_admin_status", { userId, active });
      await refresh();
    },
    [refresh],
  );

  const resetAdminPassword = useCallback(
    async (userId: string, password: string) => {
      await invoke("company_reset_admin_password", { userId, password });
      await refresh();
    },
    [refresh],
  );

  const batchTransferProfiles = useCallback(
    async (profileIds: string[], targetUserId: string) => {
      const updated = await invoke<number>("company_batch_transfer_profiles", {
        profileIds,
        targetUserId,
      });
      await refresh();
      return updated;
    },
    [refresh],
  );

  return {
    overview,
    isLoading,
    refresh,
    createAdmin,
    setAdminStatus,
    resetAdminPassword,
    batchTransferProfiles,
  };
}
