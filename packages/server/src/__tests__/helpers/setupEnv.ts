// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Test environment setup — must be imported FIRST in any server test file
 * that touches getEnv() (which calls process.exit(1) if JWT_SECRET is missing).
 */

import dotenv from "dotenv";
import path from "path";

// Load test environment variables from .env.test
dotenv.config({ path: path.resolve(__dirname, "../../../.env.test") });

// Fallback values for required env vars not present in .env.test
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-for-unit-tests-32ch";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.LICENSE_KEY = process.env.LICENSE_KEY ?? "";process.env.COLLECTOR_SECRET = process.env.COLLECTOR_SECRET ?? "test-collector-secret-for-unit-tests";
