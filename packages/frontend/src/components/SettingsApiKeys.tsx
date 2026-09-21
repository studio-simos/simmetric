// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiDelete } from "../utils/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { showSuccess, showError, showInfo } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";

interface ApiKeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsed: string | null;
  expiresAt: string | null;
}

interface CreateKeyFormValues {
  name: string;
  expiry: string;
}

export default function SettingsApiKeys() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [revealedKeyValue, setRevealedKeyValue] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);

  const form = useForm<CreateKeyFormValues>({
    defaultValues: {
      name: "",
      expiry: "0",
    },
  });

  const loadKeys = async () => {
    try {
      const data = await apiGet<ApiKeyInfo[]>("/api-keys");
      setKeys(data);
    } catch {
      // May fail if endpoint not reachable
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadKeys();
  }, []);

  const handleCreate = async (data: CreateKeyFormValues) => {
    if (!data.name.trim()) return;

    setCreating(true);
    try {
      const body: Record<string, unknown> = { name: data.name };
      const expiry = Number(data.expiry);
      if (expiry > 0) {
        body.expiresInDays = expiry;
      }
      const result = await apiPost<{ id: string; name: string; key: string; expiresAt: string | null }>("/api-keys", body);
      setRevealedKey(result.id);
      setRevealedKeyValue(result.key);
      showSuccess(t("settings.apiKeys.createSuccess"));
      form.reset({ name: "", expiry: "0" });
      await loadKeys();
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.apiKeys.createFailed")));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = (keyId: string) => {
    setRevokeTarget(keyId);
  };

  const handleConfirmRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await apiDelete(`/api-keys/${revokeTarget}`);
      showSuccess(t("settings.apiKeys.revokeSuccess"));
      await loadKeys();
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.apiKeys.revokeFailed")));
    } finally {
      setRevokeTarget(null);
    }
  };

  const copyKey = () => {
    navigator.clipboard.writeText(revealedKeyValue);
    showInfo(t("settings.apiKeys.copied"));
  };

  return (
    <div className="w-full space-y-6">
      <h3 className="text-lg font-medium text-foreground">{t("settings.apiKeys.title")}</h3>
      <p className="text-sm text-muted-foreground">
        {t("settings.apiKeys.description")}
      </p>

      {/* Revealed key banner */}
      {revealedKey && (
        <div className="bg-secondary border border-secondary rounded-lg p-4">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <p className="text-sm font-medium text-secondary-foreground">{t("settings.apiKeys.createdBannerTitle")}</p>
              <p className="text-xs text-secondary-foreground mt-1">{t("settings.apiKeys.createdBannerHint")}</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="bg-card border border-secondary px-3 py-1.5 rounded text-sm text-foreground font-mono select-all break-all">
                  {revealedKeyValue}
                </code>
                <Button size="sm" onClick={copyKey}>
                  {t("settings.apiKeys.copy")}
                </Button>
              </div>
            </div>
            <Button variant="ghost" size="sm"
              onClick={() => { setRevealedKey(null); setRevealedKeyValue(""); }}
              className="text-secondary-foreground hover:text-green-800 text-lg"
            >
              &times;
            </Button>
          </div>
        </div>
      )}

      {/* Create key form */}
      <div className="bg-card rounded-lg border border-input p-5">
        <h4 className="text-sm font-semibold text-foreground mb-4">{t("settings.apiKeys.createNewKey")}</h4>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleCreate)} className="flex flex-wrap sm:flex-nowrap items-end gap-2 sm:gap-3">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormLabel>{t("settings.apiKeys.keyNameLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      placeholder={t("settings.apiKeys.keyNamePlaceholder")}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="expiry"
              render={({ field }) => (
                <FormItem className="w-40">
                  <FormLabel>{t("settings.apiKeys.expiresInLabel")}</FormLabel>
                  <FormControl>
                    <Select
                      value={field.value}
                      onValueChange={(val) => field.onChange(val)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">{t("settings.apiKeys.expiryNever")}</SelectItem>
                        <SelectItem value="30">{t("settings.apiKeys.expiry30d")}</SelectItem>
                        <SelectItem value="90">{t("settings.apiKeys.expiry90d")}</SelectItem>
                        <SelectItem value="365">{t("settings.apiKeys.expiry1y")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              disabled={creating}
            >
              {creating ? t("settings.apiKeys.creating") : t("settings.apiKeys.createKeyButton")}
            </Button>
          </form>
        </Form>
      </div>

      {/* Keys table */}
      <div className="bg-card rounded-lg border border-input overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-input text-left text-muted-foreground">
              <TableHead className="px-5 py-2">{t("settings.apiKeys.colName")}</TableHead>
              <TableHead className="px-5 py-2">{t("settings.apiKeys.colCreated")}</TableHead>
              <TableHead className="px-5 py-2">{t("settings.apiKeys.colLastUsed")}</TableHead>
              <TableHead className="px-5 py-2">{t("settings.apiKeys.colExpires")}</TableHead>
              <TableHead className="px-5 py-2">{t("settings.apiKeys.colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id} className="border-b border-input hover:bg-accent">
                <TableCell className="px-5 py-3 font-medium text-foreground">{key.name}</TableCell>
                <TableCell className="px-5 py-3 text-muted-foreground text-xs">
                  {new Date(key.createdAt).toLocaleDateString()}
                </TableCell>
                <TableCell className="px-5 py-3 text-muted-foreground text-xs">
                  {key.lastUsed ? new Date(key.lastUsed).toLocaleDateString() : t("settings.apiKeys.lastUsedNever")}
                </TableCell>
                <TableCell className="px-5 py-3">
                  {key.expiresAt ? (
                    <Badge variant="outline" className="text-[10px]">
                      {new Date(key.expiresAt).toLocaleDateString()}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px]">
                      {t("settings.apiKeys.expiresNever")}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="px-5 py-3">
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => handleRevoke(key.id)}
                    className="text-xs text-destructive hover:underline"
                  >
                    {t("settings.apiKeys.revoke")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {keys.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="px-5 py-8 text-center text-secondary-foreground">
                  {t("settings.apiKeys.noKeys")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Revoke Confirmation AlertDialog */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.apiKeys.revokeConfirmTitle", { defaultValue: "Revoke API Key" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.apiKeys.revokeConfirmBody", { defaultValue: "This API key will be permanently revoked and cannot be recovered." })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmRevoke}
            >
              {t("settings.apiKeys.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
