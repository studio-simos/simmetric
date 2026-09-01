// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

/**
 * EnterpriseModules.test.tsx — Phase 147 (EPA-11) D-15.
 *
 * Covers:
 *   D-15a: useEnterpriseModules 200 → enterpriseInstalled=true +
 *          modules=["sso","audit","backup","white-label"]
 *   D-15b: useEnterpriseModules 404 → enterpriseInstalled=false + modules=[]
 *          (retry:false — apiGet called exactly once)
 *   D-15c: /logs route element with enterpriseInstalled=true + tier="enterprise"
 *          + effectiveMenuSections including "eventLog" → renders the lazy
 *          EventLogPanel inside a <Suspense> boundary (mock the lazy component
 *          to a synchronous div — Pitfall 4: @swc/jest does NOT code-split)
 *   D-15d: /logs route element with enterpriseInstalled=false +
 *          effectiveMenuSections including "eventLog" → renders <UpgradePrompt
 *          feature="audit_log_immutable" message={t("upgrade.pluginRequired")} />
 *
 * Modeled on `useLicense.test.tsx` (TanStack Query hook harness) +
 * `App.test.tsx` (i18n mock pattern). EventLogPanel is mocked to render
 * synchronously to avoid the React.lazy + Suspense-in-Jest pitfall (Pitfall 4).
 *
 * Phase 147 (EPA-11) — Plan 01 Task 2
 */

// Mock i18next before any imports — App.test.tsx pattern.
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Mock the lazy EventLogPanel to a synchronous div so React.lazy +
// Suspense works in Jest without async chunk resolution (Pitfall 4:
// @swc/jest does NOT code-split; the mock renders synchronously).
jest.mock("../components/EventLogPanel", () => () => (
  <div data-testid="event-log-panel">EventLog</div>
));

const mockApiGet = jest.fn();

