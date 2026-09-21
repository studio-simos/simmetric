// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, ArrowUpFromLine, Sigma } from "lucide-react";
import { useChatTokens, useSessionTokens, type ChatTokenAggregate } from "../queries/useChatTokens";
import { formatTokens } from "../utils/tokens";

type View = "conversation" | "session";

function StatRow({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  accent: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <span style={{ color: accent }}>{icon}</span>
        {label}
      </span>
      <span className="font-mono text-sm font-semibold text-[var(--text)]">{formatTokens(value)}</span>
    </div>
  );
}

/**
 * Mini horizontal bar comparing input vs output share of the total.
 * Pure CSS — no charting library, air-gap compatible.
 */
function TokenBar({ input, output }: { input: number; output: number }) {
  const total = input + output;
  const inputPct = total > 0 ? (input / total) * 100 : 0;
  const outputPct = total > 0 ? (output / total) * 100 : 0;

  return (
    <div className="mt-3">
      <div className="flex h-2.5 w-full overflow-hidden rounded-sm border border-border bg-[var(--surface-alt)]">
        <div
          className="h-full transition-all duration-300"
          style={{ width: `${inputPct}%`, backgroundColor: "var(--primary, #4c6ef5)" }}
          title={`Input ${formatTokens(input)}`}
        />
        <div
          className="h-full transition-all duration-300"
          style={{ width: `${outputPct}%`, backgroundColor: "#10b981" }}
          title={`Output ${formatTokens(output)}`}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-[var(--text-subtle)]">
        <span>
          <span
            className="mr-1 inline-block h-2 w-2 rounded-sm align-middle"
            style={{ backgroundColor: "var(--primary, #4c6ef5)" }}
          />
          {formatTokens(input)} in
        </span>
        <span>
          <span
            className="mr-1 inline-block h-2 w-2 rounded-sm align-middle"
            style={{ backgroundColor: "#10b981" }}
          />
          {formatTokens(output)} out
        </span>
      </div>
    </div>
  );
}

function AggregateView({ data, loading, view }: { data?: ChatTokenAggregate; loading: boolean; view: View }) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="space-y-2 py-2">
        <div className="h-4 w-3/4 animate-pulse rounded bg-[var(--surface-alt)]" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-[var(--surface-alt)]" />
        <div className="h-2.5 w-full animate-pulse rounded bg-[var(--surface-alt)]" />
      </div>
    );
  }

  if (!data || data.total === 0) {
    return (
      <p className="py-4 text-center text-xs text-[var(--text-muted)]">
        {view === "conversation"
          ? t("tokens.noConversationUsage", "No token usage recorded for this conversation yet.")
          : t("tokens.noSessionUsage", "No token usage recorded today yet.")}
      </p>
    );
  }

  return (
    <div>
      <StatRow
        label={t("tokens.input", "Input")}
        value={data.totalInput}
        icon={<ArrowDownToLine size={14} />}
        accent="var(--primary, #4c6ef5)"
      />
      <StatRow
        label={t("tokens.output", "Output")}
        value={data.totalOutput}
        icon={<ArrowUpFromLine size={14} />}
        accent="#10b981"
      />
      <div className="my-1 border-t border-border" />
      <StatRow
        label={t("tokens.total", "Total")}
        value={data.total}
        icon={<Sigma size={14} />}
        accent="var(--text)"
      />
      <TokenBar input={data.totalInput} output={data.totalOutput} />
      {view === "session" && data.since && (
        <p className="mt-2 text-[10px] text-[var(--text-subtle)]">
          {t("tokens.since", "Since")} {new Date(data.since).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

interface TokenStatsDetailProps {
  workspaceId: string | null;
  chatId: string | null;
}

/**
 * TokenStatsDetail — the Conversation/Today token breakdown (input/output/total
 * rows + in/out comparison bar) reused inside the RightPanel "Token Stats"
 * section as a collapsible tendina (quick 260723-nnr follow-up 3).
 *
 * Stateless presentational wrapper around `useChatTokens` + `useSessionTokens`.
 * It deliberately renders NO header and NO close button — the host section
 * supplies the section title and owns the collapse toggle, so this stays
 * embeddable. The old chat-area `TokenCounterPanel` (bordered card with a close
 * button that opened above the message input) was removed when its functions
 * moved into the right console panel.
 */
export function TokenStatsDetail({ workspaceId, chatId }: TokenStatsDetailProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("conversation");

  const chatTokens = useChatTokens(workspaceId ?? undefined, chatId);
  const sessionTokens = useSessionTokens(workspaceId ?? undefined);

  return (
    <div className="space-y-2">
      <div className="flex gap-1 rounded-md bg-[var(--surface-alt)] p-0.5">
        <button
          onClick={() => setView("conversation")}
          disabled={!chatId}
          className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
            view === "conversation"
              ? "bg-card text-[var(--text)] shadow-sm"
              : "text-[var(--text-muted)] hover:text-[var(--text)]"
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {t("tokens.conversation", "Conversation")}
        </button>
        <button
          onClick={() => setView("session")}
          className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
            view === "session"
              ? "bg-card text-[var(--text)] shadow-sm"
              : "text-[var(--text-muted)] hover:text-[var(--text)]"
          }`}
        >
          {t("tokens.today", "Today")}
        </button>
      </div>

      <AggregateView
        view={view}
        data={view === "conversation" ? chatTokens.data : sessionTokens.data}
        loading={view === "conversation" ? chatTokens.isLoading : sessionTokens.isLoading}
      />
    </div>
  );
}

export default TokenStatsDetail;