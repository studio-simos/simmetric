# Security Policy

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately via [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-reviewing/privately-reporting-a-security-vulnerability):

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability** → **Open a draft security advisory**.
3. Fill the form with a description, reproduction steps, and severity assessment.

## Response Timeline

| Severity | Acknowledge | Fix / Disclosure |
|----------|-------------|------------------|
| Critical / High | within 48 hours | within 90 days |
| Medium / Low | within 5 business days | next minor release |

If no acknowledgement is received within 48 hours, escalate by opening a draft security advisory directly (the Security tab is the only monitored channel).

## Scope

**In scope:**

- The Simmetric Chat main repository (server, collector, frontend, widget, shared).
- Vulnerabilities in the application code, configuration, or deployment scripts shipped in this repo.

**Out of scope:**

- Vulnerabilities in third-party dependencies — report these to the upstream maintainer. The dependency license/audit is in `docs/LICENSE_AUDIT.md`.
- Self-hosted deployments with modified configuration that deviates from the documented setup.
- Vulnerabilities requiring already-privileged access (authenticated admin exploiting their own tenant).
- Denial of service via large file uploads beyond the documented limits.

## Supported Versions

Only the **latest release** receives security fixes. There is no LTS branch.

## Disclosure

Once a fix is released, a GitHub Security Advisory is published with a CVE (if requested) and credit to the reporter (unless they prefer to remain anonymous).

---

*This policy is adapted from the GitHub SECURITY.md template.*