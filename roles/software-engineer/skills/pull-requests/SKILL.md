# Skill: Pull Requests

## When to use

When a change to an outside repository goes back to its owners as a pull request: opening one,
following its checks and reviews, answering review comments, posting a review someone asked you for,
and merging when a person asked you to. The commits themselves are the coding skill's; cloning,
branching and pushing are the git-repos skill's. There are no commands of its own: you run `gh`, the
GitHub CLI, and `secret-read`.

## Access: a token from Secret Manager

`gh` never logs in here. It takes a token from the `GH_TOKEN` variable, which you set for one command
at a time from Secret Manager (the secrets skill), so the token is never written anywhere:

```bash
GH_TOKEN="$(secret-read --name <secret-id>)" GH_PROMPT_DISABLED=1 gh <command> --repo <owner>/<repo> ...
```

Every command below is run that way; the examples leave out the prefix. Always pass `--repo
<owner>/<repo>`, so `gh` never guesses the repository from a directory.

- **The token** is one a person created on GitHub and a dashboard admin stored in Secret Manager and
  granted to you. Ask for its secret id when you do not have it. It needs, on the repositories you work
  on: read and write for contents and for pull requests, and read for checks, commit statuses and
  actions (a fine-grained token), or the `repo` scope (a classic one).
- **Check it before you start:** `gh api repos/<owner>/<repo> --jq .permissions` shows `"push": true`
  when you can push branches and open pull requests.
- **GitHub Enterprise Server:** set `GH_HOST=<host>` and pass the token as `GH_ENTERPRISE_TOKEN` instead.
- **Other hosts** (GitLab, Bitbucket and the rest): `gh` does not work there. Push the branch (the
  git-repos skill) and give the person the host's link to open the request, or use that host's REST API
  with `curl` and the token, the same way.

This machine has `gh` 2.23 from Debian. Use only the flags shown here, and check `gh <command> --help`
before any other: newer flags from GitHub's documentation may not exist in it.

## Procedures

### Open a pull request

1. Commit on your own branch and push it (the coding and git-repos skills). Never open a pull request
   from a default branch.
2. Write the description to a file in your workspace: what changed and why; how it was tested (the
   commands and their results, test counts before and after); risks, and how to undo it; the issue it
   closes, if any (`Closes #<n>`). Use the repository's template when it has one
   (`.github/pull_request_template.md`).
3. Open it:
   `gh pr create --repo <owner>/<repo> --base <base branch> --head <your branch> --title "<title>" --body-file <file>`.
   Add `--draft` when the person wants to look before others are asked to review. It prints the pull
   request's URL.
4. Verify: `gh pr view <number> --repo <owner>/<repo> --json number,url,state,isDraft,headRefName,baseRefName`.
   Report the URL.

### Follow its checks and reviews

- Overall: `gh pr view <number> --repo <owner>/<repo> --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,url`.
- Checks: `gh pr checks <number> --repo <owner>/<repo>` prints each check with its state. It exits 0 only
  when every check passed; non-zero when one failed or is still running, so read the table, and check
  again in a minute while any is pending. Don't use `--watch`: it outlasts a command.
- A failed check's details: the link in the table; for GitHub Actions,
  `gh run list --repo <owner>/<repo> --branch <your branch> --limit 5`, then
  `gh run view <run-id> --repo <owner>/<repo> --log-failed`.

### Answer review comments

1. Read them all: the reviews with `gh pr view <number> --repo <owner>/<repo> --json reviews,comments`, and
   the comments on lines with
   `gh api repos/<owner>/<repo>/pulls/<number>/comments --paginate --jq '.[] | {id, path, line, user: .user.login, body}'`.
2. Change the code on the same branch for each comment you agree with, verified as the coding skill
   says, and push. Never force-push a branch others have reviewed unless asked: new commits keep the
   review readable.
3. Reply once, with what changed for each comment and why for any you did not change:
   `gh pr comment <number> --repo <owner>/<repo> --body-file <file>`.

### Post a review someone asked for

Do the review with the code-review skill, then post its verdict:
`gh pr review <number> --repo <owner>/<repo> --comment --body-file <file>`, or `--request-changes`.
Use `--approve` only when the person asked you to approve, and the review found no blocker.

### Merge, only when asked

Merge only when a person asked for it in this mission, every required check passed, and the review
decision is not `CHANGES_REQUESTED`. Pin the merge to the commit you verified:

```bash
gh pr merge <number> --repo <owner>/<repo> --squash --match-head-commit <sha>
```

(`--merge` or `--rebase` when the repository uses those; `--delete-branch` removes your branch after.)
Never pass `--admin`. Read the result back with `gh pr view <number> --repo <owner>/<repo> --json state,mergedAt,mergeCommit`.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `HTTP 401` or `Bad credentials` | The secret holds no valid token, or it expired | Check the secret id; ask the person who stored it for a new token |
| `HTTP 403`, or `Resource not accessible by personal access token` | The token lacks a permission or a repository | Name the permission from the list above and ask for it |
| `HTTP 404` on a private repository | The token cannot see it | The same: the token needs that repository |
| `pull request create failed: ... No commits between` | The branch was not pushed, or holds nothing new | Push it; compare with `git log --oneline origin/<base>..HEAD` |
| `unknown flag` | A flag newer than gh 2.23 | `gh <command> --help`, or the REST API through `gh api` |
| `Pull request is not mergeable` | Conflicts, failing checks or a missing review | Read `mergeStateStatus`; rebase and push, or report what blocks it |

## Safety

- The token is set only for the one command that needs it. Never echo it, write it to a file or a git
  remote, or pass it to `gh auth login`.
- Never push to or merge into a default branch except through a merge a person asked for, and never
  with `--admin`.
- A pull request is a request: what happens to it after is its owners' decision.
