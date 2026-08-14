"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuKeyRound, LuPlus, LuRefreshCw } from "react-icons/lu";
import { LoadingButton } from "@/components/loading-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { CompanyAdminUser } from "@/types";

interface CompanyAdminPageProps {
  users: CompanyAdminUser[];
  isLoading: boolean;
  onRefresh: () => Promise<void>;
  onCreateAdmin: (username: string, password: string) => Promise<void>;
  onSetStatus: (userId: string, active: boolean) => Promise<void>;
  onResetPassword: (userId: string, password: string) => Promise<void>;
}

export function CompanyAdminPage({
  users,
  isLoading,
  onRefresh,
  onCreateAdmin,
  onSetStatus,
  onResetPassword,
}: CompanyAdminPageProps) {
  const { t, i18n } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetUser, setResetUser] = useState<CompanyAdminUser | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const formError = useMemo(() => {
    if (password && password.length < 12)
      return t("companyAdmin.passwordTooShort");
    if (confirmPassword && password !== confirmPassword)
      return t("companyAdmin.passwordMismatch");
    return null;
  }, [confirmPassword, password, t]);

  const resetForm = () => {
    setUsername("");
    setPassword("");
    setConfirmPassword("");
  };

  const handleCreate = async () => {
    if (!username.trim() || formError || password !== confirmPassword) return;
    setIsSubmitting(true);
    try {
      await onCreateAdmin(username.trim(), password);
      showSuccessToast(t("companyAdmin.createSuccess"));
      setCreateOpen(false);
      resetForm();
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = async () => {
    if (!resetUser || formError || password !== confirmPassword) return;
    setIsSubmitting(true);
    try {
      await onResetPassword(resetUser.id, password);
      showSuccessToast(t("companyAdmin.resetSuccess"));
      setResetUser(null);
      resetForm();
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStatus = async (user: CompanyAdminUser) => {
    setBusyUserId(user.id);
    try {
      await onSetStatus(user.id, !user.active);
      showSuccessToast(
        t(
          user.active
            ? "companyAdmin.disableSuccess"
            : "companyAdmin.enableSuccess",
        ),
      );
    } catch (error) {
      showErrorToast(translateBackendError(t, error));
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t("companyAdmin.title")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("companyAdmin.description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isLoading}
            onClick={() => void onRefresh()}
          >
            <LuRefreshCw className={isLoading ? "animate-spin" : undefined} />
            {t("common.buttons.refresh")}
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <LuPlus />
            {t("companyAdmin.createAdmin")}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-background">
            <TableRow>
              <TableHead>{t("companyAdmin.username")}</TableHead>
              <TableHead>{t("companyAdmin.role")}</TableHead>
              <TableHead>{t("common.labels.status")}</TableHead>
              <TableHead>{t("companyAdmin.profileCount")}</TableHead>
              <TableHead>{t("companyAdmin.createdAt")}</TableHead>
              <TableHead className="text-right">
                {t("common.labels.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => {
              const isAdmin = user.role === "admin";
              return (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.username}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {t(
                        isAdmin
                          ? "companyAdmin.roles.admin"
                          : "companyAdmin.roles.superAdmin",
                      )}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.active ? "default" : "outline"}>
                      {t(
                        user.active
                          ? "common.status.enabled"
                          : "common.status.disabled",
                      )}
                    </Badge>
                  </TableCell>
                  <TableCell>{user.assignedProfileCount}</TableCell>
                  <TableCell>
                    {new Date(user.createdAt).toLocaleString(i18n.language)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {isAdmin && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              resetForm();
                              setResetUser(user);
                            }}
                          >
                            <LuKeyRound />
                            {t("companyAdmin.resetPassword")}
                          </Button>
                          <LoadingButton
                            variant={user.active ? "destructive" : "outline"}
                            size="sm"
                            isLoading={busyUserId === user.id}
                            onClick={() => void handleStatus(user)}
                          >
                            {t(
                              user.active
                                ? "common.buttons.disable"
                                : "common.buttons.enable",
                            )}
                          </LoadingButton>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("companyAdmin.createTitle")}</DialogTitle>
            <DialogDescription>
              {t("companyAdmin.createDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="company-admin-username">
                {t("companyAdmin.username")}
              </Label>
              <Input
                id="company-admin-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="off"
              />
            </div>
            <PasswordFields
              password={password}
              confirmPassword={confirmPassword}
              onPasswordChange={setPassword}
              onConfirmPasswordChange={setConfirmPassword}
            />
            {formError && (
              <p className="text-xs text-destructive">{formError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("common.buttons.cancel")}
            </Button>
            <LoadingButton
              isLoading={isSubmitting}
              disabled={!username.trim() || !password || !!formError}
              onClick={() => void handleCreate()}
            >
              {t("common.buttons.create")}
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetUser !== null} onOpenChange={() => setResetUser(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("companyAdmin.resetTitle")}</DialogTitle>
            <DialogDescription>
              {t("companyAdmin.resetDescription", {
                username: resetUser?.username ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <PasswordFields
            password={password}
            confirmPassword={confirmPassword}
            onPasswordChange={setPassword}
            onConfirmPasswordChange={setConfirmPassword}
          />
          {formError && <p className="text-xs text-destructive">{formError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetUser(null)}>
              {t("common.buttons.cancel")}
            </Button>
            <LoadingButton
              isLoading={isSubmitting}
              disabled={!password || !!formError}
              onClick={() => void handleReset()}
            >
              {t("companyAdmin.resetPassword")}
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PasswordFields({
  password,
  confirmPassword,
  onPasswordChange,
  onConfirmPasswordChange,
}: {
  password: string;
  confirmPassword: string;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="company-admin-password">
          {t("companyAdmin.password")}
        </Label>
        <Input
          id="company-admin-password"
          type="password"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
          autoComplete="new-password"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="company-admin-confirm-password">
          {t("companyAdmin.confirmPassword")}
        </Label>
        <Input
          id="company-admin-confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(event) => onConfirmPasswordChange(event.target.value)}
          autoComplete="new-password"
        />
      </div>
    </>
  );
}
