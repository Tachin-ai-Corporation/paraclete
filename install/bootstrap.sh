#!/usr/bin/env bash
# install/bootstrap.sh: installs a paraclete release on this VM and starts its services. It runs as
# root at every boot (the startup-script stub install.sh writes fetches it from paraclete-repo at
# paraclete-ref) and for every upgrade (install/upgrade.sh fetches the target commit's own copy and
# runs it with PARACLETE_REF set). It reads the VM metadata, downloads the release at an exact commit,
# stages it in /opt/paraclete.next, checks it, swaps it into /opt/paraclete, starts the services
# (the gateway first) and writes the readiness document agent/instance. It never edits an installed
# release in place: a release that fails its checks is never swapped in, and one whose services do
# not come up is swapped back out. The contract it keeps is install/README.md; the Node helpers it
# runs from the release are in install/vm/. Everything it does is logged to stdout and stderr.
#
# Which commit it installs:
#   1. PARACLETE_REF when set (an upgrade), from PARACLETE_REPO, labelled PARACLETE_RELEASE;
#   2. else the installed release, when the metadata's paraclete-repo and paraclete-ref are the ones
#      recorded in its release.json (nothing new was asked for since it was installed, so an upgrade
#      the dashboard made survives a reboot);
#   3. else the metadata's paraclete-ref from paraclete-repo, labelled paraclete-release.
# A commit is installed by that commit's own bootstrap: this script hands over to the installed copy
# when the commit it would act on is not the one it came from. Run twice with the same commit, the
# second run only checks that the services run and writes readiness again.

set -Eeuo pipefail

readonly INSTALL_ROOT=/opt/paraclete
readonly STAGE_ROOT=/opt/paraclete.next
readonly PREV_ROOT=/opt/paraclete.prev
readonly DATA_ROOT=/var/lib/paraclete
readonly DATA_DIRS=(memory missions workspace files skills services home)
readonly ETC_DIR=/etc/paraclete
readonly INSTANCE_FILE=/etc/paraclete/instance.json
readonly TOKEN_FILE=/etc/paraclete/gateway-token
readonly UNIT_DIR=/etc/systemd/system
readonly SERVICE_USER=paraclete
readonly BASE_PACKAGES=(ca-certificates curl git jq unzip)
readonly NODE=/usr/bin/node
readonly NODE_MAJOR=24
readonly METADATA_URL=http://metadata.google.internal/computeMetadata/v1
readonly LOCK_FILE=/run/paraclete-bootstrap.lock
# How long started services get before each is checked to be running: a service that fails at startup
# has been restarted by then, and shows as activating instead of active.
readonly SETTLE_SECONDS=5

readonly COMMIT_PATTERN='^[0-9a-f]{40}$'
readonly REPO_PATTERN='^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+$'
# The role is used in paths before the instance record is checked; this only keeps it one safe path
# segment. config/instance.mjs holds the role id rule, and the record is checked against it.
readonly ROLE_SEGMENT_PATTERN='^[a-z0-9][a-z0-9-]*$'
# What was asked for (a release tag, a branch name or a commit), shown to people.
readonly LABEL_PATTERN='^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'

STEP=start
FAILURE=''
FAILED_AT=''
SERVICE_FAILURE=''
MOVED_PREVIOUS=0
SWAPPED=0
WORK_DIR=''
RELEASE_DIR=''
CHANGED=0
UNITS=()
PROJECT='' ZONE='' ROLE='' AGENT_NAME='' BUCKET='' DASHBOARD_URL=''
WORKSPACE_ACCOUNT='' WORKSPACE_SIGNER=''
META_REPO='' META_REF='' META_RELEASE=''
INSTALLED_COMMIT='' INSTALLED_REPO='' INSTALLED_REF='' INSTALLED_META_REPO='' INSTALLED_META_REF=''
TARGET_COMMIT='' TARGET_REPO='' TARGET_RELEASE='' TARGET_SOURCE='' SELF_COMMIT=''

log() { printf 'paraclete-bootstrap: %s\n' "$*"; }
warn() { printf 'paraclete-bootstrap: warning: %s\n' "$*" >&2; }

# Stops the run with a reason; the exit trap reports it as the readiness error.
die() {
  FAILURE="$*"
  printf 'paraclete-bootstrap: error: %s\n' "$*" >&2
  exit 1
}

