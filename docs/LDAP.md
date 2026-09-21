# LDAP Authentication (Enterprise)

LDAP/Active Directory authentication lets users sign in with their corporate directory credentials. It ships as an **enterprise-tier feature**: the LDAP login route, connection pool, and role sync live in the private `@simmetric-chat/enterprise` plugin (see [`docs/ENTERPRISE_PLUGIN.md`](ENTERPRISE_PLUGIN.md) for the delivery model). A community build serves local-auth fallback for the same endpoint when the config is staged, but LDAP itself validates credentials against the directory only when the enterprise plugin is installed.

This guide is operator-focused: how to connect Simmetric Chat to Active Directory, OpenLDAP, or FreeIPA, how to map directory groups to application roles, and how to verify the wiring — no code dumps.

---

## 1. How it works (operator view)

- Authentication is **direct-bind only**: Simmetric Chat binds to the directory as a service account, searches for the user, then binds **as the user** with the entered password. The directory is the single source of truth for the password — there is **no password-hash sync mode** (it is deliberately not implemented).
- On first successful login the user is provisioned locally (JIT): a local account shell, membership in the default organization, a personal workspace, and roles derived from the **group→role mapping** below.
- Group→role sync runs at login. Grants created by LDAP carry `assignedVia: "ldap"`; **only those rows are ever revoked** by a later sync — roles an admin granted manually (`assignedVia: "manual"`) survive every sync.
- **Fallback**: if the directory is unreachable or the service bind fails, and the admin left **Fall back to local auth** enabled (`ldapFallbackToLocal`, default on), the same login request is served by the platform's local authentication — an LDAP outage never takes local login down. A user who exists locally can always sign in with their local password. The response body is identical whether LDAP or local auth served the request (no path disclosure).
- **Single provider**: SSO is a singleton — configuring LDAP while SAML/OIDC is enabled (or vice versa) is rejected. One provider at a time.

## 2. Enable path

Two equivalent paths (env overrides DB per-field; both feed the same resolver):

- **Admin panel (recommended)**: *Admin → Settings → SSO* — select the **LDAP** provider, fill the connection fields, paste the custom CA PEM if your certificates are not publicly trusted, optionally add group→role mapping rows, then **Save**. Use the **Test connection** button (§6b) before and after saving.
- **Environment**: set any of the `LDAP_*` variables in the root `.env` (see [`docs/CONFIGURATION.md`](CONFIGURATION.md) — the LDAP section lists all 10 keys). Setting any `LDAP_*` key marks the env layer active and it overrides the DB row per-field. Restart the server after changing env.

### Connection fields reference

The table below pairs each admin-panel connection field with its environment key, default, and operator notes — the same 10 keys documented in [`docs/CONFIGURATION.md`](CONFIGURATION.md) (names and defaults match byte-for-byte). All keys are optional: when unset, the admin SSO panel (DB path) remains the source of truth.

| Env key | Admin-panel field | Default | Notes |
|---------|-------------------|---------|-------|
| `LDAP_URL` | Directory URL | — | `ldap://host:389` (with **Use STARTTLS**) or `ldaps://host:636`. Setting any `LDAP_*` key marks the env layer active — it overrides the DB `SsoConfig` row per-field. |
| `LDAP_BIND_DN` | Bind DN | — | Service-account bind DN — a dedicated read/service user, **not** a personal user account. |
| `LDAP_BIND_PASSWORD` | Bind password | — | Plaintext env secret (empty string = unset). The env path has no at-rest encryption — file secrecy is the operator's responsibility; preferred carrier over DB ciphertext. |
| `LDAP_SEARCH_BASE` | Base DN (users) | — | User search base DN, e.g. `dc=example,dc=com`. |
| `LDAP_SEARCH_FILTER` | User filter | `(uid={{username}})` | Exactly one `{{username}}` placeholder, substituted at login with the RFC-4515-escaped entered username. AD default: `(sAMAccountName={{username}})`. |
| `LDAP_GROUP_SEARCH_BASE` | Group base DN | — | Group search base DN, e.g. `ou=groups,dc=example,dc=com`. |
| `LDAP_GROUP_SEARCH_FILTER` | Group filter | `(member={{dn}})` | `{{dn}}` = the user's DN. AD nested groups need the transitive filter `(member:1.2.840.113556.1.4.1941:={{dn}})`. |
| `LDAP_USE_TLS` | Use STARTTLS | `true` | STARTTLS upgrade on `ldap://` URLs. `ldaps://` URLs ignore it — mutual exclusivity is enforced by the config validator (see §3). Disabled by `false` / `0` / `no` / `off` / empty. |
| `LDAP_ACCEPT_CERT` | Custom CA PEM | — | CA certificate PEM for certificate-validated TLS (concatenate blocks for chains). Strict validation by default — there is no TLS-bypass switch. |
| `LDAP_FALLBACK_TO_LOCAL` | Fall back to local auth | `true` | Break-glass: serve the login via local auth when the directory is unreachable or the service bind fails. Disabled by `false` / `0` / `no` / `off` / empty. |

