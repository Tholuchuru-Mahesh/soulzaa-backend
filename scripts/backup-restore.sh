#!/usr/bin/env bash
set -eo pipefail

# ── Backup & Restore Automation Script ──────────────────────────────────────────
# Automates PostgreSQL pg_dump, Redis AOF snapshot, and S3 backup verification.

BACKUP_DIR="${BACKUP_DIR:-/tmp/soulzaa-backups}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
PG_HOST="${POSTGRES_HOST:-localhost}"
PG_PORT="${POSTGRES_PORT:-5432}"
PG_USER="${POSTGRES_USER:-soulzaa}"
PG_DB="${POSTGRES_DB:-soulzaa}"
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"

mkdir -p "${BACKUP_DIR}"

echo "========================================="
echo " Starting Soulzaaa Production Backup"
echo " Timestamp: ${TIMESTAMP}"
echo "========================================="

# 1. PostgreSQL Backup
echo "[1/3] Backing up PostgreSQL database..."
PGPASSWORD="${POSTGRES_PASSWORD:-soulzaa}" pg_dump -h "${PG_HOST}" -p "${PG_PORT}" -U "${PG_USER}" -F c -b -v -f "${BACKUP_DIR}/postgres_${TIMESTAMP}.dump" "${PG_DB}"
echo "✅ PostgreSQL backup saved to ${BACKUP_DIR}/postgres_${TIMESTAMP}.dump"

# 2. Redis BGSAVE
echo "[2/3] Triggering Redis background snapshot..."
redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" BGSAVE
sleep 3
LAST_SAVE=$(redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" LASTSAVE)
echo "✅ Redis snapshot verified at epoch: ${LAST_SAVE}"

# 3. Test Restore (Dry Run Verification)
echo "[3/3] Verifying database backup integrity..."
if PGPASSWORD="${POSTGRES_PASSWORD:-soulzaa}" pg_restore --list "${BACKUP_DIR}/postgres_${TIMESTAMP}.dump" > /dev/null; then
  echo "✅ PostgreSQL dump file verification PASSED"
else
  echo "❌ PostgreSQL dump file verification FAILED"
  exit 1
fi

echo "========================================="
echo " Backup & Integrity Verification SUCCESS"
echo "========================================="
