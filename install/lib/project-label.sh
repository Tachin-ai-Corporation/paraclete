# install/lib/project-label.sh: the label that says a project holds paraclete, `paraclete=<role>`.
# install.sh sets it in step 3 (and changes it on a move to another role); uninstall.sh removes it. A
# caller that lists projects, such as a web app, finds every instance an admin can see by it,
# `labels.paraclete:*`, whether it was installed from the web or from Cloud Shell.
#
# gcloud sets project labels only in its alpha track, so the label goes through Resource Manager's REST
# API: the project's labels are read, the one key changed, and all of them written back
# (`updateMask=labels`). Every other label stays. Defines functions only. Sourced by install/install.sh
# and install/uninstall.sh. Needs names.sh, run.sh and auth.sh.

# project_labels <project>: the project's labels, as a JSON object ({} when it has none).
project_labels() {
  local labels
  labels="$(gcloud projects describe "$1" --format='json(labels)' 2>/dev/null || true)"
  node -e '
let labels = {};
try { labels = JSON.parse(process.argv[1] || "{}").labels || {}; } catch {}
console.log(JSON.stringify(labels));
' "$labels"
}

# write_project_labels <project number> <labels JSON> <work dir>: PATCHes the project's labels, as the
# run's account. The token travels in a header file, never on the command line.
write_project_labels() {
  local header_file="$3/project-label-headers" body_file="$3/project-labels.json" token
  printf '{"labels":%s}\n' "$2" >"$body_file"
  show_file "the project's labels after this" "$body_file"
  if [[ "$DRY_RUN" != 1 ]]; then
    token="$(access_token)" || die "no access token for $ACCOUNT"
    (umask 077 && printf 'Authorization: Bearer %s\nx-goog-user-project: %s\n' "$token" "$PROJECT" >"$header_file")
  fi
  run curl -sS --fail-with-body -X PATCH -H "@$header_file" -H 'Content-Type: application/json' \
    --data-binary "@$body_file" "https://cloudresourcemanager.googleapis.com/v3/projects/$1?updateMask=labels"
}

# ensure_project_label <project> <project number> <role> <work dir>: the project carries paraclete=<role>.
ensure_project_label() {
  local labels current next
  labels="$(project_labels "$1")"
  current="$(node -e 'console.log(JSON.parse(process.argv[1])[process.argv[2]] || "")' "$labels" "$PROJECT_LABEL_KEY")"
  if [[ "$current" == "$3" ]]; then
    note "the project is labeled $PROJECT_LABEL_KEY=$3"
    return 0
  fi
  next="$(node -e 'const l = JSON.parse(process.argv[1]); l[process.argv[2]] = process.argv[3]; console.log(JSON.stringify(l))' \
    "$labels" "$PROJECT_LABEL_KEY" "$3")"
  write_project_labels "$2" "$next" "$4"
}

# remove_project_label <project> <project number> <work dir>: the project loses the label, when it has it.
remove_project_label() {
  local labels next
  labels="$(project_labels "$1")"
  if [[ -z "$(node -e 'console.log(JSON.parse(process.argv[1])[process.argv[2]] || "")' "$labels" "$PROJECT_LABEL_KEY")" ]]; then
    note "the project has no $PROJECT_LABEL_KEY label"
    return 0
  fi
  next="$(node -e 'const l = JSON.parse(process.argv[1]); delete l[process.argv[2]]; console.log(JSON.stringify(l))' \
    "$labels" "$PROJECT_LABEL_KEY")"
  write_project_labels "$2" "$next" "$3"
}
