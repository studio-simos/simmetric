// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useCallback, useRef, useEffect } from "preact/hooks";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { t } from "../i18n";

// D-02 (Phase 90): split-host seam — identical to agent/skills.ts:44-45 and
// hooks/useChat.ts:25,39. `import type` is erased by esbuild at bundle time →
// zero runtime dependency on @simmetric-chat/shared in the IIFE bundle
// (vite.widget.config.ts has NO @simmetric-chat/shared alias). D-04: `score` is
// now optional (shared superset, Phase 87 D-01); widget consumers that read
// `citation.score` MUST narrow with `!== undefined` (graceful omission, not
// a placeholder). No widget consumer currently reads `.score` (grep-verified).
import type { SourceCitation } from "@simmetric-chat/shared";
export type { SourceCitation } from "@simmetric-chat/shared";

export interface WidgetMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  citations?: SourceCitation[];
}

export interface RateLimitInfo {
  hourlyRemaining?: number;
  dailyRemaining?: number;
  retryAfter?: number;
}

export interface UseWidgetChatReturn {
  messages: WidgetMessage[];
  isStreaming: boolean;
  error: string | null;
  chatId: string | null;
  rateLimit: RateLimitInfo | null;
  sessionLimitReached: boolean;
  sessionToken: string | null;
  sendMessage: (message: string) => Promise<void>;
  abortStream: () => void;
  clearError: () => void;
}

const API_BASE = "/api";

