#!/usr/bin/env bash
# dev/harness2/lab-follow-main.sh: keeps one harness lab VM on main's head. Lab only: a product instance
# moves only to the releases its dashboard offers, never to main, and this file is never in
# install/manifest.txt. dev/harness2/lab-updater.mjs installs it on the lab's two VMs as
# /usr/local/sbin/paraclete-lab-follow-main, which paraclete-lab-follow-main.timer runs as root every
# --interval minutes; `node dev/harness2/cli.mjs lab-follow-main --status` runs it with --status over IAP
# SSH. It does not install the timer, and it never edits an installed release: an upgrade goes through
# install/upgrade.sh, the bootstrap and validation gate a release upgrade uses.
#
# Each run, holding /run/paraclete-lab-follow-main.lock (a second run finds it held and stops):
#   1. reads the repository from /opt/paraclete/release.json (else the VM metadata's paraclete-repo) and
#      main's head from `git ls-remote https://github.com/<repo> refs/heads/main`;
#   2. when the installed commit or the harness checkout is behind main and the brain reports a mission
#      running (runner.active_mission in <data root>/services/brain/health.json), skips, and records the
#      first skip in <data root>/lab-follow-main.busy-since. Once that skip is 24 hours old it goes
#      ahead anyway, and clears the record when everything it did succeeded;
#   3. runs `install/upgrade.sh --ref <head> --repo <repo>` when release.json's commit is not main's
#      head and no bootstrap holds /run/paraclete-bootstrap.lock. The upgrade's output goes to
#      /var/log/paraclete-lab-follow-main-upgrade.log;
#   4. with --harness-checkout <dir> (the driver only), fast-forwards that checkout to origin/main as its
#      owner, the paraclete user, and only when it is on main with no changes (untracked files count),
#      no harness process runs (`pgrep -f` for dev/harness2, the global loop's cycle and the
#      paraclete-h2 role's three harness commands), and origin/main contains its HEAD. It never resets, stashes or merges anything else;
#   5. prints one line, which the journal keeps: the repository, the installed commit, main's head, the
#      agent, and what happened to the install and to the checkout.
# Running it twice is safe: the second run finds everything current, or the lock held.
#
# It never prints a remote URL or git's own output (the checkout's remote may hold a token), and it
# keeps no credential: the busy-since file holds a number, written by rename so that a link the agent's
# user puts in its place is replaced, never followed.
#
#   paraclete-lab-follow-main [--harness-checkout <dir>] [--status]
#
# --status prints the timer's state, its last run, both commits, the agent's state and the checkout's
# commit as lab-follow-main.<key>=<value> lines, and changes nothing. Sourced (the tests do), this file
# only defines its settings and functions; the tests then point the settings at a sandbox.

set -uo pipefail

INSTALL_ROOT=/opt/paraclete
DATA_ROOT=/var/lib/paraclete
LOCK_FILE=/run/paraclete-lab-follow-main.lock
BOOTSTRAP_LOCK=/run/paraclete-bootstrap.lock
UPGRADE_LOG=/var/log/paraclete-lab-follow-main-upgrade.log
METADATA_URL=http://metadata.google.internal/computeMetadata/v1
HARNESS_USER=paraclete
UNIT=paraclete-lab-follow-main
# A mission longer than this no longer holds an upgrade back, counted from the first skip.
BUSY_LIMIT_SECONDS=$((24 * 60 * 60))
# What a running harness looks like on the command line: the CLI, the global loop's cycle (run from the
# checkout by its relative path; a lane's cycle names its own clone's path, and moving this checkout
# does not touch it), or one of the paraclete-h2 role's commands that load it from the checkout.
HARNESS_PATTERN='dev/harness2|(^| )dev/loop/cycle\.mjs|harness-(cycle|eval|promote)'

readonly COMMIT_PATTERN='^[0-9a-f]{40}$'
readonly REPO_PATTERN='^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+$'

CHECKOUT=''
STATUS_ONLY=0
HARNESS_HOME=''
REPO=''
INSTALLED=''
MAIN_HEAD=''
AGENT='unknown'
UPGRADE_STATE='unknown'
CHECKOUT_STATE='none'

