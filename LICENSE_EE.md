# Enterprise Plugin License — @simmetric-chat/enterprise

Copyright (c) 2026 Simmetric Chat. All rights reserved.

This Enterprise Plugin License ("License") is a legal agreement between
Simmetric Chat ("Licensor") and the entity or individual that has obtained
a valid Simmetric Chat Enterprise License JWT ("Licensee"). By installing,
copying, or otherwise using the `@simmetric-chat/enterprise` software
("Software"), Licensee agrees to be bound by the terms of this License.

## 1. Grant of License

Subject to the terms and conditions herein and the possession of a valid,
non-expired Enterprise License JWT (RS256-signed by the Licensor), the
Licensor grants Licensee a **non-exclusive, non-transferable, non-sublicensable,
revocable** license to:

1. Install and run the Software within Licensee's internal infrastructure
   (on-premises or air-gapped environment).
2. Make modifications to the Software **solely for Licensee's own internal
   use** — modified copies may NOT be distributed or conveyed to any third
   party.
3. Use the Software with the Simmetric Chat community build (licensed under
   AGPL-3.0) as integrated via the `PluginContext` contract
   (`packages/shared/src/schemas/plugin.schema.ts`).

## 2. Restrictions

Licensee shall NOT:

1. **Distribute, sublicense, rent, lease, or lend** the Software or any
   derivative work to any third party.
2. **Reverse-engineer, decompile, or disassemble** the Software, except to
   the extent applicable law prohibits such restriction.
3. **Remove or obscure** any copyright, trademark, or proprietary notices
   within the Software.
4. **Use the Software without a valid Enterprise License JWT** — the
   Licensor's license service verifies the JWT locally at boot; an expired
   or invalid JWT causes the server to fall back to Community mode (the
   Software is not loaded).
5. **Offer the Software as a hosted service** to third parties, except as
   explicitly permitted in a separate commercial agreement with the Licensor.
6. **Incorporate the Software into a product** that competes with Simmetric
   Chat.

## 3. Enterprise License JWT

The Enterprise License JWT (defined by `licensePayloadSchema` in
`packages/shared/src/schemas/license.schema.ts`) is the proof of entitlement.
The JWT is:

- **RS256-signed** (asymmetric — the Licensor signs with the private key,
  the community build verifies with the embedded public key).
- **Locally validated** — the community build's `licenseService.initLicense()`
  verifies the signature and expiration without any outbound network call
  (air-gap compatible, CI-enforced).
- **Not a license to distribute** — the JWT grants the right to USE the
  Software; it does not grant the right to copy or distribute it.

## 4. Modules

The Software provides four enterprise modules, each gated by the JWT
`modules` array:

| Module | JWT `modules` value | Feature |
|--------|---------------------|---------|
| SSO | `"sso"` | SAML 2.0 + OIDC + SCIM 2.0 |
| Audit log | `"audit"` | Immutable event_log + INSERT-only DB role |
| White-label | `"white_label"` | Branding config keys + branding-icon routes |
| Backup | `"backup"` | Local + S3-compatible backup + scheduler + restore |

## 5. Ownership

The Software is licensed, not sold. The Licensor retains all right, title,
and interest in and to the Software, including all intellectual property
rights. This License does not grant Licensee any rights to the Licensor's
trademarks, service marks, or trade names.

## 6. Termination

This License terminates automatically if:

1. The Enterprise License JWT expires and is not renewed.
2. Licensee breaches any term of this License and fails to cure the breach
   within 30 days of written notice.
3. Licensee distributes or attempts to distribute the Software to a third
   party.

Upon termination, Licensee must cease all use of the Software and destroy
all copies in its possession. The community build (AGPL-3.0) continues to
operate in Community mode — termination of this License does not affect
Licensee's rights under AGPL-3.0 to the community build.

## 7. Disclaimer of Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT. THE LICENSOR DOES
NOT WARRANT THAT THE SOFTWARE WILL BE ERROR-FREE OR THAT IT WILL MEET
LICENSEE'S REQUIREMENTS.

## 8. Limitation of Liability

IN NO EVENT SHALL THE LICENSOR BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO
LOSS OF PROFITS, DATA, OR BUSINESS INTERRUPTION, ARISING OUT OF OR IN
CONNECTION WITH THIS LICENSE OR THE SOFTWARE, EVEN IF THE LICENSOR HAS BEEN
ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. THE LICENSOR'S TOTAL LIABILITY
UNDER THIS LICENSE SHALL NOT EXCEED THE AMOUNT PAID BY LICENSEE FOR THE
ENTERPRISE LICENSE IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM.

## 9. Governing Law

This License shall be governed by the laws of Italy. Any disputes arising
under this License shall be resolved in the courts of Italy, unless
otherwise agreed in a separate commercial agreement.

## 10. Entire Agreement

This License, together with the Enterprise License JWT and any separate
commercial agreement between the Licensor and Licensee, constitutes the
entire agreement between the parties regarding the Software.

## 11. See also

- `docs/ENTERPRISE_PLUGIN.md` — technical plugin architecture + air-gap
  install runbook
- `docs/ENTERPRISE_LICENSE_TERMS.md` — operator-facing entitlements,
  support tiers, compliance boundary
- `docs/LICENSE_DECISION.md` — license-model analysis (AGPL-3.0 vs
  Sustainable Use vs SSPL vs Apache-2.0)
- `docs/LICENSE_KEY_ROTATION.md` — license signing key rotation runbook
- `packages/shared/src/schemas/license.schema.ts` — the JWT schema (source
  of truth for the payload shape)

---

*This license file is the template to be placed at the root of the
`simmetric-enterprise/` private repository. The community repo carries
AGPL-3.0 at its `LICENSE` file; this file (`LICENSE_EE.md`) is the
proprietary counterpart for the enterprise plugin package.*