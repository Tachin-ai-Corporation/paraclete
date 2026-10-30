#!/usr/bin/env bash
# install/install.sh: turns a Google Cloud project into a running paraclete. Run by the project's owner
# in Cloud Shell, from a clone of the repo. Checks the project, enables the APIs (the role's among
# them) and checks the agent's model answers, creates the service accounts with their grants (a role's
# grants on single resources among them), Firestore, the bucket, the dashboard (built by Cloud Build,
# on Cloud Run behind IAP, with the installer as its first admin; the bucket's CORS setting lets its
# pages upload into the bucket; its service and update job carry the tag paraclete=managed, which a
# role's Cloud Run grant is fenced by), the network and the agent's VM, then waits until the agent
# reports ready. Every create is "create if missing" and every grant is additive, so re-running repairs,
# and re-running with another --ref moves the dashboard and the VM to that commit. Two things are taken
# back: on a move to another role, the grants only the previous role declared; and on every run, a
# project-wide role that would let the agent act as any service account, push to any image repository,
# or change or run any Cloud Run service or job. It never logs in to the VM: what happens on the VM is
# install/bootstrap.sh's job, and the contract between the two is install/README.md.
# --dry-run prints every command that would change something and changes nothing. With
# --access-token-file it acts with an OAuth access token instead of gcloud's login, and --events writes
# its progress as JSON lines, for a caller such as a web app (install/lib/auth.sh, install/lib/run.sh).
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$INSTALL_DIR/.." && pwd)"
# shellcheck source=lib/run.sh
source "$INSTALL_DIR/lib/run.sh"
# shellcheck source=lib/auth.sh
source "$INSTALL_DIR/lib/auth.sh"
# shellcheck source=lib/json.sh
source "$INSTALL_DIR/lib/json.sh"
# shellcheck source=lib/names.sh
source "$INSTALL_DIR/lib/names.sh"
# shellcheck source=lib/ref.sh
source "$INSTALL_DIR/lib/ref.sh"
# shellcheck source=lib/iam.sh
source "$INSTALL_DIR/lib/iam.sh"
# shellcheck source=lib/tags.sh
source "$INSTALL_DIR/lib/tags.sh"
# shellcheck source=lib/project-label.sh
source "$INSTALL_DIR/lib/project-label.sh"
# shellcheck source=lib/indexes.sh
source "$INSTALL_DIR/lib/indexes.sh"

# gcloud must never stop to ask a question: an answer the script didn't plan for is a surprise.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

STEP_TOTAL=9

# The dashboard's build and deploy commands, written once for this script and dev/deploy.mjs.
DASHBOARD_JS="$INSTALL_DIR/lib/dashboard.mjs"
# What a role's role.json asks for beyond project roles (its APIs and single-resource grants), and the
# roles never granted project-wide: checked once here and in tests/content/packages.test.mjs.
ROLE_ACCESS_JS="$INSTALL_DIR/lib/role-access.mjs"

# How long step 9 waits for the agent's first boot, and how often it looks. A first boot takes about 8
# to 12 minutes, most of it apt-get installing the role's packages and the file toolchain among them
# (install/README.md, "Packages").
WAIT_TIMEOUT_SECONDS=1200
WAIT_POLL_SECONDS=10

# The VM (build plan section 13: LibreOffice and Chromium need more memory than e2-medium has).
MACHINE_TYPE=e2-standard-2
BOOT_DISK_SIZE=50GB
BOOT_DISK_TYPE=pd-balanced
IMAGE_FAMILY=debian-12
IMAGE_PROJECT=debian-cloud
# cloud-platform lets IAM decide what the agent may do; drive is the one Google API outside Cloud that
# the agent's own account reaches through the VM's scopes.
VM_SCOPES=cloud-platform,https://www.googleapis.com/auth/drive

# Every instance's APIs, and the Workspace ones a role flagged `workspace` adds (short names; each is
# <name>.googleapis.com). A role's own `apis` come on top (read in step 1). cloudresourcemanager is there
# for gcloud itself: `iap web` commands look the project up through it, and fail on a project that
# never turned it on.
BASE_APIS=(compute run firestore iam iamcredentials aiplatform artifactregistry cloudbuild secretmanager storage iap drive cloudresourcemanager cloudscheduler)
WORKSPACE_APIS=(chat gmail calendar-json docs sheets slides people admin)
# The Service Usage API takes a limited number of services per call.
APIS_PER_CALL=10

# Step 2 asks the agent's model for one word. A just-enabled API can take a minute to answer, so a
# failure is tried again this many times, this far apart, before it stops the install.
MODEL_CHECK_ATTEMPTS="${MODEL_CHECK_ATTEMPTS:-6}"
MODEL_CHECK_DELAY_SECONDS="${MODEL_CHECK_DELAY_SECONDS:-12}"
MODEL_CHECK_PROMPT='{"contents":[{"role":"user","parts":[{"text":"Reply with one word: ready"}]}]}'

# The dashboard's account on the project (build plan sections 3 and 7, phase 6). Its other grants sit
# on single resources: the bucket (step 5), itself (below), and in step 6 the image repository (its
# builds push there) and IAP on its own Cloud Run service (it adds and removes the dashboard's users).
DASHBOARD_PROJECT_ROLES=(
  roles/datastore.user           # Firestore: users, threads, messages, approvals, commands, settings
  roles/secretmanager.admin      # the secret store: creates secrets and grants the agent access to each
  roles/cloudbuild.builds.editor # self-upgrade: builds the dashboard image at a release
  roles/run.admin                # self-upgrade: deploys the new revision of its own service
  roles/logging.logWriter        # its builds run as itself and log to Cloud Logging only (dashboard/cloudbuild.json)
)
# Granted on the dashboard's own account, not the project: it deploys revisions and submits builds
# that run as itself (actAs), and it signs its upload URLs and the commands it sends the VM as itself.
DASHBOARD_SELF_ROLES=(
  roles/iam.serviceAccountUser
  roles/iam.serviceAccountTokenCreator
)

# Permissions step 1 checks the caller holds. Owners have them all; the list names what the install
# itself does, so a missing one points at the step that would fail.
REQUIRED_PERMISSIONS=(
  resourcemanager.projects.setIamPolicy
  serviceusage.services.enable
  iam.serviceAccounts.create
  iam.serviceAccounts.setIamPolicy
  datastore.databases.create
  datastore.indexes.create
  storage.buckets.create
  compute.networks.create
  compute.firewalls.create
  compute.instances.create
  artifactregistry.repositories.create
  cloudbuild.builds.create
  run.services.create
  resourcemanager.tagKeys.create
  resourcemanager.tagValues.create
  resourcemanager.tagValueBindings.create
  resourcemanager.projects.update
)

# The dashboard's users, one Firestore document per email (dashboard/lib/server/users.mjs). Step 6
# writes the first: the installer, as an admin.
USERS_COLLECTION=users
# The instance's settings document is config/settings (agent/storage/collections.mjs); --no-auto-update
# writes its auto_update field in step 6.
CONFIG_COLLECTION=config
IMAGE_REPOSITORY_DESCRIPTION='Images of the paraclete dashboard, one per release'
AGENT_IMAGE_REPOSITORY_DESCRIPTION='Images the paraclete agent builds'

# Agent names and release names go into VM metadata as `key=value,...`, so neither may hold a comma.
AGENT_NAME_PATTERN="^[[:alnum:]][[:alnum:] ._'-]{0,39}\$"
RELEASE_NAME_PATTERN='^[A-Za-z0-9._/-]+$'

usage() {
  cat <<'EOF'
Usage: install/install.sh [options]

Prepares this Google Cloud project for one paraclete and creates its VM. Safe to re-run.

  --project <id>     The project (default: gcloud's configured project)
  --role <id>        The agent's role, one of roles/<id>/ (default: generic)
  --name <name>      The agent's display name (default: Paraclete)
  --region <region>  Where the data, bucket and VM live (default: us-central1)
  --zone <zone>      The VM's zone (default: <region>-a)
  --ref <ref>        A release tag, branch or full commit to install (default: the newest release tag,
                     else the repository's default branch)
  --repo <owner/name>  The GitHub repository to install from (default: this clone's origin)
  --no-auto-update   Don't install new releases automatically (default: on; an admin can change it on the
                     dashboard's System tab)
  --yes              Don't ask: take the defaults and skip the confirmation
  --dry-run          Print every command that would change something; change nothing
  --access-token-file <path>
                     Act with the OAuth access token in this file instead of gcloud's login (token mode;
                     needs --account and --project)
  --account <email>  The account the access token belongs to: the dashboard's first admin
  --events <path>    Also write the run's progress to this file, one JSON object per line
  -h, --help         This help
EOF
}

PROJECT=""
ROLE=""
AGENT_NAME=""
REGION=""
ZONE=""
REF=""
REPO=""
YES=0
AUTO_UPDATE_OFF=0

parse_flags() {
  local flag value
  while (($#)); do
    case "$1" in
      --yes | -y) YES=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --no-auto-update) AUTO_UPDATE_OFF=1; shift ;;
      -h | --help) usage; exit 0 ;;
      --project=* | --role=* | --name=* | --region=* | --zone=* | --ref=* | --repo=* \
        | --access-token-file=* | --account=* | --events=*)
        set_flag "${1%%=*}" "${1#*=}"; shift ;;
      --project | --role | --name | --region | --zone | --ref | --repo \
        | --access-token-file | --account | --events)
        flag="$1"
        (($# >= 2)) || die "$flag needs a value"
        value="$2"
        set_flag "$flag" "$value"; shift 2 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
  done
}

set_flag() {
  case "$1" in
    --project) PROJECT="$2" ;;
    --role) ROLE="$2" ;;
    --name) AGENT_NAME="$2" ;;
    --region) REGION="$2" ;;
    --zone) ZONE="$2" ;;
    --ref) REF="$2" ;;
    --repo) REPO="$2" ;;
    --events) start_events "$2" ;;
    *) auth_flag "$1" "$2" ;;
  esac
}

