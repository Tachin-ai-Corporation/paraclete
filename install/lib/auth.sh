# install/lib/auth.sh: whose credentials install.sh and uninstall.sh act with. By default, gcloud's own
# login: the owner who runs them in Cloud Shell. With --access-token-file, an OAuth access token
# instead (token mode): a caller such as a web app that holds an admin's short-lived token runs the
# scripts with no gcloud login and no prompt. In token mode the caller names the token's account with
# --account and the project with --project, since there is no login to ask.
#
# The token reaches gcloud through its access_token_file property, and a configuration directory of
# the run's own, empty, so no login that happens to be on the machine is ever used. The scripts' own
# REST calls read the token through access_token. It is never printed: commands carry it only in
# header files (mode 600, in the run's temporary directory). Defines functions only. Sourced by
# install/install.sh and install/uninstall.sh. Needs run.sh.

# --access-token-file and --account. Empty: gcloud's login.
TOKEN_FILE=""
TOKEN_ACCOUNT=""

# auth_flag <flag> <value>: takes --access-token-file or --account; fails for any other flag.
auth_flag() {
  case "$1" in
    --access-token-file) TOKEN_FILE="$2" ;;
    --account) TOKEN_ACCOUNT="$2" ;;
    *) return 1 ;;
  esac
}

# use_token_file <project>: in token mode, checks what it needs and points gcloud at the token and at an
# empty configuration of its own. Called once the flags are read, before any gcloud command.
use_token_file() {
  if [[ -z "$TOKEN_FILE" ]]; then
    [[ -z "$TOKEN_ACCOUNT" ]] || die "--account is for token mode: pass --access-token-file too"
    return 0
  fi
  [[ -s "$TOKEN_FILE" ]] || die "--access-token-file $TOKEN_FILE is missing or empty"
  [[ -n "$TOKEN_ACCOUNT" ]] || die "--access-token-file needs --account <the email the token belongs to>"
  [[ -n "$1" ]] || die "--access-token-file needs --project <id>: there is no gcloud configuration to read it from"
  GCLOUD_CONFIG_DIR="$(mktemp -d)"
  export CLOUDSDK_CONFIG="$GCLOUD_CONFIG_DIR"
  export CLOUDSDK_AUTH_ACCESS_TOKEN_FILE="$TOKEN_FILE"
}

# active_account: the account the run acts as. Empty when gcloud is not logged in.
active_account() {
  if [[ -n "$TOKEN_FILE" ]]; then
    printf '%s\n' "$TOKEN_ACCOUNT"
    return 0
  fi
  gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true
}

# access_token: the token for a REST call, on stdout. Fails when there is none.
access_token() {
  if [[ -n "$TOKEN_FILE" ]]; then
    head -n 1 "$TOKEN_FILE" | tr -d '\r\n'
    return 0
  fi
  gcloud auth print-access-token 2>/dev/null
}
