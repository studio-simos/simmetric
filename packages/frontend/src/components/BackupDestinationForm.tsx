// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * BackupDestinationForm — single form for create + edit (D-09).
 *
 * Layout per D-05/D-06:
 *   - Type section (always open) — Select with 8 destination types
 *   - Credentials section (collapsible, auto-opens once type is chosen) —
 *     8 type-aware field branches (D-08) with collapsible controls.
 *     For secret fields (S3 secretKey, GDrive token, SMTP password) we
 *     render them as read-only `••••••••` with a "Cambia" toggle in edit
 *     mode (D-10). The form payload omits unchanged secrets.
 *   - Footer with Cancel + Salva buttons (always visible per D-06).
 *
 * D-20 license gate: when the user picks a non-"local" type on a Community
 * tier, the Credentials section is replaced by an <UpgradePrompt feature="backup_enabled" />.
 *
 * D-07 inline test: a "Test connessione" button inside the Credentials
 * section calls POST /api/backup-destinations/:id/test with the form
 * payload — disabled in create mode (no id yet) with a tooltip.
 */

import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useForm, type SubmitHandler } from "react-hook-form";
import { showSuccess, showError } from "../lib/toast";
import { useFeature } from "../hooks/useFeature";
import { useBackupPermission } from "../hooks/useBackupPermission";
import {
  useCreateBackupDestination,
  useUpdateBackupDestination,
  useTestBackupDestination,
  type BackupDestination,
  type BackupDestinationType,
  type BackupTestResult,
} from "../queries/useBackupDestinations";
import { ApiError } from "../utils/api";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import UpgradePrompt from "./UpgradePrompt";
import { getErrorMessage } from "../utils/errorUtils";

interface BackupDestinationFormProps {
  destination?: BackupDestination | null;
  onClose: () => void;
  onSave: () => void;
}

interface FormValues {
  name: string;
  type: BackupDestinationType;
  // Flat structure: each destination type uses a known subset of these keys.
  // We send the full set; the server's Zod discriminated union validates per-type.
  path: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  tokenJson: string;
  folderId: string;
  accessToken: string;
  dropboxFolder: string;
  host: string;
  port: string;
  username: string;
  password: string;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPassword: string;
  fromAddress: string;
  toAddresses: string;
}

const REMOTE_TYPES: BackupDestinationType[] = [
  "s3",
  "s3_compatible",
  "google_drive",
  "dropbox",
  "sftp",
  "ftp",
  "email",
];

function buildConfig(
  type: BackupDestinationType,
  v: FormValues,
  secretEditing: Record<string, boolean>,
  isEdit: boolean,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  switch (type) {
    case "local":
      config.path = v.path;
      break;
    case "s3":
    case "s3_compatible":
      config.bucket = v.bucket;
      config.region = v.region;
      config.accessKeyId = v.accessKeyId;
      // Omit secretAccessKey in edit mode unless the user has unlocked it.
      if (!isEdit || secretEditing["secretAccessKey"]) {
        config.secretAccessKey = v.secretAccessKey;
      }
      if (type === "s3_compatible") {
        config.endpoint = v.endpoint;
      }
      break;
    case "google_drive":
      config.folderId = v.folderId;
      if (!isEdit || secretEditing["tokenJson"]) {
        config.tokenJson = v.tokenJson;
      }
      break;
    case "dropbox":
      config.folderPath = v.dropboxFolder;
      if (!isEdit || secretEditing["accessToken"]) {
        config.accessToken = v.accessToken;
      }
      break;
    case "sftp":
    case "ftp":
      config.host = v.host;
      config.port = Number(v.port) || 0;
      config.username = v.username;
      if (!isEdit || secretEditing["password"]) {
        config.password = v.password;
      }
      break;
    case "email":
      config.smtpHost = v.smtpHost;
      config.smtpPort = Number(v.smtpPort) || 0;
      config.username = v.smtpUser;
      if (!isEdit || secretEditing["smtpPassword"]) {
        config.password = v.smtpPassword;
      }
      config.fromAddress = v.fromAddress;
      config.toAddress = v.toAddresses;
      break;
  }
  return config;
}