# available_roles: the role ids the installer offers, one per line: every role in this clone except a
# development role (`listed: false` in its role.json), which --role still installs.
available_roles() {
  node "$ROLE_ACCESS_JS" listed "$REPO_ROOT"
}

# The instance this project already holds, if any: the role, name and zone its VM was installed with
# (its metadata). They become the defaults, so re-running install.sh repairs the instance instead of
# renaming it, moving it to another region or back to generic; a --role that differs moves it to that
# role (the developer path in install/README.md, "Moving an instance to another role"). Read quietly:
# a project with no VM yet, or no Compute Engine API yet, has none.
EXISTING_ROLE=""
EXISTING_NAME=""
EXISTING_ZONE=""
read_existing_instance() {
  local project="$PROJECT" found details
  [[ -n "$project" ]] || project="$(gcloud config get-value project 2>/dev/null || true)"
  [[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || return 0
  found="$(gcloud compute instances list --project="$project" --filter="name=$VM_NAME" \
    --format='value(name,zone.basename())' 2>/dev/null | head -n 1 || true)"
  [[ -n "$found" ]] || return 0
  EXISTING_ZONE="${found##*[[:space:]]}"
  [[ "$EXISTING_ZONE" =~ ^[a-z]+-[a-z]+[0-9]+-[a-z]$ ]] || EXISTING_ZONE=""
  details="$(gcloud compute instances describe "$VM_NAME" --zone="$EXISTING_ZONE" --project="$project" \
    --format=json 2>/dev/null || printf '{}')"
  IFS=$'\x1f' read -r EXISTING_ROLE EXISTING_NAME < <(node -e '
const fs = require("node:fs");
let items = [];
try { items = (JSON.parse(fs.readFileSync(0, "utf8") || "{}").metadata || {}).items || []; } catch { process.exit(0); }
const value = (key) => String((items.find((item) => item.key === key) || {}).value || "").replace(/[\x1f\n]/g, " ");
console.log([value("paraclete-role"), value("paraclete-agent-name")].join("\x1f"));
' <<<"$details") || true
}

# The two questions, asked only when neither a flag nor --yes answered them. On an existing instance
# the answers it was installed with are the defaults.
ask_questions() {
  if [[ "$YES" == 1 ]]; then
    return 0
  fi
  if [[ -z "$ROLE" ]]; then
    say "Roles: $(available_roles | paste -sd' ' -)"
    ROLE="$(ask "Which role should the agent have?" "${EXISTING_ROLE:-generic}")"
  fi
  if [[ -z "$AGENT_NAME" ]]; then
    AGENT_NAME="$(ask "What should the agent be called?" "${EXISTING_NAME:-Paraclete}")"
  fi
}

apply_defaults() {
  ROLE="${ROLE:-${EXISTING_ROLE:-generic}}"
  AGENT_NAME="${AGENT_NAME:-${EXISTING_NAME:-Paraclete}}"
  if [[ -z "$REGION" && -n "$EXISTING_ZONE" ]]; then
    REGION="${EXISTING_ZONE%-*}"
    ZONE="${ZONE:-$EXISTING_ZONE}"
  fi
  REGION="${REGION:-us-central1}"
  ZONE="${ZONE:-$REGION-a}"
  # The role this instance moves from, when it has one and --role names another.
  PREVIOUS_ROLE=""
  if [[ -n "$EXISTING_ROLE" && "$EXISTING_ROLE" != "$ROLE" ]]; then
    PREVIOUS_ROLE="$EXISTING_ROLE"
  fi
}

# ---------------------------------------------------------------------------------------------------
# Step 1: check
# ---------------------------------------------------------------------------------------------------

step_check() {
  step 1 check "your login and access, billing, the organization, the role and the release"
  require_tools gcloud git curl node
  check_login
  check_project
  check_permissions
  check_billing
  check_organization
  check_role
  check_name_and_place
  resolve_release
}

check_login() {
  ACCOUNT="$(active_account)"
  [[ -n "$ACCOUNT" ]] || die "gcloud is not logged in. Run: gcloud auth login"
  if [[ -n "$TOKEN_FILE" ]]; then
    note "acting as $ACCOUNT, with an access token"
  else
    note "logged in as $ACCOUNT"
  fi
}

check_project() {
  if [[ -z "$PROJECT" ]]; then
    PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  fi
  [[ -n "$PROJECT" ]] || die "no project given and gcloud has none configured. Pass --project <id>."
  [[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "'$PROJECT' is not a Google Cloud project id"
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null || true)"
  [[ -n "$PROJECT_NUMBER" ]] || die "project $PROJECT does not exist, or $ACCOUNT cannot see it"
  note "project $PROJECT ($PROJECT_NUMBER)"
}

# testIamPermissions answers for the caller's effective access, whether it comes from a direct grant,
# a group or the organization, which a look at the project's policy would miss.
check_permissions() {
  local token body response missing
  token="$(access_token)" || die "no access token for $ACCOUNT"
  body="{\"permissions\":[$(printf '"%s",' "${REQUIRED_PERMISSIONS[@]}" | sed 's/,$//')]}"
  response="$(curl -sS -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    --data "$body" "https://cloudresourcemanager.googleapis.com/v1/projects/$PROJECT:testIamPermissions")" \
    || die "could not check your permissions on $PROJECT"
  missing="$(node -e '
const fs = require("node:fs");
const asked = process.argv.slice(1);
let answer;
try { answer = JSON.parse(fs.readFileSync(0, "utf8")); } catch { answer = { error: { message: "an unreadable answer" } }; }
if (answer.error) { console.log(`(the check returned ${answer.error.message || answer.error.status})`); process.exit(0); }
const granted = new Set(answer.permissions || []);
console.log(asked.filter((p) => !granted.has(p)).join(" "));
' "${REQUIRED_PERMISSIONS[@]}" <<<"$response")"
  [[ -z "$missing" ]] || die "$ACCOUNT needs roles/owner on $PROJECT. Missing: $missing"
  note "$ACCOUNT can do everything the install needs"
}

check_billing() {
  local enabled
  enabled="$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || true)"
  case "$enabled" in
    True | true) note "billing is enabled" ;;
    False | false) die "billing is not enabled on $PROJECT. Link a billing account: https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT" ;;
    *) warn "could not read the billing status of $PROJECT; enabling the APIs will fail if billing is off" ;;
  esac
}

check_organization() {
  local ancestors
  ancestors="$(gcloud projects get-ancestors "$PROJECT" --format='value(type)' 2>&1)" \
    || die "could not read where $PROJECT sits in its organization: $ancestors"
  grep -qx organization <<<"$ancestors" \
    || die "$PROJECT is not inside a Google Cloud organization. The dashboard's Google sign-in (Identity-Aware Proxy) needs one: move the project into your Workspace's organization, then run this again."
  note "the project is inside an organization"
}

check_role() {
  [[ "$ROLE" =~ ^[a-z][a-z0-9-]*$ && -f "$REPO_ROOT/roles/$ROLE/role.json" ]] \
    || die "there is no role '$ROLE'. Roles: $(available_roles | paste -sd' ' -)"
  ROLE_FILE="$REPO_ROOT/roles/$ROLE/role.json"
  ROLE_WORKSPACE="$(json_get "$ROLE_FILE" workspace)"
  local problems
  problems="$(role_access check "$ROLE" 2>&1)" || die "the role cannot be installed as it is:"$'\n'"$problems"
  AGENT_ROLES="$(agent_roles)"
  ROLE_APIS="$(role_access apis "$ROLE")"
  RESOURCE_ROLES="$(role_access resource-roles "$ROLE")"
  REFUSED_PROJECT_ROLES="$(node "$ROLE_ACCESS_JS" project-wide-refused)"
  if [[ "$ROLE_WORKSPACE" == true ]]; then
    note "role $ROLE, with a Workspace account"
  else
    note "role $ROLE"
  fi
  available_roles | grep -qx "$ROLE" \
    || note "$ROLE is a development role (listed: false in its role.json): the installer does not offer it, and it is for working on this repo"
}

# role_access <command> <role>: install/lib/role-access.mjs on generic and <role> in this clone: `check`
# (the role's grants and APIs are well formed, and none it asks for project-wide is refused), `apis`
# (short names) or `resource-roles` (<kind> TAB <role> lines).
role_access() {
  node "$ROLE_ACCESS_JS" "$1" "$REPO_ROOT" "$2"
}

check_name_and_place() {
  [[ "$AGENT_NAME" =~ $AGENT_NAME_PATTERN ]] \
    || die "the agent's name must be 1 to 40 letters, digits, spaces or . _ ' - and start with a letter or digit"
  [[ "$REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || die "'$REGION' is not a region"
  [[ "$ZONE" == "$REGION"-[a-z] ]] || die "the zone must be in $REGION, like $REGION-a; got '$ZONE'"
}

# Turns --ref (or the newest release, or the default branch) into the commit the VM installs, and
# checks that commit has a bootstrap.sh for the VM to run.
resolve_release() {
  local remote listing
  if [[ -z "$REPO" ]]; then
    remote="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
    REPO="$(repo_from_remote_url "$remote")" \
      || die "cannot tell the GitHub repository from this clone's origin ('$remote'). Pass --repo <owner>/<name>."
  fi
  [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo must be <owner>/<name>, got '$REPO'"
  listing="$(remote_refs "$REPO")" \
    || die "cannot read https://github.com/$REPO. The repository must exist and be public."
  if [[ -z "$REF" ]]; then
    REF="$(newest_release_tag "$listing" "$(contract versioning.canonical_regex)")"
    if [[ -z "$REF" ]]; then
      REF="$(default_branch "$listing")" || die "https://github.com/$REPO has no release tag and no default branch"
    fi
  fi
  [[ "$REF" =~ $RELEASE_NAME_PATTERN ]] || die "--ref must be a tag, branch or commit name, got '$REF'"
  COMMIT="$(ref_commit "$listing" "$REF")" \
    || die "'$REF' is not a tag, branch or full 40-character commit of https://github.com/$REPO"
  RELEASE="$REF"
  curl -sSfIL -o /dev/null "$(bootstrap_url)" \
    || die "$REPO at $COMMIT has no install/bootstrap.sh, so a VM could not install it. Pick a newer --ref."
  note "release $RELEASE is commit $COMMIT of $REPO"
}

bootstrap_url() {
  printf 'https://raw.githubusercontent.com/%s/%s/install/bootstrap.sh\n' "$REPO" "$COMMIT"
}

# Derived names, once the project is known.
derive_names() {
  AGENT_EMAIL="$(account_email "$AGENT_ACCOUNT_ID" "$PROJECT")"
  DASHBOARD_EMAIL="$(account_email "$DASHBOARD_ACCOUNT_ID" "$PROJECT")"
  DWD_EMAIL="$(account_email "$DWD_ACCOUNT_ID" "$PROJECT")"
  BUCKET="$(bucket_name "$PROJECT")"
  # The installer, as IAP and the dashboard's users records name people: a lowercase email.
  INSTALLER_EMAIL="$(tr '[:upper:]' '[:lower:]' <<<"$ACCOUNT")"
  if [[ "$INSTALLER_EMAIL" == *.gserviceaccount.com ]]; then
    INSTALLER_MEMBER="serviceAccount:$INSTALLER_EMAIL"
  else
    INSTALLER_MEMBER="user:$INSTALLER_EMAIL"
  fi
}

summarize_and_confirm() {
  say ""
  say "paraclete will be installed into $PROJECT:"
  say "  role        $ROLE"
  if [[ -n "$PREVIOUS_ROLE" ]]; then
    say "              moved from $PREVIOUS_ROLE at the VM's next boot: that role's skills, prompts, playbooks and"
    say "              default responsibilities go, and the grants only it needed are removed; the agent's"
    say "              memory, missions, files and own responsibilities stay (install/README.md)"
  fi
  say "  name        $AGENT_NAME"
  say "  release     $RELEASE ($COMMIT)"
  say "  repository  $REPO"
  say "  region      $REGION, VM in $ZONE"
  say "  bucket      gs://$BUCKET"
  say "  dashboard   Cloud Run service $SERVICE_NAME, behind Google sign-in (first admin: $INSTALLER_EMAIL)"
  if [[ "$AUTO_UPDATE_OFF" == 1 ]]; then
    say "  updates     installed from the dashboard's System tab only (--no-auto-update)"
  else
    say "  updates     new releases install automatically, checked on $(contract auto_update.schedule) (UTC)"
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    say ""
    say "Dry run: nothing will change. Each command that would change something is printed after a +."
    return 0
  fi
  if [[ "$YES" != 1 ]]; then
    confirm "Go ahead?" || die "nothing was changed"
  fi
}

# ---------------------------------------------------------------------------------------------------
# Step 2: apis
# ---------------------------------------------------------------------------------------------------

step_apis() {
  step 2 apis "turn on the Google APIs the agent and the dashboard use, and check the agent's model answers"
  enable_apis
  check_model
}

# Turns on what is off of: every instance's APIs, the Workspace ones for a Workspace role, and the
# `apis` of generic and the role, each once. Never turns one off: an API a previous role needed stays
# on after a move.
enable_apis() {
  local candidates=("${BASE_APIS[@]}") wanted=() enabled api missing=() i
  if [[ "$ROLE_WORKSPACE" == true ]]; then
    candidates+=("${WORKSPACE_APIS[@]}")
  fi
  while IFS= read -r api; do
    [[ -n "$api" ]] && candidates+=("$api")
  done <<<"$ROLE_APIS"
  for api in "${candidates[@]}"; do
    [[ " ${wanted[*]} " == *" $api "* ]] || wanted+=("$api")
  done
  enabled="$(gcloud services list --enabled --project="$PROJECT" --format='value(config.name)' 2>/dev/null || true)"
  for api in "${wanted[@]}"; do
    if grep -Fxq -- "$api.googleapis.com" <<<"$enabled"; then
      continue
    fi
    missing+=("$api.googleapis.com")
  done
  if ((${#missing[@]} == 0)); then
    note "all ${#wanted[@]} are on"
    return 0
  fi
  for ((i = 0; i < ${#missing[@]}; i += APIS_PER_CALL)); do
    run gcloud services enable "${missing[@]:i:APIS_PER_CALL}" --project="$PROJECT" --quiet
  done
  if [[ "$DRY_RUN" == 1 ]]; then
    note "(dry run: while these APIs are off, the steps below cannot look inside them, so they plan to create everything there)"
  fi
}

# Gemini 4 is new and served only from Vertex AI's global endpoint (build plan section 13), so before
# building anything on it the install proves this project can call the agent's model: the contracts'
# cortex model, asked for one word, as you. A failure is tried again for about a minute (a just-enabled
# API takes a moment to answer), then stops the install with what to do about it.
check_model() {
  local spec model location url answer attempt=1
  spec="$(contract vertex.models.cortex)"
  location="$(contract vertex.location)"
  model="${spec#*/}"
  if [[ "${spec%%/*}" != vertex-google ]]; then
    note "the agent's model is $spec, not a Gemini model on Vertex AI; not checked"
    return 0
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    note "(dry run: a real run checks here that $PROJECT can call $model, once the APIs are on)"
    return 0
  fi
  url="$(vertex_endpoint "$location")/v1/projects/$PROJECT/locations/$location/publishers/google/models/$model:generateContent"
  while :; do
    answer="$(model_answer "$url")"
    if [[ "$answer" == ok ]]; then
      note "$model answers in $PROJECT (Vertex AI, $location)"
      return 0
    fi
    ((attempt < MODEL_CHECK_ATTEMPTS)) || break
    warn "$model did not answer ($answer); trying again in ${MODEL_CHECK_DELAY_SECONDS}s"
    sleep "$MODEL_CHECK_DELAY_SECONDS"
    attempt=$((attempt + 1))
  done
  die "$(model_failure "$model" "$location" "$answer")"
}

# vertex_endpoint <location>: Vertex AI's API host for a location. The global one has no prefix.
vertex_endpoint() {
  if [[ "$1" == global ]]; then
    printf 'https://aiplatform.googleapis.com\n'
  else
    printf 'https://%s-aiplatform.googleapis.com\n' "$1"
  fi
}

# model_answer <url>: "ok" when the model answered, else "<status>: <message>" from Google's error (or
# UNREACHABLE when the request never got an answer).
model_answer() {
  local token response
  token="$(access_token)" || {
    printf 'NO_TOKEN: gcloud could not give an access token\n'
    return 0
  }
  response="$(curl -sS -X POST -H "Authorization: Bearer $token" -H "x-goog-user-project: $PROJECT" \
    -H 'Content-Type: application/json' --data "$MODEL_CHECK_PROMPT" "$1" 2>&1)" || {
    printf 'UNREACHABLE: %s\n' "$(tr '\n' ' ' <<<"$response")"
    return 0
  }
  node -e '
const fs = require("node:fs");
let answer;
try { answer = JSON.parse(fs.readFileSync(0, "utf8")); } catch { console.log("UNREADABLE: the answer was not JSON"); process.exit(0); }
if (answer && Array.isArray(answer.candidates)) { console.log("ok"); process.exit(0); }
const error = (answer && answer.error) || {};
console.log(`${error.status || error.code || "UNKNOWN"}: ${String(error.message || "no message").replace(/\s+/g, " ")}`);
' <<<"$response"
}

# model_failure <model> <location> <answer>: why the model check stopped the install, and what to do.
model_failure() {
  local model="$1" location="$2" answer="$3" why
  case "$answer" in
    RESOURCE_EXHAUSTED* | 429*)
      why="$PROJECT has no quota for $model yet. Ask for it under IAM & Admin, Quotas (Vertex AI API, generate content requests per minute per base model, $location): https://console.cloud.google.com/iam-admin/quotas?project=$PROJECT" ;;
    NOT_FOUND* | 404* | FAILED_PRECONDITION* | 400*)
      why="$model is not available to $PROJECT at Vertex AI's $location endpoint. Enable it for the project in Model Garden (https://console.cloud.google.com/vertex-ai/model-garden?project=$PROJECT), or ask whoever runs your organization's policies whether they restrict which models it may use" ;;
    PERMISSION_DENIED* | 403*)
      if [[ "$answer" == *"has not been used"* || "$answer" == *disabled* ]]; then
        why="the Vertex AI API is still turning on for $PROJECT. Wait a few minutes"
      else
        why="$ACCOUNT may not call $model in $PROJECT, or an organization policy blocks it"
      fi ;;
    *) why="Vertex AI could not be reached, or did not answer as expected" ;;
  esac
  printf 'the agent cannot use its model: %s. Then run install/install.sh again; what it did so far stays. (%s)\n' "$why" "$answer"
}

# ---------------------------------------------------------------------------------------------------
# Step 3: accounts
# ---------------------------------------------------------------------------------------------------

step_accounts() {
  step 3 accounts "the agent's and the dashboard's service accounts, and what each may do"
  ensure_account "$AGENT_ACCOUNT_ID" "$AGENT_EMAIL" "paraclete agent" "The paraclete agent: its VM runs as this account."
  ensure_account "$DASHBOARD_ACCOUNT_ID" "$DASHBOARD_EMAIL" "paraclete dashboard" "The paraclete dashboard on Cloud Run runs as this account."
  if [[ "$ROLE_WORKSPACE" == true ]]; then
    ensure_account "$DWD_ACCOUNT_ID" "$DWD_EMAIL" "paraclete Workspace signer" \
      "Signs the agent's Workspace tokens through domain-wide delegation. Holds no roles in this project."
  fi

  local policy role self_policy dwd_policy
  # The tag the dashboard's service and update job carry (step 6), which a fenced grant names.
  ensure_managed_tag "$PROJECT"
  policy="$(read_project_policy "$PROJECT")"
  while IFS= read -r role; do
    [[ -n "$role" ]] || continue
    ensure_project_role "$PROJECT" "$policy" "serviceAccount:$AGENT_EMAIL" "$role"
  done <<<"$AGENT_ROLES"
  # Before a project-wide grant is taken back, so a role moving to its fenced grant never holds neither.
  ensure_resource_roles "$policy"
  revoke_project_wide_refused "$policy"
  ensure_project_label "$PROJECT" "$PROJECT_NUMBER" "$ROLE" "$WORK_DIR"
  revoke_previous_role_grants "$policy"
  for role in "${DASHBOARD_PROJECT_ROLES[@]}"; do
    ensure_project_role "$PROJECT" "$policy" "serviceAccount:$DASHBOARD_EMAIL" "$role"
  done
  self_policy="$(read_account_policy "$DASHBOARD_EMAIL" "$PROJECT")"
  for role in "${DASHBOARD_SELF_ROLES[@]}"; do
    ensure_account_role "$DASHBOARD_EMAIL" "$PROJECT" "$self_policy" "serviceAccount:$DASHBOARD_EMAIL" "$role"
  done
  if [[ "$ROLE_WORKSPACE" == true ]]; then
    # The agent signs as the Workspace signer, and only as it: the grant sits on that one account.
    dwd_policy="$(read_account_policy "$DWD_EMAIL" "$PROJECT")"
    ensure_account_role "$DWD_EMAIL" "$PROJECT" "$dwd_policy" "serviceAccount:$AGENT_EMAIL" roles/iam.serviceAccountTokenCreator
    # The dashboard's Workspace setup shows the signer's client ID, which an admin pastes into the Admin
    # console's domain-wide delegation; reading it needs this viewer role, on that one account only.
    ensure_account_role "$DWD_EMAIL" "$PROJECT" "$dwd_policy" "serviceAccount:$DASHBOARD_EMAIL" roles/iam.serviceAccountViewer
  fi
  revoke_previous_resource_roles "$policy"
}

# ensure_account <account id> <email> <display name> <description>
ensure_account() {
  if gcloud iam service-accounts describe "$2" --project="$PROJECT" --format='value(email)' >/dev/null 2>&1; then
    note "$2 exists"
    return 0
  fi
  run gcloud iam service-accounts create "$1" --project="$PROJECT" --display-name="$3" --description="$4" --quiet
}

# revoke_previous_role_grants <project policy>: on a move to another role, the project roles the
# previous role's role.json declared that neither generic nor the new role needs, taken back from the
# agent's account, which keeps least privilege. Nothing else is touched: any other grant the agent's
# account holds stays, whoever made it. IAM cannot tell the installer's grant from the same role
# granted by hand, so a role the previous role declared goes either way. When this clone has no
# role.json for the previous role, nothing is taken back and the run says so.
revoke_previous_role_grants() {
  [[ -n "$PREVIOUS_ROLE" ]] || return 0
  local file="$REPO_ROOT/roles/$PREVIOUS_ROLE/role.json" role
  if [[ ! "$PREVIOUS_ROLE" =~ ^[a-z][a-z0-9-]*$ || ! -f "$file" ]]; then
    warn "this clone has no role '$PREVIOUS_ROLE', so the grants it added cannot be told apart; the agent's account keeps them"
    return 0
  fi
  while IFS= read -r role; do
    [[ -n "$role" ]] || continue
    # A refused role was taken back already, by revoke_project_wide_refused.
    if grep -Fxq -- "$role" <<<"$AGENT_ROLES" || grep -Fxq -- "$role" <<<"$REFUSED_PROJECT_ROLES"; then
      continue
    fi
    if has_binding "$1" "$role" "serviceAccount:$AGENT_EMAIL"; then
      run_retry gcloud projects remove-iam-policy-binding "$PROJECT" --member="serviceAccount:$AGENT_EMAIL" \
        --role="$role" --condition=None --quiet
    fi
  done < <(json_get "$file" gcp_roles)
}

# revoke_project_wide_refused <project policy>: the agent's account never holds, on the whole project and
# without a condition, a role that reaches every service account, every image repository or every Cloud
# Run service and job (install/lib/role-access.mjs, PROJECT_WIDE_REFUSED): acting as any account
# includes the dashboard's, whose signature the VM's control service obeys, pushing to any repository
# includes the dashboard's images, and changing any Cloud Run service includes the dashboard's. No role
# in this clone asks for one (step 1 refuses it), so one the account holds was left by an older role
# definition or granted by hand: it is taken back on every run, saying so. A role that needs one has it
# on the agent's own account or repository, or on the project minus paraclete's own
# (ensure_resource_roles); that fenced grant stays.
revoke_project_wide_refused() {
  local role
  while IFS= read -r role; do
    [[ -n "$role" ]] || continue
    has_binding "$1" "$role" "serviceAccount:$AGENT_EMAIL" || continue
    note "the agent's account holds $role on the whole project, which reaches the dashboard's own account, images or service: taking it back"
    run_retry gcloud projects remove-iam-policy-binding "$PROJECT" --member="serviceAccount:$AGENT_EMAIL" \
      --role="$role" --condition=None --quiet
  done <<<"$REFUSED_PROJECT_ROLES"
}

# agent_roles: the generic role's gcp_roles, then the chosen role's, each once.
agent_roles() {
  {
    json_get "$REPO_ROOT/roles/generic/role.json" gcp_roles
    if [[ "$ROLE" != generic ]]; then
      json_get "$ROLE_FILE" gcp_roles
    fi
  } | awk 'NF && !seen[$0]++'
}

# ensure_resource_roles <project policy>: the grants generic and the role ask for on single resources
# (`resource_roles`, read in step 1), never on the whole project. `agent-account`: on the agent's own
# service account, granted to that account, so it may act as itself and as no other.
# `agent-repository`: on the agent's own Docker repository in the instance's region, created here the
# first time a role asks for it. `project-except-paraclete`: on the project, with the condition "not
# tagged paraclete=managed" (install/lib/iam.sh, fence_condition), so it reaches every Cloud Run service
# and job but the dashboard's service and its update job.
ensure_resource_roles() {
  local lines=() line kind role account_policy repository_policy have_account=0 have_repository=0
  mapfile -t lines <<<"$RESOURCE_ROLES"
  for line in "${lines[@]}"; do
    [[ -n "$line" ]] || continue
    kind="${line%%$'\t'*}"
    role="${line#*$'\t'}"
    case "$kind" in
      agent-account)
        if ((!have_account)); then
          account_policy="$(read_account_policy "$AGENT_EMAIL" "$PROJECT")"
          have_account=1
        fi
        ensure_account_role "$AGENT_EMAIL" "$PROJECT" "$account_policy" "serviceAccount:$AGENT_EMAIL" "$role" ;;
      agent-repository)
        if ((!have_repository)); then
          ensure_agent_repository
          repository_policy="$(read_repository_policy "$AGENT_IMAGE_REPOSITORY" "$REGION" "$PROJECT")"
          have_repository=1
        fi
        ensure_repository_role "$AGENT_IMAGE_REPOSITORY" "$REGION" "$PROJECT" "$repository_policy" \
          "serviceAccount:$AGENT_EMAIL" "$role" ;;
      project-except-paraclete)
        ensure_fenced_project_role "$PROJECT" "$1" "serviceAccount:$AGENT_EMAIL" "$role" ;;
      *) die "install/lib/role-access.mjs named an unknown resource '$kind'" ;;
    esac
  done
}

# The agent's own Docker repository, for the images its builds push. Never the dashboard's.
ensure_agent_repository() {
  if gcloud artifacts repositories describe "$AGENT_IMAGE_REPOSITORY" --location="$REGION" --project="$PROJECT" \
    --format='value(name)' >/dev/null 2>&1; then
    note "image repository $AGENT_IMAGE_REPOSITORY exists in $REGION"
    return 0
  fi
  run gcloud artifacts repositories create "$AGENT_IMAGE_REPOSITORY" --repository-format=docker --location="$REGION" \
    --description="$AGENT_IMAGE_REPOSITORY_DESCRIPTION" --project="$PROJECT" --quiet
}

# revoke_previous_resource_roles <project policy>: on a move to another role, the single-resource grants
# the previous role declared that neither generic nor the new role declares, taken back: from the agent's
# own account, from the project (a fenced grant), and from its image repository, which stays with its
# images (they are the agent's builds; uninstall.sh --purge deletes them). When this clone cannot read
# the previous role, nothing is taken back: revoke_previous_role_grants has said so already, or the
# warning here does.
revoke_previous_resource_roles() {
  [[ -n "$PREVIOUS_ROLE" ]] || return 0
  [[ "$PREVIOUS_ROLE" =~ ^[a-z][a-z0-9-]*$ && -f "$REPO_ROOT/roles/$PREVIOUS_ROLE/role.json" ]] || return 0
  local previous lines=() line kind role account_policy repository_policy have_account=0 have_repository=0
  if ! previous="$(role_access resource-roles "$PREVIOUS_ROLE" 2>&1)"; then
    warn "roles/$PREVIOUS_ROLE/role.json cannot be read ($previous), so its single-resource grants stay"
    return 0
  fi
  mapfile -t lines <<<"$previous"
  for line in "${lines[@]}"; do
    [[ -n "$line" ]] || continue
    grep -Fxq -- "$line" <<<"$RESOURCE_ROLES" && continue
    kind="${line%%$'\t'*}"
    role="${line#*$'\t'}"
    case "$kind" in
      agent-account)
        if ((!have_account)); then
          account_policy="$(read_account_policy "$AGENT_EMAIL" "$PROJECT")"
          have_account=1
        fi
        revoke_account_role "$AGENT_EMAIL" "$PROJECT" "$account_policy" "serviceAccount:$AGENT_EMAIL" "$role" ;;
      agent-repository)
        if ((!have_repository)); then
          repository_policy="$(read_repository_policy "$AGENT_IMAGE_REPOSITORY" "$REGION" "$PROJECT")"
          have_repository=1
          if [[ -n "$repository_policy" ]]; then
            note "image repository $AGENT_IMAGE_REPOSITORY stays in $REGION, with its images"
          fi
        fi
        revoke_repository_role "$AGENT_IMAGE_REPOSITORY" "$REGION" "$PROJECT" "$repository_policy" \
          "serviceAccount:$AGENT_EMAIL" "$role" ;;
      project-except-paraclete)
        revoke_fenced_project_role "$PROJECT" "$1" "serviceAccount:$AGENT_EMAIL" "$role" ;;
    esac
  done
}

