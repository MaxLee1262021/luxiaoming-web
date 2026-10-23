#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin

APP_DIR=/opt/luxiaoming-admin
APP_SERVICE=luxiaoming-admin
APP_USER=luxiaoming
APP_GROUP=luxiaoming
MIGRATE=0
PRESERVE=()
ARCHIVE=""
STATE_DIR=""
STAGE=preflight
MAINTENANCE=0
MIGRATION_STARTED=0
WAS_ACTIVE=0
NEXT_DIR=""
OLD_DIR=""
HELPER=""

usage() {
  cat <<'EOF'
Usage: bash deploy/linux/update.sh RELEASE.tar.gz [--migrate] [--preserve RELATIVE_DIRECTORY]
       [--app-dir /opt/luxiaoming-admin] [--service luxiaoming-admin]
       [--user luxiaoming] [--group luxiaoming]

Run as root. Keeps the server .env, certs and configured payment files.
Prepares dependencies before stopping the service, then backs up MySQL.
--migrate explicitly applies migrate:mysql --apply; business data migrations are separate.
Keeps the installed systemd unit, drop-ins, previous code and SQL backups.
EOF
}

log() { printf '%s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

record() {
  STAGE=$1
  if [[ -n "$STATE_DIR" ]]; then
    printf '%s stage=%s migration_started=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STAGE" "$MIGRATION_STARTED" >> "$STATE_DIR/stages.log"
  fi
}

as_service() {
  sudo -H -u "$APP_USER" -g "$APP_GROUP" -- env \
    PATH="$PATH" npm_config_cache="$STATE_DIR/npm-cache" "$@"
}

stop_service() {
  timeout 45s systemctl stop "$APP_SERVICE"
}

start_and_check() {
  timeout 45s systemctl start "$APP_SERVICE" &&
    node "$HELPER" health --app "$APP_DIR" --timeout 60 &&
    systemctl is-active --quiet "$APP_SERVICE"
}

finish() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$status" -eq 0 ]]; then return; fi
  log "Update failed at stage: $STAGE" >&2
  if [[ -n "$STATE_DIR" ]]; then
    record failed
    if [[ "$MIGRATION_STARTED" -eq 1 ]]; then
      if stop_service; then
        log "Schema migration has started. The service is stopped; automatic code/database rollback is disabled." >&2
      else
        log "Schema migration has started. Failed to confirm service stop; check systemctl immediately." >&2
      fi
      log "Keep all retained files. Review the migration and SQL backup before recovery." >&2
    elif [[ -d "$OLD_DIR" ]]; then
      if stop_service; then
        if [[ -e "$APP_DIR" ]]; then
          if ! mv -T -- "$APP_DIR" "$STATE_DIR/failed-release"; then
            log "Cannot retain the failed release; automatic rollback stopped. The service remains stopped." >&2
            log "Recovery files: $STATE_DIR" >&2
            exit "$status"
          fi
        fi
        if mv -T -- "$OLD_DIR" "$APP_DIR" && start_and_check; then
          record rolled-back
          log "Previous code restored and its health check passed." >&2
        else
          stop_service
          log "Automatic code rollback could not restore a healthy service. Check retained files and systemd logs." >&2
        fi
      else
        log "Cannot stop the service safely; no automatic directory rollback was attempted." >&2
      fi
    elif [[ "$MAINTENANCE" -eq 1 && "$WAS_ACTIVE" -eq 1 ]]; then
      if start_and_check; then
        record previous-service-restored
        log "Previous service restarted and its health check passed." >&2
      else
        log "Previous service restart failed; inspect systemd logs." >&2
      fi
    fi
    log "Recovery files and private stage logs: $STATE_DIR" >&2
  fi
  exit "$status"
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --migrate) MIGRATE=1; shift ;;
    --preserve|--app-dir|--service|--user|--group)
      [[ $# -ge 2 && -n "$2" ]] || die "Missing argument for $1."
      case "$1" in
        --preserve) PRESERVE+=("$2") ;;
        --app-dir) APP_DIR=$2 ;;
        --service) APP_SERVICE=$2 ;;
        --user) APP_USER=$2 ;;
        --group) APP_GROUP=$2 ;;
      esac
      shift 2 ;;
    -*) die "Unknown option: $1" ;;
    *) [[ -z "$ARCHIVE" ]] || die "Specify exactly one release archive."; ARCHIVE=$1; shift ;;
  esac
done

