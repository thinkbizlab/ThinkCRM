#!/usr/bin/env bash
#
# ThinkCRM Database Restore Script
#
# Usage:
#   ./scripts/restore.sh backups/thinkcrm_20260419_120000.sql.gz
#
# WARNING: This drops and recreates all tables. All current data will be lost.
# Always take a fresh backup before restoring.
#
# Prerequisites:
#   - psql (PostgreSQL client tools)
#   - DATABASE_URL env var set (or .env file in project root)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <backup_file.sql.gz>" >&2
  exit 1
fi

BACKUP_FILE="$1"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "ERROR: File not found: $BACKUP_FILE" >&2
  exit 1
fi

# Load .env if DATABASE_URL not set
if [[ -z "${DATABASE_URL:-}" ]] && [[ -f "$PROJECT_DIR/.env" ]]; then
  export $(grep -E '^DATABASE_URL=' "$PROJECT_DIR/.env" | head -1 | xargs)
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set. Set it or create a .env file." >&2
  exit 1
fi

echo "====================================="
echo "  ThinkCRM Database Restore"
echo "====================================="
echo ""
echo "Target: $(echo "$DATABASE_URL" | sed 's|://[^@]*@|://***@|')"
echo "Source: $BACKUP_FILE"
echo ""
echo "WARNING: This will DROP all existing data and replace it."
echo ""
read -p "Type 'yes' to continue: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted."
  exit 0
fi

echo "Restoring from $BACKUP_FILE ..."
gunzip -c "$BACKUP_FILE" | psql "$DATABASE_URL" --quiet --single-transaction 2>&1 | \
  grep -v "^NOTICE:" || true

echo ""
echo "Restore complete. Run 'npx prisma db push' if schema has changed since the backup."
echo "Done."