# ---------------------------------------------------------------------------------------------------
# Step 4: firestore
# ---------------------------------------------------------------------------------------------------

step_firestore() {
  step 4 firestore "the database, its indexes and its TTL policies"
  local type
  type="$(gcloud firestore databases describe --database="$FIRESTORE_DATABASE" --project="$PROJECT" --format='value(type)' 2>/dev/null || true)"
  case "$type" in
    FIRESTORE_NATIVE) note "the $FIRESTORE_DATABASE database exists" ;;
    "")
      # Delete protection: removing the agent's memory takes uninstall.sh --purge, or a deliberate
      # change in the console first.
      run gcloud firestore databases create --database="$FIRESTORE_DATABASE" --location="$REGION" \
        --type=firestore-native --delete-protection --project="$PROJECT" --quiet ;;
    *) die "the $FIRESTORE_DATABASE Firestore database of $PROJECT is in $type. paraclete needs Native mode, and a database cannot change mode." ;;
  esac
  ensure_indexes
  ensure_ttls
}

# Index builds run in the background (--async); until one is ready, the query it serves fails and the
# agent's services retry.
ensure_indexes() {
  local existing signature group scope fields field_args field_list field
  existing="$(existing_indexes "$PROJECT")"
  while IFS=$'\t' read -r signature group scope fields; do
    if [[ -n "$(index_id "$existing" "$signature")" ]]; then
      note "index $signature exists"
      continue
    fi
    field_args=()
    IFS=';' read -ra field_list <<<"$fields"
    for field in "${field_list[@]}"; do
      field_args+=("--field-config=field-path=${field%%=*},order=${field#*=}")
    done
    run gcloud firestore indexes composite create --collection-group="$group" --query-scope="$scope" \
      "${field_args[@]}" --database="$FIRESTORE_DATABASE" --project="$PROJECT" --async --quiet
  done < <(index_plan "$INSTALL_DIR/firestore.indexes.json")
}

