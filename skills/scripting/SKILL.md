# Skill: Scripting

## When to use

When a one-liner is not enough: the task has loops, conditions, structured data transforms or several
dependent steps. Write a script, run it, verify what it did.

## How to work

Prefer a written script you can read back over a fragile chain of pipes once the logic gets complex.
Use Python for anything structured (JSON, CSV, API calls, data manipulation) and bash for running
processes and moving files.

Write scripts into your workspace: a relative path in `writeFile`, such as `scripts/report.py`, lands
there, and commands run there. Put a script that belongs to the mission's deliverable in the mission's
working tree instead.

## Procedures

### Write and run a Python script

1. `writeFile scripts/<name>.py` with the whole script: imports, logic, output.
2. Run it: `python3 scripts/<name>.py`.
3. For a package the standard library lacks: `pip install --user --break-system-packages --quiet <package>`
   first (Ubuntu needs the flag). Prefer the standard library.
4. Print structured results, JSON to stdout, so the outcome is machine-readable.

### Write and run a bash script

1. `writeFile scripts/<name>.sh`, starting with `#!/usr/bin/env bash` and `set -euo pipefail`.
2. Run it: `bash scripts/<name>.sh`.
3. Read stdout and stderr.

### Make it safe to run twice

Check before creating, use `mkdir -p`, and guard destructive steps with existence checks. If a script
fails halfway, running it again must not apply anything twice.

### Long-running work

A command is stopped after a couple of minutes. For longer work, start it in the background with its
output in a file (`nohup python3 scripts/<name>.py > scripts/<name>.log 2>&1 &`), then check the log in
later steps. When progress depends on time passing, the cortex can pause the mission and resume it
later. Or break the work into steps that each finish in time.

## Safety

- `set -euo pipefail` in every bash script: fail fast, never silently.
- Read a script that changes state before you run it.
- Never write a secret into a script; read it at run time with `secret-read` (see the secrets skill).

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `ModuleNotFoundError` | A missing package | `pip install --user --break-system-packages <package>` |
| `externally-managed-environment` from pip | Ubuntu's packaging rule | Add `--break-system-packages` |
| The script exits with no output | A swallowed error | Add `set -euo pipefail`; print progress markers |
| Stopped after a couple of minutes | The command time limit | Run it in the background and check its log, or split the work |
