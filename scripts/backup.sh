#!/usr/bin/env bash
#
# ThinkCRM Database Backup Script
#
# Usage:
#   ./scripts/backup.sh                    # backup to ./backups/
#   ./scripts/backup.sh /path/to/dir       # backup to custom directory
#   BACKUP_R2=1 ./scripts/backup.sh        # also snapshot R2 bucket listing
#
# Prerequisites:
#   - pg_dump (PostgreSQL client tools)
#   - DATABASE_URL env var set (or .env file in project root)
#
# The script creates a timestamped pg_dump file with schema + data.
# Neon also provides point-in-time recovery (PITR) via their dashboard —
# this script is for portable, offline backups you control.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${1:-$PROJECT_DIR/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Load .env if DATABASE_URL not set
if [[ -z "${DATABASE_URL:-}" ]] && [[ -f "$PROJECT_DIR/.env" ]]; then
  export $(grep -E '^DATABASE_URL=' "$PROJECT_DIR/.env" | head -1 | xargs)
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set. Set it or create a .env file." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

BACKUP_FILE="$BACKUP_DIR/thinkcrm_${TIMESTAMP}.sql.gz"

echo "Backing up database to $BACKUP_FILE ..."
pg_dump "$DATABASE_URL" \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  | gzip > "$BACKUP_FILE"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "Backup complete: $BACKUP_FILE ($SIZE)"

# Optional: list R2 objects for inventory
if [[ "${BACKUP_R2:-}" == "1" ]]; then
  R2_LISTING="$BACKUP_DIR/r2_listing_${TIMESTAMP}.txt"
  echo "Listing R2 bucket objects..."
  if command -v aws &>/dev/null; then
    aws s3 ls "s3://${R2_BUCKET:-thinkcrm-dev}/" \
      --endpoint-url "https://${R2_ACCOUNT_ID:-}.r2.cloudflarestorage.com" \
      --recursive > "$R2_LISTING" 2>/dev/null || echo "(R2 listing failed — check credentials)" >&2
    echo "R2 listing: $R2_LISTING"
  else
    echo "SKIP: aws CLI not installed (needed for R2 listing)" >&2
  fi
fi

# Cleanup old backups (keep last 30)
BACKUP_COUNT=$(ls -1 "$BACKUP_DIR"/thinkcrm_*.sql.gz 2>/dev/null | wc -l | tr -d ' ')
if [[ "$BACKUP_COUNT" -gt 30 ]]; then
  REMOVE_COUNT=$((BACKUP_COUNT - 30))
  ls -1t "$BACKUP_DIR"/thinkcrm_*.sql.gz | tail -n "$REMOVE_COUNT" | xargs rm -f
  echo "Cleaned up $REMOVE_COUNT old backup(s), keeping 30."
fi

echo "Done."
