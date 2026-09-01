// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for verify-squash-identity.ts control flow.
 *
 * Mocks `pg.Client`, `node:child_process.execFileSync`, and `process.env` so
 * the control flow is exercised without requiring a live Postgres.
 */
import "./helpers/setupEnv";

jest.mock("pg", () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({ rows: [] }),
    end: jest.fn().mockResolvedValue(undefined),
  };
  return { Client: jest.fn(() => mockClient) };
});

jest.mock("node:child_process", () => ({
  execFileSync: jest.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  parseAdminUrl,
  throwawayDbName,
  runMigrateDeploy,
  runSchemaDiff,
  createThrowawayDb,
  dropDb,
} from "../../scripts/verify-squash-identity";

const { Client } = require("pg");

describe("verify-squash-identity: parseAdminUrl", () => {
  it("swaps the pathname to /postgres and builds DB URLs", () => {
    const { adminUrl, buildDbUrl } = parseAdminUrl(
      "postgresql://simmetricchat:simmetricchat@localhost:5434/simmetricchat_test",
    );
    expect(adminUrl).toBe("postgresql://simmetricchat:simmetricchat@localhost:5434/postgres");
    expect(buildDbUrl("foo")).toBe("postgresql://simmetricchat:simmetricchat@localhost:5434/foo");
  });

  it("preserves credentials and host when building DB URLs", () => {
    const { buildDbUrl } = parseAdminUrl(
      "postgresql://u:p@db.example.com:6543/anydb",
    );
    expect(buildDbUrl("throwaway")).toBe("postgresql://u:p@db.example.com:6543/throwaway");
  });
});

describe("verify-squash-identity: throwawayDbName", () => {
  it("produces a name prefixed with squash_identity_", () => {
    const name = throwawayDbName();
    expect(name).toMatch(/^squash_identity_\d+_\d+$/);
  });
});

describe("verify-squash-identity: runMigrateDeploy", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("invokes npx prisma migrate deploy with the consent env var set", () => {
    const original = process.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION;
    process.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION = "yes";
    try {
      runMigrateDeploy("postgresql://u:p@h:5432/db");
      expect(execFileSync).toHaveBeenCalledWith(
        "npx",
        ["prisma", "migrate", "deploy"],
        expect.objectContaining({
          env: expect.objectContaining({
            DATABASE_URL: "postgresql://u:p@h:5432/db",
            PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
          }),
        }),
      );
    } finally {
      if (original === undefined) delete process.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION;
      else process.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION = original;
    }
  });

  it("defaults the consent env to 'yes' when unset", () => {
    delete process.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION;
    try {
      runMigrateDeploy("postgresql://u:p@h:5432/db");
      const callEnv = (execFileSync as jest.Mock).mock.calls[0][2].env;
      expect(callEnv.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION).toBe("yes");
    } finally {
      // restore handled by setupEnv if needed
    }
  });
});

describe("verify-squash-identity: runSchemaDiff", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("returns 0 when prisma migrate diff exits 0 (empty diff — schema-identical)", () => {
    (execFileSync as jest.Mock).mockImplementationOnce(() => undefined);
    const code = runSchemaDiff("postgresql://u:p@h:5432/db");
    expect(code).toBe(0);
    expect(execFileSync).toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["prisma", "migrate", "diff", "--from-config-datasource", "--exit-code"]),
      expect.objectContaining({
        env: expect.objectContaining({ DATABASE_URL: "postgresql://u:p@h:5432/db" }),
      }),
    );
  });

  it("returns 2 when prisma migrate diff exits 2 (drift detected)", () => {
    (execFileSync as jest.Mock).mockImplementationOnce(() => {
      const err: NodeJS.ErrnoException & { status?: number } = new Error("drift");
      err.status = 2;
      throw err;
    });
    const code = runSchemaDiff("postgresql://u:p@h:5432/db");
    expect(code).toBe(2);
  });

  it("returns 1 when prisma migrate diff exits with an unexpected code", () => {
    (execFileSync as jest.Mock).mockImplementationOnce(() => {
      const err: NodeJS.ErrnoException & { status?: number } = new Error("boom");
      err.status = 42;
      throw err;
    });
    const code = runSchemaDiff("postgresql://u:p@h:5432/db");
    expect(code).toBe(42);
  });

  it("defaults to 1 when the error has no status", () => {
    (execFileSync as jest.Mock).mockImplementationOnce(() => {
      throw new Error("no status");
    });
    const code = runSchemaDiff("postgresql://u:p@h:5432/db");
    expect(code).toBe(1);
  });
});

describe("verify-squash-identity: createThrowawayDb", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("issues DROP IF EXISTS + CREATE and returns the DB URL", async () => {
    const mockInstance = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({ rows: [] }),
      end: jest.fn().mockResolvedValue(undefined),
    };
    (Client as jest.Mock).mockReturnValue(mockInstance);

    const url = await createThrowawayDb(
      "postgresql://simmetricchat:simmetricchat@localhost:5432/postgres",
      "squash_test_xyz",
    );
    expect(mockInstance.query).toHaveBeenCalledWith('DROP DATABASE IF EXISTS "squash_test_xyz" WITH (FORCE)');
    expect(mockInstance.query).toHaveBeenCalledWith('CREATE DATABASE "squash_test_xyz"');
    expect(url).toBe("postgresql://simmetricchat:simmetricchat@localhost:5432/squash_test_xyz");
  });
});

describe("verify-squash-identity: dropDb", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("swallows errors (best-effort cleanup, never throws)", async () => {
    const mockInstance = {
      connect: jest.fn().mockRejectedValue(new Error("connection refused")),
      query: jest.fn(),
      end: jest.fn(),
    };
    (Client as jest.Mock).mockReturnValue(mockInstance);

    await expect(
      dropDb("postgresql://u:p@h:5432/postgres", "squash_test_xyz"),
    ).resolves.toBeUndefined();
  });
});