// WID-03 D-05/D-06: storage helpers moved from opaque iframe sessionStorage to
// the loader's (parent page) sessionStorage via postMessage. The iframe stays
// sandboxed (no allow-same-origin), the loader has a stable origin, and the
// iframe validates the storage-data reply came from its parent before accepting
// it (defense-in-depth; server still validates the token on every chat request
// via sessionMiddleware → 401 fail-safe).
//
// CRITICAL (CR-01 fix): the iframe is sandboxed WITHOUT allow-same-origin, so
// window.location.origin is the opaque origin and serializes to the string
// "null". event.origin of a message from the parent is the host page's REAL
// origin (e.g. "https://example.com"). Comparing the two ALWAYS fails → every
// storage-data reply was rejected → 500ms timeout → null → a new session was
// created on every load → blow-through 5-sessions/day was NOT prevented
// (root cause of WID-03 intact). The correct validation is event.source ===
// window.parent: only the loader (our parent) is allowed to answer storage-data.
// Sibling iframes and host-page scripts have a different event.source and are
// ignored.
//
// requestStorageFromLoader: posts simmetric:storage-get to the parent and awaits
// simmetric:storage-data. Resolves with the data map (or null on timeout/source
// mismatch). Timeout default 500ms (Pitfall 5: await BEFORE POST /api/sessions
// so a cached valid token is reused and no blow-through happens).
//
// 131-05 (G-131-18): request/reply correlation. Each storage-get carries a
// per-request requestId; the loader echoes it in the storage-data reply; the
// handler resolves ONLY the request whose id matches. Without this, concurrent
// reads (ChatPanel mount: consent + leadSubmitted, plus useWidgetChat's
// session read) resolved on the FIRST reply — the leadSubmitted restore always
// resolved null and the lead card re-showed after reload (deterministic
// 100/100). Legacy cached loaders (max-age=3600) that never learned the echo
// degrade to unambiguous single-flight: a no-requestId reply resolves only
// when exactly ONE storage-get is pending; multi-pending legacy broadcasts are
// ignored → timeout → null (never the wrong data). The event.source ===
// window.parent check stays (CR-01) — the requestId match adds a second binding
// (T-131-12): only the loader can echo the per-request nonce.
//
// postStorageToLoader: posts simmetric:storage-set to the parent; fire-and-forget.
// Called only on done/error/unmount (D-05) — NEVER per-token (avoids postMessage
// flood on multi-hundred-token SSE responses).
// Exported for unit testing (T-65-SC: pure-helper approach — no
// @testing-library/preact). The D-05 throttle test calls postStorageToLoader
// directly to assert the done-path fires exactly one simmetric:storage-set for
// "messages" after two tokens (per-token would fire two).
function makeRequestId(): string {
  // Guarded: the node test env has no crypto.
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

// Module-level pending count for the legacy single-flight fallback: a
// no-requestId reply (stale cached loader) resolves only when exactly ONE
// storage-get request is pending in the whole iframe.
let pendingStorageGetCount = 0;

export function requestStorageFromLoader(widgetId: string, keys: string[], timeoutMs = 500): Promise<Record<string, string | null> | null> {
  return new Promise((resolve) => {
    const requestId = makeRequestId();
    pendingStorageGetCount += 1;
    const timer = setTimeout(() => {
      pendingStorageGetCount -= 1;
      window.removeEventListener("message", handler);
      resolve(null);
    }, timeoutMs);
    const handler = (event: MessageEvent) => {
      // D-06 (CR-01 fix): only accept storage-data from our parent (the loader).
      // Origin comparison is impossible under a sandboxed opaque-origin iframe
      // (window.location.origin === "null"), so validate the sender window
      // instead. See block comment above for the full rationale.
      if (event.source !== window.parent) return;
      const data = event.data as { type?: string; data?: Record<string, string | null>; requestId?: string } | null;
      if (!data || data.type !== "simmetric:storage-data") return;
      // 131-05 (G-131-18): correlation. A reply carrying a requestId resolves
      // ONLY the request with that id. A reply WITHOUT a requestId (legacy
      // cached loader) resolves only when exactly one request is pending —
      // single-flight is unambiguous; multi-pending legacy broadcasts cannot
      // be attributed and are ignored (timeout → null, never the wrong data).
      if (data.requestId !== undefined) {
        if (data.requestId !== requestId) return;
      } else if (pendingStorageGetCount !== 1) {
        return;
      }
      pendingStorageGetCount -= 1;
      clearTimeout(timer);
      window.removeEventListener("message", handler);
      resolve(data.data ?? null);
    };
    window.addEventListener("message", handler);
    window.parent.postMessage({ type: "simmetric:storage-get", widgetId, keys, requestId }, "*");
  });
}

export function postStorageToLoader(widgetId: string, key: string, value: string): void {
  window.parent.postMessage({ type: "simmetric:storage-set", widgetId, key, value }, "*");
}

// 260809-uxk (consent deadlock): single-key read/write wrappers over the
// loader handshake, used by ChatPanel for consent + lead-submitted state.
// The sandboxed iframe's own sessionStorage throws SecurityError on the
// opaque origin, so these values MUST persist on the parent page. The 1500ms
// default matches the mount-handshake bump (slow hosts get a fair chance
// before the fresh-session fallback). Exported for unit testing (T-65-SC:
// pure-helper approach — same window-mock idiom as the CR-01 tests).
export async function readStoredValue(widgetId: string, key: string, timeoutMs = 1500): Promise<string | null> {
  const data = await requestStorageFromLoader(widgetId, [key], timeoutMs);
  return data?.[key] ?? null;
}

export function writeStoredValue(widgetId: string, key: string, value: string): void {
  postStorageToLoader(widgetId, key, value);
}

// WID-01 D-09: pure dedup helpers for client `done` events. Exported so the
// dedup logic can be unit-tested in the node environment without rendering the
// Preact hook (the threat model T-65-SC forbids new test deps like
// @testing-library/preact; jest-environment-jsdom is in the workspace but the
// pure-helper approach gives the same coverage with zero new surface).
//
// Key = `${chatId}:${messageId}` when messageId is non-null; fallback
// `${chatId}:${Date.now()}` when null (path aborted, server sets messageId
// to null). The first `done` wins; duplicates are ignored silently. For null
// messageId, dedup only catches truly-simultaneous events (same ms) — best
// effort, since isStreaming(false) is idempotent anyway.
export function makeDoneKey(chatId: string | null | undefined, messageId: string | null | undefined): string {
  const cid = chatId ?? "unknown";
  return messageId ? `${cid}:${messageId}` : `${cid}:${Date.now()}`;
}

export function shouldProcessDone(seenSet: Set<string>, chatId: string | null | undefined, messageId: string | null | undefined): boolean {
  const key = makeDoneKey(chatId, messageId);
  if (seenSet.has(key)) return false;
  seenSet.add(key);
  return true;
}

// 260809-uxk Task 2 — pure helpers for SYNCHRONOUS messagesRef updates. The
// token/citations/sendMessage mutation sites update messagesRef.current
// inline via these helpers (never via a post-commit effect), so the done/
// error/unmount persistence always reads a complete snapshot — the old
// post-commit sync effect could lag the done event and persist a truncated
// assistant message. D-05 preserved: persistence still fires only on
// done/error/unmount, never per-token. Exported for unit testing (T-65-SC).
export function appendTokenToMessages(messages: WidgetMessage[], content: string): WidgetMessage[] {
  const updated = [...messages];
  const last = updated[updated.length - 1];
  if (last && last.role === "assistant") {
    updated[updated.length - 1] = { ...last, content };
  }
  return updated;
}

export function attachCitationsToMessages(messages: WidgetMessage[], citations: SourceCitation[]): WidgetMessage[] {
  const updated = [...messages];
  const last = updated[updated.length - 1];
  if (last && last.role === "assistant") {
    updated[updated.length - 1] = { ...last, citations };
  }
  return updated;
}

// 131-07 (G-131-19): the rag-degraded chrome message is translated CLIENT-side
// via t("chatErrors.ragDegraded") — the proxy no longer emits an English
// literal (the SSE status event carries only a machine-readable flag), and the
// client never displays a server-provided message verbatim. The client KNOWS
// the resolved visitor locale (initWidgetI18n(config.locale) in
// useWidgetConfig) — the proxy does not. When i18n is uninitialized, t()
// returns the key itself — the fallback shows the key, never a server English
// literal. Exported for unit testing (T-65-SC pure-helper idiom).
export function translateRagDegraded(): string {
  return t("chatErrors.ragDegraded");
}

// 131-07 (G-131-19): the stream POST body builder. The visitor locale from
// config.locale is threaded into the body so the proxy can forward it
// upstream (additive — omitted when absent, old clients keep parsing).
// Exported for unit testing (T-65-SC pure-helper idiom).
export function buildStreamBody(
  message: string,
  chatId: string | null | undefined,
  locale: string | undefined,
): Record<string, unknown> {
  return {
    message,
    ...(chatId ? { chatId } : {}),
    ...(locale ? { locale } : {}),
  };
}

// 151-02 (G-151-1b): daily MESSAGE limit detection for a 429 response. The
// per-widget daily limiter's body carries retryAfter: "86400" (24h window);
// the session-counter path carries dailyRemaining: 0; a `daily: true` flag is
// accepted as an explicit marker. A daily block is a HARD per-visitor cap —
// the client disables the input and never auto-clears. Exported for unit
// testing (T-65-SC pure-helper idiom — the hook is not renderable in node).
export function isDailyRateLimit(body: Record<string, unknown>, rl: RateLimitInfo): boolean {
  const retryAfter = body.retryAfter !== undefined ? Number(body.retryAfter) : NaN;
  return (
    body.daily === true ||
    (Number.isFinite(retryAfter) && retryAfter >= 86400) ||
    rl.dailyRemaining === 0
  );
}

export function useWidgetChat(widgetId: string, locale?: string): UseWidgetChatReturn {
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null);
  // 151-02 (G-151-1b): daily MESSAGE limit reached — a hard per-visitor cap.
  // Once set, the ChatPanel disables the input entirely; NO auto-clear (the
  // budget resets only when the server's 24h window rolls over).
  const [sessionLimitReached, setSessionLimitReached] = useState(false);
  const [sessionToken, setSessionToken] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const streamingContentRef = useRef("");
  const currentCitationsRef = useRef<SourceCitation[]>([]);
  const sessionTokenRef = useRef<string | null>(null);
  // 151-02 (G-151-1b): ref mirror of sessionLimitReached so the sendMessage
  // guard reads the latest value inside the useCallback closure (same idiom
  // as sessionTokenRef/messagesRef).
  const sessionLimitReachedRef = useRef(false);
  const messagesRef = useRef<WidgetMessage[]>([]); // mirror — updated SYNCHRONOUSLY at every mutation site (260809-uxk T2)
  // WID-01 D-09: per-conversation seen-set of processed `done` event keys.
  // First done wins; duplicates are ignored silently.
  const doneSeenRef = useRef<Set<string>>(new Set());

  // 260809-uxk T2: the post-commit sync effect (messagesRef.current = messages
  // on [messages]) is REMOVED — it could lag the done event (done processed
  // before the effect ran for the last token batch), persisting a truncated
  // assistant message. Every mutation site (sendMessage, token, citations,
  // restore) now updates messagesRef.current synchronously.

  // WID-01 D-09: reset the done seen-set when the conversation changes so a new
  // chat starts with a fresh dedup window (avoids stale-key collisions and
  // bounds memory growth to per-conversation).
  useEffect(() => {
    doneSeenRef.current = new Set();
  }, [chatId]);

  // WID-03 D-05/D-06: handshake-gated session create (Pitfall 5 — await BEFORE
  // POST /api/sessions). On mount, ask the loader for any cached token +
  // messages. If a valid cached token is present, reuse it (and the cached
  // message history) and do NOT create a new session (no blow-through). If no
  // cache, POST /api/sessions and persist the new token to the loader.
  useEffect(() => {
    if (!widgetId) return;

    let cancelled = false;
    (async () => {
      const cached = await requestStorageFromLoader(widgetId, ["session", "messages"], 1500);
      if (cancelled) return;

      if (cached?.session) {
        try {
          const parsed = JSON.parse(cached.session) as { token?: string };
          if (parsed?.token) {
            setSessionToken(parsed.token);
            sessionTokenRef.current = parsed.token;
            if (cached?.messages) {
              try {
                const parsedMessages = JSON.parse(cached.messages) as WidgetMessage[];
                if (Array.isArray(parsedMessages)) {
                  setMessages(parsedMessages);
                  messagesRef.current = parsedMessages;
                }
              } catch {
                // corrupted messages payload — start fresh
              }
            }
            return; // reused cache — no POST /api/sessions
          }
        } catch {
          // corrupted session payload — fall through to create
        }
      }

      try {
        const response = await fetch(`${API_BASE}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ widgetId }),
        });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data.sessionToken) {
          setSessionToken(data.sessionToken);
          sessionTokenRef.current = data.sessionToken;
          postStorageToLoader(widgetId, "session", JSON.stringify({ token: data.sessionToken }));
        }
      } catch {
        // Session creation failure handled on first message send
      }
    })();

    return () => { cancelled = true; };
  }, [widgetId]);

  // WID-03 D-05: cleanup-only unmount effect. The body is empty — persistence
  // happens ONLY in the cleanup return, which runs on unmount or widgetId
  // change. Deps are [widgetId] (NOT [widgetId, messages]) so the cleanup does
  // NOT fire on every token (D-05: per-token postMessage flooding is explicitly
  // forbidden — "per-token NON è un'opzione"). The cleanup reads from
  // messagesRef (the latest committed snapshot) so the final conversation is
  // persisted even though the closure doesn't capture every intermediate state.
  // [Rule 1 - Bug] Plan action specified [widgetId, messages] deps which would
  // fire the cleanup on every messages change (per-token); switched to
  // [widgetId] deps to honor D-05.
  useEffect(() => {
    return () => {
      if (widgetId && messagesRef.current.length > 0) {
        postStorageToLoader(widgetId, "messages", JSON.stringify(messagesRef.current));
      }
    };
  }, [widgetId]);

  const abortStream = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const sendMessage = useCallback(async (message: string) => {
    if (!widgetId || !message.trim()) return;
    // 151-02 (G-151-1b): hard daily cap — refuse to send at all once the
    // daily message limit is reached (defense-in-depth: the InputBar is
    // disabled, but welcome-screen chips route through this same path).
    if (sessionLimitReachedRef.current) return;

    // Abort any existing stream
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const userMessage: WidgetMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: message.trim(),
    };

    const assistantMessage: WidgetMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      citations: [],
    };

    const updated = [...messagesRef.current, userMessage, assistantMessage];
    messagesRef.current = updated;
    setMessages(updated);
    setIsStreaming(true);
    setError(null);
    setRateLimit(null);
    streamingContentRef.current = "";
    currentCitationsRef.current = [];

    const controller = new AbortController();
    abortRef.current = controller;

    const token = sessionTokenRef.current;

    try {
      await fetchEventSource(`${API_BASE}/chat/${widgetId}/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Session-Token": token } : {}),
        },
        body: JSON.stringify(buildStreamBody(message.trim(), chatId, locale)),
        signal: controller.signal,
        openWhenHidden: true,

        onopen: async (response) => {
          if (response.status === 401) {
            throw new Error(t("chatErrors.sessionExpired"));
          }
          if (response.status === 429) {
            const body = await response.json().catch(() => ({}));
            const rl: RateLimitInfo = {};
            if (body.retryAfter) rl.retryAfter = body.retryAfter;
            if (body.hourlyRemaining !== undefined) rl.hourlyRemaining = body.hourlyRemaining;
            if (body.dailyRemaining !== undefined) rl.dailyRemaining = body.dailyRemaining;
            setRateLimit(rl);
            // 151-02 (G-151-1b): distinguish the DAILY case — the per-widget
            // daily message limiter's 429 body carries retryAfter: "86400"
            // (and the session-counter path carries a dailyRemaining of 0).
            // A daily block is a hard per-visitor cap: set sessionLimitReached
            // so the UI disables the input, and never auto-clear.
            if (isDailyRateLimit(body as Record<string, unknown>, rl)) {
              setSessionLimitReached(true);
              sessionLimitReachedRef.current = true;
            }
            throw new Error(t("chatErrors.rateLimit"));
          }
          if (response.status === 502) {
            throw new Error(t("chatErrors.serviceUnavailable"));
          }
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${response.status}`);
          }
        },

        onmessage: (event) => {
          switch (event.event) {
            case "token": {
              try {
                const data = JSON.parse(event.data);
                streamingContentRef.current += data.token || data;
              } catch {
                streamingContentRef.current += event.data;
              }
              // 260809-uxk T2: SYNCHRONOUS ref update — messagesRef mirrors
              // committed state (base is equivalent to the old
              // functional-setMessages-with-prev), so the done handler reads
              // a complete snapshot including this token batch.
              const updated = appendTokenToMessages(messagesRef.current, streamingContentRef.current);
              messagesRef.current = updated;
              setMessages(updated);
              break;
            }
            case "status": {
              try {
                const data = JSON.parse(event.data);
                if (data.chatId) {
                  setChatId(data.chatId);
                }
                // WID-02 D-03: surface RAG degradation via existing ErrorBar
                // (auto-hide 5s, dismissible) — no new Preact component.
                // 131-07 (G-131-19): the server message is DROPPED — the
                // client owns the translation via t("chatErrors.ragDegraded")
                // (the proxy emits only a machine-readable flag now).
                if (data.status === "rag-degraded") {
                  setError(translateRagDegraded());
                }
              } catch {
                // Ignore parse errors
              }
              break;
            }
            case "citations": {
              try {
                const data = JSON.parse(event.data);
                currentCitationsRef.current = data.sources || data || [];
                // 260809-uxk T2: synchronous ref update (see token case).
                const updated = attachCitationsToMessages(messagesRef.current, currentCitationsRef.current);
                messagesRef.current = updated;
                setMessages(updated);
              } catch {
                // Ignore parse errors
              }
              break;
            }
            case "done": {
              // WID-01 D-09: dedup duplicate done events. Key = chatId:messageId
              // (fallback chatId:Date.now() for null messageId). First done wins.
              try {
                const data = JSON.parse(event.data);
                const cid = (data.chatId as string | undefined) ?? chatId ?? "unknown";
                const mid = data.messageId as string | null | undefined;
                if (!shouldProcessDone(doneSeenRef.current, cid, mid)) {
                  break;
                }
              } catch {
                // No/invalid payload — process once with timestamp fallback.
                // Use a synthetic key so a follow-up parsed done with the same
                // chatId+timestamp would still be deduped if it arrives in
                // the same ms; otherwise this is best-effort (isStreaming(false)
                // is idempotent).
                if (!shouldProcessDone(doneSeenRef.current, chatId ?? "unknown", undefined)) {
                  break;
                }
              }
              // WID-03 D-05: persist messages to loader on done (NOT per-token).
              // messagesRef.current holds the latest committed state (tokens
              // updated it via setMessages in the "token" case above).
              if (widgetId && messagesRef.current.length > 0) {
                postStorageToLoader(widgetId, "messages", JSON.stringify(messagesRef.current));
              }
              setIsStreaming(false);
              break;
            }
            case "error": {
              // WID-03 D-05: persist the current conversation snapshot before
              // surfacing the error so the visitor's in-flight exchange isn't
              // lost on a transient failure.
              if (widgetId && messagesRef.current.length > 0) {
                postStorageToLoader(widgetId, "messages", JSON.stringify(messagesRef.current));
              }
              try {
                const data = JSON.parse(event.data);
                setError(data.error || t("chatErrors.streamingFailed"));
              } catch {
                setError(t("chatErrors.streamingFailed"));
              }
              setIsStreaming(false);
              break;
            }
            default:
              break;
          }
        },

        onclose: () => {
          setIsStreaming(false);
        },

        onerror: (err) => {
          setError(err instanceof Error ? err.message : t("chatErrors.connectionLost"));
          setIsStreaming(false);
          throw err;
        },
      });
    } catch (err: unknown) {
      const errorObj = err as { name?: string; message?: string };
      if (errorObj.name !== "AbortError") {
        setError(errorObj.message || t("chatErrors.sendFailed"));
      }
      setIsStreaming(false);
    } finally {
      abortRef.current = null;
    }
  }, [widgetId, chatId, locale]);

  return {
    messages,
    isStreaming,
    error,
    chatId,
    rateLimit,
    sessionLimitReached,
    sessionToken,
    sendMessage,
    abortStream,
    clearError,
  };
}