ensure_ttls() {
  local existing group field state
  existing="$(existing_ttls "$PROJECT")"
  while IFS=$'\t' read -r group field; do
    state="$(ttl_state "$existing" "$group" "$field")"
    if [[ "$state" == ACTIVE || "$state" == CREATING ]]; then
      note "TTL on $group.$field is $state"
      continue
    fi
    run gcloud firestore fields ttls update "$field" --collection-group="$group" --enable-ttl \
      --database="$FIRESTORE_DATABASE" --project="$PROJECT" --async --quiet
  done < <(ttl_plan "$INSTALL_DIR/firestore.indexes.json")
}

# ---------------------------------------------------------------------------------------------------
# Step 5: bucket
# ---------------------------------------------------------------------------------------------------

step_bucket() {
  step 5 bucket "gs://$BUCKET: files, git artifacts, and nothing public"
  local lifecycle_file="$WORK_DIR/lifecycle.json" policy member
  lifecycle_json >"$lifecycle_file"
  show_file "lifecycle.json" "$lifecycle_file"
  if gcloud storage buckets describe "gs://$BUCKET" --format='value(name)' >/dev/null 2>&1; then
    note "gs://$BUCKET exists; making sure of its access settings and lifecycle"
    run gcloud storage buckets update "gs://$BUCKET" --uniform-bucket-level-access --public-access-prevention \
      --lifecycle-file="$lifecycle_file" --quiet
  else
    run gcloud storage buckets create "gs://$BUCKET" --project="$PROJECT" --location="$REGION" \
      --uniform-bucket-level-access --public-access-prevention --lifecycle-file="$lifecycle_file" --quiet
  fi
  policy="$(read_bucket_policy "$BUCKET")"
  for member in "serviceAccount:$AGENT_EMAIL" "serviceAccount:$DASHBOARD_EMAIL"; do
    ensure_bucket_role "$BUCKET" "$policy" "$member" roles/storage.objectAdmin
  done
}

