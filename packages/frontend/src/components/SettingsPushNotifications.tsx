// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsPushNotifications — toggle for enabling/disabling web push
 * notifications. Shows the current browser permission state and lets
 * the user subscribe/unsubscribe.
 */
import { useTranslation } from "react-i18next";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Bell, BellOff, Loader2, Check } from "lucide-react";

export default function SettingsPushNotifications() {
  const { t } = useTranslation();
  const { permission, subscribed, loading, subscribe, unsubscribe } = usePushNotifications();

  const supported = "serviceWorker" in navigator && "PushManager" in window;

  if (!supported) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellOff className="h-4 w-4" />
            {t("settings.subSections.notifications")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t("settings.push.notSupported")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bell className="h-4 w-4" />
          {t("settings.subSections.notifications")}
          {subscribed && (
            <Badge variant="default" className="ml-2">
              <Check className="mr-1 h-3 w-3" />
              {t("settings.push.active")}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("settings.push.description")}
        </p>

        <div className="flex items-center gap-3">
          {permission === "granted" && subscribed ? (
            <Button
              variant="outline"
              size="sm"
              onClick={unsubscribe}
              disabled={loading}
              className="min-h-[44px]"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellOff className="h-4 w-4" />}
              {t("settings.push.disable")}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={subscribe}
              disabled={loading || permission === "denied"}
              className="min-h-[44px]"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
              {t("settings.push.enable")}
            </Button>
          )}

          {permission === "denied" && (
            <span className="text-xs text-destructive">
              {t("settings.push.blocked")}
            </span>
          )}
        </div>

        {permission === "default" && (
          <p className="text-xs text-muted-foreground">
            {t("settings.push.permissionHint")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}