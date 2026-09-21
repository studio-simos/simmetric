// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ProviderIcon, capabilityKeyMap } from "../ModelSelector";

/**
 * ChatModelBadge — `[⬤ model_name]` badge (Feature 4.1.1 + 4.3.2).
 *
 * The dot color signals provider origin: green = local/ollama (air-gapped),
 * cyan = cloud (openai/anthropic). Click opens the model palette via the
 * existing `open-palette` CustomEvent pattern. The `isStale`/`fallbackFrom`
 * variant renders an amber dot + dashed border + tooltip so the user knows the
 * active model fell back from their original selection.
 *
 * Consolidated model control (Feature 8 follow-up): the "md" instance in the
 * ChatInputArea action row is now the single model selector for the chat. It
 * carries the trigger-level info previously shown by the header `ModelSelector`
 * — provider icon, colored capability badges, "no longer available" (⚠)
 * indicator, and a detailed tooltip. Picking still happens through the
 * palette (Cmd+K spotlight), which is richer than a dropdown (search, provider
 * grouping, per-item capability/default badges).
 *
 * Reused in two sizes: "sm" in the AI message header + empty state (display
 * only), "md" inline in the ChatInputArea action row (full selector).
 */
export interface ChatModelBadgeProps {
  providerId?: string;
  model?: string;
  /** Provider type string from ChatMessage.metadata.modelProvider / SSE done. */
  modelProvider?: string;
  /** Provider type for the leading icon (ollama/openai/anthropic/openrouter). */
  providerType?: string;
  /** Capability tags to render as colored badges (e.g. ["local-only","fastest"]). */
  capabilities?: string[];
  /** Active model is no longer in availableModels → ⚠ + destructive border. */
  unavailable?: boolean;
  /** Shown model is the default (no explicit selection) → ★ marker. */
  isDefault?: boolean;
  isStale?: boolean;
  fallbackFrom?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  /** Override the default click (open palette). */
  onClick?: () => void;
  className?: string;
  /**
   * Display-only label (not a button): renders a non-interactive `<span>`
   * that never opens the palette. Used in the AI message header to persist
   * the model actually used for *that* response (read from
   * `ChatMessage.metadata.modelUsed`) without offering a model picker on a
   * past response. When `model` is absent, renders nothing.
   */
  displayOnly?: boolean;
}

function isLocalProvider(providerId?: string, modelProvider?: string): boolean {
  const hay = `${providerId ?? ""} ${modelProvider ?? ""}`.toLowerCase();
  return /ollama|local/.test(hay);
}

/** Colored capability chip — mirrors the header inline badge styling. */
function CapabilityChip({ tag, label }: { tag: string; label: string }) {
  const cls =
    tag === "local-only"
      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
      : tag === "fastest"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
        : tag === "smartest"
          ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
          : tag === "reasoning"
            ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
            : "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400";
  return <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", cls)}>{label}</span>;
}

export function ChatModelBadge({
  providerId,
  model,
  modelProvider,
  providerType,
  capabilities,
  unavailable,
  isDefault,
  isStale,
  fallbackFrom,
  size = "sm",
  disabled,
  onClick,
  className,
  displayOnly,
}: ChatModelBadgeProps) {
  const { t } = useTranslation();
  const local = isLocalProvider(providerId, modelProvider);
  const dotColor = isStale
    ? "bg-amber-400"
    : local
      ? "bg-[var(--chat-accent)]"
      : "bg-[#00d4ff]";

  // displayOnly: a persisted response with no recorded model shows no badge
  // (not the "Select model" prompt — that would be misleading on a past AI reply).
  if (displayOnly && !model) return null;

  const label = model || t("chat.input.model", "Select model");
  const pad = size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs";
  const dotSize = size === "sm" ? "size-1.5" : "size-2";

  const hasCaps = !!capabilities && capabilities.length > 0;
  const labelMax = hasCaps || providerType ? "max-w-[10ch]" : "max-w-[16ch]";

  const tooltipLabel = unavailable
    ? t("chat.modelSelector.unavailable", "Model no longer available")
    : isStale && fallbackFrom
      ? t("chat.message.fallbackTooltip", { from: fallbackFrom, defaultValue: "Fallback from {{from}}" })
      : isStale
        ? t("chat.modelSelector.stale", "Model availability data is stale")
        : label;

  const borderClass = unavailable
    ? "border-destructive"
    : isStale
      ? "border-dashed border-amber-400/60"
      : "border-[var(--chat-border)]";

  const inner = (
    <>
      {providerType && <ProviderIcon type={providerType} />}
      <span className={cn("rounded-full shrink-0", dotColor, dotSize)} aria-hidden="true" />
      <span className={cn("truncate", labelMax)}>{label}</span>
      {isDefault && <span className="text-primary text-[10px] shrink-0" aria-label={t("chat.modelSelector.default", "Default")}>★</span>}
      {hasCaps && (
        <span className="inline-flex items-center gap-1 shrink-0">
          {capabilities!.map((tag) => (
            <CapabilityChip key={tag} tag={tag} label={t(capabilityKeyMap[tag] || tag)} />
          ))}
        </span>
      )}
    </>
  );

  // displayOnly: non-interactive label — persists the model used for this
  // response without offering a picker on a past AI reply.
  if (displayOnly) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded border bg-[var(--chat-ai-bg)] font-mono",
          pad,
          borderClass,
          className,
        )}
        title={tooltipLabel}
        aria-label={t("chat.message.modelUsed", { model: label, defaultValue: "Model: {{model}}" })}
      >
        {inner}
      </span>
    );
  }

  const badge = (
    <button
      type="button"
      disabled={disabled}
      onClick={() => (onClick ? onClick() : window.dispatchEvent(new CustomEvent("open-palette")))}
      className={cn(
        "inline-flex items-center gap-1.5 rounded border bg-[var(--chat-ai-bg)] font-mono transition-theme",
        pad,
        "hover:border-[var(--chat-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        borderClass,
        disabled && "opacity-60 pointer-events-none",
        className,
      )}
      aria-label={t("chat.input.model", "Select model")}
      title={tooltipLabel}
    >
      {inner}
    </button>
  );

  if (isStale && fallbackFrom && !unavailable) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top">
          {t("chat.message.fallbackTooltip", { from: fallbackFrom, defaultValue: "Fallback from {{from}}" })}
        </TooltipContent>
      </Tooltip>
    );
  }
  return badge;
}

