# Workspace Access & Roles (Phase 189)

Operator-facing reference for the workspace isolation and role-granting model introduced by Phase 189 (WSIS-01…04). It documents the role model, the API surface, the exemption semantics, the shadow-mode history behind the enforcement flip, the upload exception, the widget seam, and the LDAP forward-contract. No code dumps — for implementation details see the code seams referenced inline.

---

## 1. The three roles (D-06)

Every user's effective role on a workspace is resolved per request by a single resolver (`resolveWorkspaceRole`, `packages/server/src/middleware/rbac.ts`).

| Role | Can do | Cannot do |
|------|--------|-----------|
| **owner** | Everything: settings, share/grant/revoke, delete, folder CRUD, chats, uploads | — |
| **editor** | Create/edit chats, upload documents, folder CRUD, workspace settings update | Share (grant/revoke), delete the workspace |
| **viewer** | Read chats/documents/workspace list | Create chats, upload, write anything |

**Resolution precedence** (D-08/D-09/D-10 — first match wins):

1. **Admin** — platform admins resolve `admin` and bypass graded checks (except the upload exception, §4).
2. **Implicit owner** — the user who created the workspace's parent project (`project.createdBy`) is ALWAYS owner; no access row is required, and no row role can outrank it.
3. **Persisted row role `owner`** — external promoted users (an explicit `WorkspaceAccess` row with `role: "owner"`).
4. **Persisted row role** — `WorkspaceAccess.role` (`editor` | `viewer`).
5. **ProjectAccess-implied editor** — a project-level grant implies **editor** on every workspace of the project (D-10: can create chats/upload, cannot share). No rows are materialized.
6. **None** — the workspace is invisible to the user (list endpoints hide it; direct access returns the same shapes the binary gate always produced).

## 2. Endpoints (WSIS-03)

All under `/api/workspaces/:workspaceId/access`, gated to the **project owner or an admin**:

| Endpoint | Behavior |
|----------|----------|
| `POST /access` | Grant/upgrade one user. Body `{ userId, role }` (role: `owner`/`editor`/`viewer`). Persists `role` + `grantedBy` (the caller) and returns `{ message, role }`. |
| `POST /access/bulk` | Atomic multi-grant: `{ userIds: string[], role }` in a single transaction. Returns `{ granted: N, failed: [{ userId, error }] }` — per-user failure isolation, never partial-silent. |
| `GET /access` | List grants: `{ userId, workspaceId, username, role, grantedAt (ISO), grantedBy }`. |
| `DELETE /access/:userId` | Revoke. **Anti-lockout**: returns `400 {"error":"Cannot revoke project owner"}` when targeting the implicit project owner (transfer-ownership is v1.5). Revocation is effective on the **next request** — no session invalidation, no cache warm-up (per-request resolution is the revocation contract). |

Audit events ride the standard event log: `workspace.access.granted` / `workspace.access.revoked`.

Admin UI: **Settings → workspace-access panel** (per-workspace grant/revoke, bulk multi-select, user search) plus the owner-side share dialog on the workspace surface.

## 3. Personal workspaces (WSIS-01)

- **Lazy on-demand only** (D-01): nothing is auto-created at registration or migration time. A user with zero workspaces sees the guided first-run wizard (`!hasOnboarded`) or the "ask your admin" message (`hasOnboarded`), per `User.hasOnboarded` (D-03).
- Creation: `POST /api/users/me/personal-workspace` — idempotent (repeated calls return the existing personal workspace; no duplicates), flips `hasOnboarded` and invalidates the auth cache so `/auth/me` reflects it immediately.
- Identity: `Project.isPersonal = true` (D-02) — a single additive flag, not a name convention.
- **License exemptions**: personal workspaces never count toward the `max_workspaces` license limit (D-04 count-filter), and personal-workspace provisioning itself is not a license-gated feature. Note for operators: the per-user `max_projects` check is enforced service-side by construction — personal projects do not consume shared-project quota.

## 4. The upload exception (D-04)

**Admins do NOT bypass workspace access for document uploads.** The upload route (`POST /api/documents/upload` and the upload-draft stage routes) mounts the graded write gate with `bypassAdmin: false`: an admin without an underlying owner/editor grant on the target workspace is denied with the standard 403 byte shape (`"Access denied to this workspace"`), not a 404.

Two deliberate consequences operators should know:

- The document **read** routes (GET single/text/list, bulk-delete loop, DELETE) keep their **inline workspace-access checks in both modes** — the same admin-does-not-bypass semantic — unchanged by the enforcement flip.
- The workspace **upload toggle** (`allowMemberUploads` / global `ALLOW_NON_ADMIN_UPLOAD`) still governs non-admin uploads exactly as before; the graded gate is orthogonal to it.