Certificate trust — the **Custom CA PEM** field (`LDAP_ACCEPT_CERT`) — is where LDAPS/STARTTLS certificate handling lives; the per-IdP CA sources are documented in §3.1-3.3 (AD: export from `certsrv`; OpenLDAP: `/etc/ssl/certs/` or the CA's `ca.crt`; FreeIPA: `/etc/ipa/ca.crt`). Certificates are always strictly validated; install the CA chain, never disable validation.

## 3. Per-IdP connection guides

> **STARTTLS vs LDAPS:** the two TLS modes are mutually exclusive. With an `ldaps://` URL the connection is TLS from the first byte and the **Use STARTTLS** toggle is ignored; enabling STARTTLS explicitly on an `ldaps://` URL is rejected by the config validator. STARTTLS applies only to `ldap://` URLs, upgrading the plaintext connection before the bind (see §3.1).

### 3.1 Active Directory

**Connection**

- URL: `ldaps://dc01.example.com:636` (recommended) or `ldap://dc01.example.com:389` with **Use STARTTLS** enabled.
- Port `636` = LDAPS (TLS from the first byte). Port `389` + STARTTLS upgrades the plaintext connection before binding. The two are mutually exclusive: with an `ldaps://` URL the STARTTLS toggle is ignored (the config validator rejects enabling both on the same URL).
- Bind DN (service account): `cn=simmetric-reader,ou=services,dc=example,dc=com` — a dedicated read-only account, **not** a personal user account.

**Certificate trust (LDAPS + STARTTLS)**

- Certificates are strictly validated. If your DC uses an internal CA, obtain the CA certificate chain (e.g. export from `certsrv` or `certutil -dc ca` / the enterprise CA web enrolment page) and paste the PEM into the **Custom CA PEM** field (env: `LDAP_ACCEPT_CERT`). Multiple CAs are supported: concatenate the PEM blocks.
- Do **not** work around TLS failures by disabling validation — the deployment forbids it and the code never exposes such a switch. Install the CA certificate instead.
- For `ldap://` + STARTTLS the same CA trust applies; AD refuses LDAP binds without signing/sealing in many configurations, so prefer LDAPS.

**Search filter**

- Default user filter: `(sAMAccountName={{username}})`
- `{{username}}` is substituted at login time with the RFC-4515-escaped entered username — the user filter must contain exactly one `{{username}}` placeholder.
- Base DN example: `dc=example,dc=com`

**Group membership — the AD variance (read this before mapping roles)**

AD populates the user entry's **`memberOf`** attribute with the user's **direct** group memberships only:

- Members of a group through **nesting** (group-in-group) do **not** appear in `memberOf` on the user entry. If your role mapping targets a parent group, nested members silently miss the mapped role.
- To reach nested membership, AD supports the **transitive filter** on the **group side**: `(member:1.2.840.113556.1.4.1941:={{dn}})` (the LDAP_MATCHING_RULE_IN_CHAIN OID). Set the group search filter to that string if you rely on nested groups.
- Verify with **Test connection** — the `groupsFound` count is the number of groups the directory reports for the probe user; a zero or unexpectedly low count is the signal your filter misses nested membership.

### 3.2 OpenLDAP

**Connection**

- URL: `ldaps://ldap.example.com:636` or `ldap://ldap.example.com:389` + **Use STARTTLS** enabled. Mutual exclusivity as above.
- Service bind DN: `cn=simmetric-reader,ou=services,dc=example,dc=com`.

**Certificate trust**

- Export your CA certificate (`/etc/ssl/certs/` or your CA's `ca.crt`), paste the PEM into **Custom CA PEM**. `cn=config` servers may also require `olcTLSCACertificateFile` server-side; that is directory administration, outside this app's scope — the app only needs the CA chain to validate the presented certificate.

**Search filter**

- User filter default: `(uid={{username}})`
- Base DN example: `ou=people,dc=example,dc=com`

**Groups**

- OpenLDAP exposes membership on the **group entry** via the `member` attribute (the user entry does not carry `memberOf` by default). The default group filter `(member={{dn}})` — where `{{dn}}` is the user's DN — matches this layout and normally works unchanged.
- If your groups use `memberUid` (RFC 2307 `posixGroup`), set the group filter to `(memberUid={{username}})` and the group base to your `ou=groups` tree.
- OpenLDAP ACLs may restrict reading `member` for anonymous/service binds — make sure the service account can read the group entries, or mapping comes back empty (visible in the `groupsFound` diagnostic).

### 3.3 FreeIPA

**Connection**

- URL: `ldaps://ipa.example.com:636` or `ldap://ipa.example.com:389` + **Use STARTTLS**. FreeIPA enforces TLS for binds in most deployments — prefer LDAPS.
- Service bind DN: `uid=simmetric-reader,cn=sysaccounts,cn=etc,dc=example,dc=com` (a **system account**, not a staged user).

**Certificate trust**

- FreeIPA ships its own CA (`/etc/ipa/ca.crt` on the IPA server). Paste that PEM into **Custom CA PEM**. Regenerate/re-trust after IPA CA renewal.

**Search filter**

- User filter default: `(uid={{username}})`
- Base DN example: `cn=users,cn=accounts,dc=example,dc=com`

**Groups**

- Like OpenLDAP, membership lives on the **group side**: the default group filter `(member={{dn}})` with group base `cn=groups,cn=accounts,dc=example,dc=com` works out of the box.
- `memberOf` is present on user entries too (FreeIPA manages it), so both directions resolve; the group-side search is the shipped default.

## 4. Group→role mapping walkthrough

1. **Admin → Settings → SSO → LDAP → Mappings**: each row is a directory group DN → application role pair. Add rows for every group that should carry a role.
2. Copy group DNs exactly (case and spacing matter — the DN is matched as stored by the directory). The Test connection diagnostics print the groups the probe user resolved, which you can paste from.
3. **Admin-role warning**: mapping a directory group to the built-in **admin** role grants full administration to everyone in that group at their next login. Sync counts these grants in the audit trail (`ldap.roles.synced`) so mass-grant/mass-revoke events stay visible.
4. **Provenance semantics**: grants made by sync are tagged `assignedVia: "ldap"`. A later sync (at each LDAP login) adds new mapped roles and revokes **only** rows tagged `ldap` whose group no longer maps for that user. **Manually granted roles are never removed by sync** — if a mapped role was granted manually, the grant survives even after the group mapping changes (the grant exists either way).
5. Mapping edits take effect at the user's **next LDAP login** (sync runs at login; there is no scheduled push sync — see §6).

## 5. Docker / air-gap reachability

The server runs in a container; the directory controller usually does not.

- **Host-native DC**: from the container, `localhost`/`127.0.0.1` is the container itself. Use `host.docker.internal` as the hostname (`ldap://host.docker.internal:389`) — compose deployments set this up by default; on plain Docker add `--add-host=host.docker.internal:host-gateway`.
- **Remote DC**: use the DC's IP or DNS name directly. Ensure the firewall allows the container host → DC on port 636 (LDAPS) or 389+STARTTLS.
- **Idle connection reaping**: the enterprise plugin keeps a small pool of pre-bound service connections (§6) and re-binds idle ones periodically. Intermediate firewalls/NAT devices that silently kill idle TCP connections are handled by the reaper's health-check bind; if your network kills connections aggressively, shorten the idle window by restarting is not needed — the reaper rebuilds on repeated failure — but expect a brief re-bind latency on the first login after a long idle period.
- **Air-gap**: everything is local. No phone-home, no telemetry — the plugin validates the license JWT locally (see [`docs/ENTERPRISE_PLUGIN.md`](ENTERPRISE_PLUGIN.md)).

## 6. Pool tuning notes

The connection pool exists for the **service path** (user search + group fetch). User password binds always use a fresh short-lived connection per login — one connection, one authenticated identity — and are never pooled.

- **Pool size**: fixed at **4** pre-bound service connections (module constant). Raising it is not configurable in v0.25; scale guidance: 4 covers hundreds of logins/minute — the user bind (the per-login cost) is outside the pool.
- **Timeouts**: 5 s connect timeout and 5 s per-operation timeout are set explicitly. A hanging operation fails fast and classifies as *unreachable*, which feeds the fallback arm (§1) instead of stalling the login.
- **Retry**: transient socket errors on the service path retry **once**. The user's credential bind is **never retried** (retries would trip AD's `badPwdCount` lockout on flaky networks).
- **Reaper**: idle pre-bound clients are health-checked (re-bound) on a scheduler; a client that repeatedly fails to re-bind is destroyed and rebuilt. This is why a long-idle deployment's first login may add a fraction of a second.
- **When to worry**: sustained `unreachable` stages in the audit log with the directory demonstrably up usually mean a firewall idle-kill (§5) or DNS flakiness, not pool exhaustion.

## 6b. Self-verification path (test connection)

1. Open **Admin → Settings → SSO → LDAP** and press **Test connection** (no save required).
2. The panel renders a 4-row diagnostics checklist — booleans and a count only, never raw directory strings:
   - **reachable** — the service account could connect and bind.
   - **bindOk** — the service bind itself succeeded.
   - **userFound** — the probe username (default `administrator`) resolved against the user filter.
   - **groupsFound** — the probe user's group count (`groupCount` shown when > 0).
3. Reading the rows: `reachable: false` → network/TLS/CA problem (check §5 and the CA PEM); `bindOk: false` → wrong service DN/password; `userFound: false` → wrong base DN or filter (check the escaping of your filter — never paste unescaped special characters); `groupsFound: 0` → wrong group base/filter (check the per-IdP notes in §3 — AD nested membership needs the transitive filter).
4. Stage codes from real logins (e.g. `unreachable`, `bindFailure`, `userNotFound`) are written **server-side only** — to the audit trail and the server log — never to the browser. On the server, look for `ldap.login.failed` entries with their `stage` metadata to diagnose a rejected login.

## 6c. v1 limitations (documented deferrals)

- **No referral chasing**: if your directory returns continuation referrals for out-of-scope subtrees, the search does not chase them. Keep base DNs tight; a referral is treated as a miss. Documented as a v1 limitation — not a configurable behavior.
- **No push/scheduled sync** (LDAP-F01, deferred to v0.26): group→role sync runs **only at login**. There is no scheduled job that syncs roles for users who are not logging in, and no group membership changes are pushed from the directory. A user's roles refresh at their next login.
- **No multi-provider coexistence**: exactly one SSO provider is active at a time (singleton). Enabling LDAP while SAML/OIDC is enabled (or vice versa) is rejected at save time.
- **No password-hash sync**: direct bind is the only authentication mode (§1).

## Related docs

- [`docs/CONFIGURATION.md`](CONFIGURATION.md) — the `LDAP_*` environment variables (all 10 keys, precedence, secret posture).
- [`docs/ENTERPRISE_PLUGIN.md`](ENTERPRISE_PLUGIN.md) — enterprise delivery model and air-gap install.
- [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) — Docker deployment and `host.docker.internal` reachability.