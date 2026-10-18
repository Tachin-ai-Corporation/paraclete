# Skill: Coding

## When to use

When you change code in a real repository and must leave it working: a feature, a fix, wiring something
up, a design turned into code. For a one-off script, use the scripting skill; for judging someone
else's change, the code-review skill. There are no commands of its own: you use the project's own
tools, `git`, and the `work-*` commands.

## Where the code is

| The code is in | You work in | Commits and pushes with |
|---|---|---|
| The mission's project (its artifact repository) | The mission's working tree your instruction names, already on the mission's branch | `work-diff`, `work-commit`, `work-sync` (the git-artifacts skill) |
| An outside repository (GitHub or another host) | Your own clone, on a branch you create (the git-repos skill) | `git`, then a pull request (the pull-requests skill) |

For an outside repository, clone into a directory in your workspace named for the mission, and push your
branch as soon as a step is verified: your workspace does not outlast the mission, the remote does.
Never commit to the default branch, and never force-push one.

## Toolchains on this machine

Node.js 24 with npm, Python 3.11 with pip and venv, git, gcc and make. A project needing another
toolchain (Go, Java, Rust, Ruby, a specific Node or Python version) cannot be built or tested here:
say so at the start, verify what you can (it parses, it lints, its logic reads right), and never write
that tests passed when they did not run.

- **Node:** install with the project's lockfile (`npm ci`; `npm install` only when there is no lockfile),
  then its scripts (`npm run <script>`, read from `package.json`).
- **Python:** give the project its own environment, outside the clone:
  `python3 -m venv <workspace>/venvs/<repo> && <workspace>/venvs/<repo>/bin/pip install -r requirements.txt`
  (or `pip install -e .` for a package), then run everything through that environment's `bin/`. Never
  install a project's requirements into the system's Python.
- A long build or test run goes in the background with its output in a file, and you check the file
  (the scripting skill): a command is stopped after about two minutes.

## The method

1. **Understand the codebase before touching it.** Read what declares the stack and how it runs (the
   manifest, the README, CI configuration such as `.github/workflows/`, a `Makefile`). Note the project's
   own build, test, lint and run commands: you use those, never your own. Map the code near your change:
   the entry point, the files involved, and how existing code does something similar. You will match it.
2. **Take a baseline.** Run the tests before you change anything, and keep the result. A test that
   already fails is not yours to fix, and not yours to blame on your change.
3. **Find the real file.** Locate what to change by reading and searching (`rg`), and confirm which file
   is actually used: in a noisy repository, generated output, vendored code and stray copies look like
   source. Edit that file in place. Never create a parallel copy (`index-new.html`, `app2.js`) or a
   directory a guessed path implied.
4. **For a bug, reproduce it first.** Write a test that fails the way the bug does, watch it fail, then
   fix the code until it passes. That test stays, so the bug cannot return unnoticed.
5. **Make the smallest change that fully does the job,** in the style around it: its names, its
   patterns, its libraries. Wire it end to end: a feature is done when the data flows, the handler runs
   and the result shows, not when a stub exists. No drive-by refactors, renames or reformatting of
   lines you were not asked to touch; note what else you found for the person instead.
6. **Prove it.** Run the build, the linters and type checks the project configures, and the whole test
   suite; then run the thing itself (start the server on a free port and request the page, run the
   command, import and call the function). Read every error, fix the cause, run again until clean.
   Compare the test results with the baseline: no test that passed before may fail now.
7. **Review your own diff** (`git diff`, or `work-diff` in a mission tree). It must show your change in
   the files you meant, and nothing else: no debug prints, no commented-out code, no stray hunk, no
   reformatted lines, no secret, no scratch file. If the file you meant to change is not in the diff,
   you have not made the change: find the real file and make it there.
8. **Commit** with the repository's own message convention (`git log --oneline -10` shows it), staging
   files by name. Then sync or push.
9. **Report** what changed and why, the commands you ran to prove it with their results (test counts,
   before and after), and the commit.

### A web page

Reading the source back does not prove an HTML or CSS edit: an unclosed `<style>` or a broken inline
script leaves the source looking fine and the page blank. After the edit:

1. Check the structure: as many `<style>` as `</style>`, as many `<script>` as `</script>`, and `<head>`,
   `</head>`, `<body>`, `</body>` present and in order.
2. Render it and look: `file-convert <page>.html png --out <mission tree>/missions/<mission id>/renders`
   (the files skill), then open the PNG with the viewImage tool. For a page that needs its server,
   serve the directory on a free port (`python3 -m http.server 0` prints the port it took), render the
   URL with `chromium --headless=new --no-sandbox --disable-gpu --window-size=1280,1600 --screenshot=<png> <url>`,
   then stop the server.
3. Your change shows, and no other part of the page went blank or shows stray characters.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `command not found` for a build or test step | You guessed the command | Read the project's scripts and use its real command |
| Missing modules or imports | Dependencies not installed in this checkout | Install them with the project's own manager and lockfile, in its own environment |
| A test fails after your change | Your change broke something, or the test encodes the old behavior on purpose | Fix the code. Change a test only when the requirement changed, and say so; never delete or skip one to get green |
| The same test passes and fails between runs | A flaky test | Run it a few times; report it as flaky rather than counting it as your failure or your pass |
| `Address already in use` | A fixed port is taken | Bind port 0 and read the port chosen; stop your server when done |
| The diff is far larger than the change | A formatter or an editor rewrote other lines | Reduce the diff to the change; run only the formatter the project uses |
| Stray `\'` in a file, or a page blank below some point | An edit through inline `sed` escaped quotes into the file | Restore the file from git and redo the edit by writing it (the system-shell skill) |

## Safety

- Never write a secret, key or token into code, a test, a commit or a log; read one at run time from
  Secret Manager (the secrets skill).
- Change source, never generated output or vendored dependencies.
- Keep helper scripts outside the repository, so they can never be committed.
- Never commit a red tree, never commit to a default branch, and never rewrite published history.