# lifecycle_json: the bucket's lifecycle rules. Files people send the agent (files.prefix + in/) are
# deleted after files.inbox_retention_days.
lifecycle_json() {
  local prefix days
  prefix="$(contract files.prefix)in/"
  days="$(contract files.inbox_retention_days)"
  [[ "$days" =~ ^[1-9][0-9]*$ ]] || die "contracts files.inbox_retention_days must be a whole number of days, got '$days'"
  printf '{"lifecycle":{"rule":[{"action":{"type":"Delete"},"condition":{"age":%s,"matchesPrefix":["%s"]}}]}}\n' "$days" "$prefix"
}

# ---------------------------------------------------------------------------------------------------
# Step 6: dashboard
# ---------------------------------------------------------------------------------------------------

step_dashboard() {
  step 6 dashboard "the web dashboard on Cloud Run, behind Google sign-in"
  local deploys=0
  UPDATE_JOB="$(contract auto_update.job_name)"
  if fetch_build_config; then
    deploys=1
    DASHBOARD_IMAGE="$(dashboard_js image project="$PROJECT" region="$REGION")"
    IAP_AGENT="$(dashboard_js iap-agent projectNumber="$PROJECT_NUMBER")"
    DASHBOARD_ENV=(project="$PROJECT" projectNumber="$PROJECT_NUMBER" region="$REGION" bucket="$BUCKET"
      repo="$REPO" release="$RELEASE" commit="$COMMIT" agentName="$AGENT_NAME" role="$ROLE"
      workspaceRole="$ROLE_WORKSPACE")
    ensure_image_repository
    ensure_image
    ensure_service
    ensure_sign_in
    ensure_first_admin
    ensure_update_job
    ensure_update_schedule
    ensure_auto_update_off
    ensure_managed_tag_binding "$PROJECT" "$REGION" "$(run_resource "$PROJECT" "$REGION" services "$SERVICE_NAME")"
    ensure_managed_tag_binding "$PROJECT" "$REGION" "$(run_resource "$PROJECT" "$REGION" jobs "$UPDATE_JOB")"
  fi
  DASHBOARD_URL="$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT" \
    --format='value(status.url)' 2>/dev/null || true)"
  if [[ -n "$DASHBOARD_URL" ]]; then
    note "the dashboard is at $DASHBOARD_URL"
  fi
  # A dashboard that exists, or that this run deploys, uploads into the bucket.
  if ((deploys)) || [[ -n "$DASHBOARD_URL" ]]; then
    ensure_upload_cors
  fi
}

# dashboard_js <command> [key=value]...: runs install/lib/dashboard.mjs, which holds the dashboard's
# build and deploy commands for this script and dev/deploy.mjs alike.
dashboard_js() {
  node "$DASHBOARD_JS" "$@" || die "install/lib/dashboard.mjs $1 failed"
}

