"use client";

import { invoke } from "@tauri-apps/api/core";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { FiCheck } from "react-icons/fi";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/flag-utils";
import type { ProxyCheckResult, StoredProxy } from "@/types";

interface ProxyCheckButtonProps {
  proxy: StoredProxy;
  profileId: string;
  checkingProfileId: string | null;
  cachedResult?: ProxyCheckResult;
  onCheckComplete?: (result: ProxyCheckResult) => void;
  onCheckFailed?: (result: ProxyCheckResult) => void;
  disabled?: boolean;
  setCheckingProfileId?: (id: string | null) => void;
}

function normalizeProvince(value?: string) {
  return value?.replace(
    /(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/u,
    "",
  );
}

function normalizeCity(value?: string) {
  return value?.replace(/(自治州|地区|盟|市)$/u, "");
}

function formatProxyLocation(result: ProxyCheckResult) {
  const province = normalizeProvince(result.province);
  const city = normalizeCity(result.city);
  return (
    [province, city].filter(Boolean).join("-") ||
    [result.country, city].filter(Boolean).join("-")
  );
}

export function ProxyCheckButton({
  proxy,
  profileId,
  checkingProfileId,
  cachedResult,
  onCheckComplete,
  onCheckFailed,
  disabled = false,
  setCheckingProfileId,
}: ProxyCheckButtonProps) {
  const { t } = useTranslation();
  const [localResult, setLocalResult] = React.useState<
    ProxyCheckResult | undefined
  >(cachedResult);

  React.useEffect(() => {
    setLocalResult(cachedResult);
  }, [cachedResult]);

  const handleCheck = React.useCallback(async () => {
    if (checkingProfileId === profileId) return;

    setCheckingProfileId?.(profileId);
    try {
      const result = await invoke<ProxyCheckResult>("check_proxy_validity", {
        proxyId: proxy.id,
        proxySettings: proxy.proxy_settings,
      });
      setLocalResult(result);
      onCheckComplete?.(result);

      // Show toast with location
      const location =
        formatProxyLocation(result) || t("proxyCheck.unknownLocation");

      toast.success(
        <div className="flex flex-col">
          {t("proxyCheck.locationToast")}
          <div className="flex items-center whitespace-nowrap">
            {location}
            <span className="ml-2 font-mono text-xs">{result.ip}</span>
          </div>
        </div>,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(t("proxyCheck.failed", { error: errorMessage }));

      // Save failed check result
      const failedResult: ProxyCheckResult = {
        ip: "",
        province: undefined,
        city: undefined,
        country: undefined,
        country_code: undefined,
        timestamp: Math.floor(Date.now() / 1000),
        is_valid: false,
      };
      setLocalResult(failedResult);
      onCheckFailed?.(failedResult);
    } finally {
      setCheckingProfileId?.(null);
    }
  }, [
    proxy,
    profileId,
    checkingProfileId,
    onCheckComplete,
    onCheckFailed,
    setCheckingProfileId,
    t,
  ]);

  const isCurrentlyChecking = checkingProfileId === profileId;
  const result = localResult;
  const locationLabel = result?.is_valid
    ? formatProxyLocation(result) || result.ip
    : "";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 max-w-28 gap-1 px-1.5 text-[10px]"
          onClick={handleCheck}
          disabled={isCurrentlyChecking || disabled}
        >
          {isCurrentlyChecking ? (
            <div className="size-3 animate-spin rounded-full border border-current border-t-transparent" />
          ) : result?.is_valid ? (
            <span className="flex min-w-0 items-center gap-1">
              <span className="size-1.5 shrink-0 rounded-full bg-success" />
              <span className="truncate">{locationLabel}</span>
            </span>
          ) : result && !result.is_valid ? (
            <span className="text-sm text-destructive">✕</span>
          ) : (
            <FiCheck className="size-3" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {isCurrentlyChecking ? (
          <p>{t("proxyCheck.tooltipChecking")}</p>
        ) : result?.is_valid ? (
          <div className="space-y-1">
            <p className="flex items-center gap-1">
              {locationLabel || t("proxyCheck.unknownLocation")}
            </p>
            <p className="text-xs text-primary-foreground/70">
              {t("proxyCheck.tooltipIp", { ip: result.ip })}
            </p>
            <p className="text-xs text-primary-foreground/70">
              {t("proxyCheck.tooltipChecked", {
                time: formatRelativeTime(result.timestamp),
              })}
            </p>
          </div>
        ) : result && !result.is_valid ? (
          <div>
            <p>{t("proxyCheck.tooltipFailedTitle")}</p>
            <p className="text-xs text-primary-foreground/70">
              {t("proxyCheck.tooltipFailed", {
                time: formatRelativeTime(result.timestamp),
              })}
            </p>
          </div>
        ) : (
          <p>{t("proxyCheck.tooltipDefault")}</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