on_error() { FAILED_AT="line $1: $2"; }

on_exit() {
  local status=$?
  set +e
  if (( status != 0 )); then
    local reason="${FAILURE:-step '${STEP}' failed at ${FAILED_AT:-an unknown command} (exit ${status})}"
    printf 'paraclete-bootstrap: failed: %s\n' "$reason" >&2
    report_readiness failed "$reason"
  fi
  if [[ -n "$WORK_DIR" ]]; then rm -rf "$WORK_DIR"; fi
  exit "$status"
}

contains() {  # contains <word> <list...>
  local word="$1" item
  shift
  for item in "$@"; do [[ "$item" == "$word" ]] && return 0; done
  return 1
}

# ---- metadata ------------------------------------------------------------------------------------

metadata_value() {  # metadata_value <path>: a value the metadata server must have
  curl --silent --show-error --fail --retry 5 --retry-connrefused --connect-timeout 5 --max-time 30 \
    --header 'Metadata-Flavor: Google' "${METADATA_URL}/$1"
}

metadata_attribute() {  # metadata_attribute <name>: an instance attribute, empty when it is not set
  local value
  if value="$(curl --silent --fail --retry 5 --retry-connrefused --connect-timeout 5 --max-time 30 \
    --header 'Metadata-Flavor: Google' "${METADATA_URL}/instance/attributes/$1" 2>/dev/null)"; then
    printf '%s' "$value"
  fi
}

read_metadata() {
  STEP=metadata
  local zone_path
  PROJECT="$(metadata_value project/project-id)"
  zone_path="$(metadata_value instance/zone)"
  ZONE="${zone_path##*/}"
  META_REPO="$(metadata_attribute paraclete-repo)"
  META_REF="$(metadata_attribute paraclete-ref)"
  META_RELEASE="$(metadata_attribute paraclete-release)"
  ROLE="$(metadata_attribute paraclete-role)"
  AGENT_NAME="$(metadata_attribute paraclete-agent-name)"
  BUCKET="$(metadata_attribute paraclete-bucket)"
  WORKSPACE_ACCOUNT="$(metadata_attribute paraclete-workspace-account)"
  WORKSPACE_SIGNER="$(metadata_attribute paraclete-workspace-signer)"
  DASHBOARD_URL="$(metadata_attribute paraclete-dashboard-url)"
  check_metadata
}

check_metadata() {
  [[ -n "$PROJECT" ]] || die "the metadata server gave no project id"
  [[ -n "$ZONE" ]] || die "the metadata server gave no zone"
  [[ "$META_REF" =~ $COMMIT_PATTERN ]] \
    || die "metadata paraclete-ref must be a full 40-character commit, got '${META_REF:0:80}'"
  [[ "$META_REPO" =~ $REPO_PATTERN ]] || die "metadata paraclete-repo must be owner/name, got '${META_REPO:0:80}'"
  [[ "$ROLE" =~ $ROLE_SEGMENT_PATTERN ]] || die "metadata paraclete-role must be a role id like generic, got '${ROLE:0:80}'"
  [[ -n "$AGENT_NAME" ]] || die "metadata paraclete-agent-name is not set"
  [[ -n "$BUCKET" ]] || die "metadata paraclete-bucket is not set"
  [[ -z "$META_RELEASE" || "$META_RELEASE" =~ $LABEL_PATTERN ]] \
    || die "metadata paraclete-release must be a tag, branch or commit, got '${META_RELEASE:0:80}'"
}

# ---- which commit, and which bootstrap installs it -----------------------------------------------

read_installed_release() {  # sets INSTALLED_*: empty when no readable release.json is installed
  INSTALLED_COMMIT='' INSTALLED_REPO='' INSTALLED_REF='' INSTALLED_META_REPO='' INSTALLED_META_REF=''
  [[ -f "$INSTALL_ROOT/release.json" ]] || return 0
  if [[ ! -x "$NODE" ]]; then
    warn "Node.js is missing, so ${INSTALL_ROOT}/release.json cannot be read; installing again"
    return 0
  fi
  local fields
  if ! fields="$("$NODE" -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const m = r.metadata || {};
    for (const v of [r.commit, r.repo, r.ref, m.repo, m.ref]) console.log(typeof v === "string" ? v.replace(/\s/g, "") : "");
  ' "$INSTALL_ROOT/release.json")"; then
    warn "${INSTALL_ROOT}/release.json cannot be read; installing again"
    return 0
  fi
  { read -r INSTALLED_COMMIT; read -r INSTALLED_REPO; read -r INSTALLED_REF; read -r INSTALLED_META_REPO; read -r INSTALLED_META_REF; } <<< "$fields"
}