die() {
  printf 'paraclete-lab-follow-main: error: %s\n' "$*" >&2
  exit 2
}

parse_args() {
  while (( $# > 0 )); do
    case "$1" in
      --harness-checkout)
        (( $# >= 2 )) && [[ -n "$2" ]] || die '--harness-checkout needs a directory'
        CHECKOUT="$2"
        shift 2
        ;;
      --status)
        STATUS_ONLY=1
        shift
        ;;
      -h|--help)
        printf 'Usage: paraclete-lab-follow-main [--harness-checkout <dir>] [--status]\n'
        exit 0
        ;;
      *)
        die "unknown argument '${1:0:80}'"
        ;;
    esac
  done
}

short() {  # short <commit>: its first 12 characters, or "none"
  if [[ "$1" =~ $COMMIT_PATTERN ]]; then printf '%s' "${1:0:12}"; else printf 'none'; fi
}

release_field() {  # release_field <name>: a string field of release.json without whitespace, or nothing
  local file="$INSTALL_ROOT/release.json"
  [[ -f "$file" ]] || return 0
  timeout 10 node -e '
    const v = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (typeof v === "string") process.stdout.write(v.replace(/\s/g, ""));
  ' "$file" "$1" 2>/dev/null || true
}

metadata_repo() {  # the repository install.sh named in the VM metadata, or nothing
  curl --silent --fail --retry 3 --connect-timeout 5 --max-time 20 --header 'Metadata-Flavor: Google' \
    "${METADATA_URL}/instance/attributes/paraclete-repo" 2>/dev/null || true
}

follow_repo() {  # the repository this VM follows: the installed release's, else the metadata's
  local repo
  repo="$(release_field repo)"
  [[ "$repo" =~ $REPO_PATTERN ]] || repo="$(metadata_repo)"
  if [[ "$repo" =~ $REPO_PATTERN ]]; then printf '%s' "$repo"; fi
}

main_head() {  # main_head <repo>: the commit main's head is at on GitHub, or nothing
  local sha='' name=''
  read -r sha name < <(GIT_TERMINAL_PROMPT=0 timeout 60 git ls-remote "https://github.com/$1" refs/heads/main 2>/dev/null)
  if [[ "$sha" =~ $COMMIT_PATTERN && "$name" == refs/heads/main ]]; then printf '%s' "$sha"; fi
}

active_mission() {  # the mission the brain's health file reports running, made safe to print, or nothing
  local file="$DATA_ROOT/services/brain/health.json"
  [[ -f "$file" ]] || return 0
  timeout 10 node -e '
    const h = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const m = h && h.runner && h.runner.active_mission;
    if (m) process.stdout.write(String(m).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "unnamed");
  ' "$file" 2>/dev/null || true
}

busy_since() {  # when a run first skipped for a busy agent, in seconds since the epoch, or nothing
  local file="$DATA_ROOT/lab-follow-main.busy-since" value=''
  [[ -f "$file" && ! -L "$file" ]] || return 0
  read -r value < "$file" || true
  if [[ "$value" =~ ^[0-9]{1,12}$ ]]; then printf '%s' "$value"; fi
}

mark_busy() {  # mark_busy <epoch seconds>: records the first skip, by rename
  local tmp
  tmp="$(mktemp "$DATA_ROOT/.lab-follow-main.XXXXXX")" || return 1
  if printf '%s\n' "$1" > "$tmp" && mv -fT "$tmp" "$DATA_ROOT/lab-follow-main.busy-since"; then return 0; fi
  rm -f "$tmp"
  return 1
}

clear_busy() { rm -f "$DATA_ROOT/lab-follow-main.busy-since"; }

take_lock() {  # one run at a time
  exec 8> "$LOCK_FILE" || return 1
  flock --nonblock 8
}

bootstrap_running() {  # a boot, an upgrade or a person's bootstrap holds the bootstrap's own lock
  [[ -e "$BOOTSTRAP_LOCK" ]] || return 1
  ! flock --nonblock "$BOOTSTRAP_LOCK" true
}

harness_running() { pgrep -f -- "$HARNESS_PATTERN" > /dev/null 2>&1; }

