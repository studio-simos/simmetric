// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 189 (WSIS-01, D-01/D-03) — the personal-workspace onboarding wizard.
 *
 * Renders TWO empty states (D-03 — the hasOnboarded scalar distinguishes
 * them; it arrives via /auth/me):
 *   1. !hasOnboarded && workspacesCount === 0 → guided wizard: welcome copy,
 *      workspace-name input (1-100 chars per the shared schema), Create →
 *      useCreatePersonalWorkspace. On success the hook's invalidations
 *      re-render App past the empty-state gate (the wizard never re-shows —
 *      Pitfall 4, both halves: server invalidateAuthCache + client
 *      auth.me/workspaces refetch). A 409 surfaces the duplicate-name copy.
 *   2. hasOnboarded && workspacesCount === 0 → "no access — ask admin"
 *      message (NO create affordance — the server is the boundary: a user
 *      who already onboarded but lost all workspaces cannot self-provision
 *      a second personal project; the endpoint's idempotent fast-path would
 *      still return the OLD one, and there is none — ask an admin).
 *
 * The wizard is UX-only: the server guards (400 safeParse / 409 name
 * collision / idempotency) are the real boundary.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCreatePersonalWorkspace } from "../queries/usePersonalWorkspace";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";

interface OnboardingWizardProps {
  hasOnboarded: boolean;
  workspacesCount: number;
}

export default function OnboardingWizard({ hasOnboarded, workspacesCount }: OnboardingWizardProps) {
  const { t } = useTranslation();
  const [workspaceName, setWorkspaceName] = useState("");
  const createMut = useCreatePersonalWorkspace();

  const showWizard = !hasOnboarded && workspacesCount === 0;

  if (!showWizard) {
    // State 2 (D-03): onboarded but zero workspaces — ask an admin. Rendered
    // whenever the App gate detects an empty workspace list with
    // hasOnboarded true (or with the scalar not yet loaded).
    return (
      <div className="min-h-screen flex items-center justify-center bg-background" data-testid="onboarding-ask-admin">
        <div className="max-w-md text-center space-y-3 p-6">
          <h1 className="text-xl font-semibold text-foreground">{t("onboarding.noAccessMessage")}</h1>
          <p className="text-sm text-muted-foreground">{t("onboarding.askAdmin")}</p>
        </div>
      </div>
    );
  }

  const handleCreate = async () => {
    const name = workspaceName.trim();
    if (name.length === 0 || name.length > 100) return;
    try {
      await createMut.mutateAsync({ workspaceName: name });
      showSuccess(t("onboarding.createSuccess"));
    } catch (err: unknown) {
      const message = getErrorMessage(err, t("onboarding.createError"));
      // 409 (duplicate/tombstone name collision) surfaces the dedicated copy.
      if (message.includes("already exists")) {
        showError(t("onboarding.duplicateName"));
      } else {
        showError(message);
      }
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background" data-testid="onboarding-wizard">
      <div className="max-w-md w-full space-y-5 p-6">
        <div className="text-center space-y-2">
          <h1 className="text-xl font-semibold text-foreground">{t("onboarding.welcome")}</h1>
          <p className="text-sm text-muted-foreground">{t("onboarding.welcomeBody")}</p>
        </div>
        <div className="space-y-2">
          <label htmlFor="onboarding-workspace-name" className="block text-sm font-medium text-muted-foreground">
            {t("onboarding.workspaceNameLabel")}
          </label>
          <Input
            id="onboarding-workspace-name"
            type="text"
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            placeholder={t("onboarding.workspaceNamePlaceholder")}
            maxLength={100}
            disabled={createMut.isPending}
            aria-label={t("onboarding.workspaceNameLabel")}
          />
        </div>
        <Button
          className="w-full"
          onClick={handleCreate}
          disabled={createMut.isPending || workspaceName.trim().length === 0 || workspaceName.trim().length > 100}
          aria-label={t("onboarding.create")}
        >
          {createMut.isPending ? t("onboarding.creating") : t("onboarding.create")}
        </Button>
      </div>
    </div>
  );
}