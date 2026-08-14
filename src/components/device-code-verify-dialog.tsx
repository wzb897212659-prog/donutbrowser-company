"use client";

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingButton } from "@/components/loading-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCloudAuth } from "@/hooks/use-cloud-auth";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";

interface DeviceCodeVerifyDialogProps {
  isOpen: boolean;
  onClose: (loginOccurred?: boolean) => void;
}

/**
 * Dedicated dialog for pasting and verifying the cloud device-link code.
 * Opens after the user clicks "Login" in the sync config dialog so the
 * verify step is a focused step on its own — and so it doesn't visually
 * stack with other dialogs (e.g. the profile selector triggered by a
 * deep link) sharing the same view.
 */
export function DeviceCodeVerifyDialog({
  isOpen,
  onClose,
}: DeviceCodeVerifyDialogProps) {
  const { t } = useTranslation();
  const { loginWithPassword } = useCloudAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);

  // Reset the field when the dialog reopens so a stale code from a
  // previous attempt doesn't auto-populate.
  useEffect(() => {
    if (isOpen) {
      setUsername("");
      setPassword("");
    }
  }, [isOpen]);

  const handleVerify = async () => {
    const trimmed = username.trim();
    if (!trimmed || !password) return;
    setIsVerifying(true);
    try {
      await loginWithPassword(trimmed, password);
      showSuccessToast(t("sync.cloud.loginSuccess"));
      try {
        await invoke("restart_sync_service");
      } catch (e) {
        console.error("Failed to restart sync service:", e);
      }
      onClose(true);
    } catch (error) {
      console.error("Company login failed:", error);
      showErrorToast(String(error));
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose(false);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("sync.cloud.signInTitle")}</DialogTitle>
          <DialogDescription>
            {t("sync.cloud.companyLoginInstructions")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="company-username">{t("sync.cloud.username")}</Label>
            <Input
              id="company-username"
              placeholder={t("sync.cloud.usernamePlaceholder")}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
              }}
              autoComplete="username"
              spellCheck={false}
              autoFocus
            />
            <Label htmlFor="company-password">{t("sync.cloud.password")}</Label>
            <Input
              id="company-password"
              type="password"
              placeholder={t("sync.cloud.passwordPlaceholder")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && username.trim() && password)
                  void handleVerify();
              }}
              autoComplete="current-password"
            />
            <LoadingButton
              onClick={() => void handleVerify()}
              isLoading={isVerifying}
              disabled={!username.trim() || !password}
              className="w-full"
            >
              {isVerifying
                ? t("sync.cloud.loggingIn")
                : t("sync.cloud.companyLogin")}
            </LoadingButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
