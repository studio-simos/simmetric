// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useState, useCallback } from "react";
import { logger } from "../utils/logger";

/**
 * Lightweight React 19-compatible Web Speech API wrapper.
 *
 * Replaces `react-speech-recognition` (deprecated, emits React 19 warnings)
 * with a vanilla implementation around the browser-native
 * `window.SpeechRecognition` / `webkitSpeechRecognition` API.
 *
 * Provides a singleton-managed state shared across all hook consumers
 * (mirroring the behavior of `react-speech-recognition`), so the
 * microphone state remains consistent even when multiple components
 * subscribe (e.g. ChatPanel + ComparisonInputBar).
 *
 * API surface kept compatible:
 *   const { transcript, listening, resetTranscript, browserSupportsSpeechRecognition } = useSpeechRecognition();
 *   SpeechRecognition.startListening({ continuous: true, language: "it-IT" });
 *   SpeechRecognition.stopListening();
 */

interface SpeechRecognitionOptions {
  continuous?: boolean;
  language?: string;
}

const LOCALE_MAP: Record<string, string> = {
  en: "en-US",
  it: "it-IT",
  ru: "ru-RU",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
  zh: "zh-CN",
};

function toBcp47(lang: string): string {
  if (lang.length >= 4) return lang;
  return LOCALE_MAP[lang] ?? "en-US";
}

interface SpeechRecognitionState {
  transcript: string;
  listening: boolean;
  resetTranscript: () => void;
  browserSupportsSpeechRecognition: boolean;
}

// Avoid clashing with the DOM `SpeechRecognition` constructor name
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;
interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: ((event: Event) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

const hasWindow = typeof window !== "undefined";
const getSpeechRecognitionCtor = (): SpeechRecognitionCtor | null => {
  if (!hasWindow) return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

const browserSupportsSpeechRecognition = (() => {
  if (!hasWindow) return false;
  return getSpeechRecognitionCtor() !== null;
})();

type Listener = (state: SpeechRecognitionState) => void;

class SpeechRecognitionManager {
  private recognition: SpeechRecognitionInstance | null = null;
  private finalTranscript = "";
  private interimTranscript = "";
  private state: SpeechRecognitionState = {
    transcript: "",
    listening: false,
    resetTranscript: () => this.resetTranscript(),
    browserSupportsSpeechRecognition,
  };
  private listeners = new Set<Listener>();

  getState(): SpeechRecognitionState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    this.state = {
      ...this.state,
      transcript: (this.finalTranscript + this.interimTranscript).trimStart(),
      resetTranscript: () => this.resetTranscript(),
    };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  startListening(options: SpeechRecognitionOptions = {}): void {
    if (!browserSupportsSpeechRecognition) return;
    if (this.state.listening) return;

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;

    this.recognition = new Ctor();
    this.recognition.continuous = options.continuous ?? true;
    this.recognition.interimResults = true;
    this.recognition.lang = toBcp47(options.language ?? "en");

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      let newInterim = "";
      let newFinal = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        if (result.isFinal) {
          newFinal += result[0]?.transcript ?? "";
        } else {
          newInterim += result[0]?.transcript ?? "";
        }
      }
      if (newFinal) {
        this.finalTranscript += newFinal;
        this.interimTranscript = "";
      } else {
        this.interimTranscript = newInterim;
      }
      this.emit();
    };

    this.recognition.onend = () => {
      this.state = { ...this.state, listening: false };
      this.recognition = null;
      this.emit();
    };

    this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // Surface non-fatal errors as state changes (e.g. "no-speech", "aborted")
      // Don't crash the app — just stop listening.
      logger.warn("[SpeechRecognition] error:", { error: event.error });
      this.state = { ...this.state, listening: false };
      this.recognition = null;
      this.emit();
    };

    try {
      this.recognition.start();
      this.state = { ...this.state, listening: true };
      this.emit();
    } catch (err) {
      // Some browsers throw if start() is called when already started.
      logger.warn("[SpeechRecognition] start failed:", { error: err });
      this.state = { ...this.state, listening: false };
      this.emit();
    }
  }

  stopListening(): void {
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // ignore — recognition may already be stopped
      }
    }
    this.interimTranscript = "";
    this.state = { ...this.state, listening: false };
    this.emit();
  }

  abortListening(): void {
    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch {
        // ignore
      }
    }
    this.finalTranscript = "";
    this.interimTranscript = "";
    this.state = { ...this.state, transcript: "", listening: false };
    this.emit();
  }

  resetTranscript(): void {
    this.finalTranscript = "";
    this.interimTranscript = "";
    this.state = { ...this.state, transcript: "" };
    this.emit();
  }
}

const manager = new SpeechRecognitionManager();

/**
 * Static API mirroring `react-speech-recognition`'s default export.
 * Components can keep using `SpeechRecognition.startListening({...})` and
 * `SpeechRecognition.stopListening()` without refactoring call sites.
 */
export const SpeechRecognition = {
  startListening: (options: SpeechRecognitionOptions = {}) =>
    manager.startListening(options),
  stopListening: () => manager.stopListening(),
  abortListening: () => manager.abortListening(),
};

export function useSpeechRecognition(): SpeechRecognitionState {
  const [state, setState] = useState<SpeechRecognitionState>(() =>
    manager.getState(),
  );

  // Subscribe to manager updates and re-render on changes
  useEffect(() => {
    const unsubscribe = manager.subscribe(setState);
    // Sync to current state on mount in case it changed between
    // hook initialization and effect.
    setState(manager.getState());
    return unsubscribe;
  }, []);

  // Stable resetTranscript function — manager handles identity per emit
  const resetTranscript = useCallback(() => manager.resetTranscript(), []);

  return {
    ...state,
    resetTranscript,
  };
}