as_owner() {  # as_owner <git arguments>: git in the checkout as its owner, never asking for anything
  runuser -u "$HARNESS_USER" -- env HOME="$HARNESS_HOME" GIT_TERMINAL_PROMPT=0 \
    timeout 300 git -C "$CHECKOUT" "$@"
}

checkout_ready() {  # the checkout is a git checkout its owner can work in; else sets CHECKOUT_STATE
  if [[ ! -e "$CHECKOUT/.git" ]]; then
    CHECKOUT_STATE=skipped:not-a-checkout
    return 1
  fi
  if [[ "$(stat -c %U "$CHECKOUT" 2>/dev/null)" != "$HARNESS_USER" ]]; then
    CHECKOUT_STATE="skipped:not-owned-by-$HARNESS_USER"
    return 1
  fi
  HARNESS_HOME="$(getent passwd "$HARNESS_USER" | cut -d: -f6)"
  if [[ -z "$HARNESS_HOME" ]]; then
    CHECKOUT_STATE="skipped:no-$HARNESS_USER-user"
    return 1
  fi
}

checkout_commit() { as_owner rev-parse --verify --quiet HEAD 2>/dev/null || true; }

checkout_guard() {  # nothing may change the checkout now; else sets CHECKOUT_STATE
  local branch changes
  if harness_running; then
    CHECKOUT_STATE=skipped:harness-running
    return 1
  fi
  branch="$(as_owner symbolic-ref --quiet --short HEAD 2>/dev/null)" || branch=''
  if [[ "$branch" != main ]]; then
    CHECKOUT_STATE=skipped:not-on-main
    return 1
  fi
  if ! changes="$(as_owner status --porcelain 2>/dev/null)"; then
    CHECKOUT_STATE=failed:git-status
    return 1
  fi
  if [[ -n "$changes" ]]; then
    CHECKOUT_STATE=skipped:uncommitted-changes
    return 1
  fi
}

sync_checkout() {  # fast-forwards a ready checkout to origin/main; sets CHECKOUT_STATE
  local before after status=0
  checkout_guard || { [[ "$CHECKOUT_STATE" != failed:* ]]; return; }
  as_owner fetch --quiet --tags origin '+refs/heads/main:refs/remotes/origin/main' > /dev/null 2>&1 || status=$?
  if (( status )); then
    CHECKOUT_STATE="failed:fetch-exit-$status"
    return 1
  fi
  before="$(checkout_commit)"
  after="$(as_owner rev-parse --verify --quiet refs/remotes/origin/main 2>/dev/null)" || after=''
  if [[ ! "$after" =~ $COMMIT_PATTERN ]]; then
    CHECKOUT_STATE=failed:no-origin-main
    return 1
  fi
  if [[ "$before" == "$after" ]]; then
    CHECKOUT_STATE=current
    return 0
  fi
  if ! as_owner merge-base --is-ancestor HEAD refs/remotes/origin/main > /dev/null 2>&1; then
    CHECKOUT_STATE=skipped:not-a-fast-forward
    return 0
  fi
  # Again: a harness run or an edit may have started while the fetch ran.
  checkout_guard || { [[ "$CHECKOUT_STATE" != failed:* ]]; return; }
  as_owner merge --ff-only --quiet refs/remotes/origin/main > /dev/null 2>&1 || status=$?
  if (( status )); then
    CHECKOUT_STATE="failed:merge-exit-$status"
    return 1
  fi
  CHECKOUT_STATE="fast-forwarded:$(short "$before")..$(short "$after")"
}

upgrade() {  # moves the install to MAIN_HEAD through upgrade.sh; sets UPGRADE_STATE
  local status=0
  if [[ ! -x "$INSTALL_ROOT/install/upgrade.sh" ]]; then
    UPGRADE_STATE=skipped:not-installed
    return 0
  fi
  if bootstrap_running; then
    UPGRADE_STATE=skipped:bootstrap-running
    return 0
  fi
  "$INSTALL_ROOT/install/upgrade.sh" --ref "$MAIN_HEAD" --repo "$REPO" > "$UPGRADE_LOG" 2>&1 < /dev/null || status=$?
  if (( status )); then
    UPGRADE_STATE="failed:exit-$status"
    return 1
  fi
  UPGRADE_STATE=upgraded
}