choose_target() {  # sets TARGET_* from the environment, the installed release and the metadata
  SELF_COMMIT="${PARACLETE_REF:-$META_REF}"
  if [[ -n "${PARACLETE_REF:-}" ]]; then
    TARGET_COMMIT="$PARACLETE_REF"
    TARGET_REPO="${PARACLETE_REPO:-$META_REPO}"
    TARGET_RELEASE="${PARACLETE_RELEASE:-$PARACLETE_REF}"
    TARGET_SOURCE=PARACLETE_REF
  elif [[ -n "$INSTALLED_COMMIT" && "$INSTALLED_META_REF" == "$META_REF" && "$INSTALLED_META_REPO" == "$META_REPO" ]]; then
    TARGET_COMMIT="$INSTALLED_COMMIT"
    TARGET_REPO="$INSTALLED_REPO"
    TARGET_RELEASE="${INSTALLED_REF:-$INSTALLED_COMMIT}"
    TARGET_SOURCE='the installed release'
  else
    TARGET_COMMIT="$META_REF"
    TARGET_REPO="$META_REPO"
    TARGET_RELEASE="${META_RELEASE:-$META_REF}"
    TARGET_SOURCE='the VM metadata'
  fi
  [[ "$TARGET_COMMIT" =~ $COMMIT_PATTERN ]] || die "the commit to install must be 40 hex characters, got '${TARGET_COMMIT:0:80}'"
  [[ "$TARGET_REPO" =~ $REPO_PATTERN ]] || die "the repository must be owner/name, got '${TARGET_REPO:0:80}'"
  [[ "$TARGET_RELEASE" =~ $LABEL_PATTERN ]] || die "'${TARGET_RELEASE:0:80}' is not a release tag, branch or commit"
}

node_is_current() {  # Node.js at $NODE, NODE_MAJOR or later
  local version major
  version="$("$NODE" --version 2>/dev/null)" || return 1
  major="${version#v}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= NODE_MAJOR ))
}

installed_release_is_target() {  # the target commit is installed whole, from the target repository
  [[ "$INSTALLED_COMMIT" == "$TARGET_COMMIT" && "$INSTALLED_REPO" == "$TARGET_REPO" ]] || return 1
  local path missing=''
  for path in agent/node_modules bin config/contracts.mjs install/vm/instance-record.mjs install/vm/readiness.mjs; do
    [[ -e "$INSTALL_ROOT/$path" ]] || missing+=" ${path}"
  done
  if [[ -n "$missing" ]]; then
    warn "the installed release lacks${missing}; installing it again"
    return 1
  fi
  if ! node_is_current; then
    warn "Node.js ${NODE_MAJOR} is not installed; installing the release again"
    return 1
  fi
}

hand_off() {  # runs the target commit's own bootstrap in place of this one
  local script="$INSTALL_ROOT/install/bootstrap.sh"
  if [[ "$INSTALLED_COMMIT" != "$TARGET_COMMIT" || ! -f "$script" ]]; then
    script="$(mktemp /var/tmp/paraclete-bootstrap-handoff.XXXXXX)"
    download "https://raw.githubusercontent.com/${TARGET_REPO}/${TARGET_COMMIT}/install/bootstrap.sh" "$script"
  fi
  log "this instance runs ${TARGET_COMMIT}; handing over to that commit's bootstrap"
  release_lock
  if [[ -n "$WORK_DIR" ]]; then rm -rf "$WORK_DIR"; fi
  trap - ERR EXIT
  exec env PARACLETE_REF="$TARGET_COMMIT" PARACLETE_REPO="$TARGET_REPO" PARACLETE_RELEASE="$TARGET_RELEASE" \
    bash "$script"
}

