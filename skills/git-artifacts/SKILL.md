# Skill: Git Artifacts

## When to use

When you work in a mission's working tree, or with a project's artifact repository: checking status,
diffs and history, committing and syncing your work, reading another project's repository, or running
repository upkeep.

## How the artifact store works

Every project has one git repository in the agent's artifact store. The repository's history is kept
as git bundles in the instance's Cloud Storage bucket, and each branch's ref (its latest commit and the
bundles that hold it) is kept in Firestore, updated by compare-and-swap so two writers can never
overwrite each other. The repository id is the project id.

- **Branches:** `main`, and one `mission/<missionId>` branch per mission.
- **Mission trees:** when a mission belongs to a project, the brain clones the project's repository
  into the mission's working tree (under `missions/` in the agent's data directory) and checks out the
  mission's branch. Your instruction names that directory. The brain commits and syncs it at every
  checkpoint, and merges the mission branch into `main` when the mission completes, following the
  project's merge policy (`auto`, or `gated` behind a person's approval).

**Never clone the mission's own project, and never switch branches.** The tree is already cloned and on
the right branch. Don't check out `main`, don't create another branch, and don't try to merge your work
into `main`: reaching `main` is the brain's step at completion, and pushing `main` from a working tree
is refused. Your job is to edit, commit and sync on the branch you are on. A task that says "create a
branch from main" or "push to main" is over-specified: ignore the git mechanics and edit, commit, sync.

## Commands

The `work-*` commands take `--dir <path>` and otherwise act on the current directory. Run them in the
mission's working tree.

### Read

- `work-status [--dir <path>]` prints JSON: `branch`, `clean`, and the `staged`, `modified` and
  `untracked` files (up to 50 each).
- `work-diff [--dir <path>] [--staged] [--stat] [--file <path>]` prints the diff of uncommitted
  changes: `--staged` for staged ones, `--stat` for a summary of files and line counts, `--file` for one
  file.
- `work-log [--dir <path>] [--count <n>] [--oneline]` prints the commit history, newest first (default
  10): full hash, date and subject, or one line each with `--oneline`.

### Write

- `work-commit "<message>" [--dir <path>] [--add-all]` commits the staged changes, or every change with
  `--add-all`. Prints JSON: `sha`, `message`, `filesChanged`. Refuses when nothing is staged.
- `work-sync <repoId> [--branch <branch>] [--dir <path>] [--actor <id>]` pushes local commits to the
  artifact store, fetching and rebasing automatically when the branch moved. The branch defaults to the
  one checked out; `--actor`, the name recorded on the branch's ref, defaults to the agent's own. Prints
  JSON: `status` (`pushed`, `up_to_date` or `failed`), `sha`, `attempts`. Refuses to push `main`.
- `work-clone <repoId> [--ref <branch>] [--dir <path>]` clones a repository from the store, for reading
  another project's artifacts. The branch defaults to `main`; the directory defaults to `<repoId>`
  under the current directory. Prints JSON: `repoId`, `branch`, `sha`, `dir`.

### Repository upkeep and inspection

- `git-store gc <repoId> [branch]` consolidates a branch's chain of bundles into one (branch default
  `main`). Prints JSON with the branch's `sha` and its `bundle_keys` afterwards. A repository with
  nothing to consolidate, or none at all, comes back unchanged (`sha` null for no repository).
- `git-store read-ref <repoId> [branch]` prints a branch's ref: `sha` and `bundle_keys`.
- `git-store list-refs <repoId>` prints every branch of a repository.
- `git-store manifest <repoId> [branch] [paths...]` prints the files on a branch's tip (all of them, or
  the paths named), each with its blob hash and size.

`git-store` logs to stderr with a `[git-store]` prefix, prints JSON on stdout, and exits 1 on error.

## Procedures

### Commit your work

1. Make your changes in the working tree. For changes to existing text files, follow the system-shell
   skill's surgical-edit method.
2. **Check that the diff is only your change:** `work-diff --stat`. It must list just the files you
   meant, with line counts proportionate to the change (a one-word edit is a one- or two-line diff, not
   the whole file). If it lists unrelated or scratch files, do not use `--add-all`: stage your own files
   with `git add <path>` and commit those.
3. Check that the edit did not mangle quotes: `grep -nF "\\'" <file>` must print nothing (`-F` makes
   it a plain-text search). A stray `\'` means shell escaping wrote backslashes into the file: restore
   the file (`git checkout -- <file>`) and redo the edit by writing the file directly.
4. `work-commit "<what changed>"`, with `--add-all` only when step 2 showed every pending change is
   yours. Write the message as one line saying what changed.
5. `work-sync <repoId>` to push the mission branch to the store.
6. Verify: `work-status` shows a clean tree on `mission/<missionId>`. Include the `work-diff --stat`
   and `work-log --count 3 --oneline` output in your result: the cerebellum judges the diff, not your
   description of it.

### Edit the tracked file, not a copy

The file to change is the one git tracks inside the working tree. If `work-diff --stat` shows nothing
after your edit, you edited a file outside the tree (a scratch copy at another path): the change is
invisible to the repository and will never reach the project. Find the tracked file (`work-status`,
`git ls-files`), edit that one, and confirm `work-diff` now shows your change.

### Inspect what changed

1. `work-status` lists modified, staged and untracked files.
2. `work-diff` shows the changes (`--staged` for staged ones, `--stat` for a summary).
3. `work-log --count 5` shows the last five commits.

### Read another project's files

`work-clone <repoId> --dir <scratch-dir>` into your workspace, read what you need, and leave the clone
there: your workspace is cleared between missions. Never commit into a clone of another project's
repository from within a mission.

### Clean up the artifact store (the weekly responsibility)

1. `project-manage list` gives every project id: each is a repository id.
2. For each project, `git-store gc <projectId> main`.
3. Report the repositories processed and, for each, the bundle count before (from `git-store read-ref`)
   and after.

## Error recovery

| Symptom | Cause | What to do |
|---|---|---|
| `work-sync` returns `failed` | A rebase conflict after the branch moved | Resolve the conflict in the tree (`git status`, edit, `git add`, `git rebase --continue`), then commit and sync again |
| `work-clone` returns a null `sha` | The repository has no commits yet | Normal for a new project: proceed to the first commit |
| `work-commit` refuses: nothing staged | Nothing was added | Stage your files with `git add <path>`, or use `--add-all` after checking `work-diff --stat` |
| `work-commit` refuses: not inside a git repository | You ran it outside the working tree | Run it in the mission's working tree, or pass `--dir` |
| `work-sync` refuses to push `main` | You are on `main` | Work reaches `main` only through the merge at mission completion. Commit on the mission branch |
| A one-line edit shows a whole-file diff, stray `\'` or `\"`, or a page that renders blank below its first section | Quotes in an inline `sed` were escaped into the file | Restore the file and redo the edit by writing the file directly (system-shell skill), then check the diff again |

## Rules

1. Never commit to `main` directly; work on the mission branch.
2. Commit each meaningful step, and sync after committing, so the work survives a restart.
3. Use these commands rather than raw git for anything that touches the store; never edit `.git`
   internals.
