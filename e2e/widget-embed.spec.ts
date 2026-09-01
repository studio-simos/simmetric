/**
 * E2E-02 — Widget embed lifecycle WID-03 (D-07, D-03 full-mock).
 *
 * Four tests covering the embeddable widget handshake contract fixed in
 * Phase 65 (WID-03) + the Phase 131 BUG-02 verification gate:
 *
 *  Test 1 "iframe mount + session reuse": real widget service :3211 + real
 *   loader script + real iframe + mock ONLY chat SSE. Assert iframe visible
 *   with src containing localhost:3211; assert parent sessionStorage has the
 *   session token key after useWidgetConfig mounts. The panel is opened via
 *   the PARENT-PAGE host FAB (#simmetric-widget button[aria-expanded] — Phase
 *   128-04: the iframe FAB is hidden on real embeds, hostFab=1).
 *
 *  Test 2 "postMessage handshake WID-03 — session + messages persist across
 *   iframe reload": type a message in the iframe chat → mock token renders →
 *   reload the iframe → assert the session token is REUSED (no new
 *   POST /api/sessions after reload) AND previous messages are still visible.
 *   This is the regression for the WID-03 blow-through fix (CR-01). Both
 *   open/close interactions drive the host FAB (it survives the iframe
 *   reload — it lives on the parent page).
 *
 *  Test 3 "NO allow-same-origin sandbox guardrail": assert iframe.sandbox
 *   contains allow-scripts + allow-forms and DOES NOT contain
 *   allow-same-origin. WID-03 security invariant (T-66-01 mitigation).
 *
 *  Test 4 "host-FAB round-trip open → close → reopen (BUG-02, D-01 (a))":
 *   open via the host FAB (aria-expanded false → click → true, panel
 *   textarea visible) → close via the panel header close button (funnels
 *   through notifyOpenState → the loader resets aria-expanded) → false →
 *   click again → true (the FAB stays clickable through open → close →
 *   reopen). Also asserts the BUG-01 44×44px send-button geometry (w-11
 *   h-11, depends_on 131-01) in the real embed.
 *
 * api_keys seeding is handled by globalSetup (Plan 103-01 D-02), which has
 * DATABASE_URL access via dotenv. Worker contexts (this spec file) do NOT
 * have DATABASE_URL, so the previous per-spec api_keys seeding in beforeAll
 * was failing silently — it has been removed. globalSetup seeds the row with
 * a bcrypt-hashed WIDGET_API_KEY matching the root .env before any
 * spec runs.
 *
 * Env-gating: NONE. The chat SSE is full-mock per D-03. The only runtime
 * prerequisite is the widget service :3211 reachable (Playwright webServer
 * starts it via `pnpm --filter widget dev` if not already running).
 *
 * Rule 1 note: the plan's Test 1 said "intercepta request POST
 * /api/internal/widget/<widgetId>/session o verifica via parent eval". The
 * session create endpoint from the iframe's perspective is
 * POST /api/sessions (widget service → server POST /api/internal/widget
 * /session). We assert via parent sessionStorage (the loader's storage
 * handshake writes the session token under sc-widget-<widgetId>-session).
 *
 * Phase 131 (BUG-02) note: the FAB interactions were rewritten from the
 * stale iframe-FAB locator (hidden on real embeds since Phase 128-04) to
 * the parent-page host FAB, and the silent isVisible-with-catch-false
 * guards were deleted — a missing/unclickable FAB now fails the test loudly
 * instead of masking the panel-closed state (131-RESEARCH Pitfall 1).
 */

import { test, expect } from "./fixtures";

const SERVER_URL = "http://localhost:3000";