# gcloud_args <command> [key=value]...: the gcloud arguments dashboard.mjs builds, into GCLOUD_ARGS.
gcloud_args() {
  local listing arg
  listing="$(dashboard_js "$@")"
  GCLOUD_ARGS=()
  while IFS= read -r arg; do
    GCLOUD_ARGS+=("$arg")
  done <<<"$listing"
}

# Downloads the release's own dashboard/cloudbuild.json. gcloud reads --config from this machine, not
# from the source it builds, and a release is built with its own build steps, not this clone's. A
# commit from before the first release has none (older ones kept their steps in YAML, or had no
# dashboard), and installs without a dashboard.
fetch_build_config() {
  local url status=0
  BUILD_CONFIG_FILE="$WORK_DIR/cloudbuild.json"
  url="$(dashboard_js build-config-url repo="$REPO" commit="$COMMIT")"
  curl -sSfL --retry 3 -o "$BUILD_CONFIG_FILE" "$url" 2>/dev/null || status=$?
  case "$status" in
    0)
      show_file cloudbuild.json "$BUILD_CONFIG_FILE"
      return 0 ;;
    22)
      note "$RELEASE has no dashboard/cloudbuild.json: it is older than the first release, so no dashboard is deployed"
      return 1 ;;
    *) die "could not download $url (curl exit $status)" ;;
  esac
}

# The Artifact Registry repository the images go to. The dashboard's account may push to it, and to
# nothing else in the registry: its builds run as itself.
ensure_image_repository() {
  local policy
  if gcloud artifacts repositories describe "$IMAGE_REPOSITORY" --location="$REGION" --project="$PROJECT" \
    --format='value(name)' >/dev/null 2>&1; then
    note "image repository $IMAGE_REPOSITORY exists in $REGION"
  else
    run gcloud artifacts repositories create "$IMAGE_REPOSITORY" --repository-format=docker --location="$REGION" \
      --description="$IMAGE_REPOSITORY_DESCRIPTION" --project="$PROJECT" --quiet
  fi
  policy="$(read_repository_policy "$IMAGE_REPOSITORY" "$REGION" "$PROJECT")"
  ensure_repository_role "$IMAGE_REPOSITORY" "$REGION" "$PROJECT" "$policy" "serviceAccount:$DASHBOARD_EMAIL" \
    roles/artifactregistry.writer
}

# The image at the release's commit, built by Cloud Build as the dashboard's own account (the one its
# upgrade button builds as). An image is tagged with its commit, so one that exists is not built again.
ensure_image() {
  local tags
  gcloud_args tags-args project="$PROJECT" region="$REGION"
  tags="$(gcloud "${GCLOUD_ARGS[@]}" 2>/dev/null || true)"
  if grep -Fxq -- "$COMMIT" <<<"$tags"; then
    note "the image $DASHBOARD_IMAGE:$COMMIT exists"
    return 0
  fi
  gcloud_args build-args repo="$REPO" commit="$COMMIT" configFile="$BUILD_CONFIG_FILE" project="$PROJECT" region="$REGION"
  run gcloud "${GCLOUD_ARGS[@]}"
}

# The Cloud Run service, deployed unless it already runs this commit exactly as it should: the same
# environment, account, IAP, ingress and size, and not open to everyone.
ensure_service() {
  local service policy drift env_file="$WORK_DIR/dashboard-env.yaml"
  gcloud_args describe-args project="$PROJECT" region="$REGION"
  service="$(gcloud "${GCLOUD_ARGS[@]}" 2>/dev/null || true)"
  policy="$(read_service_policy "$SERVICE_NAME" "$REGION" "$PROJECT")"
  drift="$(dashboard_js drift "${DASHBOARD_ENV[@]}" <<<"$service")"
  if has_binding "$policy" roles/run.invoker allUsers || has_binding "$policy" roles/run.invoker allAuthenticatedUsers; then
    drift="${drift:+$drift, }public access"
  fi
  if [[ -z "$drift" ]]; then
    note "$SERVICE_NAME already runs $COMMIT"
    return 0
  fi
  if [[ "$drift" != missing ]]; then
    note "$SERVICE_NAME exists; deploying because of: $drift"
  fi
  dashboard_js env-file "${DASHBOARD_ENV[@]}" >"$env_file"
  show_file dashboard-env.yaml "$env_file"
  ensure_iap_agent "$policy"
  gcloud_args deploy-args project="$PROJECT" region="$REGION" commit="$COMMIT" envFile="$env_file"
  run gcloud "${GCLOUD_ARGS[@]}"
}

# ensure_iap_agent <service policy>: IAP reaches the service as its own service agent, which a project
# has only once it is asked for. Asked for once per run, and only while that agent is not already let
# in (then it exists). It comes before a deploy: gcloud grants it the invoker role as it turns IAP on.
ensure_iap_agent() {
  if has_binding "$1" roles/run.invoker "serviceAccount:$IAP_AGENT" || ((${IAP_AGENT_ASKED:-0})); then
    return 0
  fi
  run gcloud beta services identity create --service=iap.googleapis.com --project="$PROJECT" --quiet
  IAP_AGENT_ASKED=1
}

# Who reaches the dashboard. IAP's service agent may invoke the service (IAP itself decides who signs
# in); the installer may sign in, and becomes the first admin below; the dashboard's own account
# administers IAP on its service, so the dashboard adds and removes its users itself.
ensure_sign_in() {
  local policy iap_policy
  policy="$(read_service_policy "$SERVICE_NAME" "$REGION" "$PROJECT")"
  ensure_iap_agent "$policy"
  ensure_service_role "$SERVICE_NAME" "$REGION" "$PROJECT" "$policy" "serviceAccount:$IAP_AGENT" roles/run.invoker
  iap_policy="$(read_iap_policy "$SERVICE_NAME" "$REGION" "$PROJECT")"
  ensure_iap_role "$SERVICE_NAME" "$REGION" "$PROJECT" "$iap_policy" "$INSTALLER_MEMBER" roles/iap.httpsResourceAccessor
  ensure_iap_role "$SERVICE_NAME" "$REGION" "$PROJECT" "$iap_policy" "serviceAccount:$DASHBOARD_EMAIL" roles/iap.admin
}

# The installer becomes the dashboard's first admin: users/<email> in Firestore, written through the
# REST API as you. Create-only (the exists=false precondition), so a re-run never rewrites a record the
# dashboard has changed since, nor demotes or restores anyone.
ensure_first_admin() {
  local url state body_file="$WORK_DIR/first-admin.json" header_file="$WORK_DIR/firestore-headers" token
  url="https://firestore.googleapis.com/v1/projects/$PROJECT/databases/$FIRESTORE_DATABASE/documents/$USERS_COLLECTION/$INSTALLER_EMAIL"
  state="$(firestore_doc_state "$url")"
  case "$state" in
    exists)
      note "$INSTALLER_EMAIL is a dashboard user already; the record stays as it is"
      return 0 ;;
    missing) ;;
    *)
      [[ "$DRY_RUN" == 1 ]] \
        || die "could not read $USERS_COLLECTION/$INSTALLER_EMAIL from Firestore (${state#unknown: }). Re-running install/install.sh is safe."
      note "(dry run: Firestore cannot be read yet, so it plans to create the record)" ;;
  esac
  first_admin_json "$INSTALLER_EMAIL" >"$body_file"
  show_file first-admin.json "$body_file"
  # The token reaches curl through a file (mode 600, in the run's own temporary directory), so the
  # command `run` prints, and a dry run shows, never holds it.
  if [[ "$DRY_RUN" != 1 ]]; then
    token="$(access_token)" || die "no access token for $ACCOUNT"
    (umask 077 && printf 'Authorization: Bearer %s\nx-goog-user-project: %s\n' "$token" "$PROJECT" >"$header_file")
  fi
  run curl -sS --fail-with-body -g -X PATCH -H "@$header_file" -H 'Content-Type: application/json' \
    --data-binary "@$body_file" "$url?currentDocument.exists=false"
}

# The automatic-update job: dashboard/jobs/auto-update.mjs in the dashboard's image at this commit, as the
# dashboard's account, with the service's environment. Deployed unless it already runs exactly that.
# Each run installs the newest release when the admin setting allows it (dashboard/lib/server/auto-update.mjs);
# the dashboard's own upgrade moves its image afterwards.
ensure_update_job() {
  local job drift env_file="$WORK_DIR/update-job-env.yaml"
  gcloud_args job-describe-args project="$PROJECT" region="$REGION"
  job="$(gcloud "${GCLOUD_ARGS[@]}" 2>/dev/null || true)"
  drift="$(dashboard_js job-drift "${DASHBOARD_ENV[@]}" <<<"$job")"
  if [[ -z "$drift" ]]; then
    note "the update job $UPDATE_JOB already runs $COMMIT"
    return 0
  fi
  [[ "$drift" == missing ]] || note "the update job $UPDATE_JOB exists; deploying because of: $drift"
  dashboard_js env-file "${DASHBOARD_ENV[@]}" >"$env_file"
  gcloud_args job-deploy-args project="$PROJECT" region="$REGION" commit="$COMMIT" envFile="$env_file"
  run gcloud "${GCLOUD_ARGS[@]}"
}

