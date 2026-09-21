// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 190 (SKIL-01/03/05, D-19/D-20) — the dedicated /skills management
 * page. Built-in section renders the 7 registry entries read-only with a
 * secondary badge; Custom section renders own + visible global rows with
 * scope/mode badges and edit/delete actions gated owner-or-admin (client
 * gate is UX-only — the server re-gates every mutation, D-07/UI-SPEC).
 *
 * SKIL-05 limit surfacing (Pitfall 3): a null max_skills (enterprise
 * Infinity serialized) renders the unlimited copy — NEVER a numeric counter
 * from null; a 402 from create renders the limit-reached note and disables
 * Create.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePageMeta } from "@/hooks/usePageMeta";
import { Plus, Pencil, Trash2, Wrench } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Separator } from "./ui/separator";
import { Skeleton } from "./ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { useSkills, useTestSkill, useCreateSkill, useUpdateSkill, useDeleteSkill, type CustomSkillRow } from "../queries/useSkills";
import { useFeatureLimit } from "../hooks/useFeature";
import { useLicenseInfo } from "../queries/useLicense";
import { useMe } from "../queries/useAuth";
import { useWorkspaces } from "../queries/useWorkspaces";
import { showSuccess, showError } from "../lib/toast";
import { ApiError } from "../utils/api";
import SkillFormDialog from "./SkillFormDialog";

interface SkillsPageProps {
  /** Test seam — the auth user id (defaults to the useMe query). */
  currentUserId?: string;
  /** Test seam — admin flag (defaults to the useMe permissions gate). */
  isAdmin?: boolean;
}

const SCOPE_LABEL_KEYS: Record<string, string> = {
  personal: "skills.form.scopePersonal",
  workspace: "skills.form.scopeWorkspace",
  global: "skills.form.scopeGlobal",
};