test.describe("E2E-02 — Widget embed lifecycle WID-03 (D-07, D-03 full-mock)", () => {
  // License-tier probe (quick 260831-sqr): every route this suite touches is
  // gated by the widget_enabled license flag (402 on Community — the widget
  // service maps it to 503). A valid Enterprise JWT cannot exist in the public
  // repo's CI by design (the signing key lives only in the private
  // simmetric-license-tool repo, and the verifier deliberately has no env
  // override), so Community CI skips the suite cleanly instead of failing.
  // Local runs with an Enterprise LICENSE_KEY in the root .env run it fully.
  test.beforeAll(async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/license/info`, { timeout: 10000 });
    if (res.ok()) {
      const info = (await res.json()) as { tier?: string };
      if (info.tier !== "enterprise") {
        test.skip(true, "Enterprise license required (Community build — widget_enabled is off)");
      }
    }
  });

  test("iframe mount + seeded session reuse (real widget service :3211, TST-01)", async ({ widgetPage }) => {
    // widgetPage fixture (from ./fixtures, TST-01):
    //   - reads process.env.E2E_WIDGET_ID (globalSetup seed)
    //   - registers mockCollector on the widget chat SSE pattern (D-03 mock)
    //   - obtains a REAL session token via POST http://localhost:3211/api/sessions
    //     (a WidgetSession DB row — validateSession requires it)
    //   - seeds BOTH audited keys (sc-widget-<id>-session + sc-widget-<id>-messages)
    //     in the PARENT sessionStorage via addInitScript BEFORE the loader runs
    //   - navigates to the REAL-origin host page on :5173
    //     (packages/frontend/public/e2e-widget-host.html — never page.route
    //     synthesis, never page.setContent; D-06 PNA fix)
    //   - waits for iframe[src*="localhost:3211"] to mount
    // The loader, iframe HTML, config fetch, and session create all run
    // against the REAL widget service :3211 (D-07).

    const widgetId = process.env.E2E_WIDGET_ID;
    expect(widgetId, "E2E_WIDGET_ID must be seeded by globalSetup").toBeTruthy();

    // WR-02 (131-REVIEW.md): the session-create counter is registered in the
    // widgetPage FIXTURE via page.route("**/api/sessions") BEFORE the iframe
    // mounts — the loader handshake (mount → requestStorageFromLoader → cache
    // hit vs fall-through to POST /api/sessions) completes during fixture
    // setup, so a test-body counter would be vacuous. The fixture's own
    // APIRequestContext POST (session token seeding) is NOT intercepted by
    // page.route (browser-originated requests only), so the count below is
    // exactly the iframe's browser-side creates.
    const sessionCreateCount = (widgetPage as any).__sessionCreateCount.value as number;

    // Iframe mounted with src pointing at the widget service.
    const iframe = widgetPage.locator('iframe[src*="localhost:3211"]').first();
    await expect(iframe).toBeVisible({ timeout: 10000 });

    // The seeded session key parses to a 256-bit hex WidgetSession token
    // (the shape POST /api/sessions returns — RESEARCH KF-4).
    const sessionKey = `sc-widget-${widgetId}-session`;
    const seededRaw = await widgetPage.evaluate((k) => sessionStorage.getItem(k), sessionKey);
    expect(seededRaw, "seeded session key must be present").toBeTruthy();
    const seededToken = (JSON.parse(seededRaw as string) as { token: string }).token;
    expect(seededToken).toMatch(/^[0-9a-f]{64}$/);

    // Phase 128-04: the clickable FAB lives on the PARENT page (the iframe
    // FAB is hidden on real embeds — hostFab=1). Drive
    // #simmetric-widget button[aria-expanded] — never a frame locator
    // (131-RESEARCH Pitfall 1). The chat panel starts closed.
    const frame = widgetPage.frameLocator('iframe[src*="localhost:3211"]');
    const hostFab = widgetPage.locator("#simmetric-widget button[aria-expanded]");
    await expect(hostFab).toHaveAttribute("aria-expanded", "false");
    await hostFab.click();
    await expect(hostFab).toHaveAttribute("aria-expanded", "true");
    await expect(frame.locator("textarea")).toBeVisible({ timeout: 10000 });
    await expect(frame.locator("text=Seeded answer").first()).toBeVisible({ timeout: 10000 });

    // ZERO new POST /api/sessions — the seeded token is reused (WID-03 CR-01).
    // The counter covers the FULL handshake including the fixture-time iframe
    // mount (WR-02 — the old test-body counter could not fail).
    expect(sessionCreateCount, "seeded token reused — no new POST /api/sessions").toBe(0);
  });

  test("postMessage handshake WID-03 — session + messages persist across iframe reload (TST-01)", async ({ widgetPage }) => {
    const widgetId = process.env.E2E_WIDGET_ID;
    expect(widgetId).toBeTruthy();
    const sessionKey = `sc-widget-${widgetId}-session`;
    const messagesKey = `sc-widget-${widgetId}-messages`;

    // Seeded-value assertion (KF-5): the fixture seeded the session key before
    // the loader ran — assert its shape instead of polling for it to appear.
    const initialTokenRaw = await widgetPage.evaluate((k) => sessionStorage.getItem(k), sessionKey);
    expect(initialTokenRaw, "seeded session key must be present").toBeTruthy();
    const initialToken = (JSON.parse(initialTokenRaw as string) as { token: string }).token;
    expect(initialToken).toMatch(/^[0-9a-f]{64}$/);

    // D-05 throttle count (the audit's exactness check, secondary gate per
    // OQ4/A1): register BEFORE typing. The seeded path never writes session
    // (the create-path post at useWidgetChat.ts:199 does not fire) and writes
    // exactly ONE messages storage-set on done.
    //
    // WR-03 (131-REVIEW.md): Playwright's Page has NO "message" event — the
    // old page.on("message") listener could never fire, so the D-05 throttle
    // assertions were dead code. The correct mechanism for observing
    // cross-window postMessage from the parent page is a DOM listener
    // installed via evaluate: window.addEventListener("message", …) writing
    // to a page-exposed counter. The iframe posts simmetric:storage-set to
    // window.parent (the host page) with the SHORT key ("messages"/"session"
    // — useWidgetChat.ts:96; the loader maps it to the full
    // sc-widget-<id>-<key> sessionStorage key) — the listener below sees
    // every one.
    await widgetPage.evaluate(() => {
      (window as any).__storageSets = {};
      window.addEventListener("message", (ev) => {
        const d = ev.data as { type?: string; key?: string } | undefined;
        if (d?.type === "simmetric:storage-set" && d.key) {
          (window as any).__storageSets[d.key] = ((window as any).__storageSets[d.key] ?? 0) + 1;
        }
      });
    });

    // Type a message in the iframe chat input and send. The iframe src is
    // <baseUrl>/<widgetId>?... — frameLocator targets the iframe content.
    const frame = widgetPage.frameLocator('iframe[src*="localhost:3211"]');
    // Phase 128-04: open the panel via the PARENT-page host FAB (the iframe
    // FAB is hidden on real embeds). The Preact InputBar renders a textarea
    // for the chat input once the panel is open.
    const hostFab = widgetPage.locator("#simmetric-widget button[aria-expanded]");
    await expect(hostFab).toHaveAttribute("aria-expanded", "false");
    await hostFab.click();
    await expect(hostFab).toHaveAttribute("aria-expanded", "true");

    const chatInput = frame.locator("textarea").first();
    await expect(chatInput).toBeVisible({ timeout: 10000 });
    // The PII consent gate disables the input until "I understand" is clicked
    // (ChatPanel.tsx:174 disabled={!hasConsented}). The consent prompt only
    // renders on textarea focus (ChatPanel.tsx:54-58 handleInputFocus →
    // setShowPIIPrompt(true)) — and the seeded path never focuses the input,
    // so the prompt never appears and the old isVisible-guarded click was a
    // guaranteed miss. dispatchEvent("focus") fires Preact's direct onFocus
    // listener even on a disabled textarea (programmatic dispatch is not
    // gated by the disabled attribute — only user-initiated focus is). The
    // click itself is frameLocator interaction (audit §3.4: DOM consent
    // banner behavior MAY be asserted; only the sc-consent key itself is
    // off-limits — never asserted, never seeded).
    await chatInput.dispatchEvent("focus");
    const consentBtn = frame.getByRole("button", { name: "I understand" });
    await expect(consentBtn).toBeVisible({ timeout: 5000 });
    await consentBtn.click();
    await expect(chatInput).toBeEnabled({ timeout: 5000 });
    await chatInput.fill("hello");
    await chatInput.press("Enter");

    // The mock SSE chat emits tokens "Hello", " world", "!" + done. Wait for
    // the assistant message to render inside the iframe.
    await expect(frame.locator("text=Hello world!").first()).toBeVisible({ timeout: 15000 });

    // WID-03 D-05: on `done`, the iframe persists messages to the loader's
    // sessionStorage via postMessage simmetric:storage-set. PRIMARY gate (OQ4):
    // the messages key parses to an array CONTAINING the new user message
    // "hello" — and the seeded "Seeded question"/"Seeded answer" are still
    // present (the seeded path hydrates then appends).
    await expect.poll(
      async () => {
        const raw = await widgetPage.evaluate((k) => sessionStorage.getItem(k), messagesKey);
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw) as Array<{ role: string; content: string }>;
          return parsed.map((m) => m.content);
        } catch {
          return null;
        }
      },
      { timeout: 8000, intervals: [500, 1000] }
    ).toEqual(expect.arrayContaining(["hello", "Seeded question", "Seeded answer"]));

    // Count POST /api/sessions requests on this page before reload. The
    // widgetPage fixture mocks the chat SSE, but /api/sessions hits the real
    // widget service :3211. We'll count via request interception.
    let sessionCreateCount = 0;
    widgetPage.on("request", (req) => {
      if (req.url().includes("/api/sessions") && req.method() === "POST") {
        sessionCreateCount++;
      }
    });

    // RELOAD the iframe by re-setting its src (this re-runs the loader
    // handshake; the iframe asks the loader for cached storage; the loader
    // returns the existing session token; the iframe must REUSE it without
    // creating a new session — WID-03 CR-01 fix).
    await widgetPage.evaluate((wId) => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[src*="localhost:3211"]');
      if (!iframe) throw new Error("iframe not found for reload");
      // Reset src to force a fresh load of the iframe document.
      const src = iframe.src;
      iframe.src = "about:blank";
      // Restore on next tick so the iframe re-fetches.
      setTimeout(() => { iframe.src = src; }, 100);
      void wId;
    }, widgetId);

    // Wait for the iframe to re-mount with the widget service URL.
    await widgetPage.waitForSelector('iframe[src*="localhost:3211"]', { timeout: 10000 });
    // The reloaded widget remounts with the chat panel CLOSED (App.tsx
    // isOpen=false) — the iframe's initial mount posts simmetric:widgetClose, so
    // the host FAB flips back to aria-expanded=false. The FAB itself survives
    // the iframe reload (it lives on the parent page — the loader re-appends
    // it only if the container is rebuilt, which it isn't on iframe-only
    // reload). The aria-expanded expect auto-waits past the iframe
    // re-navigation, then the click reopens the panel. Deterministic waits
    // only (Pitfall 9) — no isVisible-with-catch-false guards
    // (131-RESEARCH Pitfall 1).
    const reloadedFrame = widgetPage.frameLocator('iframe[src*="localhost:3211"]');
    await expect(hostFab).toHaveAttribute("aria-expanded", "false");
    await hostFab.click();
    await expect(hostFab).toHaveAttribute("aria-expanded", "true");
    await expect(reloadedFrame.locator("text=Seeded answer").first()).toBeVisible({ timeout: 10000 });

    // Assert: the session token in parent sessionStorage is UNCHANGED
    // (i.e., the iframe reused the cached token, not a new one).
    const postReloadTokenRaw = await widgetPage.evaluate(
      (k) => sessionStorage.getItem(k),
      sessionKey
    );
    expect(postReloadTokenRaw).toBeTruthy();
    const postReloadToken = (JSON.parse(postReloadTokenRaw as string) as { token: string }).token;
    expect(postReloadToken).toBe(initialToken);

    // Assert: no new POST /api/sessions was issued after reload (the
    // handshake returned the cached token, so useWidgetChat did not fall
    // through to create a new session). Tolerate exactly 0 new session
    // creates — WID-03 CR-01 invariant.
    expect(sessionCreateCount, "no new POST /api/sessions after iframe reload (WID-03 reuse)").toBe(0);

    // D-05 throttle (secondary gate per OQ4/A1): exactly ONE messages
    // storage-set and ZERO session storage-sets in the seeded path. The
    // counter is the DOM window.addEventListener("message") listener
    // installed above (WR-03 — the old page.on("message") could never fire).
    // The iframe posts the SHORT key ("messages"/"session" — the loader maps
    // it to the full sc-widget-<id>-<key> sessionStorage key), so the lookup
    // uses the short key, not the full sessionStorage key. If the DOM
    // listener proves unreliable in this Chromium (A1), the storage-content
    // assertions above remain the gate — log a warning instead of failing on
    // the count alone.
    const storageSetCounts = await widgetPage.evaluate(
      () => (window as any).__storageSets as Record<string, number>
    );
    const messagesSets = storageSetCounts?.["messages"] ?? 0;
    const sessionSets = storageSetCounts?.["session"] ?? 0;
    if (messagesSets === 0 && sessionSets === 0) {
      console.warn(
        "[widget-embed] A1 fallback: no simmetric:storage-set messages observed — " +
        "storage-content assertions remain the gate"
      );
    } else {
      expect(messagesSets, "exactly one messages storage-set on done (D-05 throttle)").toBe(1);
      expect(sessionSets, "zero session storage-sets in the seeded path (token reuse)").toBe(0);
    }

    // Assert: previous messages are still visible in the reloaded iframe
    // (useWidgetChat hydrates from the cached messages payload).
    await expect(reloadedFrame.locator("text=hello").first()).toBeVisible({ timeout: 10000 });
  });

  test("NO allow-same-origin sandbox guardrail (WID-03 security invariant)", async ({ widgetPage }) => {
    // WID-03 T-66-01 mitigation: the iframe MUST be sandboxed with
    // allow-scripts + allow-forms and MUST NOT contain allow-same-origin.
    // Without this guardrail, the sandboxed iframe could access parent-page
    // sessionStorage directly (same-origin) and read/inject session tokens
    // for any widget on the page. The loader sets the sandbox attribute
    // verbatim (packages/widget/src/routes/loader.ts:32).
    const sandbox = await widgetPage.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[src*="localhost:3211"]');
      if (!iframe || !iframe.sandbox) return null;
      return Array.from(iframe.sandbox);
    });
    expect(sandbox, "iframe must have a sandbox attribute").not.toBeNull();
    expect(sandbox as string[]).toContain("allow-scripts");
    expect(sandbox as string[]).toContain("allow-forms");
    expect(sandbox as string[]).not.toContain("allow-same-origin");
  });

  test("host-FAB round-trip open → close → reopen (BUG-02, D-01 (a))", async ({ widgetPage }) => {
    // BUG-02 (D-01 (a), UI-SPEC Interaction 8): the host FAB must drive the
    // full round-trip — aria-expanded false → click → true (panel textarea
    // visible) → close via the panel header button → false → click again →
    // true. The FAB stays clickable through open → close → reopen.
    const frame = widgetPage.frameLocator('iframe[src*="localhost:3211"]');
    const hostFab = widgetPage.locator("#simmetric-widget button[aria-expanded]");

    // Open via the host FAB.
    await expect(hostFab).toHaveAttribute("aria-expanded", "false");
    await hostFab.click();
    await expect(hostFab).toHaveAttribute("aria-expanded", "true");
    await expect(frame.locator("textarea")).toBeVisible({ timeout: 10000 });

    // BUG-01 (depends_on 131-01): the InputBar send button must render at
    // 44×44px (w-11 h-11) in the real embed — the e2e proof the class change
    // landed (not 36×36).
    const sendButton = frame.locator('button[aria-label="Send message"]');
    await expect(sendButton).toBeVisible({ timeout: 10000 });
    const box = await sendButton.boundingBox();
    expect(box, "send button must have a bounding box").not.toBeNull();
    expect(box!.width).toBeCloseTo(44, 0);
    expect(box!.height).toBeCloseTo(44, 0);

    // BUG-03 (D-03): the interactive surfaces render inline SVGs — the send
    // button (viewBox 0 0 16 16, InputBar.tsx:83) and the panel header close
    // (ChatHeader.tsx:56-67). The LeadCaptureCard X-SVG cannot be asserted
    // here (lead capture is off on the seeded widget) — the 131-01 static
    // grep + the 131-04 human-UAT item cover that surface.
    await expect(frame.locator('button[aria-label*="Send"] svg')).toBeVisible();
    await expect(frame.locator('button[aria-label*="Send"] svg[viewBox="0 0 16 16"]')).toBeVisible();
    await expect(frame.locator('button[aria-label="Close chat"] svg')).toBeVisible();

    // Residual clickability audit (D-01 (b), UI-SPEC Interaction 10): with
    // the panel OPEN, every interactive surface must be clickable — no
    // overlay intercepts, no pointer-events leak, no z-index stacking
    // defect. The click succeeding IS the audit for stacking.
    //
    // The PII consent gate disables the textarea until "I understand" is
    // clicked (ChatPanel.tsx:174). dispatchEvent("focus") fires Preact's
    // direct onFocus listener even on a disabled textarea (programmatic
    // dispatch is not gated by the disabled attribute), which surfaces the
    // consent prompt — same pattern as Test 2.
    const chatInput = frame.locator("textarea").first();
    await chatInput.dispatchEvent("focus");
    const consentBtn = frame.getByRole("button", { name: "I understand" });
    await expect(consentBtn).toBeVisible({ timeout: 5000 });
    await consentBtn.click();
    await expect(chatInput).toBeEnabled({ timeout: 5000 });
    // Textarea click → focused (no overlay intercepts the input).
    await chatInput.click();
    await expect(chatInput).toBeFocused();
    // Credits anchor click → no throw (the relay fires; the real popup is a
    // 131-04 human-UAT item — D-05).
    await frame.getByRole("link", { name: /Powered by Simmetric Chat/ }).click();
    // FAB-side z-index contract (UI-SPEC Interaction 9): the FAB is a
    // parent-page node — evaluate is allowed. The PANEL's z-[999998] lives
    // INSIDE the opaque iframe and cannot be read from the parent
    // (SecurityError); its value is string-pinned by loader.test.ts/chatPanel
    // source, and the "FAB never covered by the panel" behavior is proven by
    // the FAB staying clickable with the panel open (the panel's bottom-24
    // geometry sits above the FAB's bottom-20 position by design).
    const fabZIndex = await widgetPage.evaluate(
      () => getComputedStyle(document.querySelector("#simmetric-widget button[aria-expanded]")!).zIndex
    );
    expect(fabZIndex).toBe("999999");

    // Close via the panel header close button (t("chat.closeLabel") — also
    // funnels through notifyOpenState → the loader resets aria-expanded).
    await frame.locator('button[aria-label="Close chat"]').click();
    await expect(hostFab).toHaveAttribute("aria-expanded", "false");

    // Reopen — the FAB must still be clickable.
    await hostFab.click();
    await expect(hostFab).toHaveAttribute("aria-expanded", "true");
    await expect(frame.locator("textarea")).toBeVisible({ timeout: 10000 });
  });

  test("credits relay fires window.open with the default URL (CRD-03 automated half)", async ({ widgetPage }) => {
    // CRD-03 (D-05): the automated half of the credits-relay verification —
    // the sandboxed iframe (allow-scripts allow-forms, no allow-popups)
    // cannot window.open itself; the credits anchor funnels through
    // notifyCreditsOpen → the WR-01-guarded loader relay (loader.ts:482-497)
    // → window.open on the HOST page. Stub window.open on the host page via
    // addInitScript (applies to the next navigation), then reload so the
    // loader runs with the stub in place. The REAL new-tab open stays a
    // 131-04 human-UAT item (popup blockers require a direct user gesture —
    // a postMessage-relayed window.open can return null).
    await widgetPage.addInitScript(() => {
      (window as any).__creditsOpened = null;
      window.open = (url: string) => { (window as any).__creditsOpened = url; return null as any; };
    });
    await widgetPage.reload();
    await widgetPage.waitForSelector('iframe[src*="localhost:3211"]', { timeout: 10000 });

    const frame = widgetPage.frameLocator('iframe[src*="localhost:3211"]');
    const hostFab = widgetPage.locator("#simmetric-widget button[aria-expanded]");
    await expect(hostFab).toHaveAttribute("aria-expanded", "false");
    await hostFab.click();
    await expect(hostFab).toHaveAttribute("aria-expanded", "true");

    // The seeded E2E widget has credits:null → the anchor falls back to the
    // default label "Powered by Simmetric Chat" and the default URL
    // https://simmetric.chat (ChatPanel.tsx:196, A6).
    await frame.getByRole("link", { name: /Powered by Simmetric Chat/ }).click();
    await expect.poll(() => widgetPage.evaluate(() => (window as any).__creditsOpened)).toBe("https://simmetric.chat");
  });
});
