// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Form for create + edit of a BackupJob.
 *
 * Mirrors `McpConnectionForm` structure: react-hook-form useForm + shadcn
 * Form primitives, payload assembly on submit, footer with Cancel/Salva.
 *
 * Fields:
 *  - name (Input)
 *  - destinationId (Select from props.destinations)
 *  - frequency (Select: daily | weekly | monthly | manual)
 *  - schedule (Input, cron expression, e.g. "0 2 * * *")
 *  - retentionDays (Input, number, optional)
 *  - enabled (Switch)
 */

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { showSuccess, showError } from "../lib/toast";

import {
  useCreateBackupJob,
  useUpdateBackupJob,
  type BackupJob,
  type BackupJobCreateInput,
  type BackupJobUpdateInput,
  type BackupJobFrequency,
} from "../queries/useBackupJobs";
import type { BackupDestination } from "../queries/useBackupDestinations";
import { getErrorMessage } from "../utils/errorUtils";

interface BackupJobFormProps {
  job?: BackupJob | null;
  destinations: BackupDestination[];
  onClose: () => void;
  onSave: () => void;
}

interface BackupJobFormValues {
  name: string;
  destinationId: string;
  frequency: BackupJobFrequency;
  schedule: string;
  retentionDays: string;
  enabled: boolean;
}

export default function BackupJobForm({
  job,
  destinations,
  onClose,
  onSave,
}: BackupJobFormProps) {
  const { t } = useTranslation();
  const createMutation = useCreateBackupJob();
  const updateMutation = useUpdateBackupJob();
  const isEdit = !!job;
  const firstInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<BackupJobFormValues>({
    defaultValues: {
      name: job?.name || "",
      destinationId: job?.destinationId || destinations[0]?.id || "",
      frequency: job?.frequency || "daily",
      schedule: job?.schedule || "",
      retentionDays:
        job?.retentionDays !== null && job?.retentionDays !== undefined
          ? String(job.retentionDays)
          : "",
      enabled: job?.enabled ?? true,
    },
    mode: "onChange",
  });
  const watchedFrequency = form.watch("frequency");

  const handleSubmit = form.handleSubmit(async (data) => {
    if (!data.name.trim()) {
      showError(t("settings.backups.jobs.nameRequired"));
      return;
    }
    if (!data.destinationId) {
      showError(t("settings.backups.jobs.destinationRequired"));
      return;
    }

    const payload: BackupJobCreateInput = {
      name: data.name.trim(),
      destinationId: data.destinationId,
      frequency: data.frequency,
      schedule: data.schedule.trim() || undefined,
      retentionDays: data.retentionDays
        ? Number(data.retentionDays)
        : undefined,
      enabled: data.enabled,
    };

    try {
      if (isEdit && job) {
        const updatePayload: BackupJobUpdateInput = payload;
        await updateMutation.mutateAsync({ id: job.id, data: updatePayload });
        showSuccess(t("settings.backups.jobs.updateSuccess"));
      } else {
        await createMutation.mutateAsync(payload);
        showSuccess(t("settings.backups.jobs.createSuccess"));
      }
      onSave();
    } catch (err: unknown) {
      showError(
        getErrorMessage(err,
          isEdit
            ? t("settings.backups.jobs.updateFailed")
            : t("settings.backups.jobs.createFailed")
        )
      );
    }
  });

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name */}
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => {
            const { ref: _fieldRef, ...fieldRest } = field;
            return (
              <FormItem>
                <FormLabel>{t("settings.backups.jobs.fields.name")}</FormLabel>
                <FormControl>
                  <Input
                    ref={firstInputRef}
                    type="text"
                    placeholder={t("settings.backups.jobs.fields.namePlaceholder")}
                    {...fieldRest}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            );
          }}
        />

        {/* Destination */}
        <FormField
          control={form.control}
          name="destinationId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("settings.backups.jobs.fields.destination")}
              </FormLabel>
              <FormControl>
                <Select
                  value={field.value}
                  onValueChange={(value) => field.onChange(value)}
                  disabled={isEdit}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={t(
                        "settings.backups.jobs.fields.destinationPlaceholder"
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {destinations.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Frequency */}
        <FormField
          control={form.control}
          name="frequency"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("settings.backups.jobs.fields.frequency")}
              </FormLabel>
              <FormControl>
                <Select
                  value={field.value}
                  onValueChange={(value) => field.onChange(value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">
                      {t("settings.backups.jobs.frequency_daily")}
                    </SelectItem>
                    <SelectItem value="weekly">
                      {t("settings.backups.jobs.frequency_weekly")}
                    </SelectItem>
                    <SelectItem value="monthly">
                      {t("settings.backups.jobs.frequency_monthly")}
                    </SelectItem>
                    <SelectItem value="manual">
                      {t("settings.backups.jobs.frequency_manual")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Schedule (cron) */}
        <FormField
          control={form.control}
          name="schedule"
          rules={{
            // WR-02: non-manual frequencies require a cron schedule.
            // Manual runs are ad-hoc; scheduled jobs (daily/weekly/monthly)
            // must have a cron string the Bree scheduler can parse.
            validate: (value: string) => {
              if (watchedFrequency === "manual") return true;
              return value && value.trim().length > 0
                ? true
                : t("settings.backups.jobs.scheduleRequired") || "Schedule is required";
            },
          }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("settings.backups.jobs.fields.schedule")}
              </FormLabel>
              <FormControl>
                <Input
                  type="text"
                  placeholder={t(
                    "settings.backups.jobs.fields.scheduleHint"
                  )}
                  {...field}
                />
              </FormControl>
              {watchedFrequency !== "manual" && (
                <p className="text-xs text-muted-foreground italic">
                  {t("settings.backups.jobs.fields.scheduleHint")}
                </p>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Retention days */}
        <FormField
          control={form.control}
          name="retentionDays"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {t("settings.backups.jobs.fields.retentionDays")}
              </FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  placeholder="30"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Enabled */}
        <FormField
          control={form.control}
          name="enabled"
          render={({ field }) => (
            <FormItem className="flex items-center gap-2">
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  aria-label={t("settings.backups.jobs.fields.enabled")}
                />
              </FormControl>
              <FormLabel className="!mt-0">
                {t("settings.backups.jobs.fields.enabled")}
              </FormLabel>
            </FormItem>
          )}
        />

        {/* Footer */}
        <div className="pt-4 border-t border-border flex gap-2 justify-end">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={onClose}
            disabled={saving}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving
              ? t("common.saving")
              : t("settings.backups.jobs.saveButton")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
