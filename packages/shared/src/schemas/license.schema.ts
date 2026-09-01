// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

/** Shape of the JWT payload inside a license token */
export const licensePayloadSchema = z.object({
  tier: z.enum(["community", "enterprise"]),
  iss: z.string().min(1), // issuer (e.g. "simmetric-chat")
  sub: z.string().min(1), // licensee (org name or domain)
  iat: z.number(), // issued at
  exp: z.number(), // expiry (unix epoch)
  features: z.record(z.string(), z.union([z.boolean(), z.number()])).optional(),
});

export type LicensePayload = z.infer<typeof licensePayloadSchema>;