jest.mock("../queries/api", () => ({
  apiGet: (...args: Parameters<typeof mockApiGet>) => mockApiGet(...args),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { renderHook, waitFor, render, screen, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { useEnterpriseModules } from "../hooks/useEnterpriseModules";
import { queryKeys } from "../queries/keys";
import type { AuthUser } from "../queries/useAuth";
import {
  EnterpriseModulesContext,
  EnterpriseModulesProvider,
} from "../contexts/EnterpriseModulesContext";

const ENTERPRISE_MANIFEST = { modules: ["sso", "audit", "backup", "white-label"] };

// Minimal truthy AuthUser-shaped object — `me` is only a session signal for
// the hook's `hasSession` computation (quick 260831-nzf), so a skeletal user
// suffices.
const fakeUser: AuthUser = {
  id: "u1",
  username: "admin",
  email: "admin@example.com",
  firstName: null,
  lastName: null,
  avatar: null,
  customInstructions: null,
  textSize: null,
  mustChangePassword: false,
  roles: [{ id: "r1", name: "admin", isDefault: true }],
  permissions: [],
};

/**
 * Shared harness (quick 260831-nzf): creates the QueryClient AND returns a
 * wrapper that provides it, so tests can drive the auth transition via
 * `queryClient.setQueryData(queryKeys.auth.me, ...)`.
 */
function createHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
  return { queryClient, wrapper };
}

/**
 * Path-keyed `apiGet` mock (quick 260831-nzf). `useMe` now ALSO consumes the
 * `apiGet` mock (via `useEnterpriseModules` → `useMe`), so sequence-based
 * `mockResolvedValueOnce` mocks become order-dependent between `/auth/me`
 * and `/enterprise/modules`. Keying on the requested path removes the
 * ordering coupling. Per-test overrides still work by re-calling
 * `mockApiGet.mockImplementation(...)` with a different implementation.
 */
function mockApiGetByPath(overrides: Record<string, () => unknown> = {}) {
  mockApiGet.mockImplementation((path: string) => {
    if (path === "/auth/me") return Promise.resolve(fakeUser);
    if (path === "/enterprise/modules") return Promise.resolve(ENTERPRISE_MANIFEST);
    const override = overrides[path];
    if (override) return override();
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

// ─── quick 260831-nzf: auth-gated, session-reactive manifest query ────
//
// The hook subscribes to `useMe()` (session signal) and gates the manifest
// query on `hasSession` (me-data OR a stored token). Three truths:
//   Test A — no session ⇒ NO manifest probe at all (the old hook fired an
//            unauthenticated 401 probe at boot on the login screen).
//   Test B — an in-SPA login transition (token + me-data landing in the
//            cache) re-triggers the manifest fetch and flips
//            `enterpriseInstalled` to true (the actual reported bug).
//   Test C — a 404 WITH a session stays false (community-build semantics
//            are unchanged — no behavior regression from the gating).
//   Test D — a stored token alone (page reload path) starts the manifest
//            fetch at boot in parallel with /auth/me (no request waterfall).

describe("useEnterpriseModules — auth-gated + session-reactive (260831-nzf)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it("Test A: no stored token → manifest is never probed, enterpriseInstalled=false", async () => {
    mockApiGetByPath();

    const { wrapper } = createHarness();
    const { result } = renderHook(() => useEnterpriseModules(), { wrapper });

    // Give any (erroneous) pending fetch a chance to land before asserting
    // the absence of the probe.
    await act(async () => {});

    const manifestCalls = mockApiGet.mock.calls.filter(
      (call) => call[0] === "/enterprise/modules",
    );
    expect(manifestCalls).toHaveLength(0);
    expect(result.current.enterpriseInstalled).toBe(false);
    expect(result.current.modules).toEqual([]);
  });

  it("Test B: in-SPA login transition (token + me cache write) refetches the manifest → enterpriseInstalled=true", async () => {
    mockApiGetByPath();

    // Boot unauthenticated — no probe (Test A truth).
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(() => useEnterpriseModules(), { wrapper });
    await act(async () => {});
    expect(mockApiGet.mock.calls.filter((c) => c[0] === "/enterprise/modules")).toHaveLength(0);

    // Simulate the useLogin.onSuccess transition: token stored + me-data
    // written to the cache (queries/useAuth.ts setQueryData path). TanStack
    // re-renders the provider, `enabled` flips false→true, the manifest
    // query fires with the Authorization header attached.
    await act(async () => {
      localStorage.setItem("token", "jwt-x");
      queryClient.setQueryData(queryKeys.auth.me, fakeUser);
    });

    await waitFor(() => expect(result.current.enterpriseInstalled).toBe(true));
    expect(result.current.modules).toEqual([
      "sso",
      "audit",
      "backup",
      "white-label",
    ]);
    expect(mockApiGet).toHaveBeenCalledWith("/enterprise/modules");
  });

  it("Test C: 404 with a session → enterpriseInstalled=false, modules=[] (community semantics unchanged)", async () => {
    localStorage.setItem("token", "jwt-x");
    const { ApiError } = await import("../queries/api");
    mockApiGetByPath({
      "/enterprise/modules": () => Promise.reject(new ApiError(404, "Not found")),
    });

    const { wrapper } = createHarness();
    const { result } = renderHook(() => useEnterpriseModules(), { wrapper });

    await waitFor(() => expect(result.current.enterpriseInstalled).toBe(false));
    expect(result.current.modules).toEqual([]);
    // retry:false — the manifest path is called exactly once, no retries.
    const manifestCalls = mockApiGet.mock.calls.filter(
      (call) => call[0] === "/enterprise/modules",
    );
    expect(manifestCalls).toHaveLength(1);
  });

  it("Test D: stored token only (reload path) → manifest fetched at boot (no auth transition needed)", async () => {
    localStorage.setItem("token", "jwt-x");
    mockApiGetByPath();

    const { wrapper } = createHarness();
    const { result } = renderHook(() => useEnterpriseModules(), { wrapper });

    await waitFor(() => expect(result.current.enterpriseInstalled).toBe(true));
    expect(result.current.modules).toEqual(ENTERPRISE_MANIFEST.modules);
  });
});

// ─── D-15a / D-15b: hook behavior ────────────────────────────────────

describe("useEnterpriseModules (D-15a/b)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // quick 260831-nzf: the query is auth-gated now — seed a token so the
    // manifest fetch is enabled (post-fix, a token-less render would leave
    // the query disabled and D-15a would never observe the 200).
    localStorage.clear();
    localStorage.setItem("token", "test-token");
  });

  it("D-15a: 200 → enterpriseInstalled=true + modules manifest", async () => {
    mockApiGetByPath();

    const { wrapper } = createHarness();
    const { result } = renderHook(() => useEnterpriseModules(), { wrapper });

    await waitFor(() => expect(result.current.enterpriseInstalled).toBe(true));
    expect(result.current.modules).toEqual(["sso", "audit", "backup", "white-label"]);
    expect(mockApiGet).toHaveBeenCalledWith("/enterprise/modules");
  });

  it("D-15b: 404 → enterpriseInstalled=false + modules=[] (retry:false — single call)", async () => {
    const { ApiError } = await import("../queries/api");
    mockApiGetByPath({
      "/enterprise/modules": () => Promise.reject(new ApiError(404, "Not found")),
    });

    const { wrapper } = createHarness();
    const { result } = renderHook(() => useEnterpriseModules(), { wrapper });

    await waitFor(() => expect(result.current.enterpriseInstalled).toBe(false));
    expect(result.current.modules).toEqual([]);
    // retry:false — the manifest path is called exactly once, no retries.
    // (The bare toHaveBeenCalledTimes(1) no longer holds: `/auth/me` may
    // also be called when the query is enabled.)
    const manifestCalls = mockApiGet.mock.calls.filter(
      (call) => call[0] === "/enterprise/modules",
    );
    expect(manifestCalls).toHaveLength(1);
    expect(mockApiGet).toHaveBeenCalledWith("/enterprise/modules");
  });
});

