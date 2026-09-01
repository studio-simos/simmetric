#!/bin/sh
# provision-encryption-key.sh — production secret auto-provision for Docker
# boots (Phase 162 hard-default + Phase 163 HMAC follow-up).
#
# Designed to be SOURCED by docker/entrypoint-server.sh so the exported
# ENCRYPTION_KEY reaches `exec node packages/server/dist/index.js`:
#
#   . /app/provision-encryption-key.sh /app/storage
#
# ...and also runnable standalone for verification:
#
#   sh provision-encryption-key.sh [storage_dir]
#
# Provisions TWO production-required secrets with identical precedence rules:
#   1. ENCRYPTION_KEY   — Phase 162: data-at-rest key (provider API keys,
#      backup destination configs). Server exits when unset in production.
#   2. API_KEY_HMAC_SECRET — Phase 163: HMAC-SHA256 signing key for API keys
#      (widget API key auto-seed runs during boot). hmacSha256() throws when
#      unset, surfacing as "Database connection failed" AFTER listen — late
#      and misleading, so it is provisioned here, early.
#
# Precedence: operator-supplied value (env / env_file) always wins; otherwise
# the persisted value at $storage_dir/.<name> is restored; only when neither
# exists is a value generated ONCE and persisted.
# NEVER regenerates over existing key material (fail-loud on corrupt) —
# a different ENCRYPTION_KEY would brick stored provider API keys / backup
# configs; a different API_KEY_HMAC_SECRET would invalidate every issued
# API key's digest (lookup becomes impossible).
#
# Scale-out caveat: provisioning must complete ONCE before scaling the
# server service beyond one replica (concurrent first-boot replicas could
# each generate a divergent key); single-instance is the documented default.
#
# V7 logging discipline: key values are NEVER echoed in any code path —
# logs name only the file path.
#
# NOTE on exits: error paths `exit 1` so that, when SOURCED, they abort the
# entrypoint fail-loud BEFORE prisma generate/migrate/seed. Success paths
# `return` from the function (NO exit) so a sourced invocation hands control
# back to the entrypoint with ENCRYPTION_KEY exported.

is_valid_key() {
  # 32 raw bytes after base64 decode (the exact shape `openssl rand -base64 32` emits)
  node -e 'const b=Buffer.from(process.argv[1]||"","base64");process.exit(b.length===32?0:1)' "$1"
}

is_template_placeholder() {
  # The .env.example ships unfilled secrets as <sostituire-con-valore-generato>
  # ("replace with generated value"). A placeholder that reaches the container
  # is a MISCONFIGURED deploy, not an operator choice: an unfilled template
  # value must never override the persisted secret (operator-supplied value
  # always wins — a placeholder would shadow the volume key AND crash-loop
  # the validation gate). Recognize it and treat the variable as unset.
  case "$1" in
    \<[a-z]*-con-valore-generato\>) return 0 ;;
    *) return 1 ;;
  esac
}

# provision_secret <env_name> <persist_file_name> <purpose_warn_blurb>
# Shared engine for both secrets: operator env wins → restore persisted →
# generate once + persist atomically. Failure paths exit 1 (abort the
# sourced entrypoint); success exports the variable and returns 0.
provision_secret() {
  name="$1"
  file_name="$2"
  purpose="$3"
  storage_dir="${4:-/app/storage}"
  key_file="$storage_dir/$file_name"

  eval current="\${$name:-}"

  # 1) Operator-supplied secret always wins — never read from or overwrite
  #    the persisted file; validate early (fail-loud beats a late crypto failure).
  #    EXCEPTION: an unfilled .env.example template placeholder (<...>) is
  #    treated as unset (warn + fall through to restore/generate) — it is not
  #    key material and would otherwise fail the gate on every restart.
  if [ -n "$current" ]; then
    if is_template_placeholder "$current"; then
      echo "WARNING: $name holds the .env.example template placeholder (value not logged) — ignoring it as unset; fill the root .env with 'openssl rand -base64 32' output to control the value yourself." >&2
    else
      echo "$name already set via environment — using operator-supplied value (value not logged)" >&2
      if ! is_valid_key "$current"; then
        echo "ERROR: $name from environment is invalid — expected the output of 'openssl rand -base64 32' (base64 decoding to exactly 32 bytes). Refusing to boot with an invalid value." >&2
        exit 1
      fi
      return 0
    fi
  fi

  # 2) Restore path — persisted value inside the server-storage volume.
  if [ -f "$key_file" ]; then
    persisted="$(tr -d ' \t\r\n' < "$key_file")"
    if [ -z "$persisted" ] || ! is_valid_key "$persisted"; then
      echo "ERROR: the persisted $name at $key_file is empty or corrupt (must decode to exactly 32 base64 bytes)." >&2
      echo "This file holds the $purpose" >&2
      echo "Regenerating a DIFFERENT value would invalidate existing key material — it will NOT be done automatically." >&2
      echo "The operator must either restore the file's content from backup, or delete it deliberately after confirming the rotation consequences." >&2
      exit 1
    fi
    eval "export $name=\"\$persisted\""
    echo "restored persisted $name from $key_file (value not logged)" >&2
    return 0
  fi

  # 3) Generate path (node crypto — the openssl CLI is not guaranteed on
  #    node:24-alpine, while node itself is).
  new_key="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
  if [ -z "$new_key" ] || ! is_valid_key "$new_key"; then
    echo "ERROR: generated $name failed validation — refusing to persist an invalid value." >&2
    exit 1
  fi

  # 4) Persist atomically: tmp write (no trailing newline) → chmod 600 →
  #    rename (atomic on the same filesystem — a crash mid-write can never
  #    leave a half key file that the restore path would treat as corrupt).
  mkdir -p "$storage_dir"
  key_tmp="$key_file.tmp.$$"
  printf '%s' "$new_key" > "$key_tmp"
  chmod 600 "$key_tmp"
  mv "$key_tmp" "$key_file"

  eval "export $name=\"\$new_key\""
  echo "========================================================================" >&2
  echo "WARNING: $name was AUTO-GENERATED because it was not set." >&2
  echo "  ($purpose)" >&2
  echo "  It is persisted at: $key_file (inside the server-storage volume)." >&2
  echo "  BACK IT UP NOW, e.g.:" >&2
  echo "    docker cp simmetric-chat-server:$key_file ." >&2
  echo "  Losing it while other state survives will invalidate the $purpose" >&2
  echo "  Supply an explicit $name in the root .env to control the value" >&2
  echo "  yourself (see docs/ENCRYPTION_KEY_ROTATION.md)." >&2
  echo "========================================================================" >&2
  return 0
}

provision_encryption_key() {
  provision_secret ENCRYPTION_KEY .encryption-key \
    "data-at-rest key for stored provider API keys / backup destination configs (server refuses to boot without it in production)" \
    "${1:-/app/storage}"
}

provision_hmac_secret() {
  provision_secret API_KEY_HMAC_SECRET .api-key-hmac-secret \
    "HMAC-SHA256 signing secret for API keys (widget API key auto-seed + key issuance/verification fail without it)" \
    "${1:-/app/storage}"
}

# Define + immediately invoke (works both sourced and standalone:
# failure → exit 1 here; success → falls through to EOF with status 0).
provision_encryption_key "${1:-/app/storage}" || exit 1
provision_hmac_secret "${1:-/app/storage}" || exit 1