## 4a. Revoked-user byte shapes — writes hide existence, reads disclose (SC-4 posture)

A **revoked** user (previously granted, now without a row — the workspace itself still exists) observes deliberately different responses depending on the gate their request hits:

| Request class | Gate | Response | Rationale |
|---------------|------|----------|-----------|
| Graded WRITE (chat-create, upload, folder CRUD, workspace settings) | `requireWorkspaceWriteAccess` (enforced) | **404** `"Workspace not found"` | SC-4 existence hiding on the write path: a revoked writer learns nothing about the workspace's existence (enumeration oracle closed for writes). |
| Binary READ (GET chats, GET workspace, document reads) | `requireWorkspaceAccess` | **403** `"Access denied to this workspace"` | Reads disclose existence: the binary gate answers 403 for a live workspace the caller cannot access (the E2E parity set pins this shape on the GET arm). |
| Binary-gated access trio (grant/list/revoke, non-owner) | in-handler owner-or-admin gate | **403** `"Access denied to this workspace"` | Same disclosure posture for the management surface. |

This is the **intended divergence** (review option (b), pinned by `workspaceAccess.routes.test.ts` — "WR-06 parity pin"): same workspace, same actor, different status class per HTTP method. The 404-on-revoked-write is NOT a bug — it is the existence-hiding half of the SC-4 posture; only a *verified-absent* workspace (soft-deleted or unknown id) and a *revoked user* share the write-path 404, while every read path keeps the 403 disclosure. The parity matrix in `e2e/workspace-access.spec.ts` pins the read-arm 403 explicitly; the write-arm 404 is pinned at the unit matrix (`non-admin + absent workspace → 404` and the revoked-role resolution `null → 404` enforced arm).

If a future phase reconciles the two shapes (mapping `role === null` on an existing workspace to the binary 403 on writes too), that is a client-visible change and must update this table plus both pin sets.

## 5. Enforcement flag & shadow-mode history (D-13)

`WORKSPACE_ROLE_ENFORCEMENT` is a DB-backed SystemConfig key (admin-editable at runtime via `PUT /api/system/settings`; not in the read-only infra set).

- **Resolution order**: DB row (global, `organizationId IS NULL`) → ENV override → `CONFIG_DEFAULTS` fresh-install default. The DB row wins on any install whose seed ran — which is why the flip below is *persisted*, not constants-only.
- **Shadow mode** (flag `"false"`, 2026-09-15 → 2026-09-16): the graded middlewares resolved each request's role, logged `[workspace-access] shadow decision` lines, and fell through — the pre-existing binary gate remained the enforcement. 78 sampled shadow decisions across admin/editor/viewer showed **zero drift** against the binary gate's outcomes.
- **The flip** (2026-09-16, evidence-gated after three parity classes: route-matrix unit pins, E2E parity probes in a real browser, shadow-log spot-check):
  - `CONFIG_DEFAULTS.WORKSPACE_ROLE_ENFORCEMENT` `"false"` → `"true"` (fresh installs seed `"true"` directly), and
  - the persisted global row was overwritten and the config cache invalidated via `scripts/set-workspace-role-enforcement.cjs` (the upgraded-install half; the resolved `getSetting` value was asserted, not just the constant).
- **Rollback**: `node scripts/set-workspace-role-enforcement.cjs --value false` (or settings-UI PUT). The script is idempotent and replicates the settings-write cache fan-out (global DEL + tenant-override DELs).
- mcpPins/memories surfaces remain on the binary inline checks in this milestone (v1.5 sweep debt).

## 6. Widget seam (D-14)

Widget-embedded chats never consult user grants: the widget resolves its workspace through the **`WidgetWorkspace` API-key whitelist** (its own org resolution), and no Phase 189 middleware touches the API-key seam. Granting/revoking user roles never affects a live widget session.

## 7. LDAP forward-contract (`UserRole.assignedVia`)

The Phase 189 additive migration also landed `user_roles.assignedVia` (default `"manual"`). **Phase 193's LDAP sync will delete only rows with `assignedVia: 'ldap'`.** Administrators must not hand-edit role assignments in ways that set `assignedVia` to anything other than `"manual"` — manual rows are never touched by LDAP sync, and masquerading an LDAP-provisioned row as `manual` would orphan it across sync cycles.

---

*Maintained by the workspace-isolation milestone. Schema: `WorkspaceAccess.role/grantedBy`, `Project.isPersonal`, `User.hasOnboarded`, `UserRole.assignedVia` (all additive, migration `20260915174208_wsis_workspace_access_roles`).*