take_lock() {  # one bootstrap at a time: a boot and an upgrade must not stage over each other
  exec 9>"$LOCK_FILE"
  if ! flock --nonblock 9; then
    log "another bootstrap is running; waiting for it to finish"
    flock 9
  fi
}

release_lock() { exec 9>&-; }

# ---- packages and the release --------------------------------------------------------------------

download() {  # download <url> <file>
  curl --fail --silent --show-error --location --retry 5 --retry-connrefused --connect-timeout 20 \
    --speed-limit 1024 --speed-time 60 --output "$2" "$1"
}

apt_get() {
  DEBIAN_FRONTEND=noninteractive apt-get -q -o DPkg::Lock::Timeout=600 -o Acquire::Retries=3 "$@"
}

package_installed() {  # package_installed <name>
  local status
  status="$(dpkg-query --show --showformat='${Status}' "$1" 2>/dev/null)" || return 1
  [[ "$status" == 'install ok installed' ]]
}

ensure_packages() {  # ensure_packages <name...>: installs the ones missing, and nothing when none is
  local missing=() package
  for package in "$@"; do
    [[ -z "$package" ]] || package_installed "$package" || missing+=("$package")
  done
  (( ${#missing[@]} > 0 )) || return 0
  log "installing packages: ${missing[*]}"
  apt_get update
  apt_get install -y "${missing[@]}"
}

ensure_node() {
  if node_is_current; then return 0; fi
  log "installing Node.js ${NODE_MAJOR} from NodeSource"
  local setup="$WORK_DIR/nodesource-setup.sh"
  download "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" "$setup"
  bash "$setup"
  apt_get install -y nodejs
  node_is_current || die "Node.js ${NODE_MAJOR} or later is required at ${NODE}; found $("$NODE" --version 2>/dev/null || echo none)"
}

archive_top_directory() {  # archive_top_directory <dir>: its one entry, which must be a directory
  local entries=()
  shopt -s nullglob dotglob
  entries=("$1"/*)
  shopt -u nullglob dotglob
  (( ${#entries[@]} == 1 )) && [[ -d "${entries[0]}" ]] || return 1
  printf '%s\n' "${entries[0]}"
}

download_release() {  # sets RELEASE_DIR to the extracted release, checked to be TARGET_COMMIT
  local archive="$WORK_DIR/release.tar.gz" extract="$WORK_DIR/release" top
  log "downloading ${TARGET_REPO} at ${TARGET_COMMIT}"
  download "https://codeload.github.com/${TARGET_REPO}/tar.gz/${TARGET_COMMIT}" "$archive"
  mkdir -p "$extract"
  tar --extract --gzip --file "$archive" --directory "$extract" --no-same-owner
  top="$(archive_top_directory "$extract")" || die "the archive of ${TARGET_COMMIT} does not hold exactly one top directory"
  [[ "${top##*/}" == *"-${TARGET_COMMIT}" ]] || die "the archive holds '${top##*/}', not commit ${TARGET_COMMIT}"
  [[ -f "$top/install/manifest.txt" ]] || die "commit ${TARGET_COMMIT} has no install/manifest.txt, so it is not an installable release"
  RELEASE_DIR="$top"
}

node_step() {  # node_step <what failed> <node arguments...>: runs a release helper; a failure stops the run with its message
  local what="$1" errors="$WORK_DIR/step-errors"
  shift
  if ! "$NODE" "$@" 2>"$errors"; then
    cat "$errors" >&2
    die "${what}: $(head -c 1500 "$errors" | tr '\n' ' ')"
  fi
  cat "$errors" >&2
}

install_role_packages() {
  local list="$WORK_DIR/role-packages" packages=()
  node_step "the packages of role ${ROLE} cannot be read" \
    "$RELEASE_DIR/install/vm/role-packages.mjs" "--root=$RELEASE_DIR" "--role=$ROLE" > "$list"
  mapfile -t packages < "$list"
  ensure_packages "${packages[@]}"
}

stage_release() {  # builds the release in STAGE_ROOT: its files, npm packages and launchers
  log "staging ${TARGET_COMMIT} in ${STAGE_ROOT}"
  rm -rf "$STAGE_ROOT"
  node_step "the release cannot be staged" "$RELEASE_DIR/install/vm/manifest.mjs" stage \
    "--source=$RELEASE_DIR" "--dest=$STAGE_ROOT" "--role=$ROLE"
  log "installing the npm packages in agent/"
  (cd "$STAGE_ROOT/agent" && npm_config_update_notifier=false npm ci --omit=dev --no-audit --no-fund)
  node_step "the command launchers cannot be written" "$RELEASE_DIR/install/vm/launchers.mjs" \
    "--root=$STAGE_ROOT" "--install-root=$INSTALL_ROOT" "--role=$ROLE"
}

record_release() {  # writes release.json into the checked stage; makes the tree root's, read-only to others
  node_step "release.json cannot be written" "$RELEASE_DIR/install/vm/release-record.mjs" \
    "--out=$STAGE_ROOT/release.json" "--repo=$TARGET_REPO" "--ref=$TARGET_RELEASE" "--commit=$TARGET_COMMIT" \
    "--metadata-repo=$META_REPO" "--metadata-ref=$META_REF"
  chown -R root:root "$STAGE_ROOT"
  chmod -R u+rwX,go+rX,go-w "$STAGE_ROOT"
  chmod 0755 "$STAGE_ROOT/install/bootstrap.sh" "$STAGE_ROOT/install/upgrade.sh" "$STAGE_ROOT"/bin/*
}

build_instance_record() {  # build_instance_record <release root> <out file>: checked by that release
  local args=(
    "--out=$2" "--project=$PROJECT" "--zone=$ZONE" "--agent-name=$AGENT_NAME" "--role=$ROLE"
    "--bucket=$BUCKET" "--release=$TARGET_RELEASE" "--source-repo=$TARGET_REPO"
    "--install-root=$INSTALL_ROOT" "--data-root=$DATA_ROOT"
  )
  if [[ -n "$DASHBOARD_URL" ]]; then args+=("--dashboard-url=$DASHBOARD_URL"); fi
  if [[ -n "$WORKSPACE_ACCOUNT" ]]; then args+=("--workspace-account=$WORKSPACE_ACCOUNT"); fi
  if [[ -n "$WORKSPACE_SIGNER" ]]; then args+=("--workspace-signer=$WORKSPACE_SIGNER"); fi
  node_step "the instance record is not valid" "$1/install/vm/instance-record.mjs" "${args[@]}"
}

validate_release() {  # the gate: nothing is stopped or swapped unless the staged release passes it
  log "checking the staged release"
  node_step "release ${TARGET_COMMIT} failed its checks and was not installed" \
    "$STAGE_ROOT/install/vm/check-release.mjs" "--install-root=$INSTALL_ROOT"
  build_instance_record "$STAGE_ROOT" "$WORK_DIR/instance.json"
}

# ---- the host: user, directories, instance record, token -----------------------------------------

ensure_user() {
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    log "creating the ${SERVICE_USER} user"
    useradd --system --user-group --home-dir "$DATA_ROOT/home" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  if [[ "$(getent passwd "$SERVICE_USER" | cut -d: -f6)" != "$DATA_ROOT/home" ]]; then
    usermod --home "$DATA_ROOT/home" "$SERVICE_USER"
  fi
  usermod --append --groups systemd-journal "$SERVICE_USER"
}

ensure_directories() {
  local dir
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_ROOT"
  for dir in "${DATA_DIRS[@]}"; do
    install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_ROOT/$dir"
  done
  install -d -o root -g "$SERVICE_USER" -m 0750 "$ETC_DIR"
}

new_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
    printf '\n'
  fi
}

ensure_gateway_token() {  # created once, kept across upgrades; never printed
  if [[ ! -s "$TOKEN_FILE" ]]; then
    log "creating the gateway token"
    local temp
    temp="$(mktemp "$ETC_DIR/.gateway-token.XXXXXX")"
    new_token > "$temp"
    mv -f "$temp" "$TOKEN_FILE"
    CHANGED=1
  fi
  chown "root:$SERVICE_USER" "$TOKEN_FILE"
  chmod 0640 "$TOKEN_FILE"
}

seed_memory() {  # seed_memory <release root>: the first working memory, only when there is none
  local target="$DATA_ROOT/memory/MEMORY.md" seed="$1/roles/$ROLE/memory.md"
  if [[ -e "$target" ]]; then return 0; fi
  [[ -f "$seed" ]] || seed="$1/roles/generic/memory.md"
  if [[ ! -f "$seed" ]]; then
    warn "the release has no memory seed; working memory starts empty"
    return 0
  fi
  log "seeding working memory from ${seed#"$1"/}"
  install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0640 "$seed" "$target"
}

prepare_host() {  # prepare_host <release root>
  ensure_user
  ensure_directories
  ensure_gateway_token
  seed_memory "$1"
}

install_instance_record() {  # install_instance_record <new record>: keeps the last one for a rollback
  if [[ -f "$INSTANCE_FILE" ]] && cmp -s "$1" "$INSTANCE_FILE"; then return 0; fi
  log "writing ${INSTANCE_FILE}"
  if [[ -f "$INSTANCE_FILE" ]]; then cp -p "$INSTANCE_FILE" "$INSTANCE_FILE.prev" || return 1; fi
  install -o root -g root -m 0644 "$1" "$INSTANCE_FILE.next" && mv -f "$INSTANCE_FILE.next" "$INSTANCE_FILE" || return 1
  CHANGED=1
}

# ---- services ------------------------------------------------------------------------------------
# These functions also run where a failure must not end the script (a switch that is rolled back), so
# each one checks its own steps and says what failed in SERVICE_FAILURE.

installed_unit_names() {  # the paraclete units in /etc/systemd/system; an upgrade's transient unit is never one
  local file name
  for file in "$UNIT_DIR"/paraclete-*.service; do
    [[ -f "$file" ]] || continue
    name="${file##*/}"
    [[ "$name" == paraclete-upgrade-* ]] && continue
    printf '%s\n' "$name"
  done
  return 0
}

install_units() {  # copies the installed release's units into place, removes ones it no longer ships, enables them
  local file name changed=0 shipped=() current=()
  for file in "$INSTALL_ROOT"/agent/services/*/paraclete-*.service; do
    [[ -f "$file" ]] || continue
    name="${file##*/}"
    shipped+=("$name")
    if ! cmp -s "$file" "$UNIT_DIR/$name"; then
      install -o root -g root -m 0644 "$file" "$UNIT_DIR/$name" || { SERVICE_FAILURE="cannot install ${name}"; return 1; }
      changed=1
    fi
  done
  if (( ${#shipped[@]} == 0 )); then
    SERVICE_FAILURE="${INSTALL_ROOT} ships no systemd units"
    return 1
  fi
  mapfile -t current < <(installed_unit_names)
  for name in "${current[@]}"; do
    if ! contains "$name" "${shipped[@]}"; then
      log "removing ${name}, which this release no longer ships"
      systemctl disable --now "$name" || warn "could not stop ${name}"
      rm -f "$UNIT_DIR/$name"
      changed=1
    fi
  done
  if (( changed )); then
    systemctl daemon-reload || { SERVICE_FAILURE='systemctl daemon-reload failed'; return 1; }
    CHANGED=1
  fi
  systemctl enable --quiet "${shipped[@]}" || { SERVICE_FAILURE="cannot enable ${shipped[*]}"; return 1; }
  UNITS=("${shipped[@]}")
}

stop_services() {
  local units=()
  mapfile -t units < <(installed_unit_names)
  (( ${#units[@]} > 0 )) || return 0
  log "stopping ${units[*]}"
  systemctl stop "${units[@]}" || { SERVICE_FAILURE="cannot stop ${units[*]}"; return 1; }
}

contract_value() {  # contract_value <dotted key>: one value from the installed, checked contracts
  "$NODE" -e '
    const [file, key] = process.argv.slice(1);
    import(require("node:url").pathToFileURL(file).href).then((m) => {
      let value = m.loadContracts();
      for (const part of key.split(".")) value = value == null ? undefined : value[part];
      if (value == null || typeof value === "object") throw new Error(`the contracts have no value at ${key}`);
      process.stdout.write(`${value}\n`);
    }).catch((err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
  ' "$INSTALL_ROOT/config/contracts.mjs" "$1"
}

wait_for_gateway() {  # polls the gateway's /ready for as long as the contracts give a restarted gateway
  local bind port limit_ms seconds url deadline
  if ! bind="$(contract_value gateway.bind)" || ! port="$(contract_value gateway.port)" \
    || ! limit_ms="$(contract_value control.gateway_ready_timeout_ms)"; then
    SERVICE_FAILURE="the gateway's address cannot be read from ${INSTALL_ROOT}/config/contracts.json"
    return 1
  fi
  if [[ "$bind" == *:* ]]; then bind="[$bind]"; fi
  url="http://${bind}:${port}/ready"
  seconds=$(( (limit_ms + 999) / 1000 ))
  deadline=$(( SECONDS + seconds ))
  log "waiting up to ${seconds}s for the gateway at ${url}"
  until curl --silent --fail --max-time 5 --output /dev/null "$url"; do
    if (( SECONDS >= deadline )); then
      SERVICE_FAILURE="the gateway was not ready at ${url} within ${seconds}s; see journalctl -u paraclete-gateway"
      return 1
    fi
    sleep 1
  done
}

start_services() {  # start_services start|restart: the gateway first, the rest once it is ready, control last
  local verb="$1" unit rest=() last=()
  if ! contains paraclete-gateway.service "${UNITS[@]}"; then
    SERVICE_FAILURE='the release has no paraclete-gateway.service'
    return 1
  fi
  for unit in "${UNITS[@]}"; do
    case "$unit" in
      paraclete-gateway.service) ;;
      paraclete-control.service) last+=("$unit") ;;
      *) rest+=("$unit") ;;
    esac
  done
  rest+=("${last[@]}")
  log "${verb}ing paraclete-gateway.service"
  systemctl "$verb" paraclete-gateway.service || { SERVICE_FAILURE="cannot ${verb} paraclete-gateway.service"; return 1; }
  wait_for_gateway || return 1
  if (( ${#rest[@]} > 0 )); then
    log "${verb}ing ${rest[*]}"
    systemctl "$verb" "${rest[@]}" || { SERVICE_FAILURE="cannot ${verb} ${rest[*]}"; return 1; }
  fi
  sleep "$SETTLE_SECONDS"
  for unit in "${UNITS[@]}"; do
    if ! systemctl is-active --quiet "$unit"; then
      SERVICE_FAILURE="${unit} is not running ${SETTLE_SECONDS}s after it was started; see journalctl -u ${unit}"
      return 1
    fi
  done
  log "all services are running"
}

# ---- switch, roll back, install ------------------------------------------------------------------

swap_release() {  # the staged release becomes the installed one; the installed one is kept as the previous
  log "swapping ${TARGET_COMMIT} into ${INSTALL_ROOT}"
  rm -rf "$PREV_ROOT" || { SERVICE_FAILURE="cannot remove ${PREV_ROOT}"; return 1; }
  if [[ -d "$INSTALL_ROOT" ]]; then
    mv "$INSTALL_ROOT" "$PREV_ROOT" || { SERVICE_FAILURE="cannot move ${INSTALL_ROOT} aside"; return 1; }
    MOVED_PREVIOUS=1
  fi
  mv "$STAGE_ROOT" "$INSTALL_ROOT" || { SERVICE_FAILURE="cannot move ${STAGE_ROOT} into place"; return 1; }
  SWAPPED=1
}

switch_release() {  # from the services stopping to the new release running; returns 1 at the first failure
  stop_services || return 1
  swap_release || return 1
  install_instance_record "$WORK_DIR/instance.json" || { SERVICE_FAILURE="cannot write ${INSTANCE_FILE}"; return 1; }
  install_units || return 1
  start_services start
}

rollback() {  # the previous release runs again; the failed one goes to STAGE_ROOT, which the next install clears
  (( MOVED_PREVIOUS )) && [[ -d "$PREV_ROOT" ]] || { SERVICE_FAILURE="${PREV_ROOT} is gone"; return 1; }
  warn "returning to the previous release"
  stop_services || warn "could not stop every service"
  if [[ -d "$INSTALL_ROOT" ]]; then
    rm -rf "$STAGE_ROOT" && mv "$INSTALL_ROOT" "$STAGE_ROOT" || { SERVICE_FAILURE="cannot move the failed release aside"; return 1; }
  fi
  mv "$PREV_ROOT" "$INSTALL_ROOT" || { SERVICE_FAILURE="cannot move ${PREV_ROOT} back into place"; return 1; }
  if [[ -f "$INSTANCE_FILE.prev" ]]; then
    mv -f "$INSTANCE_FILE.prev" "$INSTANCE_FILE" || { SERVICE_FAILURE="cannot restore ${INSTANCE_FILE}"; return 1; }
  fi
  install_units && start_services start || return 1
  log "the previous release is running again"
}

restart_installed() {  # after a switch that failed before the swap: the untouched release starts again
  [[ -d "$INSTALL_ROOT" ]] || return 1
  install_units && start_services start
}

full_install() {
  log "installing ${TARGET_RELEASE} (${TARGET_COMMIT}) from ${TARGET_REPO}"
  STEP=packages
  ensure_packages "${BASE_PACKAGES[@]}"
  ensure_node
  STEP=download
  download_release
  STEP=role-packages
  install_role_packages
  STEP=stage
  stage_release
  STEP=validate
  validate_release
  STEP=record
  record_release
  STEP=prepare
  prepare_host "$STAGE_ROOT"
  rm -f "$INSTANCE_FILE.prev"
  STEP=switch
  if ! switch_release; then
    local reason="$SERVICE_FAILURE"
    if (( MOVED_PREVIOUS )); then
      rollback && die "${reason}; returned to the previous release ${INSTALLED_COMMIT}"
      die "${reason}; returning to the previous release ${INSTALLED_COMMIT} failed as well: ${SERVICE_FAILURE}"
    fi
    if (( SWAPPED )); then die "${reason}; there is no previous release to return to"; fi
    restart_installed && die "${reason}; the installed release was not changed and runs again"
    die "${reason}; the installed release was not changed"
  fi
}

fast_path() {
  log "${TARGET_RELEASE} (${TARGET_COMMIT}) is installed; checking that it runs"
  STEP=prepare
  prepare_host "$INSTALL_ROOT"
  build_instance_record "$INSTALL_ROOT" "$WORK_DIR/instance.json"
  install_instance_record "$WORK_DIR/instance.json" || die "cannot write ${INSTANCE_FILE}"
  STEP=start
  install_units || die "$SERVICE_FAILURE"
  local verb=start
  if (( CHANGED )); then verb=restart; fi
  start_services "$verb" || die "$SERVICE_FAILURE"
}

# ---- readiness -----------------------------------------------------------------------------------

report_readiness() {  # report_readiness ready|failed [error]: the Firestore document agent/instance
  local helper='' dir
  if [[ ! -x "$NODE" ]]; then
    warn "Node.js is not installed yet, so agent/instance cannot be written"
    return 1
  fi
  for dir in "$RELEASE_DIR" "$INSTALL_ROOT"; do
    if [[ -n "$dir" && -f "$dir/install/vm/readiness.mjs" ]]; then helper="$dir/install/vm/readiness.mjs"; break; fi
  done
  if [[ -z "$helper" || -z "$PROJECT" ]]; then
    warn "no release is downloaded or installed yet, so agent/instance cannot be written"
    return 1
  fi
  local args=("--project=$PROJECT" "--status=$1" "--release=$TARGET_RELEASE" "--commit=$TARGET_COMMIT")
  if [[ -n "${2:-}" ]]; then args+=("--error=$2"); fi
  "$NODE" "$helper" "${args[@]}"
}

main() {
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  export HOME="${HOME:-/root}"
  umask 022
  trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR
  trap on_exit EXIT
  [[ "$(id -u)" == 0 ]] || die "bootstrap.sh runs as root"
  log "starting"
  read_metadata
  STEP=lock
  take_lock
  WORK_DIR="$(mktemp -d /var/tmp/paraclete-bootstrap.XXXXXX)"
  read_installed_release
  choose_target
  log "target ${TARGET_RELEASE} (${TARGET_COMMIT}) from ${TARGET_REPO}, chosen by ${TARGET_SOURCE}"
  if [[ "$TARGET_COMMIT" != "$SELF_COMMIT" ]]; then hand_off; fi
  if installed_release_is_target; then
    fast_path
  else
    full_install
  fi
  STEP=readiness
  report_readiness ready || die "the services run, but the readiness document agent/instance could not be written"
  log "ready: ${TARGET_RELEASE} (${TARGET_COMMIT})"
}

# Sourced (the tests do), this file only defines the functions above; run, it installs.
if [[ -n "${BASH_SOURCE[0]:-}" && "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi
main "$@"
