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

backup_target="${1:-${BACKUP_FILE:-}}"
if [ -z "$backup_target" ]; then
  echo "Usage: configure DATABASE_URL or complete PG* variables, then run: $0 /absolute/path/pytaskgantt-before-upgrade.dump" >&2
  exit 1
fi

case "$backup_target" in
  /*) ;;
  *) echo "Backup path must be absolute" >&2; exit 1 ;;
esac

pg_dump --format=custom --file="$backup_target"
echo "Backup created: $backup_target"
