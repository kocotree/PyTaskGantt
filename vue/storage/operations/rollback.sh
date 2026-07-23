#!/bin/sh
set -eu
umask 077

if [ -n "${DATABASE_URL:-}" ]; then
  PGDATABASE="$DATABASE_URL"
  export PGDATABASE
  unset DATABASE_URL
elif [ -z "${PGHOST:-}" ] ||
  [ -z "${PGPORT:-}" ] ||
  [ -z "${PGDATABASE:-}" ] ||
  [ -z "${PGUSER:-}" ] ||
  [ -z "${PGPASSWORD:-}" ]; then
  echo "DATABASE_URL or complete PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD is required" >&2
  exit 1
fi

backup_source="${1:-${BACKUP_FILE:-}}"
if [ -z "$backup_source" ] || [ ! -f "$backup_source" ]; then
  echo "Usage: configure DATABASE_URL or complete PG* variables, then run: CONFIRM_RESTORE=RESTORE_BACKUP $0 /absolute/path/backup.dump" >&2
  exit 1
fi

case "$backup_source" in
  /*) ;;
  *) echo "Backup path must be absolute" >&2; exit 1 ;;
esac

if [ "${CONFIRM_RESTORE:-}" != "RESTORE_BACKUP" ]; then
  echo "Restore is destructive. Set CONFIRM_RESTORE=RESTORE_BACKUP after stopping the application." >&2
  exit 1
fi

pg_restore \
  --dbname= \
  --clean \
  --if-exists \
  --no-owner \
  --exit-on-error \
  --single-transaction \
  "$backup_source"

echo "Database restored from: $backup_source"
