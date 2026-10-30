#!/usr/bin/env bash
# install/uninstall.sh: removes what install/install.sh created from a Google Cloud project: the VM, the
# firewall rules (and the network, when the installer made it), the dashboard's Cloud Run service and
# its image repository (it holds only the dashboard's images; the grants on the two go with them), the
# tag paraclete=managed that marks the service and the update job, the Firestore indexes and TTL
# policies, the service accounts and their grants (the grants on an account go with it: the agent's on
# its own account among them).
# Keeps the Firestore database, the bucket and the agent's own image repository (`agent-images`, which
# holds the agent's builds), with all their data, unless --purge, which also takes typing the project
# id; what stays loses the accounts' grants on it first. Enabled APIs stay on. Run by the project's
# owner in Cloud Shell. It finds what exists first and names exactly that before deleting anything;
# re-running finishes an interrupted uninstall. --dry-run prints every command that would change
# something and changes nothing.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$INSTALL_DIR/.." && pwd)"
# shellcheck source=lib/run.sh
source "$INSTALL_DIR/lib/run.sh"
# shellcheck source=lib/json.sh
source "$INSTALL_DIR/lib/json.sh"
# shellcheck source=lib/names.sh
source "$INSTALL_DIR/lib/names.sh"
# shellcheck source=lib/iam.sh
source "$INSTALL_DIR/lib/iam.sh"
# shellcheck source=lib/tags.sh
source "$INSTALL_DIR/lib/tags.sh"
# shellcheck source=lib/indexes.sh
source "$INSTALL_DIR/lib/indexes.sh"

export CLOUDSDK_CORE_DISABLE_PROMPTS=1

STEP_TOTAL=8

