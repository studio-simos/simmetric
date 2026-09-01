// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import ComparisonHeader from "./ComparisonHeader";
import MobileTabSwitcher from "./MobileTabSwitcher";
import ComparisonPane from "./ComparisonPane";
import ComparisonInputBar from "./ComparisonInputBar";
import ComparisonFabPicker from "./ComparisonFabPicker";
import { useChat } from "../hooks/useChat";
import type { UseChatReturn } from "../hooks/useChat";
import { useViewTransition } from "./ui/view-transition";

import { cn } from "@/lib/utils"
interface ModelComparisonViewProps {
  workspaceId: string | null;
  onClose: () => void;
  mainChat: UseChatReturn;
}

export default function ModelComparisonView({
  workspaceId,
  onClose,
  mainChat,
}: ModelComparisonViewProps) {
  const [paneAModel, setPaneAModel] = useState<{
    providerId?: string;
    model?: string;
  } | null>(mainChat.persistedModel);
  const [paneBModel, setPaneBModel] = useState<{
    providerId?: string;
    model?: string;
  } | null>(mainChat.persistedModel);
  const [activeTab, setActiveTab] = useState<"A" | "B">("A");
  const [sendToOne, setSendToOne] = useState(false);

  // Animate the A/B mobile tab switch via the CSS View Transitions API
  // (graceful no-op on browsers without support).
  const transitionTo = useViewTransition();
  const handleTabChange = (tab: "A" | "B") => {
    transitionTo(() => setActiveTab(tab));
  };

  const paneA = useChat(workspaceId);
  const paneB = useChat(workspaceId);

  useEffect(() => {
    return () => {
      paneA.abortStream();
      paneB.abortStream();
    };
  }, []);

  const handleMerge = (pane: "A" | "B") => {
    const sourceChat = pane === "A" ? paneA : paneB;
    const lastAssistant = [...sourceChat.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (!lastAssistant) return;
    mainChat.setMessages((prev) => [...prev, lastAssistant]);
    const selectedModel = pane === "A" ? paneAModel : paneBModel;
    if (selectedModel?.providerId && mainChat.currentChatId) {
      mainChat.updateChatModel(selectedModel.providerId, selectedModel.model || null).catch(() => {
        // revert handled internally by updateChatModel
      });
    }
    onClose();
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-background">
      <ComparisonHeader onClose={onClose} />
      <MobileTabSwitcher
        activeTab={activeTab}
        onTabChange={handleTabChange}
        paneAModel={paneAModel}
        paneBModel={paneBModel}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 flex-1 h-full overflow-hidden">
        <div
          className={cn("border-r border-border", (activeTab !== "A") && "hidden md:block")}
        >
          <ComparisonPane
            chat={paneA}
            modelOverride={paneAModel}
            onModelChange={setPaneAModel}
            isStale={false}
          />
        </div>
        <div className={cn((activeTab !== "B") && "hidden md:block")}>
          <ComparisonPane
            chat={paneB}
            modelOverride={paneBModel}
            onModelChange={setPaneBModel}
            isStale={false}
          />
        </div>
      </div>

      <ComparisonInputBar
        paneA={paneA}
        paneB={paneB}
        activePane={activeTab}
        sendToOne={sendToOne}
        onToggleSendToOne={() => setSendToOne((prev) => !prev)}
        modelOverrideA={paneAModel}
        modelOverrideB={paneBModel}
        workspaceId={workspaceId}
      />

      <ComparisonFabPicker
        paneAModel={paneAModel}
        paneBModel={paneBModel}
        onMerge={handleMerge}
      />
    </div>
  );
}
