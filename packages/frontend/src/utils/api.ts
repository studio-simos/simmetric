// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Shared API client — wraps fetch with auth headers and error handling.
 */

const API_BASE = "/api";

function getToken(): string | null {
  return localStorage.getItem("token");
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Shape of the canonical error envelope (utils/httpError.ts on the server):
 * `{ error: { code, message, details?, requestId } }`. Legacy endpoints may
 * still answer `{ error: "<prose>" }` — both are accepted here (dual-read
 * while the server-side migration is in flight).
 */
export interface ApiErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
  requestId?: string | null;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const rawError: unknown = (body as { error?: unknown }).error;
    // Dual-read: nested canonical envelope (object) vs legacy prose (string).
    let message: string;
    let details: unknown;
    let code: string | undefined;
    let requestId: string | null | undefined;
    if (rawError !== null && typeof rawError === "object") {
      const env = rawError as ApiErrorBody;
      message = env.message ?? res.statusText;
      code = env.code;
      requestId = env.requestId;
      details = env.details;
    } else {
      message = (rawError as string | undefined) || res.statusText;
      details = body;
    }
    throw new ApiError(res.status, message, details, code, requestId);
  }
  return res.json();
}

export class ApiError extends Error {
  status: number;
  details: unknown;
  /** Machine-readable error code (canonical envelope only; undefined for legacy prose bodies). */
  code?: string;
  /** Server correlation id (echoes the X-Request-Id response header). */
  requestId?: string | null;

  constructor(
    status: number,
    message: string,
    details?: unknown,
    code?: string,
    requestId?: string | null,
  ) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
    this.requestId = requestId;
  }
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  return handleResponse<T>(res);
}

export async function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "GET" });
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function apiDelete<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "DELETE" });
}

export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: formData,
  });
  return handleResponse<T>(res);
}