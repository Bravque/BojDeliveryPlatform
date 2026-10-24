#!/usr/bin/env bash
#
# backup-mysql.sh — take a consistent, compressed logical backup of the BojDelivery MySQL
# database. Intended for operator / cron use against the real (managed) database; in production
# the managed provider's automated snapshots + PITR are the primary mechanism (see
# docs/architecture/10-deployment-and-dr.md §6) and this script is the portable fallback and the
# input to the restore drill (scripts/restore-drill.sh).
#
# Usage:
#   DATABASE_URL="mysql://user:pass@host:3306/dbname" ./scripts/backup-mysql.sh [OUT_DIR]
#
# Produces: OUT_DIR/boj-<dbname>-<UTC-timestamp>.sql.gz  (+ a .sha256 checksum sidecar)
# Default OUT_DIR: ./backups
#
# Requires: mysqldump, gzip, sha256sum. Reads connection details from DATABASE_URL so the
# password never appears in the process list or shell history.

set -Eeuo pipefail

fail() {
  echo "backup-mysql: $*" >&2
  exit 1
}

command -v mysqldump >/dev/null 2>&1 || fail "mysqldump not found on PATH"
command -v gzip >/dev/null 2>&1 || fail "gzip not found on PATH"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum not found on PATH"

[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL is not set (mysql://user:pass@host:port/db)"

# Parse mysql://user:pass@host:port/db using bash regex (no external deps).
if [[ ! "$DATABASE_URL" =~ ^mysql://([^:/@]+):([^@]*)@([^:/]+):([0-9]+)/([^?]+) ]]; then
  fail "DATABASE_URL is not a well-formed mysql:// URL"
fi
DB_USER="${BASH_REMATCH[1]}"
DB_PASS="${BASH_REMATCH[2]}"
DB_HOST="${BASH_REMATCH[3]}"
DB_PORT="${BASH_REMATCH[4]}"
DB_NAME="${BASH_REMATCH[5]}"

OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/boj-${DB_NAME}-${TS}.sql.gz"

echo "backup-mysql: dumping ${DB_NAME} from ${DB_HOST}:${DB_PORT} -> ${OUT_FILE}"

# --single-transaction: consistent snapshot without locking (InnoDB).
# --routines --triggers --events: capture the full schema surface.
# --set-gtid-purged=OFF: keep the dump portable for restore into a fresh/isolated instance.
# MYSQL_PWD passes the password without exposing it in argv.
MYSQL_PWD="$DB_PASS" mysqldump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --user="$DB_USER" \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  --events \
  --set-gtid-purged=OFF \
  --default-character-set=utf8mb4 \
  "$DB_NAME" \
  | gzip -9 >"$OUT_FILE"

sha256sum "$OUT_FILE" >"${OUT_FILE}.sha256"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo "backup-mysql: wrote ${OUT_FILE} (${SIZE}) and checksum ${OUT_FILE}.sha256"
echo "backup-mysql: OK"
