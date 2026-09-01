// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useSessionTokens } from "../queries/useChatTokens";
import { formatTokens } from "../utils/tokens";
import { cn } from "@/lib/utils";

export interface TokenCounterWidgetProps {
  workspaceId: string | null;
  className?: string;
}

/**
 * TokenCounterWidget — compact top-bar token readout (Feature 3.6 / UI_DESIGN.md).
 *
 * Shows today's session token totals (input / output) for the active workspace
 * in monospace, reusing the `useSessionTokens` aggregation from Feature 2.
 * Renders nothing meaningful until a workspace is selected; callers may hide it
 * via the returned `hasData` flag (this component stays mounted but muted).
 */
export default function TokenCounterWidget({ workspaceId, className }: TokenCounterWidgetProps) {
  const { data, isLoading } = useSessionTokens(workspaceId ?? undefined);

  const input = data?.totalInput ?? 0;
  const output = data?.totalOutput ?? 0;
  const hasData = !!workspaceId && !isLoading && (input > 0 || output > 0);

  return (
    <div
      className={cn(
        // Visible from 375px up (tablet + mobile ≥375 + desktop). Hidden
        // below 375px where the bar is too crowded for the readout.
        "hidden min-[375px]:flex items-center gap-1.5 rounded border border-input bg-background/40 px-1.5 py-1 font-mono text-xs transition-theme sm:gap-2 sm:px-2",
        !hasData && "opacity-40",
        className,
      )}
      title={hasData ? `Today — in: ${input.toLocaleString()}  out: ${output.toLocaleString()}` : "No token usage yet"}
      aria-label="Session token usage"
    >
      <span className="text-muted-foreground">IN</span>
      <span className="text-foreground tabular-nums">
        {hasData ? formatTokens(input) : "—"}
      </span>
      <span className="text-muted-foreground">OUT</span>
      <span className="text-foreground tabular-nums">
        {hasData ? formatTokens(output) : "—"}
      </span>
    </div>
  );
}