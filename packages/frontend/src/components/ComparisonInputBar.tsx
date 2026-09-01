// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { useTranslation } from "react-i18next";
import { apiUpload } from "../utils/api";
import { SpeechRecognition, useSpeechRecognition } from "../hooks/useSpeechRecognition";
import type { UseChatReturn } from "../hooks/useChat";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { cn } from "@/lib/utils"
import { sanitizeFileName } from "@simmetric-chat/shared";
interface UploadedDoc {
  id: string;
  name: string;
}

interface ComparisonInputBarProps {
  paneA: UseChatReturn;
  paneB: UseChatReturn;
  activePane: "A" | "B";
  sendToOne: boolean;
  onToggleSendToOne: () => void;
  modelOverrideA: { providerId?: string; model?: string } | null;
  modelOverrideB: { providerId?: string; model?: string } | null;
  workspaceId: string | null;
}

export default function ComparisonInputBar({
  paneA,
  paneB,
  activePane,
  sendToOne,
  onToggleSendToOne,
  modelOverrideA,
  modelOverrideB,
  workspaceId,
}: ComparisonInputBarProps) {
  const { t, i18n } = useTranslation();
  const [input, setInput] = useState("");
  const [attachedDoc, setAttachedDoc] = useState<UploadedDoc | null>(null);
  const [uploading, setUploading] = useState(false);

  const isAnyStreaming = paneA.isStreaming || paneB.isStreaming;

  const {
    transcript,
    listening,
    resetTranscript,
    browserSupportsSpeechRecognition,
  } = useSpeechRecognition();

  useEffect(() => {
    if (transcript) {
      setInput(transcript);
    }
  }, [transcript]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isAnyStreaming) return;

    if (sendToOne && activePane === "A") {
      paneA.sendMessage(trimmed, attachedDoc?.id, attachedDoc?.name, modelOverrideA ?? undefined);
    } else if (sendToOne && activePane === "B") {
      paneB.sendMessage(trimmed, attachedDoc?.id, attachedDoc?.name, modelOverrideB ?? undefined);
    } else {
      paneA.sendMessage(trimmed, attachedDoc?.id, attachedDoc?.name, modelOverrideA ?? undefined)
        .then(() => {
          paneB.sendMessage(trimmed, attachedDoc?.id, attachedDoc?.name, modelOverrideB ?? undefined);
        })
        .catch(() => {
          paneB.sendMessage(trimmed, attachedDoc?.id, attachedDoc?.name, modelOverrideB ?? undefined);
        });
    }

    setInput("");
    resetTranscript();
    setAttachedDoc(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleMic = () => {
    if (listening) {
      SpeechRecognition.stopListening();
    } else {
      SpeechRecognition.startListening({ continuous: true, language: i18n.language });
    }
  };

  const onDrop =
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length === 0 || !workspaceId) return;
      setUploading(true);

      for (const file of acceptedFiles) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("workspaceId", workspaceId);

        try {
          const result = await apiUpload<{ id: string }>("/documents/upload", formData);
          // quick 260808-vzm: badge shows the sanitized name the server stores.
          setAttachedDoc({ id: result.id, name: sanitizeFileName(file.name) });
        } catch {
          // ignore upload errors
        }
      }
      setUploading(false);
    };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: true,
    accept: {
      "application/pdf": [".pdf"],
      "text/markdown": [".md"],
      "text/plain": [".txt"],
      "text/csv": [".csv"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    },
  });

  return (
    <div
      className="chat-input-panel border-t border-[var(--chat-border)] bg-[var(--chat-input-bg)] p-3 sm:p-4 transition-theme"
      {...getRootProps()}
    >
      <input {...getInputProps()} className="hidden" />

      {isDragActive && (
        <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary z-50 flex items-center justify-center">
          <p className="text-primary text-lg font-medium">
            Drop files here to attach to chat
          </p>
        </div>
      )}

      {/* Attached document indicator */}
      {attachedDoc && (
        <div className="mb-2 flex items-center gap-2 px-3 py-2 bg-primary/10 rounded-lg">
          <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
          <span className="text-sm text-primary truncate flex-1">{attachedDoc.name}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setAttachedDoc(null)}
            className="text-primary hover:text-primary"
            title={t("chat.removeAttachment")}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </Button>
        </div>
      )}

      {/* Row 1 — action buttons, right-aligned (attach / mic / send-to-one / send / stop). */}
      <div className="flex items-center justify-end gap-2 mb-2">
        {/* File attachment button */}
        <label className="cursor-pointer shrink-0">
          <input
            type="file"
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              if (files && files.length > 0) {
                onDrop(Array.from(files));
              }
              e.target.value = "";
            }}
            accept=".pdf,.md,.txt,.csv,.docx,.xlsx"
            disabled={uploading || isAnyStreaming}
          />
          <svg className="w-5 h-5 text-secondary-foreground hover:text-muted-foreground transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </label>

        {/* Microphone button */}
        {browserSupportsSpeechRecognition && (
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleMic}
            className={cn("shrink-0 rounded-lg border", listening
                ? "bg-destructive border-destructive text-destructive-foreground hover:bg-destructive"
                : "bg-card border-input text-muted-foreground hover:bg-accent")}
            title={t("chat.microphone")}
          >
            🎤
          </Button>
        )}

        {/* Send-to-one toggle */}
        <Button
          variant="outline"
          size="sm"
          onClick={onToggleSendToOne}
          aria-pressed={sendToOne}
          aria-label={t("chat.comparison.sendToOne")}
          title={t("chat.comparison.sendToOne")}
          className={cn("shrink-0 rounded-lg", (sendToOne) && "bg-accent")}
        >
          {sendToOne ? (
            <span className="flex items-center gap-1">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
              <span className="text-xs font-medium">{activePane}</span>
            </span>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          )}
        </Button>

        {/* Send button */}
        <Button
          variant="default"
          size="sm"
          onClick={handleSend}
          disabled={!input.trim() || isAnyStreaming}
          className="shrink-0"
        >
          {isAnyStreaming ? (
            <>
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              {t("chat.comparison.waiting")}
            </>
          ) : (
            t("chat.send")
          )}
        </Button>

        {/* Stop button */}
        {isAnyStreaming && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              paneA.abortStream();
              paneB.abortStream();
            }}
            className="shrink-0"
            title={t("chat.stopGenerating")}
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            {t("chat.stopGenerating")}
          </Button>
        )}
      </div>

      {/* Row 2 — message input, full width below the buttons. */}
      <Textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("chat.placeholder")}
        className="w-full resize-none min-h-[44px]"
        rows={2}
        disabled={isAnyStreaming}
      />
    </div>
  );
}
