// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Embedded RSA public key for license JWT verification (RS256).
 *
 * This is the PUBLIC half of the Simmetric Chat license signing keypair. The
 * matching PRIVATE key lives only in the separate `simmetric-license-tool`
 * repository — it is NEVER committed here. Because this is a public key, it is
 * safe to ship in the source distribution: anyone can verify a license, but no
 * one (including customers running the source on-prem) can mint one.
 *
 * Override at runtime by setting LICENSE_PUBLIC_KEY (PEM string) or
 * LICENSE_PUBLIC_KEY_PATH (path to a PEM file) — see licenseService.ts.
 *
 * If you need to rotate the keypair, generate a new pair in the license tool,
 * replace this constant, and re-issue all outstanding enterprise licenses.
 */
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmkuI00AoIVk9pEPnc//1
9aRjnG4gS4ZCp6Q88XuE10A2tTHKblpjGAp9WDxD9i5pVIM1fv498URUWgCiPo0o
js+1tc10RzjQXUWe0owBcYvXVejdirk9Hky/Sm7Kdl4Yo19zIg+7xCeUX7HkLRge
YQbL1O/XVKq1zvp06ldXK2Jf8trsUNc/F2N4f3lEn1+rNZLe8usu1p6+SgjlVO/K
hEjSmBL+FjbXw0oboz/ou3VZZEZm/jIYUXZr3DMT+Dr+qOdsMRvrDgQSARAM+3G3
/RV6aieSW8PgAry7cFPPDcbpIQHrCTpKY2EA/JqsO0VJ4T/jPds0a6DeY29QGCEm
SwIDAQAB
-----END PUBLIC KEY-----
`;