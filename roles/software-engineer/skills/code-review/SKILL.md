# Skill: Code Review

## When to use

When someone asks you to review a change: a pull request, a branch, a commit range or a patch. The
generic `p-review` playbook is the shape of the work; this skill is how to do it on code. A review is
read-only: you may check out and run the change, but you never edit it, push to it or merge it. A fix
you would make is a finding, written so its author can make it. There are no commands of its own: you
use `git`, the project's own tools, and `gh` for a pull request (the pull-requests skill).

## Get the change

- A pull request: `gh pr view <number> --repo <owner>/<repo> --json title,body,author,baseRefName,headRefName,files,additions,deletions`
  and `gh pr diff <number> --repo <owner>/<repo>` (the pull-requests skill gives the token form). To run
  it, clone the repository (the git-repos skill) and `git fetch origin pull/<number>/head:pr-<number> && git checkout pr-<number>`.
- A branch: `git fetch origin && git diff origin/<base>...origin/<branch>`. The three dots compare with
  the point the branch left its base, so only the branch's own changes show.

| See | Command |
|---|---|
| Files and line counts | `git diff --stat origin/<base>...HEAD` |
| Changed files with their status | `git diff --name-status origin/<base>...HEAD` |
| One file | `git diff origin/<base>...HEAD -- <path>` |
| Ignoring whitespace | add `-w` |
| The commits | `git log --oneline origin/<base>..HEAD` |

## The method

1. **Understand the intent** from the description, the linked issue and the commits, before judging a
   line. A change is reviewed against what it set out to do.
2. **Read the whole diff,** then the code around it: the callers of what changed, and how the codebase
   already does the same kind of thing.
3. **Run it.** Install, build, lint and run the tests the project configures, on the change. Report the
   counts. A suite that does not run here is said so, not assumed green.
4. **Judge, in this order:**
   - **Correct:** does it do what it claims? Edge cases (empty, none, many, wrong type, concurrent),
     error handling, off-by-one, time zones, resource cleanup.
   - **Safe:** no secret in the code or history (`git log -p origin/<base>..HEAD | rg -i 'BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key|secret|password|token'`
     and read each hit); input from outside is validated; no injection (SQL, shell, HTML); new
     dependencies are maintained and free of known problems (`npm audit --omit=dev`, or the project's
     own audit).
   - **Tested:** the new behavior has a test that would fail without it, and a fixed bug has its
     regression test. Tests skipped or deleted in the change are findings.
   - **Consistent:** names, structure and patterns match the codebase; no debug output, no commented-out
     code, no unrelated reformatting.
5. **Write the verdict.**

## The verdict

Lead with one of: **approve**, **approve with small fixes**, or **request changes**, and why in one
sentence. Then the findings, most serious first, each with:

- where: `path:line`;
- what is wrong, and the evidence (the input that breaks it, the test that fails, the line that leaks);
- what would fix it;
- its weight: **blocker** (must change before merging: wrong, unsafe, or untested behavior),
  **should fix**, or **nit** (style; never blocks).

Close with what you ran (commands and results) and what you could not check. Praise what is done well
in a line, when it is true; it tells the author what to keep.

Post it on a pull request only when the person asked you to (the pull-requests skill); otherwise it
is your answer.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| The diff shows changes the author did not make | Two dots against a base that moved | Use three dots (`<base>...<branch>`), after `git fetch origin` |
| `couldn't find remote ref pull/<n>/head` | The host is not GitHub, or the number is wrong | Fetch the branch by name instead |
| The tests fail on the base branch too | A failure that predates the change | Say so; judge the change by what it changes |

## Safety

- Never edit, push to, approve on the host, or merge a change you review unless the person asked for
  exactly that.
- A secret found in a change is reported to the person at once, without repeating its value: the
  secret must be rotated, since removing the line does not remove it from history.