follow() {  # one run; returns 1 when something failed (a skip is not a failure)
  local need_upgrade=0 need_checkout=0 mission now since status=0 override=0
  if ! take_lock; then
    AGENT=- UPGRADE_STATE=skipped:another-run CHECKOUT_STATE=skipped:another-run
    return 0
  fi
  REPO="$(follow_repo)"
  if [[ -z "$REPO" ]]; then
    UPGRADE_STATE=failed:no-repository
    return 1
  fi
  INSTALLED="$(release_field commit)"
  MAIN_HEAD="$(main_head "$REPO")"
  if [[ -z "$MAIN_HEAD" ]]; then
    UPGRADE_STATE=failed:ls-remote
    return 1
  fi
  if [[ "$INSTALLED" == "$MAIN_HEAD" ]]; then UPGRADE_STATE=current; else need_upgrade=1; fi
  if [[ -n "$CHECKOUT" ]] && checkout_ready; then
    if [[ "$(checkout_commit)" == "$MAIN_HEAD" ]]; then CHECKOUT_STATE=current; else need_checkout=1; fi
  fi

  mission="$(active_mission)"
  now="$(date +%s)"
  if [[ -z "$mission" ]]; then
    AGENT=idle
    clear_busy
  elif (( !need_upgrade && !need_checkout )); then
    AGENT="busy:$mission"
    clear_busy
  else
    since="$(busy_since)"
    if [[ -z "$since" ]] || (( now - since < BUSY_LIMIT_SECONDS )); then
      [[ -n "$since" ]] || { since="$now"; mark_busy "$now"; }
      AGENT="busy:$mission:waiting-$(( (now - since) / 3600 ))h"
      (( need_upgrade )) && UPGRADE_STATE=skipped:agent-busy
      (( need_checkout )) && CHECKOUT_STATE=skipped:agent-busy
      return 0
    fi
    AGENT="busy:$mission:over-24h"
    override=1
  fi

  if (( need_upgrade )); then upgrade || status=1; fi
  if (( need_checkout )); then sync_checkout || status=1; fi
  if (( override && status == 0 )); then clear_busy; fi
  return "$status"
}

report() {  # the run's one line
  printf 'repo=%s installed=%s head=%s agent=%s upgrade=%s checkout=%s\n' "${REPO:-unknown}" \
    "$(short "$INSTALLED")" "$(short "$MAIN_HEAD")" "$AGENT" "$UPGRADE_STATE" "$CHECKOUT_STATE"
}

field() { printf 'lab-follow-main.%s=%s\n' "$1" "${2//[$'\r\n']/ }"; }

status_report() {  # what --status prints; changes nothing
  local repo mission
  field timer_enabled "$(systemctl is-enabled "$UNIT.timer" 2>/dev/null)"
  field timer_active "$(systemctl is-active "$UNIT.timer" 2>/dev/null)"
  field service_active "$(systemctl is-active "$UNIT.service" 2>/dev/null)"
  field last_run "$(systemctl show --property=LastTriggerUSec --value "$UNIT.timer" 2>/dev/null)"
  field last_result "$(systemctl show --property=Result --value "$UNIT.service" 2>/dev/null)"
  field last_line "$(journalctl --identifier="$UNIT" --lines=1 --output=cat --no-pager --quiet 2>/dev/null | tail -n 1)"
  repo="$(follow_repo)"
  field repo "$repo"
  field installed "$(release_field commit)"
  field head "$(if [[ -n "$repo" ]]; then main_head "$repo"; fi)"
  mission="$(active_mission)"
  field agent "${mission:+busy:$mission}"
  field busy_since "$(busy_since)"
  if [[ -n "$CHECKOUT" ]]; then
    if checkout_ready; then field checkout "$(checkout_commit)"; else field checkout "$CHECKOUT_STATE"; fi
  fi
}

main() {
  local status=0
  parse_args "$@"
  if (( STATUS_ONLY )); then
    status_report
    return 0
  fi
  follow || status=$?
  report
  return "$status"
}

# Sourced (the tests do), this file only defines the settings and functions above; run, it follows main.
if [[ -n "${BASH_SOURCE[0]:-}" && "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi
main "$@"