# The schedule that starts the update job: Cloud Scheduler calls Cloud Run's Admin API as the dashboard's
# account on contracts.auto_update.schedule. Created, or updated when it differs. A schedule someone
# paused stays paused: the admin setting is what turns automatic updates off.
ensure_update_schedule() {
  local schedule drift verb=create
  gcloud_args schedule-describe-args project="$PROJECT" region="$REGION"
  schedule="$(gcloud "${GCLOUD_ARGS[@]}" 2>/dev/null || true)"
  drift="$(dashboard_js schedule-drift project="$PROJECT" region="$REGION" <<<"$schedule")"
  if [[ -z "$drift" ]]; then
    note "the update schedule $UPDATE_JOB runs the job on $(contract auto_update.schedule) (UTC)"
    return 0
  fi
  if [[ "$drift" != missing ]]; then
    verb=update
    note "the update schedule $UPDATE_JOB exists; updating because of: $drift"
  fi
  gcloud_args schedule-args project="$PROJECT" region="$REGION" verb="$verb"
  run gcloud "${GCLOUD_ARGS[@]}"
}

# --no-auto-update: stores auto_update=false in config/settings, through the REST API as you, with a
# field mask, so the rest of the document stays as it is. Without the flag nothing is written: an
# absent setting is the contracts' default (on), and a re-run never undoes an admin's choice.
ensure_auto_update_off() {
  [[ "$AUTO_UPDATE_OFF" == 1 ]] || return 0
  local url body_file="$WORK_DIR/auto-update-off.json" header_file="$WORK_DIR/firestore-headers" token mask
  url="https://firestore.googleapis.com/v1/projects/$PROJECT/databases/$FIRESTORE_DATABASE/documents/$CONFIG_COLLECTION/settings"
  mask='updateMask.fieldPaths=auto_update&updateMask.fieldPaths=auto_update_updated_at&updateMask.fieldPaths=auto_update_updated_by'
  node -e '
const [email] = process.argv.slice(1);
console.log(JSON.stringify({ fields: {
  auto_update: { booleanValue: false },
  auto_update_updated_at: { stringValue: new Date().toISOString() },
  auto_update_updated_by: { stringValue: email },
} }));
' "$INSTALLER_EMAIL" >"$body_file"
  show_file auto-update-off.json "$body_file"
  if [[ "$DRY_RUN" != 1 ]]; then
    token="$(access_token)" || die "no access token for $ACCOUNT"
    (umask 077 && printf 'Authorization: Bearer %s\nx-goog-user-project: %s\n' "$token" "$PROJECT" >"$header_file")
  fi
  run curl -sS --fail-with-body -g -X PATCH -H "@$header_file" -H 'Content-Type: application/json' \
    --data-binary "@$body_file" "$url?$mask"
}

# The browser uploads files straight into the bucket through V4 signed URLs (dashboard/README.md), which
# it may do only from origins the bucket's CORS setting names: every URL the service answers at, and its
# deterministic https://<service>-<project number>.<region>.run.app, which a dry run before the first
# deploy can name already. Set only when the bucket's setting differs; it replaces the whole setting.
ensure_upload_cors() {
  local cors_file="$WORK_DIR/cors.json" service origins bucket drift
  gcloud_args describe-args project="$PROJECT" region="$REGION"
  service="$(gcloud "${GCLOUD_ARGS[@]}" 2>/dev/null || true)"
  origins="$(dashboard_js origins projectNumber="$PROJECT_NUMBER" region="$REGION" <<<"$service")"
  bucket="$(gcloud storage buckets describe "gs://$BUCKET" --format=json 2>/dev/null || true)"
  drift="$(dashboard_js cors-drift origins="$origins" <<<"$bucket")"
  if [[ -z "$drift" ]]; then
    note "gs://$BUCKET lets the dashboard upload from ${origins//,/ and }"
    return 0
  fi
  note "gs://$BUCKET: letting the dashboard upload from ${origins//,/ and } (its CORS setting: $drift)"
  dashboard_js cors-file origins="$origins" >"$cors_file"
  show_file cors.json "$cors_file"
  run gcloud storage buckets update "gs://$BUCKET" --cors-file="$cors_file" --quiet
}

# firestore_doc_state <document url>: "exists", "missing", or "unknown: <why>", read as you.
firestore_doc_state() {
  local token response
  token="$(access_token)" || {
    printf 'unknown: gcloud could not give an access token\n'
    return 0
  }
  response="$(curl -sS -g -H "Authorization: Bearer $token" -H "x-goog-user-project: $PROJECT" "$1" 2>&1)" || {
    printf 'unknown: %s\n' "$(tr '\n' ' ' <<<"$response")"
    return 0
  }
  node -e '
const fs = require("node:fs");
let doc;
try { doc = JSON.parse(fs.readFileSync(0, "utf8")); } catch { console.log("unknown: the answer was not JSON"); process.exit(0); }
if (doc && doc.name && !doc.error) console.log("exists");
else if (doc && doc.error && doc.error.status === "NOT_FOUND") console.log("missing");
else console.log(`unknown: ${String((doc && doc.error && (doc.error.message || doc.error.status)) || "no answer").replace(/\s+/g, " ")}`);
' <<<"$response"
}

# first_admin_json <email>: the record dashboard/lib/server/users.mjs reads, as a Firestore document.
first_admin_json() {
  node -e '
const [email] = process.argv.slice(1);
const record = { email, role: "admin", added_by: "install.sh", added_at: new Date().toISOString() };
const fields = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, { stringValue: value }]));
console.log(JSON.stringify({ fields }));
' "$1"
}

# ---------------------------------------------------------------------------------------------------
# Step 7: network
# ---------------------------------------------------------------------------------------------------

step_network() {
  step 7 network "a network for the VM, and SSH through IAP as the only way in"
  if gcloud compute networks describe default --project="$PROJECT" --format='value(name)' >/dev/null 2>&1; then
    NETWORK=default
    note "using the default network"
  elif gcloud compute networks describe "$NETWORK_NAME" --project="$PROJECT" --format='value(name)' >/dev/null 2>&1; then
    NETWORK="$NETWORK_NAME"
    note "using the $NETWORK_NAME network"
  else
    NETWORK="$NETWORK_NAME"
    run gcloud compute networks create "$NETWORK_NAME" --subnet-mode=auto --description="$NETWORK_DESCRIPTION" \
      --project="$PROJECT" --quiet
  fi
  if gcloud compute firewall-rules describe "$FIREWALL_RULE" --project="$PROJECT" --format='value(name)' >/dev/null 2>&1; then
    note "firewall rule $FIREWALL_RULE exists"
  else
    run gcloud compute firewall-rules create "$FIREWALL_RULE" --network="$NETWORK" --direction=INGRESS \
      --action=ALLOW --rules=tcp:22 --source-ranges="$IAP_SOURCE_RANGE" --target-tags="$NETWORK_TAG" \
      --priority="$FIREWALL_RULE_PRIORITY" \
      --description="SSH to the paraclete VM through Identity-Aware Proxy only" --project="$PROJECT" --quiet
  fi
  if gcloud compute firewall-rules describe "$DENY_RULE" --project="$PROJECT" --format='value(name)' >/dev/null 2>&1; then
    note "firewall rule $DENY_RULE exists"
  else
    run gcloud compute firewall-rules create "$DENY_RULE" --network="$NETWORK" --direction=INGRESS \
      --action=DENY --rules=all --source-ranges=0.0.0.0/0 --target-tags="$NETWORK_TAG" \
      --priority="$DENY_RULE_PRIORITY" \
      --description="Nothing else reaches the paraclete VM, whatever the network's own rules allow" \
      --project="$PROJECT" --quiet
  fi
}

# ---------------------------------------------------------------------------------------------------
# Step 8: vm
# ---------------------------------------------------------------------------------------------------

step_vm() {
  step 8 vm "the agent's VM, told which release to install"
  local startup_file="$WORK_DIR/startup-script.sh" metadata found changed
  startup_script >"$startup_file"
  show_file "startup-script" "$startup_file"
  metadata="$(vm_metadata)"

  found="$(gcloud compute instances list --project="$PROJECT" --filter="name=$VM_NAME" \
    --format='value(name,zone.basename())' 2>/dev/null | head -n 1 || true)"
  if [[ -z "$found" ]]; then
    VM_ZONE="$ZONE"
    WAIT_SINCE_MS=$((($(date +%s) - 60) * 1000))
    run gcloud compute instances create "$VM_NAME" --zone="$VM_ZONE" --project="$PROJECT" \
      --machine-type="$MACHINE_TYPE" --boot-disk-size="$BOOT_DISK_SIZE" --boot-disk-type="$BOOT_DISK_TYPE" \
      --image-family="$IMAGE_FAMILY" --image-project="$IMAGE_PROJECT" \
      --service-account="$AGENT_EMAIL" --scopes="$VM_SCOPES" \
      --network="$NETWORK" --tags="$NETWORK_TAG" \
      --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
      --metadata="$metadata" --metadata-from-file=startup-script="$startup_file" --quiet
    VM_STATE=created
    return 0
  fi

  VM_ZONE="${found##*[[:space:]]}"
  if [[ "$VM_ZONE" != "$ZONE" ]]; then
    note "$VM_NAME already runs in $VM_ZONE; keeping it there"
  fi
  changed="$(changed_metadata "$metadata" "$startup_file")"
  if [[ -z "$changed" ]]; then
    note "$VM_NAME exists and its metadata already names $RELEASE ($COMMIT)"
    VM_STATE=current
    return 0
  fi
  note "$VM_NAME exists; updating: $changed"
  run gcloud compute instances add-metadata "$VM_NAME" --zone="$VM_ZONE" --project="$PROJECT" \
    --metadata="$metadata" --metadata-from-file=startup-script="$startup_file" --quiet
  # A new commit, or a new role: either takes the next bootstrap (a boot, or upgrade.sh) to install.
  if grep -qw -e paraclete-ref -e paraclete-role <<<"$changed"; then
    VM_STATE=moved
  else
    VM_STATE=current
  fi
}

