// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useLogin } from "../queries/useAuth";
import { useSsoStatus } from "../queries/useSso";
import { useFeature } from "../hooks/useFeature";
import { showSuccess, showError } from "../lib/toast";
import { useTranslation } from "react-i18next";
import ThemeToggle from "./ThemeToggle";
import { getEnabledLanguages } from "../i18n";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AppInput } from "@/components/ui/app";
import { Eye, EyeOff } from "lucide-react";
import { getErrorMessage } from "../utils/errorUtils";
import { navigateTo } from "../utils/navigation";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [enabledLanguages, setEnabledLanguages] = useState(getEnabledLanguages());

  useEffect(() => {
    const handler = () => setEnabledLanguages(getEnabledLanguages());
    window.addEventListener("enabled-languages-changed", handler);
    return () => window.removeEventListener("enabled-languages-changed", handler);
  }, []);

  const loginMutation = useLogin();
  // Public SSO availability (quick 260808-p5y) — replaces the admin-gated
  // useSsoConfig() which 401s for unauthenticated visitors. The button is
  // additionally gated on the license feature flag via useFeature below.
  const { data: ssoStatus } = useSsoStatus();
  const ssoFeatureEnabled = useFeature("sso_enabled");
  const { t, i18n } = useTranslation();

  const submitting = loginMutation.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      await loginMutation.mutateAsync({ username, password });
      showSuccess(t("login.successLogin"));
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("login.authFailed")));
    }
  };

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        {/* Controls bar — theme toggle + language selector */}
        <div className="flex items-center justify-end gap-2 mb-4">
          <ThemeToggle />
          {enabledLanguages.length > 1 && (
            <Select
              value={i18n.language}
              onValueChange={(value) => changeLanguage(value)}
              aria-label={t("login.language")}
            >
              <SelectTrigger className="w-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {enabledLanguages.map((code) => (
                  <SelectItem key={code} value={code}>
                    {code === "en" && "English"}
                    {code === "de" && "Deutsch"}
                    {code === "es" && "Español"}
                    {code === "fr" && "Français"}
                    {code === "it" && "Italiano"}
                    {code === "ru" && "Русский"}
                    {code === "zh" && "中文"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Card */}
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-bold">Simmetric Chat</CardTitle>
            <CardDescription>{t("app.subtitle")}</CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Username */}
              <AppInput
                label={t("login.username")}
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                minLength={1}
                placeholder={t("login.usernamePlaceholder")}
              />

              {/* Password */}
              <div className="flex flex-col gap-1.5">
                <Label>{t("login.password")}</Label>
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={1}
                    className="pr-10"
                    placeholder={t("login.passwordPlaceholderLogin")}
                    autoComplete="current-password"
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

              {/* Contact admin */}
              <div className="text-center text-sm text-secondary-foreground">
                {t("login.contactAdmin")}
              </div>

              {/* Submit */}
              <Button
                type="submit"
                variant="default"
                disabled={submitting}
                className="w-full py-2.5 px-4 rounded-lg font-medium"
              >
                {submitting ? t("login.signingIn") : t("login.signIn")}
              </Button>

              {/* SSO login button (D-06) — driven by the public status endpoint
                  (quick 260808-p5y). The admin-gated useSsoConfig() 401s for
                  unauthenticated visitors, so availability comes from the
                  public GET /api/auth/sso/status instead. */}
              {ssoFeatureEnabled && ssoStatus?.enabled && ssoStatus?.provider && (
                <div className="mt-4 border-t border-border pt-4">
                  <p className="mb-2 text-center text-sm text-muted-foreground">
                    {t("login.ssoOr")}
                  </p>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      // Full-page navigation is REQUIRED — the server sets
                      // signed state/nonce cookies and 302s to the IdP; an
                      // SPA fetch cannot carry the redirect.
                      const path =
                        ssoStatus.provider === "saml"
                          ? "/api/auth/saml/login"
                          : `/api/auth/oidc/${ssoStatus.oidcProvider ?? "oidc"}/login`;
                      navigateTo(path);
                    }}
                  >
                    {ssoStatus.provider === "oidc" &&
                    ssoStatus.oidcProvider &&
                    ssoStatus.oidcProvider !== "oidc"
                      ? t("login.ssoSignInWith", {
                          provider:
                            ssoStatus.oidcProvider === "google"
                              ? "Google"
                              : ssoStatus.oidcProvider === "github"
                                ? "GitHub"
                                : "Microsoft",
                        })
                      : t("login.ssoSignIn")}
                  </Button>
                </div>
              )}
            </form>
          </CardContent>
        </Card>

        {/* Footer */}
        <p className="text-center mt-4 text-xs text-secondary-foreground">
          {t("login.footer")}
        </p>
      </div>
    </div>
  );
}
