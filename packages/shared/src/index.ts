// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// ===== @simmetric-chat/shared =====
// Shared kernel for types, schemas, and constants.
// Used by both server and collector to ensure validation consistency.

// Types
export * from "./types";

// Schemas
export * from "./schemas";

// Constants
export * from "./constants/index";

// Utils
export * from "./utils/fileName";

// Config loaders (Node-consumers only — server/collector/widget; the browser
// bundle must never value-import this symbol or node:fs enters the graph:
// packages/shared/src/__tests__/loadEnv.test.ts browser-barrel guard pins it)
export { loadRootEnv, findRepoRoot, resolveRootEnvPath } from "./config/loadEnv";
export type { RootEnvResult } from "./config/loadEnv";