export default function SkillsPage(props: SkillsPageProps) {
  const { t } = useTranslation();
  usePageMeta(t("skills.page.heading"));

  const { data, isLoading } = useSkills();
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();
  const testSkill = useTestSkill();
  // The scope picker rides the existing workspaces query (no new fetch) —
  // server re-gates write access on save (D-07).
  const { data: workspacesData } = useWorkspaces(!!localStorage.getItem("token"));

  // SKIL-05 — the limit indicator. Pitfall 3: enterprise Infinity serializes
  // null on the wire; useFeatureLimit returns 0 for non-numbers, so the
  // null/unlimited arm reads the RAW license feature value instead.
  const { data: license } = useLicenseInfo();
  const rawLimit = license?.features?.max_skills;
  const numericLimit = useFeatureLimit("max_skills");
  const meData = useMe(meLoadedGuard());
  const currentUserId = props.currentUserId ?? meData.data?.id ?? "";
  const isAdmin =
    props.isAdmin ??
    (meData.data?.permissions?.includes("admin:settings") ?? false);

  // 402 from create → inline note under the header + Create disabled.
  const [limitReached, setLimitReached] = useState<{ limit: number | null } | null>(null);

  // Dialog state — create or edit.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<CustomSkillRow | null>(null);

  // Delete confirmation.
  const [deletingSkill, setDeletingSkill] = useState<CustomSkillRow | null>(null);

  const builtin = data?.builtin ?? [];
  const custom = data?.custom ?? [];

  const canManage = useMemo(
    () => (skill: CustomSkillRow) =>
      isAdmin || (currentUserId !== "" && skill.createdBy === currentUserId),
    [isAdmin, currentUserId]
  );

  const handleOpenCreate = () => {
    setEditingSkill(null);
    setDialogOpen(true);
  };

  const handleOpenEdit = (skill: CustomSkillRow) => {
    setEditingSkill(skill);
    setDialogOpen(true);
  };

  const handleSave = async (payload: Record<string, unknown>, id?: string) => {
    try {
      if (id) {
        await updateSkill.mutateAsync({ id, data: payload });
        showSuccess(t("skills.success.updated"));
      } else {
        await createSkill.mutateAsync(payload);
        showSuccess(t("skills.success.created"));
      }
      setDialogOpen(false);
      setEditingSkill(null);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        // 409 — duplicate slug surfaces inline in the dialog; rethrow so the
        // dialog can render skills.form.slugDuplicate under the field.
        throw err;
      }
      if (err instanceof ApiError && err.status === 402) {
        const details = (err.details ?? {}) as { limit?: number };
        setLimitReached({ limit: typeof details.limit === "number" ? details.limit : null });
        showError(t("skills.error.limit402"));
        setDialogOpen(false);
        setEditingSkill(null);
        return;
      }
      showError(t("skills.error.save"));
      throw err;
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingSkill) return;
    const slug = deletingSkill.slug;
    setDeletingSkill(null);
    try {
      await deleteSkill.mutateAsync(deletingSkill.id);
      showSuccess(t("skills.success.deleted"));
    } catch {
      showError(t("skills.error.delete"));
      void slug;
    }
  };

  const renderLimit = () => {
    // Pitfall 3 — the null arm (enterprise Infinity serialized as null)
    // renders the unlimited copy and NEVER a numeric counter.
    if (rawLimit === null || rawLimit === undefined || typeof rawLimit !== "number") {
      return <span className="text-xs text-muted-foreground">{t("skills.page.limitUnlimited")}</span>;
    }
    return (
      <span className="text-xs text-muted-foreground">
        {t("skills.page.limit", { used: custom.length, limit: numericLimit })}
      </span>
    );
  };

  return (
    <div className="h-full overflow-y-auto p-6" data-testid="skills-page">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[28px] font-semibold leading-[1.2] text-foreground">
            {t("skills.page.heading")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("skills.page.subtitle")}</p>
          <div className="mt-2">{renderLimit()}</div>
          {limitReached && (
            <p className="text-xs text-destructive mt-1" data-testid="skills-limit-reached">
              {limitReached.limit !== null
                ? t("skills.page.limitReached", { limit: limitReached.limit })
                : t("skills.page.limitReached", { limit: "" })}
            </p>
          )}
        </div>
        <Button
          onClick={handleOpenCreate}
          disabled={limitReached !== null}
          data-testid="skills-create-cta"
        >
          <Plus className="mr-2 h-4 w-4" />
          {t("skills.page.create")}
        </Button>
      </div>

      {/* Built-in section — read-only catalog, always rendered */}
      <section aria-label={t("skills.builtinSection")}>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold text-foreground">{t("skills.builtinSection")}</h2>
        </div>
        <div className="space-y-2">
          {builtin.map((skill) => (
            <div
              key={skill.name}
              className="bg-card p-4 rounded-lg flex items-start justify-between gap-4"
              data-testid={`skills-builtin-${skill.name}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-foreground">{skill.displayName}</span>
                  <Badge variant="secondary" className="text-xs">
                    {t("skills.builtinBadge")}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-1 truncate" title={skill.description}>
                  {skill.description}
                </p>
              </div>
              {/* Read-only: built-in rows carry no edit/delete buttons (server 400s regardless — D-16/D-21). */}
            </div>
          ))}
        </div>
      </section>

      <Separator className="my-8" />

      {/* Custom section */}
      <section aria-label={t("skills.customSection")}>
        {isLoading ? (
          <div className="space-y-2" data-testid="skills-loading">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : builtin.length === 0 && isLoading ? null : custom.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center" data-testid="skills-empty">
            <Wrench className="h-12 w-12 text-muted-foreground/50 mb-4" strokeWidth={1.5} />
            <h2 className="text-[28px] font-semibold text-foreground mb-2">
              {t("skills.empty.heading")}
            </h2>
            <p className="text-base text-muted-foreground mb-6">{t("skills.empty.body")}</p>
            <Button onClick={handleOpenCreate} disabled={limitReached !== null} data-testid="skills-empty-create-cta">
              <Plus className="mr-2 h-4 w-4" />
              {t("skills.page.create")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {custom.map((skill) => (
              <div
                key={skill.id}
                className="bg-card p-4 rounded-lg flex items-start justify-between gap-4"
                data-testid={`skills-custom-${skill.slug}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground">{skill.name}</span>
                    <span className="text-sm font-mono text-muted-foreground">/{skill.slug}</span>
                    <Badge variant="outline" className="text-xs">
                      {t(SCOPE_LABEL_KEYS[skill.scope] ?? "skills.form.scopePersonal")}
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      {t("skills.form.modePrompt")}
                    </Badge>
                  </div>
                  <p
                    className="text-sm text-muted-foreground mt-1 truncate"
                    title={skill.description}
                  >
                    {skill.description}
                  </p>
                </div>
                {canManage(skill) && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${t("common.edit")} /${skill.slug}`}
                          onClick={() => handleOpenEdit(skill)}
                          data-testid={`skills-edit-${skill.slug}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">{t("common.edit")}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${t("common.delete")} /${skill.slug}`}
                          onClick={() => setDeletingSkill(skill)}
                          data-testid={`skills-delete-${skill.slug}`}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">{t("common.delete")}</TooltipContent>
                    </Tooltip>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <SkillFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditingSkill(null);
        }}
        skill={editingSkill}
        onSave={handleSave}
        onTest={async (id, params) => {
          const result = await testSkill.mutateAsync({ id, params });
          return result;
        }}
        isAdmin={isAdmin}
        workspaces={(workspacesData ?? []).map((w) => ({ id: w.id, name: w.name }))}
      />

      {/* Delete confirmation — MarketplaceCard AlertDialog precedent */}
      <AlertDialog open={deletingSkill !== null} onOpenChange={(open) => { if (!open) setDeletingSkill(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("skills.delete.title", { slug: deletingSkill?.slug ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("skills.delete.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={handleConfirmDelete}
              data-testid="skills-delete-confirm"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** useMe is enabled only when a token exists — keep the page usable in tests without auth. */
function meLoadedGuard(): boolean {
  return typeof localStorage !== "undefined" && !!localStorage.getItem("token");
}