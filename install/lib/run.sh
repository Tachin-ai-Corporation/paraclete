# install/lib/run.sh: how install.sh and uninstall.sh talk and act. Progress lines, notes, warnings and
# fatal errors; `run`, which every side effect goes through, so that it prints the exact command and,
# in a dry run, stops there; and the two kinds of question, a value with a default and a yes or no.
# With --events <path>, each of those lines is also written there as one JSON object per line, for a
# caller such as a web app that shows the run step by step (install/README.md, "Token mode"). Defines
# functions only. Sourced by install/install.sh and install/uninstall.sh, never installed on the VM.

# 1 in a dry run: `run` prints commands and runs nothing. The scripts set it from --dry-run.
DRY_RUN="${DRY_RUN:-0}"
# How many numbered steps the sourcing script has, for the progress lines.
STEP_TOTAL="${STEP_TOTAL:-0}"
# `run_retry`: a just-created service account can take a few seconds to be visible to IAM.
RETRY_ATTEMPTS="${RETRY_ATTEMPTS:-6}"
RETRY_DELAY_SECONDS="${RETRY_DELAY_SECONDS:-10}"
# --events <path>: where the progress events go. Empty: nowhere.
EVENTS_FILE=""

# start_events <path>: progress events from now on go to path, which starts empty.
start_events() {
  EVENTS_FILE="$1"
  : >"$EVENTS_FILE" || die "cannot write the events file $EVENTS_FILE"
}

# json_string <text>: the text as a JSON string. Control characters other than newline, carriage return
# and tab are dropped.
json_string() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  s="${s//[$'\001'-$'\037']/}"
  printf '"%s"' "$s"
}

# event <type> [<key> <value>]...: one progress event, {"t": <UTC time>, "type": <type>, <key>: <value>, ...},
# appended to EVENTS_FILE when there is one. step and total are numbers; every other value is a string.
event() {
  [[ -n "$EVENTS_FILE" ]] || return 0
  local line key value
  line="{\"t\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"type\":$(json_string "$1")"
  shift
  while (($# >= 2)); do
    key="$1"
    value="$2"
    shift 2
    if [[ "$key" == step || "$key" == total ]]; then
      line+=",\"$key\":$value"
    else
      line+=",\"$key\":$(json_string "$value")"
    fi
  done
  printf '%s}\n' "$line" >>"$EVENTS_FILE"
}

# say <text>: a plain line of output.
say() {
  printf '%s\n' "$*"
  event text text "$*"
}

# step <number> <name> <what it does>: the progress line that opens a step, e.g. "[3/9] accounts: ...".
step() {
  printf '\n[%s/%s] %s: %s\n' "$1" "$STEP_TOTAL" "$2" "$3"
  event step step "$1" total "$STEP_TOTAL" name "$2" text "$3"
}

# note <text>: a detail under the current step.
note() {
  printf '      %s\n' "$*"
  event note text "$*"
}

# warn <text>: something the user should know that does not stop the script.
warn() {
  printf 'warning: %s\n' "$*" >&2
  event warning text "$*"
}

# die <text>: stops the script, naming the problem.
die() {
  printf 'error: %s\n' "$*" >&2
  event error text "$*"
  exit 1
}

# shell_quote <arg>...: the arguments as one line a shell would split back into the same words. Words
# made only of safe characters stay bare; anything else is single-quoted.
shell_quote() {
  local words=() arg escaped="'\\''"
  for arg in "$@"; do
    if [[ "$arg" =~ ^[A-Za-z0-9_@%+=:,./-]+$ ]]; then
      words+=("$arg")
    else
      words+=("'${arg//\'/$escaped}'")
    fi
  done
  printf '%s' "${words[*]}"
}

# run <command> [arg]...: prints "+ <command>", then runs it, unless this is a dry run. A failure
# stops the script. The command never reads stdin: it often runs inside a loop that reads its own
# input there, and the user's answers are read only by ask and confirm.
run() {
  printf '+ %s\n' "$(shell_quote "$@")"
  event command text "$(shell_quote "$@")"
  if [[ "$DRY_RUN" == 1 ]]; then
    return 0
  fi
  "$@" </dev/null || die "this command failed: $(shell_quote "$@")"
}

# run_retry <command> [arg]...: run, but tries again a few times before giving up. For grants that
# name an account created moments before.
run_retry() {
  printf '+ %s\n' "$(shell_quote "$@")"
  event command text "$(shell_quote "$@")"
  if [[ "$DRY_RUN" == 1 ]]; then
    return 0
  fi
  local attempt=1
  until "$@" </dev/null; do
    if ((attempt >= RETRY_ATTEMPTS)); then
      die "this command failed $attempt times: $(shell_quote "$@")"
    fi
    warn "that failed; trying again in ${RETRY_DELAY_SECONDS}s (a new service account takes a moment to appear everywhere)"
    sleep "$RETRY_DELAY_SECONDS"
    attempt=$((attempt + 1))
  done
}

# show_file <label> <path>: in a dry run, prints a file the next command reads, so the plan is complete.
show_file() {
  if [[ "$DRY_RUN" != 1 ]]; then
    return 0
  fi
  note "$1:"
  sed 's/^/          /' "$2"
}

# ask <question> <default>: prints the answer, or the default when the answer is empty or there is no
# input. The question goes to stderr, so callers can capture the answer.
ask() {
  local answer=""
  printf '%s [%s]: ' "$1" "$2" >&2
  read -r answer || true
  printf '%s\n' "${answer:-$2}"
}

# confirm <question>: succeeds only when the answer is y or yes.
confirm() {
  local answer=""
  printf '%s [y/N]: ' "$1" >&2
  read -r answer || true
  [[ "$answer" =~ ^([yY]|[yY][eE][sS])$ ]]
}

# require_tools <command>...: stops, naming the first missing command.
require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 \
      || die "$tool is not installed. Run this in Cloud Shell, which has everything it needs."
  done
}
