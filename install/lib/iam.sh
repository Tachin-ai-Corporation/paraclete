# install/lib/iam.sh: reads and changes IAM policies on the project, on a service account and on the
# bucket. A policy is read once into "<role>,<member>" lines; a grant is made only when that line is
# missing, so re-running grants nothing twice, and grants are additive: nothing here removes a binding
# it did not name. Removal is for uninstall.sh. Defines functions only. Sourced by install/install.sh
# and install/uninstall.sh. Needs run.sh.

# The gcloud arguments that print a policy as "<role>,<member>" lines.
POLICY_FORMAT=(--flatten='bindings[].members' --format='csv[no-heading](bindings.role,bindings.members)')

# read_project_policy <project>: the project's bindings. Empty when unreadable.
read_project_policy() {
  gcloud projects get-iam-policy "$1" "${POLICY_FORMAT[@]}" 2>/dev/null || true
}

# read_account_policy <email> <project>: the bindings on a service account (who may act as it). Empty
# when the account doesn't exist yet.
read_account_policy() {
  gcloud iam service-accounts get-iam-policy "$1" --project="$2" "${POLICY_FORMAT[@]}" 2>/dev/null || true
}

# read_bucket_policy <bucket>: the bucket's bindings. Empty when the bucket doesn't exist yet.
read_bucket_policy() {
  gcloud storage buckets get-iam-policy "gs://$1" "${POLICY_FORMAT[@]}" 2>/dev/null || true
}

# has_binding <policy> <role> <member>: succeeds when the policy grants role to member.
has_binding() {
  grep -Fxq -- "$2,$3" <<<"$1"
}

# roles_of <policy> <member>: every role the policy grants member, one per line.
roles_of() {
  awk -F, -v member="$2" '$2 == member { print $1 }' <<<"$1"
}

# ensure_project_role <project> <policy> <member> <role>
ensure_project_role() {
  if has_binding "$2" "$4" "$3"; then
    note "$3 has $4"
    return 0
  fi
  run_retry gcloud projects add-iam-policy-binding "$1" --member="$3" --role="$4" --condition=None --quiet
}

# ensure_account_role <account email> <project> <policy> <member> <role>: a grant on one service
# account, not on the project.
ensure_account_role() {
  if has_binding "$3" "$5" "$4"; then
    note "$4 has $5 on $1"
    return 0
  fi
  run_retry gcloud iam service-accounts add-iam-policy-binding "$1" --project="$2" --member="$4" --role="$5" --quiet
}

# ensure_bucket_role <bucket> <policy> <member> <role>: a grant on the bucket only.
ensure_bucket_role() {
  if has_binding "$2" "$4" "$3"; then
    note "$3 has $4 on gs://$1"
    return 0
  fi
  run_retry gcloud storage buckets add-iam-policy-binding "gs://$1" --member="$3" --role="$4" --quiet
}
