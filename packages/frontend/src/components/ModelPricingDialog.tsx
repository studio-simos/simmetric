// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 203 (MCC-01, D3) — per-1M-token pricing dialog.
 *
 * Input: per-1M-token (the tiny per-token value is unusable as a direct
 * input). Save converts client-side: perToken = perMillion / 1_000_000.
 * Helper text shows BOTH equivalents. Reset nullifies (N/A).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  useModelPricing,
  useUpdateModelPricing,
  useResetModelPricing,
} from "../queries/useCost";
import { showSuccess, showError } from "../lib/toast";

const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CNY", "INR"] as const;

export default function ModelPricingDialog(props: {
  providerId: string;
  modelId: string;
  modelName: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // Prefill from the current pricing (per-1M display: perToken × 1e6).
  const { data: pricing } = useModelPricing(props.providerId, props.modelId);
  const update = useUpdateModelPricing();
  const reset = useResetModelPricing();

  const [inputPerMillion, setInputPerMillion] = useState(
    pricing?.inputCostPerToken !== null && pricing?.inputCostPerToken !== undefined
      ? String(pricing.inputCostPerToken * 1_000_000)
      : "",
  );
  const [outputPerMillion, setOutputPerMillion] = useState(
    pricing?.outputCostPerToken !== null && pricing?.outputCostPerToken !== undefined
      ? String(pricing.outputCostPerToken * 1_000_000)
      : "",
  );
  const [currency, setCurrency] = useState<string>(pricing?.currency ?? "USD");

  const handleSave = async () => {
    try {
      await update.mutateAsync({
        providerId: props.providerId,
        modelId: props.modelId,
        inputCostPerToken: inputPerMillion ? Number(inputPerMillion) / 1_000_000 : undefined,
        outputCostPerToken: outputPerMillion ? Number(outputPerMillion) / 1_000_000 : undefined,
        currency,
      });
      showSuccess(t("settings.providers.cost.saved"));
      props.onClose();
    } catch (err: unknown) {
      showError(t("settings.providers.cost.saveFailed"));
      void err;
    }
  };

  const handleReset = async () => {
    try {
      await reset.mutateAsync({ providerId: props.providerId, modelId: props.modelId });
      showSuccess(t("settings.providers.cost.reset"));
      setInputPerMillion("");
      setOutputPerMillion("");
      props.onClose();
    } catch (err: unknown) {
      showError(t("settings.providers.cost.saveFailed"));
      void err;
    }
  };

  const inputHelper = inputPerMillion
    ? `≈ ${(Number(inputPerMillion) / 1_000_000).toExponential(3)} / token`
    : "";
  const outputHelper = outputPerMillion
    ? `≈ ${(Number(outputPerMillion) / 1_000_000).toExponential(3)} / token`
    : "";

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t("settings.providers.cost.title")}</DialogTitle>
          <DialogDescription>
            {t("settings.providers.cost.dialogHint", { model: props.modelName })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="pricing-input">{t("settings.providers.cost.inputLabel")}</Label>
            <Input
              id="pricing-input"
              type="number"
              step="any"
              min={0}
              value={inputPerMillion}
              onChange={(e) => setInputPerMillion(e.target.value)}
              placeholder="1.50"
            />
            {inputHelper && <p className="text-xs text-muted-foreground">{inputHelper}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="pricing-output">{t("settings.providers.cost.outputLabel")}</Label>
            <Input
              id="pricing-output"
              type="number"
              step="any"
              min={0}
              value={outputPerMillion}
              onChange={(e) => setOutputPerMillion(e.target.value)}
              placeholder="6.00"
            />
            {outputHelper && <p className="text-xs text-muted-foreground">{outputHelper}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="pricing-currency">{t("settings.providers.cost.currencyLabel")}</Label>
            <select
              id="pricing-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm"
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => void handleSave()}
              disabled={update.isPending || reset.isPending}
            >
              {update.isPending ? t("settings.providers.cost.saving") : t("settings.providers.cost.save")}
            </Button>
            <Button
              variant="outline"
              disabled={reset.isPending}
              onClick={() => void handleReset()}
            >
              {t("settings.providers.cost.reset")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
