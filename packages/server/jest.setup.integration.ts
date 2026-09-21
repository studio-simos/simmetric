/**
 * Jest setupFilesAfterEnv for integration tests.
 *
 * Each *test file* gets its own worker database cloned from the template.
 * We use expect.getState().testPath to derive a unique DB name per file,
 * avoiding re-clones when Jest runs the setup before/after every describe block.
 */

import { Client } from "pg";
import { createHash } from "crypto";

// The worker-DB drop+clone hook can exceed the 5s default under parallel
// workers / prior-run connection churn — a mid-hook timeout leaves the OLD
// worker DB in place and the suite's seeding then collides with stale rows
// (dup usernames). Give the lifecycle hooks a 60s budget.
jest.setTimeout(60000);

const BASE_DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://simmetricchat:simmetricchat@host.docker.internal:5432/simmetricchat";
const TEMPLATE_DB_NAME = "simmetricchat_test_template";

let currentWorkerDb: string | null = null;

function getAdminUrl() {
  const url = new URL(BASE_DB_URL);
  url.pathname = "/postgres";
  return url.toString();
}

function getWorkerUrl(dbName: string) {
  const url = new URL(BASE_DB_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function getDbNameForFile(testPath: string): string {
  const hash = createHash("sha256").update(testPath).digest("hex").slice(0, 16);
  return `simmetricchat_test_${hash}`;
}

/**
 * Helper to get a fresh app + prisma instance pointing at the worker DB.
 * Call this inside `beforeAll` of every integration test file.
 */
export async function getTestApp() {
  jest.resetModules();
  const { createApp } = await import("./src/index");
  return createApp();
}

export async function getTestPrisma() {
  jest.resetModules();
  const { default: prisma } = await import("./src/utils/prisma");
  return prisma;
}

export const TEST_DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Grant a test-seeded user membership in the Default org so the Phase 189
 * tenantContextMiddleware (fail-closed D-02) resolves an org for them.
 * Without a live membership every tenant-scoped request 404s — production
 * users always carry one (invitation/JIT landing), so suites that mint
 * bare users must seed the membership to mirror that behavior.
 */
export async function ensureOrgMembership(
  prisma: import("@prisma/client").PrismaClient,
  userId: string,
  organizationId: string = TEST_DEFAULT_ORG_ID,
): Promise<void> {
  await prisma.organizationMember.create({
    data: {
      id: `itest-member-${userId}`,
      organizationId,
      userId,
      roleInOrg: "member",
      joinedAt: new Date(),
    },
  });
}

/**
 * Clear all mutable data from the worker database.
 * Run this in `afterAll` to avoid leaking data between test files that share
 * the same worker process.
 */
export async function clearTestData() {
  const { default: prisma } = await import("./src/utils/prisma");

  const tables = [
    "ChatMessage",
    "ChatMCPPin",
    "ChatPin",
    "ChatFolder",
    "Chat",
    "WidgetSession",
    "WidgetWorkspace",
    "Widget",
    "McpCatalogEntry",
    "MCPConnection",
    "DocumentChunk",
    "Document",
    "ProviderModel",
    "Provider",
    "ProjectAccess",
    "WorkspaceAccess",
    "ApiKey",
    "RoleMenuSection",
    "UserRole",
    "Role",
    "SystemConfig",
    "EventLog",
    "PushSubscription",
    "Template",
    "WorkspaceAgentConfig",
    "Workspace",
    "Project",
    "User",
  ];

  for (const table of tables) {
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    } catch {
      // Table may not exist in some migration states; ignore
    }
  }
}

beforeAll(async () => {
  const testPath = (expect as any).getState?.()?.testPath ?? "unknown";
  const workerDbName = getDbNameForFile(testPath);

  // If this file already has a cloned DB, just ensure DATABASE_URL is set
  if (currentWorkerDb === workerDbName) {
    process.env.DATABASE_URL = getWorkerUrl(workerDbName);
    return;
  }

  currentWorkerDb = workerDbName;

  const adminClient = new Client({ connectionString: getAdminUrl() });
  await adminClient.connect();

  // Drop worker DB if it exists from a previous interrupted run
  await adminClient.query(
    `DROP DATABASE IF EXISTS "${workerDbName}" WITH (FORCE)`,
  );

  // Clone template into worker DB
  await adminClient.query(
    `CREATE DATABASE "${workerDbName}" TEMPLATE "${TEMPLATE_DB_NAME}"`,
  );
  await adminClient.end();

  // Override DATABASE_URL for this process
  process.env.DATABASE_URL = getWorkerUrl(workerDbName);

  console.log(`[jest-setup] Worker DB ${workerDbName} ready for ${testPath}`);
});