# vm_metadata: the VM metadata install/README.md defines, as key=value,... for --metadata. The two
# Workspace keys are left out: they go together (config/instance.mjs refuses a signer without an
# account), and the agent's Workspace account does not exist until the dashboard's setup wizard
# creates it (build plan phase 8). add-metadata leaves a key it is not given as it was, so a re-run
# never removes them.
vm_metadata() {
  local items=(
    "paraclete-repo=$REPO"
    "paraclete-ref=$COMMIT"
    "paraclete-release=$RELEASE"
    "paraclete-role=$ROLE"
    "paraclete-agent-name=$AGENT_NAME"
    "paraclete-bucket=$BUCKET"
  )
  if [[ -n "$DASHBOARD_URL" ]]; then
    items+=("paraclete-dashboard-url=$DASHBOARD_URL")
  fi
  local IFS=,
  printf '%s\n' "${items[*]}"
}

# changed_metadata <key=value,...> <startup script file>: the keys whose value on the VM differs from
# what this run would write, space-separated; nothing when the VM is up to date.
changed_metadata() {
  local current
  current="$(gcloud compute instances describe "$VM_NAME" --zone="$VM_ZONE" --project="$PROJECT" \
    --format=json 2>/dev/null || printf '{}')"
  node -e '
const fs = require("node:fs");
const [pairs, scriptFile] = process.argv.slice(1);
const items = (JSON.parse(fs.readFileSync(0, "utf8") || "{}").metadata || {}).items || [];
const onVm = new Map(items.map((item) => [item.key, item.value]));
const wanted = new Map(pairs.split(",").map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
wanted.set("startup-script", fs.readFileSync(scriptFile, "utf8"));
console.log([...wanted].filter(([key, value]) => onVm.get(key) !== value).map(([key]) => key).join(" "));
' "$1" "$2" <<<"$current"
}

# startup_script: the VM's startup script. At every boot it fetches install/bootstrap.sh from
# paraclete-repo at paraclete-ref (read from the metadata, so a new ref needs no new script) and runs it
# as root in the unit paraclete-bootstrap, whose output goes to the journal.
startup_script() {
  cat <<'EOF'
#!/bin/bash
# paraclete startup script, written by install/install.sh. Fetches install/bootstrap.sh from the
# repository and commit in this VM's metadata and runs it as root in the unit paraclete-bootstrap.
# Read its output with: journalctl -u paraclete-bootstrap
set -euo pipefail
attribute() {
  curl --fail --silent --show-error --retry 5 --retry-connrefused -H 'Metadata-Flavor: Google' \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}
repo="$(attribute paraclete-repo)"
ref="$(attribute paraclete-ref)"
install -d -m 0700 /run/paraclete-bootstrap
curl --fail --silent --show-error --location --retry 10 --retry-delay 6 --retry-all-errors \
  --output /run/paraclete-bootstrap/bootstrap.sh \
  "https://raw.githubusercontent.com/${repo}/${ref}/install/bootstrap.sh"
exec systemd-run --unit=paraclete-bootstrap --collect --wait --quiet --setenv=HOME=/root \
  --property=StandardOutput=journal --property=StandardError=journal \
  /bin/bash /run/paraclete-bootstrap/bootstrap.sh
EOF
}

# ---------------------------------------------------------------------------------------------------
# Step 9: wait
# ---------------------------------------------------------------------------------------------------

step_wait() {
  step 9 wait "until the agent reports ready"
  if [[ "$DRY_RUN" == 1 ]]; then
    note "would wait up to $((WAIT_TIMEOUT_SECONDS / 60)) minutes for Firestore agent/instance to report ready on $COMMIT"
    return 0
  fi
  if [[ "$VM_STATE" == moved ]]; then
    if [[ -n "$PREVIOUS_ROLE" ]]; then
      note "$VM_NAME moves from role $PREVIOUS_ROLE to $ROLE at its next boot:"
    else
      note "$VM_NAME picks up $RELEASE ($COMMIT) at its next boot:"
    fi
    note "  gcloud compute instances reset $VM_NAME --zone=$VM_ZONE --project=$PROJECT"
    note "or now, without a reboot:"
    note "  gcloud compute ssh $VM_NAME --zone=$VM_ZONE --project=$PROJECT --tunnel-through-iap -- sudo /opt/paraclete/install/upgrade.sh --ref $COMMIT"
    return 0
  fi
  if [[ "$VM_STATE" == current ]]; then
    # The VM may have been upgraded since its metadata was written (the dashboard and upgrade.sh never
    # touch metadata), so any commit it reports ready on is the answer.
    WAIT_SINCE_MS=0
    WAIT_ANY_COMMIT=1
  fi
  wait_for_agent
}

# instance_status: "<status> US <commit> US <updated, ms since epoch> US <error>" from the Firestore
# document agent/instance, or nothing while it doesn't exist or can't be read. US is the unit separator
# (0x1f): unlike a tab, read keeps an empty field between two of them.
instance_status() {
  local token response
  token="$(access_token)" || return 0
  response="$(curl -sS -g -H "Authorization: Bearer $token" -H "x-goog-user-project: $PROJECT" \
    "https://firestore.googleapis.com/v1/projects/$PROJECT/databases/$FIRESTORE_DATABASE/documents/agent/instance" 2>/dev/null)" || return 0
  node -e '
const fs = require("node:fs");
let doc;
try { doc = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(0); }
if (!doc || !doc.fields) process.exit(0);
const text = (name) => {
  const v = doc.fields[name] || {};
  return String(v.stringValue ?? v.timestampValue ?? "").replace(/[\t\n]/g, " ");
};
console.log([text("status"), text("commit"), Date.parse(doc.updateTime) || 0, text("error")].join("\x1f"));
' <<<"$response"
}

# Waits for agent/instance to report ready or failed on this commit, written after the VM was created
# (a document left by an earlier install doesn't count).
wait_for_agent() {
  local deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS)) status commit updated error
  printf '      waiting for %s to install %s and start' "$VM_NAME" "$RELEASE"
  while ((SECONDS < deadline)); do
    status="" commit="" updated=0 error=""
    IFS=$'\x1f' read -r status commit updated error < <(instance_status) || true
    if [[ -n "$commit" ]] && { [[ "$commit" == "$COMMIT" ]] || ((${WAIT_ANY_COMMIT:-0})); } && ((${updated:-0} >= WAIT_SINCE_MS)); then
      case "$status" in
        ready)
          printf '\n'
          if [[ "$commit" == "$COMMIT" ]]; then
            note "the agent is ready on $RELEASE ($COMMIT)"
          else
            note "the agent is ready on $commit, upgraded since install (its metadata still names $COMMIT)"
          fi
          return 0 ;;
        failed)
          printf '\n'
          note "the agent's install failed: ${error:-no reason given}"
          print_log_hint
          exit 1 ;;
      esac
    fi
    printf '.'
    sleep "$WAIT_POLL_SECONDS"
  done
  printf '\n'
  note "the agent has not reported ready after $((WAIT_TIMEOUT_SECONDS / 60)) minutes"
  print_log_hint
  exit 1
}

print_log_hint() {
  note "Read what happened on the VM:"
  note "  gcloud compute ssh $VM_NAME --zone=$VM_ZONE --project=$PROJECT --tunnel-through-iap -- sudo journalctl -u 'paraclete-*' -u google-startup-scripts --no-pager"
  note "The VM tries again at every boot (gcloud compute instances reset $VM_NAME --zone=$VM_ZONE --project=$PROJECT),"
  note "and re-running install/install.sh, with a fixed --ref if the release was at fault, is safe."
}

finish() {
  say ""
  if [[ "$DRY_RUN" == 1 ]]; then
    say "Dry run complete: nothing was changed."
    event done
    return 0
  fi
  say "Done. $AGENT_NAME runs on the VM $VM_NAME in $VM_ZONE."
  if [[ -n "$DASHBOARD_URL" ]]; then
    say "Dashboard: $DASHBOARD_URL (sign in as $INSTALLER_EMAIL; add other people from the dashboard)"
  fi
  say "Watch its logs:"
  say "  gcloud compute ssh $VM_NAME --zone=$VM_ZONE --project=$PROJECT --tunnel-through-iap -- sudo journalctl -u 'paraclete-*' -f"
  event done dashboard "$DASHBOARD_URL" commit "$COMMIT" release "$RELEASE"
}

main() {
  parse_flags "$@"
  use_token_file "$PROJECT"
  trap 'rm -rf "${WORK_DIR:-}" "${GCLOUD_CONFIG_DIR:-}"' EXIT
  read_existing_instance
  ask_questions
  apply_defaults
  step_check
  derive_names
  summarize_and_confirm
  WORK_DIR="$(mktemp -d)"
  step_apis
  step_accounts
  step_firestore
  step_bucket
  step_dashboard
  step_network
  step_vm
  step_wait
  finish
}

main "$@"
