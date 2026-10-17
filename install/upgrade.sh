#!/usr/bin/env bash
# install/upgrade.sh: moves this instance to a release tag or a commit. It resolves the ref to a commit,
# downloads that commit's own install/bootstrap.sh (never the copy installed here, which knows only the
# release it came with) and runs it with PARACLETE_REF, PARACLETE_REPO and PARACLETE_RELEASE set, which
# bootstrap.sh prefers over the VM metadata. bootstrap.sh does the rest: download, checks, swap,
# restart, readiness. Running it twice with the same ref is safe; the second run only checks that the
# services run. The VM metadata is left alone, so the agent's service account needs no right to change
# it; release.json records what was installed, and a reboot keeps it.
#
# The control service runs `upgrade.sh --ref <ref>` as root in its own transient systemd unit
# (agent/services/control/upgrade.mjs); a person on the VM can run it with sudo. Exit status is the
# bootstrap's: 0 when the instance runs the new release.
#
#   upgrade.sh --ref <release tag | 40-character commit> [--repo <owner>/<name>]

set -Eeuo pipefail

readonly INSTALL_ROOT=/opt/paraclete
readonly NODE=/usr/bin/node
readonly METADATA_URL=http://metadata.google.internal/computeMetadata/v1
readonly COMMIT_PATTERN='^[0-9a-f]{40}$'
# A tag name: letters, digits, dot, dash and underscore, not starting with a dash or a dot.
readonly TAG_PATTERN='^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$'
readonly REPO_PATTERN='^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+$'

REF=''
REPO=''
SCRIPT=''

log() { printf 'paraclete-upgrade: %s\n' "$*"; }

die() {
  printf 'paraclete-upgrade: error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: upgrade.sh --ref <release tag | 40-character commit> [--repo <owner>/<name>]

Moves this instance to the release tag or commit, using that commit's own bootstrap.sh.
--repo defaults to the repository the installed release came from. Runs as root.
EOF
}

parse_args() {
  while (( $# > 0 )); do
    case "$1" in
      --ref)
        (( $# >= 2 )) || die '--ref needs a value'
        REF="$2"
        shift 2
        ;;
      --repo)
        (( $# >= 2 )) || die '--repo needs a value'
        REPO="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "unknown argument '${1:0:80}'"
        ;;
    esac
  done
}

ref_is_valid() {  # a full commit, or a tag name git allows and no shell or option can hide in
  [[ "$1" =~ $COMMIT_PATTERN ]] && return 0
  [[ "$1" =~ $TAG_PATTERN && "$1" != *..* && "$1" != *.lock && "$1" != *. ]]
}

check_args() {
  [[ -n "$REF" ]] || { usage >&2; die '--ref is required'; }
  ref_is_valid "$REF" || die "'${REF:0:80}' is not a release tag or a full 40-character commit"
  [[ -z "$REPO" || "$REPO" =~ $REPO_PATTERN ]] || die "--repo must be <owner>/<name>, got '${REPO:0:80}'"
}

installed_repo() {  # the repository the installed release came from, or nothing
  [[ -f "$INSTALL_ROOT/release.json" && -x "$NODE" ]] || return 0
  "$NODE" -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (typeof r.repo === "string") process.stdout.write(r.repo);
  ' "$INSTALL_ROOT/release.json" 2>/dev/null || true
}

metadata_repo() {  # the repository install.sh named in the VM metadata, or nothing
  curl --silent --fail --retry 3 --connect-timeout 5 --max-time 20 --header 'Metadata-Flavor: Google' \
    "${METADATA_URL}/instance/attributes/paraclete-repo" 2>/dev/null || true
}

default_repo() {
  local repo
  repo="$(installed_repo)"
  [[ "$repo" =~ $REPO_PATTERN ]] || repo="$(metadata_repo)"
  [[ "$repo" =~ $REPO_PATTERN ]] || die 'cannot tell which repository this instance came from; pass --repo <owner>/<name>'
  printf '%s\n' "$repo"
}

tag_commit() {  # tag_commit <tag> < `git ls-remote` output: the commit the tag names, peeled when annotated
  local tag="$1" sha name peeled='' plain=''
  while read -r sha name; do
    if [[ "$name" == "refs/tags/${tag}^{}" ]]; then peeled="$sha"; fi
    if [[ "$name" == "refs/tags/${tag}" ]]; then plain="$sha"; fi
  done
  printf '%s\n' "${peeled:-$plain}"
}

resolve_commit() {  # resolve_commit <repo> <ref>: a full commit for a commit or a release tag
  local repo="$1" ref="$2" listing commit
  if [[ "$ref" =~ $COMMIT_PATTERN ]]; then
    printf '%s\n' "$ref"
    return 0
  fi
  listing="$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags "https://github.com/${repo}.git" \
    "refs/tags/${ref}" "refs/tags/${ref}^{}")" || die "cannot read the tags of ${repo}"
  commit="$(tag_commit "$ref" <<< "$listing")"
  [[ "$commit" =~ $COMMIT_PATTERN ]] || die "${repo} has no tag '${ref}'"
  printf '%s\n' "$commit"
}

main() {
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  parse_args "$@"
  check_args
  [[ "$(id -u)" == 0 ]] || die 'upgrade.sh runs as root'
  [[ -n "$REPO" ]] || REPO="$(default_repo)"

  local commit status=0
  commit="$(resolve_commit "$REPO" "$REF")"
  log "upgrading to ${REF} (${commit}) from ${REPO}"

  SCRIPT="$(mktemp /var/tmp/paraclete-upgrade.XXXXXX)"
  trap 'rm -f "$SCRIPT"' EXIT
  curl --fail --silent --show-error --location --retry 5 --retry-connrefused --connect-timeout 20 --max-time 120 \
    --output "$SCRIPT" "https://raw.githubusercontent.com/${REPO}/${commit}/install/bootstrap.sh" \
    || die "cannot download install/bootstrap.sh of ${commit} from ${REPO}"
  bash -n "$SCRIPT" || die "install/bootstrap.sh of ${commit} does not parse"

  PARACLETE_REF="$commit" PARACLETE_REPO="$REPO" PARACLETE_RELEASE="$REF" bash "$SCRIPT" || status=$?
  if (( status == 0 )); then log "the instance runs ${REF} (${commit})"; else log "the bootstrap of ${commit} failed (exit ${status})"; fi
  exit "$status"
}

# Sourced (the tests do), this file only defines the functions above; run, it upgrades.
if [[ -n "${BASH_SOURCE[0]:-}" && "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi
main "$@"
