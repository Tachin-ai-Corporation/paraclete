# install/lib/ref.sh: which repository and which commit an install comes from. Reads the GitHub
# repository from the clone's remote, lists its branches and tags with `git ls-remote`, and turns a
# release tag, a branch or a commit into the full 40-character commit the VM installs. The functions
# that take a listing are pure: they read it from their arguments, never from the network. Defines
# functions only. Sourced by install/install.sh.

# is_commit <text>: succeeds for a full 40-character commit id.
is_commit() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

# repo_from_remote_url <url>: owner/name of a GitHub remote, given in https or ssh form.
repo_from_remote_url() {
  local url="${1%/}"
  if [[ "$url" =~ github\.com[:/]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$ ]]; then
    printf '%s/%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]%.git}"
  else
    return 1
  fi
}

# remote_refs <owner/name>: `git ls-remote` of the repository's default branch, branches and tags.
# Never prompts: a private or missing repository fails instead of asking for a password.
remote_refs() {
  GIT_TERMINAL_PROMPT=0 git ls-remote --symref "https://github.com/$1.git" HEAD 'refs/heads/*' 'refs/tags/*'
}

# ref_commit <listing> <ref>: the commit a ref names, from a remote_refs listing. A full commit id
# passes through. A tag wins over a branch of the same name, as in git itself, and an annotated tag
# resolves to the commit it points at, not to the tag object.
ref_commit() {
  local listing="$1" ref="$2" candidate commit
  if is_commit "$ref"; then
    printf '%s\n' "$ref"
    return 0
  fi
  for candidate in "refs/tags/$ref^{}" "refs/tags/$ref" "refs/heads/$ref" "$ref^{}" "$ref"; do
    commit="$(awk -F'\t' -v ref="$candidate" '$2 == ref { print $1; exit }' <<<"$listing")"
    if is_commit "$commit"; then
      printf '%s\n' "$commit"
      return 0
    fi
  done
  return 1
}

# default_branch <listing>: the branch the repository's HEAD points at.
default_branch() {
  local branch
  branch="$(awk -F'\t' '$2 == "HEAD" && $1 ~ /^ref: refs\/heads\// { sub(/^ref: refs\/heads\//, "", $1); print $1; exit }' <<<"$1")"
  [[ -n "$branch" ]] || return 1
  printf '%s\n' "$branch"
}

# newest_release_tag <listing> <pattern>: the newest tag that is a release version, or nothing. A
# release tag is exactly a match of <pattern> (contracts versioning.canonical_regex); versions compare
# number by number, so v2026.10.17.10.1 is newer than v2026.10.17.9.1.
newest_release_tag() {
  node -e '
const fs = require("node:fs");
const pattern = new RegExp(process.argv[1]);
const tags = new Set();
for (const line of fs.readFileSync(0, "utf8").split("\n")) {
  const ref = (line.split("\t")[1] || "").replace(/\^\{\}$/, "");
  if (!ref.startsWith("refs/tags/")) continue;
  const tag = ref.slice("refs/tags/".length);
  const match = pattern.exec(tag);
  if (match && (match[1] ?? match[0]) === tag) tags.add(tag);
}
const numbers = (tag) => tag.replace(/^\D+/, "").split(/\D+/).map(Number);
const compare = (a, b) => {
  const x = numbers(a), y = numbers(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
const newest = [...tags].sort(compare).pop();
if (newest) console.log(newest);
' "$2" <<<"$1"
}
