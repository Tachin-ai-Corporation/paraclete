# install/lib/tags.sh: the tag paraclete=managed, which marks the dashboard's Cloud Run service and its
# update job as paraclete's own. A role whose Cloud Run grant is `on: project-except-paraclete`
# (install/lib/role-access.mjs) holds it with the condition "not tagged paraclete=managed" (iam.sh,
# fence_condition), so its agent can change every Cloud Run service and job but these two. The tag key
# lives on the project, with one value. install.sh creates them and binds the value to the two
# resources; uninstall.sh removes the bindings, then the value and the key. The agent holds no tag
# permissions, so it cannot take the tag off. Defines functions only. Sourced by install/install.sh and
# install/uninstall.sh. Needs names.sh and run.sh.

# managed_tag_key <project> / managed_tag_value <project>: their namespaced names, as gcloud and IAM
# conditions take them.
managed_tag_key() {
  printf '%s/%s\n' "$1" "$MANAGED_TAG_KEY"
}

managed_tag_value() {
  printf '%s/%s/%s\n' "$1" "$MANAGED_TAG_KEY" "$MANAGED_TAG_VALUE"
}

# run_resource <project> <region> <services|jobs> <name>: a Cloud Run resource's full name, as tag
# bindings take it.
run_resource() {
  printf '//run.googleapis.com/projects/%s/locations/%s/%s/%s\n' "$1" "$2" "$3" "$4"
}

# managed_tag_value_id <project>: the value's id (tagValues/<number>), as bindings name it. Empty when
# the value doesn't exist.
managed_tag_value_id() {
  gcloud resource-manager tags values describe "$(managed_tag_value "$1")" --format='value(name)' 2>/dev/null || true
}

# has_managed_tag <value id> <resource> <region>: succeeds when the resource carries the value.
has_managed_tag() {
  [[ -n "$1" ]] || return 1
  gcloud resource-manager tags bindings list --parent="$2" --location="$3" --format='value(tagValue)' 2>/dev/null \
    | grep -Fxq -- "$1"
}

# ensure_managed_tag <project>: the tag key and its value, each created when missing.
ensure_managed_tag() {
  local key value
  key="$(managed_tag_key "$1")"
  value="$(managed_tag_value "$1")"
  if gcloud resource-manager tags keys describe "$key" --format='value(name)' >/dev/null 2>&1; then
    note "the tag key $key exists"
  else
    run gcloud resource-manager tags keys create "$MANAGED_TAG_KEY" --parent="projects/$1" \
      --description="Marks the paraclete dashboard and its update job" --quiet
  fi
  if [[ -n "$(managed_tag_value_id "$1")" ]]; then
    note "the tag value $value exists"
  else
    run gcloud resource-manager tags values create "$MANAGED_TAG_VALUE" --parent="$key" \
      --description="The paraclete dashboard and its update job" --quiet
  fi
}

# ensure_managed_tag_binding <project> <region> <resource>: the resource carries the tag. Retried: a
# service or job just deployed can take a moment to be visible to tags.
ensure_managed_tag_binding() {
  if has_managed_tag "$(managed_tag_value_id "$1")" "$3" "$2"; then
    note "${3##*/} carries the tag $MANAGED_TAG_KEY=$MANAGED_TAG_VALUE"
    return 0
  fi
  run_retry gcloud resource-manager tags bindings create --tag-value="$(managed_tag_value "$1")" --parent="$3" \
    --location="$2" --quiet
}

# remove_managed_tag_binding <project> <region> <resource>: takes the tag off, when the resource carries it.
remove_managed_tag_binding() {
  has_managed_tag "$(managed_tag_value_id "$1")" "$3" "$2" || return 0
  run gcloud resource-manager tags bindings delete --tag-value="$(managed_tag_value "$1")" --parent="$3" \
    --location="$2" --quiet
}

# remove_managed_tag <project>: the value, then the key, each when it exists.
remove_managed_tag() {
  if [[ -n "$(managed_tag_value_id "$1")" ]]; then
    run gcloud resource-manager tags values delete "$(managed_tag_value "$1")" --quiet
  fi
  if gcloud resource-manager tags keys describe "$(managed_tag_key "$1")" --format='value(name)' >/dev/null 2>&1; then
    run gcloud resource-manager tags keys delete "$(managed_tag_key "$1")" --quiet
  fi
}