export default function BackupDestinationForm({
  destination,
  onClose,
  onSave,
}: BackupDestinationFormProps) {
  const { t } = useTranslation();
  const createMutation = useCreateBackupDestination();
  const updateMutation = useUpdateBackupDestination();
  const testMutation = useTestBackupDestination();
  const backupEnabled = useFeature("backup_enabled");
  const canWrite = useBackupPermission("backup:destination:write");
  const isEdit = !!destination;

  const firstInputRef = useRef<HTMLInputElement>(null);

  // Initial values from the destination record (if editing).
  const d = destination as Partial<BackupDestination> | null | undefined;
  const cfg = (d?.config as Record<string, unknown> | undefined) || {};
  const defaultValues: FormValues = {
    name: d?.name ?? "",
    type: (d?.type as BackupDestinationType) ?? "local",
    path: String(cfg.path ?? ""),
    bucket: String(cfg.bucket ?? ""),
    region: String(cfg.region ?? ""),
    accessKeyId: String(cfg.accessKeyId ?? ""),
    secretAccessKey: "",
    endpoint: String(cfg.endpoint ?? ""),
    tokenJson: "",
    folderId: String(cfg.folderId ?? ""),
    accessToken: "",
    dropboxFolder: String(cfg.folderPath ?? ""),
    host: String(cfg.host ?? ""),
    port: cfg.port != null ? String(cfg.port) : "",
    username: String(cfg.username ?? ""),
    password: "",
    smtpHost: String(cfg.smtpHost ?? ""),
    smtpPort: cfg.smtpPort != null ? String(cfg.smtpPort) : "",
    smtpUser: String(cfg.username ?? ""),
    smtpPassword: "",
    fromAddress: String(cfg.fromAddress ?? ""),
    toAddresses: String(cfg.toAddress ?? ""),
  };

  const form = useForm<FormValues>({
    defaultValues,
    // WR-05: validate on every change so switching the type from
    // "local" (path is the only required field) to "s3" (needs bucket,
    // region, accessKeyId, secretAccessKey) re-runs the per-field
    // `required` rules immediately and shows form-level errors.
    mode: "onChange",
  });
  const selectedType = form.watch("type");

  // WR-01: focus the Name field on mount / on dialog open so the user
  // can start typing without an extra click.
  useEffect(() => {
    firstInputRef.current?.focus();
  }, [destination?.id]);

  // D-06: Credential section auto-opens once a type is selected (or always
  // open in edit mode). Type section is always open.
  const [credentialsOpen, setCredentialsOpen] = useState<boolean>(isEdit);
  const [secretEditing, setSecretEditing] = useState<Record<string, boolean>>({});
  const [testResult, setTestResult] = useState<BackupTestResult | null>(null);
  const [testRunning, setTestRunning] = useState(false);

  // License gate: if user picks a remote type and lacks backup_enabled,
  // we render the UpgradePrompt in place of credentials (D-20).
  const showUpgradeForRemote =
    REMOTE_TYPES.includes(selectedType) && !backupEnabled;

  const handleSubmit: SubmitHandler<FormValues> = async (data) => {
    if (!canWrite) {
      showError(t("settings.backups.permissionDenied"));
      return;
    }
    // CR-03: short-circuit on Community+remote before building the
    // payload — submitting a half-filled remote config emits a malformed
    // request and a Zod error toast that masks the real license gate.
    if (showUpgradeForRemote) {
      showError(t("settings.backups.destinations.enterpriseRequired"));
      return;
    }
    const config = buildConfig(selectedType, data, secretEditing, isEdit);
    try {
      if (isEdit && destination) {
        await updateMutation.mutateAsync({ id: destination.id, data: { name: data.name, config } });
        showSuccess(t("settings.backups.destinations.updateSuccess"));
      } else {
        await createMutation.mutateAsync({ name: data.name, type: selectedType, config });
        showSuccess(t("settings.backups.destinations.createSuccess"));
      }
      onSave();
    } catch (err: unknown) {
      // CR-03: detect the 402 license-gate response and surface a
      // dedicated i18n string rather than the raw Zod message.
      if (err instanceof ApiError && err.status === 402) {
        showError(t("settings.backups.destinations.enterpriseRequired"));
        return;
      }
      const msg = err instanceof Error ? getErrorMessage(err) : String(err);
      showError(
        msg ||
          (isEdit
            ? t("settings.backups.destinations.updateFailed")
            : t("settings.backups.destinations.createFailed")),
      );
    }
  };

  const handleTest = async () => {
    if (!isEdit || !destination) return;
    setTestRunning(true);
    setTestResult(null);
    try {
      const result = await testMutation.mutateAsync(destination.id);
      setTestResult(result);
      if (result.success) {
        showSuccess(t("settings.backups.destinations.testSuccess"));
      } else {
        showError(
          t("settings.backups.destinations.testFailed", { error: result.error || "" }),
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? getErrorMessage(err) : String(err);
      setTestResult({ success: false, error: msg });
      showError(t("settings.backups.destinations.testFailed", { error: msg }));
    } finally {
      setTestRunning(false);
    }
  };

  const renderSecretField = (fieldName: keyof FormValues, labelKey: string) => {
    const isUnlocked = secretEditing[fieldName];
    return (
      <FormField
        key={fieldName}
        control={form.control}
        name={fieldName}
        render={({ field }) => {
          const { ref: _fieldRef, ...fieldRest } = field as { ref?: unknown };
          if (isEdit && !isUnlocked) {
            return (
              <FormItem>
                <FormLabel>{t(labelKey)}</FormLabel>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    value="••••••••"
                    disabled
                    aria-label={t("settings.backups.destinations.secretMasked")}
                  />
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() =>
                      setSecretEditing((prev) => ({ ...prev, [fieldName]: true }))
                    }
                  >
                    {t("settings.backups.destinations.changeSecret")}
                  </Button>
                </div>
              </FormItem>
            );
          }
          return (
            <FormItem>
              <FormLabel>{t(labelKey)}</FormLabel>
              <div className="flex items-center gap-2">
                <FormControl>
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder={isEdit ? t("settings.backups.destinations.secretNewPlaceholder") : ""}
                    {...fieldRest}
                    ref={_fieldRef as React.Ref<HTMLInputElement>}
                  />
                </FormControl>
                {isEdit && isUnlocked && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setSecretEditing((prev) => ({ ...prev, [fieldName]: false }))
                    }
                  >
                    {t("settings.backups.destinations.cancelSecret")}
                  </Button>
                )}
              </div>
              <FormMessage />
            </FormItem>
          );
        }}
      />
    );
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        {/* Name */}
        <FormField
          control={form.control}
          name="name"
          rules={{ required: true, minLength: 1, maxLength: 200 }}
          render={({ field }) => {
            const { ref: _fieldRef, ...fieldRest } = field;
            return (
              <FormItem>
                <FormLabel>{t("settings.backups.destinations.nameLabel")}</FormLabel>
                <FormControl>
                  <Input
                    ref={firstInputRef}
                    placeholder={t("settings.backups.destinations.namePlaceholder")}
                    {...fieldRest}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            );
          }}
        />

        {/* Type (always open) */}
        <FormField
          control={form.control}
          name="type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("settings.backups.destinations.typeLabel")}</FormLabel>
              <FormControl>
                <Select
                  value={field.value}
                  onValueChange={(v) => {
                    field.onChange(v as BackupDestinationType);
                    if (v !== "local" && backupEnabled) setCredentialsOpen(true);
                  }}
                  disabled={isEdit /* type is immutable in update */}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">{t("settings.backups.destinations.type_local")}</SelectItem>
                    <SelectItem value="s3">{t("settings.backups.destinations.type_s3")}</SelectItem>
                    <SelectItem value="s3_compatible">{t("settings.backups.destinations.type_s3_compatible")}</SelectItem>
                    <SelectItem value="google_drive">{t("settings.backups.destinations.type_google_drive")}</SelectItem>
                    <SelectItem value="dropbox">{t("settings.backups.destinations.type_dropbox")}</SelectItem>
                    <SelectItem value="sftp">{t("settings.backups.destinations.type_sftp")}</SelectItem>
                    <SelectItem value="ftp">{t("settings.backups.destinations.type_ftp")}</SelectItem>
                    <SelectItem value="email">{t("settings.backups.destinations.type_email")}</SelectItem>
                  </SelectContent>
                </Select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Credentials (collapsible, auto-opens once type is chosen) */}
        <Collapsible open={credentialsOpen} onOpenChange={setCredentialsOpen}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-between"
              disabled={!selectedType}
            >
              <span className="font-medium">
                {t("settings.backups.destinations.sectionCredentials")}
              </span>
              <span className="text-xs text-muted-foreground">
                {credentialsOpen ? "−" : "+"}
              </span>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-2">
            {showUpgradeForRemote ? (
              <UpgradePrompt feature="backup_enabled" />
            ) : (
              <>
                {selectedType === "local" && (
                  <FormField
                    control={form.control}
                    name="path"
                    rules={{ required: true }}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("settings.backups.destinations.fields.path")}</FormLabel>
                        <FormControl>
                          <Input placeholder="/var/backups" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {(selectedType === "s3" || selectedType === "s3_compatible") && (
                  <>
                    <FormField
                      control={form.control}
                      name="bucket"
                      rules={{ required: true }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.backups.destinations.fields.bucket")}</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="region"
                      rules={{ required: true }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.backups.destinations.fields.region")}</FormLabel>
                          <FormControl>
                            <Input placeholder="us-east-1" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="accessKeyId"
                      rules={{ required: true }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.backups.destinations.fields.accessKeyId")}</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {renderSecretField("secretAccessKey", "settings.backups.destinations.fields.secretAccessKey")}
                    {selectedType === "s3_compatible" && (
                      <FormField
                        control={form.control}
                        name="endpoint"
                        rules={{ required: true }}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t("settings.backups.destinations.fields.endpoint")}</FormLabel>
                            <FormControl>
                              <Input placeholder="https://s3.example.com" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                  </>
                )}

                {selectedType === "google_drive" && (
                  <>
                    <FormField
                      control={form.control}
                      name="folderId"
                      rules={{ required: true }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.backups.destinations.fields.folderId")}</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {renderSecretField("tokenJson", "settings.backups.destinations.fields.tokenJson")}
                  </>
                )}

                {selectedType === "dropbox" && (
                  <>
                    <FormField
                      control={form.control}
                      name="dropboxFolder"
                      rules={{ required: true }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.backups.destinations.fields.dropboxFolder")}</FormLabel>
                          <FormControl>
                            <Input placeholder="/backups" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {renderSecretField("accessToken", "settings.backups.destinations.fields.accessToken")}
                  </>
                )}

                {(selectedType === "sftp" || selectedType === "ftp") && (
                  <>
                    <FormField
                      control={form.control}
                      name="host"
                      rules={{ required: true }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.backups.destinations.fields.host")}</FormLabel>
                          <FormControl>
                            <Input placeholder="backup.example.com" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="port"
                      rules={{ required: true }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.backups.destinations.fields.port")}</FormLabel>
                          <FormControl>
                            <Input type="number" placeholder={selectedType === "sftp" ? "22" : "21"} {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="username"
                      rules={{ required: true }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.backups.destinations.fields.username")}</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {renderSecretField("password", "settings.backups.destinations.fields.password")}
                  </>
                )}

                {selectedType === "email" && (
                  <>
                    <FormField
                      control={form.control}
                      name="smtpHost"
                      rules={{ required: true }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.backups.destinations.fields.smtpHost")}</FormLabel>
                          <FormControl>
                            <Input placeholder="smtp.example.com" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="smtpPort"
                      rules={{ required: true }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.backups.destinations.fields.smtpPort")}</FormLabel>
                          <FormControl>
                            <Input type="number" placeholder="587" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="smtpUser"
                      rules={{ required: true }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.backups.destinations.fields.smtpUser")}</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {renderSecretField("smtpPassword", "settings.backups.destinations.fields.smtpPassword")}
                    <FormField
                      control={form.control}
                      name="fromAddress"
                      rules={{ required: true }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.backups.destinations.fields.fromAddress")}</FormLabel>
                          <FormControl>
                            <Input type="email" placeholder="backup@example.com" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="toAddresses"
                      rules={{ required: true }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("settings.backups.destinations.fields.toAddresses")}</FormLabel>
                          <FormControl>
                            <Input placeholder="ops@example.com, sec@example.com" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}

                {/* Inline test button (D-07) */}
                {isEdit && (
                  <div className="pt-2 border-t border-border space-y-2">
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={handleTest}
                        disabled={testRunning}
                      >
                        {testRunning
                          ? t("settings.backups.destinations.testing")
                          : t("settings.backups.destinations.testConnection")}
                      </Button>
                      {testResult && (
                        <Badge variant={testResult.success ? "default" : "destructive"}>
                          {testResult.success
                            ? t("settings.backups.destinations.testSuccess")
                            : t("settings.backups.destinations.testFailed", {
                                error: testResult.error || "",
                              })}
                        </Badge>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </CollapsibleContent>
        </Collapsible>

        {/* Footer */}
        <div className="pt-4 border-t border-border flex gap-2 justify-end">
          <Button variant="ghost" size="sm" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={
              !canWrite ||
              createMutation.isPending ||
              updateMutation.isPending ||
              showUpgradeForRemote
            }
          >
            {createMutation.isPending || updateMutation.isPending
              ? t("common.saving")
              : t("common.save")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
