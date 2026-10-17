# Skill: Git Repositories

## When to use

When you work in a git repository hosted outside the agent's artifact store (on a public or company git
host): cloning it, branching, committing, running its checks, and resolving conflicts. For a project's
own artifact repository and mission trees, use the git-artifacts skill instead.

There are no commands of its own: you use `git` directly.

## Procedures

### Clone a repository

- Public: `git clone https://<host>/<owner>/<repo>.git <dir>`
- Private, with a token stored in Secret Manager, without writing the token anywhere:

  ```bash
  git -c credential.helper='!f() { echo username=x-access-token; echo "password=$(secret-read --name <secret-id>)"; }; f' \
    clone https://<host>/<owner>/<repo>.git <dir>
  ```

  Repeat the same `-c credential.helper=...` on every later `fetch`, `pull` or `push`. Never put the
  token in the URL: it would be saved in `.git/config`. Most hosts accept any username with a token;
  some name a fixed one (`oauth2` on some hosts), so check the host's documentation if it is refused.

Clone into your workspace, or into the mission's working tree when the repository's files are part of
the deliverable.

### Branch and stay current

1. Start from the latest default branch: `git checkout main && git fetch origin && git rebase origin/main`
   (use the repository's default branch name).
2. Create a branch for your change: `git checkout -b feat/<short-description>` (or `fix/...`).
3. Sync with the default branch as you go: `git fetch origin && git rebase origin/main`.
4. Verify: `git branch` shows you on your branch, up to date.

### Check, then commit

Run the repository's own checks, in order, before every commit; if one fails, fix it and start over:

1. **Format:** the project's formatter (for example `prettier`, `black`, `gofmt`).
2. **Lint:** the project's linter (for example `eslint`, `ruff`, `golangci-lint`), applying safe fixes.
3. **Type check**, if the project has one (for example `tsc --noEmit`, `mypy`).
4. **Test:** the project's test suite (for example `npm test`, `pytest`, `go test ./...`).

Then stage your files by name (`git add <file1> <file2>`) and commit. Follow the repository's own commit
message convention (read `git log --oneline -10`); with none, use conventional commits,
`<type>(<scope>): <subject>`, where the type is `feat`, `fix`, `docs`, `style`, `refactor`, `test`,
`chore` or `perf`. Verify with `git log -1`.

### Resolve a merge or rebase conflict

1. List the conflicted files: `git diff --name-only --diff-filter=U`.
2. Edit each one to resolve the `<<<<<<<`, `=======`, `>>>>>>>` markers.
3. Stage the resolved files: `git add <file>`.
4. Continue: `git rebase --continue` (or `git commit` for a merge).
5. Verify that no conflict markers remain (`git diff --check`) and the operation finished.

## Reference

| What | Command |
|---|---|
| List branches, newest first | `git branch -a --sort=-committerdate` |
| Switch branch | `git checkout <branch>` |
| Update from the default branch | `git fetch origin && git rebase origin/main` |
| Delete a local branch | `git branch -d <branch>` |
| See what you are about to push | `git log --oneline origin/<branch>..HEAD` |

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| A rebase stops with conflicts | Your branch and the target changed the same lines | Resolve as above, then `git rebase --continue` |
| A push is rejected as non-fast-forward | The remote branch has newer commits | `git fetch origin`, rebase onto it, then push again |
| You committed on the default branch by mistake | No feature branch was created | `git branch <new-branch>`, `git reset --hard origin/main`, `git checkout <new-branch>` |
| Authentication fails | Wrong token, or the wrong username for the host | Check the secret's id with the person who stored it; try the host's documented username |

## Safety

- Never force-push to `main`, `master` or a shared branch.
- Fetch before you rebase: work against the latest remote state.
- Run the checks before you push.
- Use `--dry-run` with destructive git operations when available.
- List before you delete a branch; check its name twice.
- Never print a token, and never store one in a file or a remote URL.