// ─── D-15c / D-15d: conditional route rendering ───────────────────────
//
// The /logs route element in App.tsx is a ternary on:
//   effectiveMenuSections.includes("eventLog")
//     ? (enterpriseInstalled && tier === "enterprise"
//         ? <Suspense><EventLogPanel/></Suspense>
//         : <UpgradePrompt feature="audit_log_immutable"
//             message={!enterpriseInstalled ? t("upgrade.pluginRequired") : undefined} />)
//     : <Navigate to="/" />
//
// We exercise the ternary directly by rendering a small harness that
// mounts the EnterpriseModulesContext.Provider with a fixed value and
// imports the App route element. To keep the test isolated from the full
// App boot (which pulls in many providers/queries), we replicate the
// route element expression in a tiny component under test. This is the
// recommended pattern from the plan ("extract the /logs route element
// logic into a small test component OR test the conditional rendering by
// rendering <EnterpriseModulesContext.Provider value={...}> + the route
// element expression").

import { Suspense } from "react";
import { Navigate } from "react-router-dom";
import { lazy } from "react";
import UpgradePrompt from "../components/UpgradePrompt";
import { useTranslation } from "react-i18next";

// EventLogPanel is already mocked above to a synchronous div.
const EventLogPanel = lazy(() => import("../components/EventLogPanel"));

function EnterpriseSpinner() {
  return <div className="p-6 text-muted-foreground">Loading…</div>;
}

interface LogsRouteProps {
  enterpriseInstalled: boolean;
  tier: "community" | "enterprise";
  effectiveMenuSections: string[];
}

function LogsRoute({ enterpriseInstalled, tier, effectiveMenuSections }: LogsRouteProps) {
  const { t } = useTranslation();
  return effectiveMenuSections.includes("eventLog") ? (
    enterpriseInstalled && tier === "enterprise" ? (
      <Suspense fallback={<EnterpriseSpinner />}>
        <EventLogPanel />
      </Suspense>
    ) : (
      <UpgradePrompt
        feature="audit_log_immutable"
        message={!enterpriseInstalled ? t("upgrade.pluginRequired") : undefined}
      />
    )
  ) : (
    <Navigate to="/" />
  );
}

function renderWithProviders(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("/logs route element (D-15c/d)", () => {
  it("D-15c: enterpriseInstalled=true + tier=enterprise + eventLog section → renders lazy EventLogPanel", async () => {
    renderWithProviders(
      <LogsRoute
        enterpriseInstalled={true}
        tier="enterprise"
        effectiveMenuSections={["eventLog"]}
      />,
    );
    // The mocked EventLogPanel renders synchronously inside Suspense.
    expect(await screen.findByTestId("event-log-panel")).toBeInTheDocument();
  });

  it("D-15d: enterpriseInstalled=false + eventLog section → renders UpgradePrompt with upgrade.pluginRequired message", async () => {
    renderWithProviders(
      <LogsRoute
        enterpriseInstalled={false}
        tier="community"
        effectiveMenuSections={["eventLog"]}
      />,
    );
    // The i18n mock returns the key string verbatim.
    expect(await screen.findByText("upgrade.pluginRequired")).toBeInTheDocument();
  });
});

// ─── Provider wiring smoke test ───────────────────────────────────────

describe("EnterpriseModulesProvider (D-06)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // quick 260831-nzf: auth-gated query — seed a token so the provider's
    // manifest fetch is enabled (same adaptation as D-15a/b).
    localStorage.clear();
    localStorage.setItem("token", "test-token");
  });

  it("exposes the hook value via context (200 → enterpriseInstalled=true)", async () => {
    mockApiGetByPath();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    let captured: { enterpriseInstalled: boolean; modules: string[] } | null = null;
    function Consumer() {
      const ctx = require("../contexts/EnterpriseModulesContext").useEnterpriseModulesContext();
      captured = ctx;
      return null;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <EnterpriseModulesProvider>
          <Consumer />
        </EnterpriseModulesProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(captured?.enterpriseInstalled).toBe(true));
    expect(captured?.modules).toEqual(["sso", "audit", "backup", "white-label"]);
  });
});