[[ -n "$ARCHIVE" ]] || { usage >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || die "Run this updater as root."
[[ "$APP_SERVICE" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$ ]] || die "Invalid service name."
[[ "$APP_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*\$?$ ]] || die "Invalid service user."
[[ "$APP_GROUP" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*\$?$ ]] || die "Invalid service group."
for command in node npm bash sudo flock systemctl timeout getent mktemp mv; do
  command -v "$command" >/dev/null 2>&1 || die "Required command not found: $command"
done
[[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 22')" == true ]] || die "Node.js 22 or later is required."
[[ "$(id -u "$APP_USER")" -ne 0 ]] || die "The application must run as a non-root service user."
getent group "$APP_GROUP" >/dev/null || die "The service group does not exist."

SCRIPT_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
SOURCE_HELPER="$SCRIPT_ROOT/scripts/prepare-linux-update.cjs"
[[ -f "$SOURCE_HELPER" && ! -L "$SOURCE_HELPER" ]] || die "Missing updater helper; use the full release directory."
node "$SOURCE_HELPER" validate --app "$APP_DIR" >/dev/null
APP_DIR=$(node -p 'require("node:path").resolve(process.argv[1])' "$APP_DIR")
ARCHIVE=$(node -p 'require("node:path").resolve(process.argv[1])' "$ARCHIVE")
[[ -f "$ARCHIVE" && ! -L "$ARCHIVE" ]] || die "Release archive not found or is a symbolic link."
[[ ! -L "$APP_DIR.update.lock" ]] || die "The update lock cannot be a symbolic link."
[[ ! -e "$APP_DIR.update.lock" || -f "$APP_DIR.update.lock" ]] || die "The update lock must be a regular file."
exec 9>"$APP_DIR.update.lock"
flock -n 9 || die "Another update is already running for this application."
chmod 600 "$APP_DIR.update.lock"

[[ "$(systemctl show --property=LoadState --value "$APP_SERVICE")" == loaded ]] || die "Install the systemd service before using the updater."
[[ "$(systemctl show --property=WorkingDirectory --value "$APP_SERVICE")" == "$APP_DIR" ]] || die "The systemd WorkingDirectory does not match --app-dir."
[[ "$(systemctl show --property=User --value "$APP_SERVICE")" == "$APP_USER" ]] || die "The systemd User does not match --user."
SERVICE_GROUP=$(systemctl show --property=Group --value "$APP_SERVICE")
[[ -z "$SERVICE_GROUP" || "$SERVICE_GROUP" == "$APP_GROUP" ]] || die "The systemd Group does not match --group."
if systemctl is-active --quiet "$APP_SERVICE"; then WAS_ACTIVE=1; fi

STATE_DIR=$(mktemp -d "$APP_DIR-update-$(date +%Y%m%d-%H%M%S)-XXXXXXXX")
chown "root:$APP_GROUP" "$STATE_DIR"
chmod 710 "$STATE_DIR"
NEXT_DIR="$STATE_DIR/next"
OLD_DIR="$STATE_DIR/previous"
HELPER="$STATE_DIR/prepare-linux-update.cjs"
cp -- "$SOURCE_HELPER" "$HELPER"
chmod 644 "$HELPER"
mkdir "$STATE_DIR/database" "$STATE_DIR/npm-cache"
chown "$APP_USER:$APP_GROUP" "$STATE_DIR/database" "$STATE_DIR/npm-cache"
chmod 700 "$STATE_DIR/database" "$STATE_DIR/npm-cache"
record preparing
log "Preparing release. Recovery files: $STATE_DIR"
PREPARE_ARGS=(prepare --archive "$ARCHIVE" --current "$APP_DIR" --next "$NEXT_DIR")
for directory in "${PRESERVE[@]}"; do PREPARE_ARGS+=(--preserve "$directory"); done
node "$HELPER" "${PREPARE_ARGS[@]}" > "$STATE_DIR/prepare.json"
chown -R "$APP_USER:$APP_GROUP" "$NEXT_DIR"
as_service node "$HELPER" references --app "$NEXT_DIR" --original "$APP_DIR" > "$STATE_DIR/references.json"
record installing
(
  cd "$NEXT_DIR"
  as_service sh deploy/linux/install.sh
) > "$STATE_DIR/install.log" 2>&1 || die "Dependency installation or syntax check failed; inspect the private install.log."

record stopping
MAINTENANCE=1
log "Preparation passed. Stopping $APP_SERVICE for the database backup and release switch."
stop_service
record database-backup
SQL_BACKUP="$STATE_DIR/database/before-update.sql"
(
  cd "$NEXT_DIR"
  as_service npm run backup:mysql -- --output "$SQL_BACKUP"
) > "$STATE_DIR/backup.log" 2>&1 || die "Database backup failed; no schema migration or code switch was attempted."
[[ -s "$SQL_BACKUP" ]] || die "Database backup did not create a nonempty SQL file."

if [[ "$MIGRATE" -eq 1 ]]; then
  MIGRATION_STARTED=1
  record schema-migration
  (
    cd "$NEXT_DIR"
    as_service npm run migrate:mysql -- --apply
  ) > "$STATE_DIR/migration.log" 2>&1 || die "Schema migration failed; the service will remain stopped for review."
fi

record switching
cd "$(dirname -- "$APP_DIR")"
mv -T -- "$APP_DIR" "$OLD_DIR"
mv -T -- "$NEXT_DIR" "$APP_DIR"
record starting
start_and_check > "$STATE_DIR/health.log" 2>&1 || die "New release did not become healthy; inspect the private health.log and systemd journal."
record complete
log "Update complete; the service is active and /api/health returned ok=true."
log "Previous code: $OLD_DIR"
log "Database backup: $SQL_BACKUP"
log "Stage logs: $STATE_DIR/stages.log"
