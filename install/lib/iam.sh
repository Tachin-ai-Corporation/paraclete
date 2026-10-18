# install/lib/iam.sh: reads and changes IAM policies on the project, on a service account, on the
# bucket, on an image repository (the dashboard's, or the agent's own), and on the dashboard's Cloud Run
# service and IAP resource. A policy is read once into "<role>,<member>" lines; a grant is made only
# when that line is missing, so re-running grants nothing twice, and grants are additive: nothing here
# removes a binding it did not name. The two revoke_ functions take back one named grant, for a move
# to another role that no longer declares it. Defines functions only. Sourced by install/install.sh and
# install/uninstall.sh. Needs run.sh.

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

# read_repository_policy <repository> <location> <project>: the bindings on an Artifact Registry
# repository. Empty when it doesn't exist yet.
read_repository_policy() {
  gcloud artifacts repositories get-iam-policy "$1" --location="$2" --project="$3" "${POLICY_FORMAT[@]}" 2>/dev/null || true
}

# read_service_policy <service> <region> <project>: the bindings on a Cloud Run service (who may invoke
# it). Empty when it doesn't exist yet.
read_service_policy() {
  gcloud run services get-iam-policy "$1" --region="$2" --project="$3" "${POLICY_FORMAT[@]}" 2>/dev/null || true
}

# read_iap_policy <service> <region> <project>: the bindings on IAP in front of a Cloud Run service: who
# may sign in to it, and who may change that. Empty while the service doesn't exist.
read_iap_policy() {
  gcloud iap web get-iam-policy --resource-type=cloud-run --service="$1" --region="$2" --project="$3" \
    "${POLICY_FORMAT[@]}" 2>/dev/null || true
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

# ensure_repository_role <repository> <location> <project> <policy> <member> <role>: a grant on one
# Artifact Registry repository only.
ensure_repository_role() {
  if has_binding "$4" "$6" "$5"; then
    note "$5 has $6 on the repository $1"
    return 0
  fi
  run_retry gcloud artifacts repositories add-iam-policy-binding "$1" --location="$2" --project="$3" \
    --member="$5" --role="$6" --quiet
}

# ensure_service_role <service> <region> <project> <policy> <member> <role>: a grant on one Cloud Run
# service only.
ensure_service_role() {
  if has_binding "$4" "$6" "$5"; then
    note "$5 has $6 on the service $1"
    return 0
  fi
  run_retry gcloud run services add-iam-policy-binding "$1" --region="$2" --project="$3" \
    --member="$5" --role="$6" --quiet
}

# ensure_iap_role <service> <region> <project> <policy> <member> <role>: a grant on IAP in front of one
# Cloud Run service. --condition=None: IAP policies may hold conditional bindings (access levels), and
# gcloud refuses an unconditional grant beside them unless told so.
ensure_iap_role() {
  if has_binding "$4" "$6" "$5"; then
    note "$5 has $6 on IAP for $1"
    return 0
  fi
  run_retry gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service="$1" --region="$2" \
    --member="$5" --role="$6" --condition=None --project="$3" --quiet
}

# revoke_account_role <account email> <project> <policy> <member> <role>: takes back one grant on one
# service account, when the policy holds it. Service account policies hold no conditions.
revoke_account_role() {
  has_binding "$3" "$5" "$4" || return 0
  run_retry gcloud iam service-accounts remove-iam-policy-binding "$1" --project="$2" --member="$4" --role="$5" --quiet
}

# revoke_repository_role <repository> <location> <project> <policy> <member> <role>: takes back one
# grant on one Artifact Registry repository, when the policy holds it. The repository stays.
revoke_repository_role() {
  has_binding "$4" "$6" "$5" || return 0
  run_retry gcloud artifacts repositories remove-iam-policy-binding "$1" --location="$2" --project="$3" \
    --member="$5" --role="$6" --quiet
}
