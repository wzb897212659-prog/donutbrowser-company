"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingButton } from "@/components/loading-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { CompanyAdminUser } from "@/types";

interface CompanyTransferDialogProps {
  open: boolean;
  profileIds: string[];
  admins: CompanyAdminUser[];
  onOpenChange: (open: boolean) => void;
  onTransfer: (profileIds: string[], targetUserId: string) => Promise<number>;
  onTransferred: () => Promise<void> | void;
}

export function CompanyTransferDialog({
  open,
  profileIds,
  admins,
  onOpenChange,
  onTransfer,
  onTransferred,
}: CompanyTransferDialogProps) {
  const { t } = useTranslation();
  const [targetUserId, setTargetUserId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) setTargetUserId("");
  }, [open]);

  const handleTransfer = async () => {
    if (!targetUserId || profileIds.length === 0) return;
    setIsSubmitting(true);
    try {
      const updated = await onTransfer(profileIds, targetUserId);
      showSuccessToast(t("companyAdmin.transferSuccess", { count: updated }));
      onOpenChange(false);
      await onTransferred();
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("companyAdmin.transferTitle")}</DialogTitle>
          <DialogDescription>
            {t("companyAdmin.transferDescription", {
              count: profileIds.length,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>{t("companyAdmin.transferTarget")}</Label>
          <Select value={targetUserId} onValueChange={setTargetUserId}>
            <SelectTrigger>
              <SelectValue placeholder={t("companyAdmin.selectAdmin")} />
            </SelectTrigger>
            <SelectContent>
              {admins.map((admin) => (
                <SelectItem key={admin.id} value={admin.id}>
                  {admin.username} ({admin.assignedProfileCount})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-warning">
            {t("companyAdmin.transferWarning")}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.buttons.cancel")}
          </Button>
          <LoadingButton
            isLoading={isSubmitting}
            disabled={!targetUserId || profileIds.length === 0}
            onClick={() => void handleTransfer()}
          >
            {t("companyAdmin.transferConfirm")}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
