// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { createMcpCatalogEntrySchema } from "@simmetric-chat/shared";
import type { CreateMcpCatalogEntryInput } from "@simmetric-chat/shared";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  FormDescription,
  FormMessage,
} from "@/components/ui/form";
import { useCreateCatalogEntry, type CreateCatalogEntryInput } from "../queries/useMarketplace";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";

// CREATE-ONLY per UI-SPEC §5: no PUT route exists — the edit arm ships when
// the server exposes PUT /:entryId; do not invent the route.

interface CatalogEntryFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Form values derive from the SHARED schema's input type — never re-declared
// (root AGENTS.md schema-location rule; frontend aliases shared source). Only
// genuine form-shape deltas stay local: the field defaults below, the
// "none" UI sentinels (deselectable selects — not schema values), and the
// UI-only options lists. The schema's refines (oauth⇔provider) ride the
// imported schema through zodResolver.
type CatalogEntryFormInput = z.input<typeof createMcpCatalogEntrySchema>;

// Deselect sentinels — the shadcn Select cannot express an unset value, so
// the "none" DOM value maps to undefined at the field boundary. Not schema
// values: they never reach the payload.
const TIER_NONE = "none";

const VERIFICATION_TIER_OPTIONS = ["official", "verified_community", "unverified"] as const;

