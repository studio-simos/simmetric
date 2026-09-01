// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useSetInitialPassword, useLogout } from "../queries/useAuth";
import { showSuccess, showError } from "../lib/toast";
import { useTranslation } from "react-i18next";
import ThemeToggle from "./ThemeToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Eye, EyeOff } from "lucide-react";
import { getErrorMessage } from "../utils/errorUtils";

/**
 * Forced first-login password change screen.
 *
 * Rendered by App.tsx whenever the authenticated user has
 * `mustChangePassword === true`. Blocks the whole app until the user sets a
 * new password via POST /auth/set-initial-password, which clears the flag and
 * triggers a /auth/me refetch.
 */
export default function ForcePasswordChange() {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [mismatch, setMismatch] = useState(false);

  const setInitialPassword = useSetInitialPassword();
  const logoutMutation = useLogout();
  const { t } = useTranslation();

  const submitting = setInitialPassword.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      setMismatch(true);
      return;
    }
    setMismatch(false);

    try {
      await setInitialPassword.mutateAsync({ newPassword });
      showSuccess(t("login.forceChange.success"));
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("login.authFailed")));
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        {/* Controls bar — theme toggle */}
        <div className="flex items-center justify-end gap-2 mb-4">
          <ThemeToggle />
        </div>

        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-bold">{t("login.forceChange.title")}</CardTitle>
            <CardDescription>{t("login.forceChange.description")}</CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* New password */}
              <div className="flex flex-col gap-1.5">
                <Label>{t("login.forceChange.newPassword")}</Label>
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    minLength={8}
                    className="pr-10"
                    placeholder={t("login.forceChange.newPasswordPlaceholder")}
                    autoComplete="new-password"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
                  </Button>
                </div>
              </div>

              {/* Confirm password */}
              <div className="flex flex-col gap-1.5">
                <Label>{t("login.forceChange.confirmPassword")}</Label>
                <Input
                  type={showPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder={t("login.forceChange.confirmPasswordPlaceholder")}
                  autoComplete="new-password"
                />
              </div>

              {mismatch && (
                <p role="alert" className="text-sm text-destructive">
                  {t("login.forceChange.mismatch")}
                </p>
              )}

              {/* Submit */}
              <Button
                type="submit"
                variant="default"
                disabled={submitting}
                className="w-full py-2.5 px-4 rounded-lg font-medium"
              >
                {submitting ? t("login.forceChange.submitting") : t("login.forceChange.submit")}
              </Button>

              {/* Sign out escape link */}
              <button
                type="button"
                onClick={() => logoutMutation.mutate()}
                className="w-full text-center text-sm text-secondary-foreground hover:underline"
              >
                {t("login.forceChange.signOut")}
              </button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