usage() {
  cat <<'EOF'
Usage: install/uninstall.sh [options]

Removes paraclete from this Google Cloud project. Keeps the Firestore database, the bucket and the
agent's image repository, and everything in them, unless --purge.

  --project <id>     The project (default: gcloud's configured project)
  --region <region>  Where the dashboard was deployed (default: the VM's region, else us-central1)
  --purge            Also delete the Firestore database, the bucket and the agent's image repository,
                     with all the agent's data and builds.
                     Irreversible: asks you to type the project id, even with --yes
  --yes              Don't ask before deleting (except the --purge confirmation)
  --dry-run          Print every command that would change something; change nothing
  -h, --help         This help
EOF
}

PROJECT=""
REGION=""
PURGE=0
YES=0

parse_flags() {
  while (($#)); do
    case "$1" in
      --yes | -y) YES=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --purge) PURGE=1; shift ;;
      -h | --help) usage; exit 0 ;;
      --project=*) PROJECT="${1#*=}"; shift ;;
      --region=*) REGION="${1#*=}"; shift ;;
      --project | --region)
        (($# >= 2)) || die "$1 needs a value"
        if [[ "$1" == --project ]]; then PROJECT="$2"; else REGION="$2"; fi
        shift 2 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
  done
}

# ---------------------------------------------------------------------------------------------------
# Step 1: check, and find what exists
# ---------------------------------------------------------------------------------------------------

step_check() {
  step 1 check "your login, the project, and what paraclete left in it"
  require_tools gcloud node
  ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true)"
  [[ -n "$ACCOUNT" ]] || die "gcloud is not logged in. Run: gcloud auth login"
  if [[ -z "$PROJECT" ]]; then
    PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  fi
  [[ -n "$PROJECT" ]] || die "no project given and gcloud has none configured. Pass --project <id>."
  [[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "'$PROJECT' is not a Google Cloud project id"
  gcloud projects describe "$PROJECT" --format='value(projectNumber)' >/dev/null 2>&1 \
    || die "project $PROJECT does not exist, or $ACCOUNT cannot see it"
  note "project $PROJECT, as $ACCOUNT"
  discover
}

# Finds every resource install.sh may have created. Each list holds only what exists.
discover() {
  local found
  AGENT_EMAIL="$(account_email "$AGENT_ACCOUNT_ID" "$PROJECT")"
  DASHBOARD_EMAIL="$(account_email "$DASHBOARD_ACCOUNT_ID" "$PROJECT")"
  DWD_EMAIL="$(account_email "$DWD_ACCOUNT_ID" "$PROJECT")"
  BUCKET="$(bucket_name "$PROJECT")"

  found="$(gcloud compute instances list --project="$PROJECT" --filter="name=$VM_NAME" \
    --format='value(name,zone.basename())' 2>/dev/null | head -n 1 || true)"
  VM_ZONE="${found##*[[:space:]]}"
  if [[ -z "$REGION" ]]; then
    REGION="${VM_ZONE%-*}"
    REGION="${REGION:-us-central1}"
  fi

  FIREWALL_EXISTS=0
  if gcloud compute firewall-rules describe "$FIREWALL_RULE" --project="$PROJECT" --format='value(name)' >/dev/null 2>&1; then
    FIREWALL_EXISTS=1
  fi
  DENY_EXISTS=0
  if gcloud compute firewall-rules describe "$DENY_RULE" --project="$PROJECT" --format='value(name)' >/dev/null 2>&1; then
    DENY_EXISTS=1
  fi
  NETWORK_OWNED=0
  if [[ "$(gcloud compute networks describe "$NETWORK_NAME" --project="$PROJECT" --format='value(description)' 2>/dev/null || true)" == "$NETWORK_DESCRIPTION" ]]; then
    NETWORK_OWNED=1
  fi
  UPDATE_JOB="$(contract auto_update.job_name)"
  SCHEDULE_EXISTS=0
  if gcloud scheduler jobs describe "$UPDATE_JOB" --location="$REGION" --project="$PROJECT" --format='value(name)' >/dev/null 2>&1; then
    SCHEDULE_EXISTS=1
  fi
  UPDATE_JOB_EXISTS=0
  if gcloud run jobs describe "$UPDATE_JOB" --region="$REGION" --project="$PROJECT" --format='value(metadata.name)' >/dev/null 2>&1; then
    UPDATE_JOB_EXISTS=1
  fi
  SERVICE_EXISTS=0
  if gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT" --format='value(metadata.name)' >/dev/null 2>&1; then
    SERVICE_EXISTS=1
  fi
  IMAGES_EXIST=0
  if gcloud artifacts repositories describe "$IMAGE_REPOSITORY" --location="$REGION" --project="$PROJECT" --format='value(name)' >/dev/null 2>&1; then
    IMAGES_EXIST=1
  fi
  TAG_EXISTS=0
  if gcloud resource-manager tags keys describe "$(managed_tag_key "$PROJECT")" --format='value(name)' >/dev/null 2>&1; then
    TAG_EXISTS=1
  fi
  AGENT_IMAGES_EXIST=0
  if gcloud artifacts repositories describe "$AGENT_IMAGE_REPOSITORY" --location="$REGION" --project="$PROJECT" --format='value(name)' >/dev/null 2>&1; then
    AGENT_IMAGES_EXIST=1
  fi

  DATABASE_PROTECTION="$(gcloud firestore databases describe --database="$FIRESTORE_DATABASE" --project="$PROJECT" \
    --format='value(name,deleteProtectionState)' 2>/dev/null || true)"
  DATABASE_EXISTS=0
  [[ -n "$DATABASE_PROTECTION" ]] && DATABASE_EXISTS=1
  discover_indexes

  ACCOUNTS=()
  local email
  for email in "$AGENT_EMAIL" "$DASHBOARD_EMAIL" "$DWD_EMAIL"; do
    if gcloud iam service-accounts describe "$email" --project="$PROJECT" --format='value(email)' >/dev/null 2>&1; then
      ACCOUNTS+=("$email")
    fi
  done
  BUCKET_EXISTS=0
  if gcloud storage buckets describe "gs://$BUCKET" --format='value(name)' >/dev/null 2>&1; then
    BUCKET_EXISTS=1
  fi
}

# The indexes and TTL policies firestore.indexes.json lists that the database has.
discover_indexes() {
  local existing ttls signature id group field state
  INDEX_IDS=()
  INDEX_NAMES=()
  TTL_FIELDS=()
  existing="$(existing_indexes "$PROJECT")"
  while IFS=$'\t' read -r signature _; do
    id="$(index_id "$existing" "$signature")"
    if [[ -n "$id" ]]; then
      INDEX_IDS+=("$id")
      INDEX_NAMES+=("$signature")
    fi
  done < <(index_plan "$INSTALL_DIR/firestore.indexes.json")
  ttls="$(existing_ttls "$PROJECT")"
  while IFS=$'\t' read -r group field; do
    state="$(ttl_state "$ttls" "$group" "$field")"
    if [[ -n "$state" ]]; then
      TTL_FIELDS+=("$group"$'\t'"$field")
    fi
  done < <(ttl_plan "$INSTALL_DIR/firestore.indexes.json")
}

# Prints exactly what will be deleted and what stays, then asks. --purge always takes the project id
# typed out; otherwise a yes, unless --yes. A dry run asks nothing: it changes nothing.
confirm_plan() {
  local doomed=() kept=() line account
  [[ -n "$VM_ZONE" ]] && doomed+=("VM $VM_NAME in $VM_ZONE, with its disk")
  ((FIREWALL_EXISTS)) && doomed+=("firewall rule $FIREWALL_RULE")
  ((DENY_EXISTS)) && doomed+=("firewall rule $DENY_RULE")
  ((NETWORK_OWNED)) && doomed+=("network $NETWORK_NAME (the installer created it)")
  ((SCHEDULE_EXISTS)) && doomed+=("Cloud Scheduler job $UPDATE_JOB in $REGION (starts the automatic update)")
  ((UPDATE_JOB_EXISTS)) && doomed+=("Cloud Run job $UPDATE_JOB in $REGION (the automatic update)")
  ((SERVICE_EXISTS)) && doomed+=("Cloud Run service $SERVICE_NAME in $REGION (the dashboard)")
  ((IMAGES_EXIST)) && doomed+=("Artifact Registry repository $IMAGE_REPOSITORY in $REGION (the dashboard's images)")
  ((TAG_EXISTS)) && doomed+=("tag $MANAGED_TAG_KEY=$MANAGED_TAG_VALUE on the project (it marks the dashboard and its update job)")
  ((PURGE && AGENT_IMAGES_EXIST)) && doomed+=("Artifact Registry repository $AGENT_IMAGE_REPOSITORY in $REGION and ALL the agent's images (irreversible)")
  if ((PURGE && DATABASE_EXISTS)); then
    doomed+=("the Firestore $FIRESTORE_DATABASE database and ALL its data: chats, missions, memory (irreversible)")
  else
    for line in "${INDEX_NAMES[@]}"; do doomed+=("Firestore index $line"); done
    for line in "${TTL_FIELDS[@]}"; do doomed+=("Firestore TTL policy on ${line/$'\t'/.}"); done
  fi
  for account in "${ACCOUNTS[@]}"; do doomed+=("service account $account and its grants"); done
  if ((BUCKET_EXISTS)); then
    if ((PURGE)); then
      doomed+=("bucket gs://$BUCKET and ALL its files (irreversible)")
    else
      kept+=("bucket gs://$BUCKET and its files")
    fi
  fi
  if ((DATABASE_EXISTS && !PURGE)); then
    kept+=("the Firestore $FIRESTORE_DATABASE database and its data")
  fi
  if ((AGENT_IMAGES_EXIST && !PURGE)); then
    kept+=("Artifact Registry repository $AGENT_IMAGE_REPOSITORY in $REGION and the agent's images")
  fi
  kept+=("the enabled APIs")

  if ((${#doomed[@]} == 0)); then
    say ""
    say "Nothing of paraclete's is left to remove from $PROJECT."
    exit 0
  fi
  say ""
  say "This deletes from $PROJECT:"
  for line in "${doomed[@]}"; do say "  - $line"; done
  say "It keeps:"
  for line in "${kept[@]}"; do say "  - $line"; done
  if ((BUCKET_EXISTS || DATABASE_EXISTS || AGENT_IMAGES_EXIST)) && ((!PURGE)); then
    say "(--purge deletes the database, the bucket and the agent's image repository too.)"
  fi

  if [[ "$DRY_RUN" == 1 ]]; then
    say ""
    say "Dry run: nothing will change. Each command that would change something is printed after a +."
    return 0
  fi
  if ((PURGE && (DATABASE_EXISTS || BUCKET_EXISTS || AGENT_IMAGES_EXIST))); then
    local typed=""
    printf 'This cannot be undone. Type the project id (%s) to confirm: ' "$PROJECT" >&2
    read -r typed || true
    [[ "$typed" == "$PROJECT" ]] || die "the project id did not match; nothing was deleted"
    return 0
  fi
  if [[ "$YES" != 1 ]]; then
    confirm "Delete these?" || die "nothing was deleted"
  fi
}

# ---------------------------------------------------------------------------------------------------
# Steps 2 to 8: delete, the VM first (it uses the accounts), the accounts last (grants name them)
# ---------------------------------------------------------------------------------------------------

step_vm() {
  step 2 vm "the agent's VM"
  if [[ -z "$VM_ZONE" ]]; then
    note "no VM $VM_NAME"
    return 0
  fi
  run gcloud compute instances delete "$VM_NAME" --zone="$VM_ZONE" --project="$PROJECT" --quiet
}

step_network() {
  step 3 network "the firewall rules, and the installer's network"
  if ((FIREWALL_EXISTS)); then
    run gcloud compute firewall-rules delete "$FIREWALL_RULE" --project="$PROJECT" --quiet
  else
    note "no firewall rule $FIREWALL_RULE"
  fi
  if ((DENY_EXISTS)); then
    run gcloud compute firewall-rules delete "$DENY_RULE" --project="$PROJECT" --quiet
  else
    note "no firewall rule $DENY_RULE"
  fi
  if ((NETWORK_OWNED)); then
    run gcloud compute networks delete "$NETWORK_NAME" --project="$PROJECT" --quiet
  else
    note "no network the installer created (a default network stays)"
  fi
}

step_dashboard() {
  step 4 dashboard "the dashboard's Cloud Run service, its automatic-update job and schedule, its images, and their tag"
  # The schedule first, so it cannot start the job while the job and the service go.
  if ((SCHEDULE_EXISTS)); then
    run gcloud scheduler jobs delete "$UPDATE_JOB" --location="$REGION" --project="$PROJECT" --quiet
  else
    note "no Cloud Scheduler job $UPDATE_JOB in $REGION"
  fi
  # Each loses its tag first: a tag value still bound to a resource cannot be deleted.
  if ((UPDATE_JOB_EXISTS)); then
    remove_managed_tag_binding "$PROJECT" "$REGION" "$(run_resource "$PROJECT" "$REGION" jobs "$UPDATE_JOB")"
    run gcloud run jobs delete "$UPDATE_JOB" --region="$REGION" --project="$PROJECT" --quiet
  else
    note "no Cloud Run job $UPDATE_JOB in $REGION"
  fi
  if ((SERVICE_EXISTS)); then
    remove_managed_tag_binding "$PROJECT" "$REGION" "$(run_resource "$PROJECT" "$REGION" services "$SERVICE_NAME")"
    run gcloud run services delete "$SERVICE_NAME" --region="$REGION" --project="$PROJECT" --quiet
  else
    note "no Cloud Run service $SERVICE_NAME in $REGION"
  fi
  if ((IMAGES_EXIST)); then
    run gcloud artifacts repositories delete "$IMAGE_REPOSITORY" --location="$REGION" --project="$PROJECT" --quiet
  else
    note "no image repository $IMAGE_REPOSITORY in $REGION"
  fi
  if ((TAG_EXISTS)); then
    remove_managed_tag "$PROJECT"
  else
    note "no tag $MANAGED_TAG_KEY on the project"
  fi
}

# The agent's own image repository holds its builds, so it goes only with --purge. Kept, it loses the
# accounts' grants on it first, as the bucket does: a binding that outlives its account lingers in the
# policy as deleted:serviceAccount:...
step_images() {
  step 5 images "the agent's image repository: kept, with its images, unless --purge"
  if ((!AGENT_IMAGES_EXIST)); then
    note "no image repository $AGENT_IMAGE_REPOSITORY in $REGION"
    return 0
  fi
  if ((PURGE)); then
    run gcloud artifacts repositories delete "$AGENT_IMAGE_REPOSITORY" --location="$REGION" --project="$PROJECT" --quiet
    return 0
  fi
  local policy member role
  policy="$(read_repository_policy "$AGENT_IMAGE_REPOSITORY" "$REGION" "$PROJECT")"
  for member in "serviceAccount:$AGENT_EMAIL" "serviceAccount:$DASHBOARD_EMAIL"; do
    while IFS= read -r role; do
      [[ -n "$role" ]] || continue
      run gcloud artifacts repositories remove-iam-policy-binding "$AGENT_IMAGE_REPOSITORY" --location="$REGION" \
        --project="$PROJECT" --member="$member" --role="$role" --quiet
    done < <(roles_of "$policy" "$member")
  done
  note "the repository and its images stay"
}

step_firestore() {
  step 6 firestore "the indexes and TTL policies, or with --purge the whole database"
  local id line
  if ((PURGE && DATABASE_EXISTS)); then
    if [[ "$DATABASE_PROTECTION" == *DELETE_PROTECTION_ENABLED* ]]; then
      run gcloud firestore databases update --database="$FIRESTORE_DATABASE" --no-delete-protection \
        --project="$PROJECT" --quiet
    fi
    run gcloud firestore databases delete --database="$FIRESTORE_DATABASE" --project="$PROJECT" --quiet
    return 0
  fi
  if ((${#INDEX_IDS[@]} == 0 && ${#TTL_FIELDS[@]} == 0)); then
    note "no paraclete indexes or TTL policies"
  fi
  for id in "${INDEX_IDS[@]}"; do
    run gcloud firestore indexes composite delete "$id" --database="$FIRESTORE_DATABASE" --project="$PROJECT" --quiet
  done
  for line in "${TTL_FIELDS[@]}"; do
    run gcloud firestore fields ttls update "${line#*$'\t'}" --collection-group="${line%%$'\t'*}" --disable-ttl \
      --database="$FIRESTORE_DATABASE" --project="$PROJECT" --async --quiet
  done
  if ((DATABASE_EXISTS)); then
    note "the database and its data stay"
  fi
}

# Without --purge the bucket stays, so the grants the accounts hold on it go first: a binding that
# outlives its account lingers in the policy as deleted:serviceAccount:...
step_bucket() {
  step 7 bucket "gs://$BUCKET"
  if ((!BUCKET_EXISTS)); then
    note "no bucket gs://$BUCKET"
    return 0
  fi
  if ((PURGE)); then
    run gcloud storage rm --recursive --all-versions "gs://$BUCKET" --quiet
    return 0
  fi
  local policy member role
  policy="$(read_bucket_policy "$BUCKET")"
  for member in "serviceAccount:$AGENT_EMAIL" "serviceAccount:$DASHBOARD_EMAIL"; do
    while IFS= read -r role; do
      [[ -n "$role" ]] || continue
      run gcloud storage buckets remove-iam-policy-binding "gs://$BUCKET" --member="$member" --role="$role" --quiet
    done < <(roles_of "$policy" "$member")
  done
  note "the bucket and its files stay"
}

# Every project role an account holds goes before the account does, whoever granted it: the
# installer's (the dashboard's logging.logWriter, for its builds, among them) and any added since.
# Grants on an account itself (the agent's act-as on its own account, the dashboard's on its own) live
# in that account's policy and go with the account.
step_accounts() {
  step 8 accounts "the service accounts and their project grants"
  if ((${#ACCOUNTS[@]} == 0)); then
    note "no paraclete service accounts"
    return 0
  fi
  local policy email role
  policy="$(read_project_policy "$PROJECT")"
  for email in "${ACCOUNTS[@]}"; do
    while IFS= read -r role; do
      [[ -n "$role" ]] || continue
      run gcloud projects remove-iam-policy-binding "$PROJECT" --member="serviceAccount:$email" --role="$role" --all --quiet
    done < <(roles_of "$policy" "serviceAccount:$email")
    run gcloud iam service-accounts delete "$email" --project="$PROJECT" --quiet
  done
}

main() {
  parse_flags "$@"
  step_check
  confirm_plan
  step_vm
  step_network
  step_dashboard
  step_images
  step_firestore
  step_bucket
  step_accounts
  say ""
  if [[ "$DRY_RUN" == 1 ]]; then
    say "Dry run complete: nothing was changed."
  else
    say "paraclete is removed from $PROJECT."
  fi
}

main "$@"
