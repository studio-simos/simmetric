# Admin Guide

This guide covers administration tasks in Simmetric Chat: user management, roles, permissions, license configuration, and feature gating. Most admin tasks are accessible from the Settings page, which is visible only to users with the appropriate menu section and permission set.

Before making changes to roles or licenses, ensure you have a backup of the database. Misconfigured permissions can lock legitimate users out of critical features.

---

## RBAC Overview

Simmetric Chat uses Role-Based Access Control with two built-in roles:

- **Admin** — all 31 permissions + all 13 menu sections
- **User** — limited permissions (`workspace:read`, `chat:read/write`, `document:read/write`, `archive:read`, `provider:read`, `project:create`, `workspace:create`, `memory:read/write`) + menu sections: `dashboard`, `chat`, `documents`, `knowledgeBase`, `workspaces`, `widget`, `uploads`

The full permission set covers:

| Category | Permissions |
|----------|-------------|
| Users | `admin:users` |
| Roles | `admin:roles` |
| Settings | `admin:settings` |
| Workspaces | `workspace:read`, `workspace:write`, `workspace:delete` |
| Projects | `project:create`, `project:read`, `project:write`, `project:delete` |
| Documents | `document:read`, `document:write`, `document:delete` |

IDOR prevention is enforced via `requireProjectAccess` and `requireWorkspaceAccess` middleware on every relevant route, ensuring users can only access resources they own or have been explicitly granted access to. The middleware checks the authenticated user's ID against project and workspace ownership or access grants before allowing the request to proceed.

---

## Role Management

Create custom roles in Settings → Roles & Permissions. Assign any subset of the 31 permissions and map menu sections (`dashboard`, `chat`, `documents`, `knowledgeBase`, `workspaces`, `projects`, `marketplace`, `mcpConnections`, `eventLog`, `analytics`, `widget`, `settings`, `uploads`) to control what sidebar items a user sees.

Role edit and delete are available for non-default roles. Default roles (Admin, User) cannot be deleted but their permissions and menu sections can be updated. When editing a role, the system replaces the entire permission set and menu section mapping atomically. Validation ensures that every assigned permission exists in the canonical permission set and that menu sections are from the allowed enum values.

Role assignment is performed via `POST /api/roles/assign` with a user ID and role ID. Revocation uses `POST /api/roles/revoke`. A user can hold multiple roles; their effective permissions and menu sections are the union across all assigned roles.

---

## User Administration

Admins can list all users and create new accounts manually. The user list shows account creation dates and assigned roles. The `ALLOW_REGISTRATION` environment variable gates registration: `true` allows open signup, `false` restricts creation to admins only.

After creating a user, assign roles via the role assignment interface. A user can hold multiple roles; their effective permissions and menu sections are the union across all assigned roles. Role assignment uses an upsert pattern to prevent duplicate role bindings.

Password resets are admin-only: an admin sets a new password for a user via `POST /api/auth/admin-reset-password` (new password must be at least 8 characters). There is no email-based reset flow; per `packages/server/src/config/env.ts`, SMTP is configured for password-reset and backup failure notifications.

---

## License Management

Two tiers: **Community** (default) and **Enterprise**.

Enterprise licenses are JWTs signed with **RS256** (asymmetric). The vendor signs each license with a private key that never leaves their tooling; the matching **public key is embedded in the server source** (`packages/server/src/services/license-public-key.ts`), so customer instances verify licenses out of the box with **no secret env config**. To unlock Enterprise, set only `LICENSE_KEY` (the JWT issued by the vendor). There is intentionally no env override: key rotation is done by replacing the embedded PEM in the source and redeploying. If the license expires during runtime, the platform gracefully degrades to Community tier automatically — no restart required.

**Feature flags** (boolean): SSO (`sso_enabled`), immutable audit logs (`audit_log_immutable`), white-label branding (`white_label`), widget system (`widget_enabled`), backup system (`backup_enabled`), widget credits editing (`widget_credits_editing`). Webhooks and push notifications are commodity flags removed from `FEATURE_FLAGS` and are always-ON in Community builds; `custom_agents` is a numeric limit (Community default 3, Enterprise unlimited), not a boolean flag.

**Numeric limits:** `max_workspaces` (default 3), `max_projects` (default 3), `max_widgets` (default 1). Enterprise defaults set all features enabled and limits to Infinity. White-label branding is enforced at the settings level: `BRANDING_*` keys are rejected when the `white_label` feature flag is false.

For security, never include example license keys, JWT secrets, or real admin credentials in documentation. Use placeholders such as `LICENSE_KEY=your-jwt-here` when sharing configuration examples. Always rotate secrets promptly if they are ever exposed.

### license:check CLI (LIC-03)

Run `pnpm license:check` from the repo root (or `pnpm --filter server license:check` inside `packages/server`) to verify the configured license without starting the server. It reuses the same verifier as server startup, so the verdict always matches runtime behavior. Add `-- --json` to emit a machine-readable single-line JSON object (`{ tier, expiresAt, reason, exitCode }`) instead of the human-readable verdict.

Exit codes (scriptable for CI/monitoring):

- `0` — valid Enterprise key **or** Community-entitled state (a missing `LICENSE_KEY` is the normal Community state)
- `1` — token-doesn't-entitle: the key exists but fails verification (`expired`, `bad-signature`, `malformed`, `schema-mismatch`)
- `2` — environment/config error (`.env` could not be loaded)

The command never prints the license key, the secret, or the decoded JWT payload — only the tier, expiry, and closed reason.

---

## Feature Gating

Server middleware `requireFeature(flag)` returns HTTP 402 for boolean features that are disabled in the current tier. The response includes `{ error, feature, tier }` so clients can identify which feature is blocked. `requireFeatureLimit(flag, model)` returns HTTP 402 when the current count meets or exceeds the limit, with optional `limit` and `current` fields in the response.

On the frontend, `useFeature()` and `useFeatureLimit()` hooks gate UI rendering. The `UpgradePrompt` component shows a locked-state card with an upgrade CTA when a feature is unavailable. License information is fetched via the `useLicenseInfo()` TanStack Query hook (`src/queries/useLicense.ts`) and cached by the query client — there is no separate license store. All feature gates fail-open on database errors to prevent lockouts.

---

## Admin-Only Features

The following capabilities are restricted to the admin role. Access is controlled by both the `settings` menu section and the relevant permission set:

- **MCP Connections** — Settings → MCP Connections: add, test, and manage external MCP tool servers that extend agent capabilities. Each connection specifies a URL and transport type (`sse` or `streamable-http`; stdio is not supported), plus optional request headers.
- **Widget Management** — Settings → Widgets: full CRUD for embeddable widgets, including branding, workspace whitelist, and CORS origin configuration. Widget creation is gated by `widget_enabled` and `max_widgets`.
- **Analytics Dashboard** — Token usage, model breakdown, and top-user reports for monitoring platform consumption.
- **Event Logs** — Immutable audit trail of platform actions with webhook auto-dispatch.
- **System Settings** — Runtime configuration with read-only enforcement for infrastructure keys such as JWT_SECRET, DATABASE_URL, and server ports. Settings are resolved with priority: DB setting > ENV > Default for editable keys; ENV > Default for always-read-only keys. The settings API always returns 200 with `{ updated, rejected }` so partial updates are visible immediately.