// G-197-2: the tier Select composes its t() key from the snake_case tier
// value, but the translation keys are camelCase (verificationTierOfficial /
// verificationTierVerifiedCommunity / verificationTierUnverified ×8).
// Splitting on "_" and capitalizing each part maps verified_community →
// VerifiedCommunity and identity-maps the single-word tiers, so no explicit
// per-tier lookup is needed.
function tierKeySuffix(tier: string): string {
  return tier
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
const TRANSPORT_OPTIONS = ["sse", "streamable-http"] as const;
// OAuth providers (registry keys — mirrors McpConnectionForm's option list;
// the server schema/registry remain authoritative).
const OAUTH_PROVIDER_OPTIONS = ["google", "microsoft"] as const;

export default function CatalogEntryFormDialog({
  open,
  onOpenChange,
}: CatalogEntryFormDialogProps) {
  const { t } = useTranslation();
  const createMutation = useCreateCatalogEntry();
  const [saving, setSaving] = useState(false);

  const form = useForm<CatalogEntryFormInput, unknown, CreateMcpCatalogEntryInput>({
    resolver: zodResolver(createMcpCatalogEntrySchema),
    defaultValues: {
      name: "",
      url: "",
      transportType: "sse",
      description: "",
      category: "",
      version: "",
      author: "",
      // Phase 197 (D-04): authType defaults to "none" — the provider field
      // reveals only for oauth (D-01 spurious-field pattern).
      authType: "none",
      oauthProvider: undefined,
      verificationTier: undefined,
    },
  });

  const isOauth = form.watch("authType") === "oauth";

  // Reset the form each time the dialog opens (MarketplaceInstallDialog idiom)
  useEffect(() => {
    if (open) {
      form.reset({
        name: "",
        url: "",
        transportType: "sse",
        description: "",
        category: "",
        version: "",
        author: "",
        authType: "none",
        oauthProvider: undefined,
        verificationTier: undefined,
      });
      setSaving(false);
    }
  }, [open, form]);

  const onSubmit = form.handleSubmit(async (data) => {
    // Build the payload: optional text fields are omitted when empty; the
    // oauth fields are included ONLY when authType=oauth — a stale provider
    // value is never submitted with authType none (the shared spurious-field
    // refine would reject it; the flip handler also clears it).
    const payload: CreateCatalogEntryInput = {
      name: data.name.trim(),
      url: data.url.trim(),
      transportType: data.transportType ?? "sse",
      ...(data.description?.trim() ? { description: data.description.trim() } : {}),
      ...(data.category?.trim() ? { category: data.category.trim() } : {}),
      ...(data.version?.trim() ? { version: data.version.trim() } : {}),
      ...(data.author?.trim() ? { author: data.author.trim() } : {}),
      ...(data.verificationTier ? { verificationTier: data.verificationTier } : {}),
      ...(data.authType === "oauth" && data.oauthProvider
        ? { authType: "oauth" as const, oauthProvider: data.oauthProvider }
        : {}),
    };

    setSaving(true);
    try {
      await createMutation.mutateAsync(payload);
      showSuccess(t("marketplace.toast.created", { name: payload.name }));
      onOpenChange(false);
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("marketplace.toast.createFailed", { name: data.name.trim() || "" })));
    } finally {
      setSaving(false);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("marketplace.form.addTitle")}</DialogTitle>
          <DialogDescription>
            {t("marketplace.detail.install")}: {t("marketplace.description")}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            {/* Name */}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("marketplace.form.formNameLabel")}</FormLabel>
                  <FormControl>
                    <Input type="text" data-testid="catalog-name-input" {...field} />
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />

            {/* URL */}
            <FormField
              control={form.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("marketplace.form.formUrlLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      data-testid="catalog-url-input"
                      placeholder="https://example.com/mcp/sse"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />

            {/* Transport Type */}
            <FormField
              control={form.control}
              name="transportType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("marketplace.form.formTransportLabel")}</FormLabel>
                  <FormControl>
                    <Select
                      value={field.value ?? "sse"}
                      onValueChange={(value) => field.onChange(value)}
                    >
                      <SelectTrigger className="w-full" data-testid="catalog-transport-trigger">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TRANSPORT_OPTIONS.map((tr) => (
                          <SelectItem key={tr} value={tr}>
                            {tr}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />

            {/* Description */}
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("marketplace.form.formDescriptionLabel")}</FormLabel>
                  <FormControl>
                    <Textarea data-testid="catalog-description-input" {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />

            {/* Category */}
            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("marketplace.form.formCategoryLabel")}</FormLabel>
                  <FormControl>
                    <Input type="text" data-testid="catalog-category-input" {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />

            {/* Version + Author */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="version"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("marketplace.form.formVersionLabel")}</FormLabel>
                    <FormControl>
                      <Input type="text" data-testid="catalog-version-input" {...field} value={field.value ?? ""} />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="author"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("marketplace.form.formAuthorLabel")}</FormLabel>
                    <FormControl>
                      <Input type="text" data-testid="catalog-author-input" {...field} value={field.value ?? ""} />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
            </div>

            {/* Verification tier — deselectable via the "none" sentinel */}
            <FormField
              control={form.control}
              name="verificationTier"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("marketplace.form.formVerificationTierLabel")}</FormLabel>
                  <FormControl>
                    <Select
                      value={field.value ?? TIER_NONE}
                      onValueChange={(value) =>
                        field.onChange(value === TIER_NONE ? undefined : value)
                      }
                    >
                      <SelectTrigger className="w-full" data-testid="catalog-tier-trigger">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={TIER_NONE}>
                          {t("marketplace.form.verificationTierUnverified")}
                        </SelectItem>
                        {VERIFICATION_TIER_OPTIONS.map((tier) => (
                          <SelectItem key={tier} value={tier}>
                            {t(`marketplace.form.verificationTier${tierKeySuffix(tier)}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />

            {/* Authentication (Phase 197 D-04) — the flip mirrors the
                McpConnectionForm D-01 spurious-field pattern: selecting OAuth
                reveals the provider Select; selecting None hides AND clears
                it (a stale provider value is never submitted). */}
            <FormField
              control={form.control}
              name="authType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("marketplace.form.authTypeLabel")}</FormLabel>
                  <FormControl>
                    <Select
                      value={field.value ?? "none"}
                      onValueChange={(value) => {
                        field.onChange(value);
                        // Spurious-field reset on flip away from oauth (the
                        // shared refine rejects oauth fields on non-oauth).
                        if (value !== "oauth") {
                          form.setValue("oauthProvider", undefined);
                          form.clearErrors("oauthProvider");
                        }
                      }}
                    >
                      <SelectTrigger className="w-full" data-testid="catalog-authtype-trigger">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t("marketplace.form.authTypeNone")}</SelectItem>
                        <SelectItem value="oauth">{t("marketplace.form.authTypeOauth")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />

            {/* Phase 197 (D-04): the oauth⇔provider refines ride the shared
                createMcpCatalogEntrySchema through zodResolver — NO client
                re-declaration. zodResolver maps object-level refine errors to
                the "" formState key (verified against
                @hookform/resolvers 5.9.1 + zod 4: probe run — errors[""]),
                with formState.errors.root as the standard RHF location for
                resolver-level errors; both are surfaced here (12px
                text-destructive, same placement as the field messages). */}
            {typeof form.formState.errors.root?.message === "string" && (
              <p className="text-xs text-destructive" role="alert">
                {form.formState.errors.root.message}
              </p>
            )}
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {typeof (form.formState.errors as Record<string, { message?: string } | undefined>)[""]?.message === "string" && (
              <p className="text-xs text-destructive" role="alert">
                {(form.formState.errors as Record<string, { message?: string } | undefined>)[""]!.message}
              </p>
            )}

            {/* OAuth provider — revealed ONLY when authType=oauth */}
            {isOauth && (
              <FormField
                control={form.control}
                name="oauthProvider"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("marketplace.form.oauthProviderLabel")}</FormLabel>
                    <FormControl>
                      <Select
                        value={field.value || undefined}
                        onValueChange={(value) => field.onChange(value)}
                      >
                        <SelectTrigger className="w-full" data-testid="catalog-provider-trigger">
                          <SelectValue placeholder={t("marketplace.form.oauthProviderLabel")} />
                        </SelectTrigger>
                        <SelectContent>
                          {OAUTH_PROVIDER_OPTIONS.map((p) => (
                            <SelectItem key={p} value={p}>
                              {t(`marketplace.form.oauthProvider${p === "google" ? "Google" : "Microsoft"}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormDescription className="text-xs">
                      {t("marketplace.form.oauthProviderHint")}
                    </FormDescription>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
            )}

            {/* Footer */}
            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                data-testid="catalog-cancel"
                onClick={() => onOpenChange(false)}
                disabled={saving}
              >
                {t("marketplace.form.formCancel")}
              </Button>
              <Button type="submit" size="sm" data-testid="catalog-submit" disabled={saving}>
                {saving ? t("marketplace.form.creating") : t("marketplace.form.formSave")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}