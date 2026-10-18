# Skill: System Shell

## When to use

When a task needs general command-line work and no other skill covers it: navigating the filesystem,
processing text and JSON, reading logs, checking processes and services, chaining standard tools. This
is your general problem-solving surface. When a dedicated skill exists for the work, use that skill.

## How to work

You have a real shell, through the `runCommand` tool. Use it the way a capable engineer would: compose
small tools, inspect before acting, verify after. You are not limited to a fixed menu: if a standard
tool solves the problem, use it. Prefer clear, reversible steps, and check the state before a
destructive change.

Commands run in your workspace directory, which is also where a relative path in `readFile`,
`writeFile`, `listDir` and `viewImage` points (`viewImage` shows you a PNG, JPEG or WebP image). Each command has a time limit of a couple of minutes, and its output
is cut to a bounded size, with a notice when it was cut.

## Tools on the machine

The Ubuntu userland, including:

| Kind | Tools |
|---|---|
| Files | `ls`, `find`, `tree`, `stat`, `du`, `df`, `readlink`, `realpath`, `cat`, `head`, `tail`, `wc`, `file` |
| Text and data | `grep`, `rg` (ripgrep), `sed`, `awk`, `cut`, `sort`, `uniq`, `tr`, `column`, `jq`, `python3`, `diff`, `patch`, `comm` |
| Processes and network | `ps`, `top -bn1`, `pgrep`, `systemctl status <unit>`, `journalctl -u <unit> --no-pager -n <N>`, `ss`, `curl`, `wget` |
| Archives and transfer | `tar`, `gzip`, `zip`, `unzip`, `rsync` |
| Scripting | `bash`, `python3`, `node` (see the scripting skill) |

## Procedures

### Inspect before acting

1. Understand the current state first: `ls -la`, read the relevant file, check a service's status or
   its log.
2. Form a hypothesis about what needs to change.
3. Make the change in the smallest reversible step.
4. Verify that it had the intended effect.

### Process structured data

For JSON, `jq '.field' file.json` for simple extraction, and `python3` for transforms, validation or
anything with several steps. For CSV and tables, Python's `csv` module, or `awk` and `cut` for simple
column work.

### Pass free text safely

When an argument holds free text with apostrophes, quotes, newlines or `$`, do not inline it in the
command. Put the text in the runCommand tool's `stdin` field and use the command's `--stdin` flag, or
write it to a file with `writeFile` and pass the path. Text inlined in single quotes breaks the
shell's quoting.

### Edit a file surgically

Changing text in an existing file (HTML, CSS, code, configuration) is a surgical edit: change the
smallest unique span and leave the rest byte for byte. How you make the edit decides whether you
quietly corrupt the file.

- **Match the smallest unique token, never a whole block.** To retitle one heading, target just that
  text: `sed -i 's/>Proof</>The proof</' index.html`. Don't build a multi-line `sed` pattern from a
  chunk of the surrounding markup: basic `sed` cannot match across lines, so it fails and you retry
  blind.
- **The quote trap silently corrupts files.** A `sed 's/.../.../'` program sits inside single quotes in
  the shell. If the text you match or insert holds an apostrophe or a quote (`client's`, `class="x"`, a
  script using `'.reveal'`), the escaping turns each `'` into `\'` and writes the backslashes into the
  file. One heading edit can mangle dozens of quotes and break inline scripts, so the page renders
  blank below the first broken one. If the span holds any quote, don't use inline `sed`.
- **Beyond a tiny token with no quotes, write the file instead.** Read it, compute the new content and
  write it literally with `writeFile`, or run a small Python replace
  (`s=open(p).read().replace(OLD, NEW, 1); open(p, 'w').write(s)`), which never shell-escapes anything.
- **Prove you didn't corrupt it.** After the edit, the diff (`git diff --stat`, or `work-diff --stat` in
  a mission tree) must show about the lines you meant, and `grep -nF "\\'" <file>` must print nothing.
  A stray `\'` means you hit the quote trap: restore the file and redo the edit by writing it.

## Safety

- Inspect before destructive operations. Before `rm -rf`, a mass `mv` or a permission change, state
  what you are about to do and what it touches.
- Never print, log or write a secret's value (see the secrets skill).
- Read stderr as well as stdout: a failure's reason is usually there.
- Installed code, prompts and skills are read-only; you cannot change them, and you should not try.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `command not found` | The tool is not installed | Check with `which <tool>`; use an installed alternative (`rg` → `grep`, `tree` → `find`) |
| `permission denied` | File permissions | `ls -la` the target. The agent runs as an unprivileged user and cannot write installed files; work in your workspace or a mission tree |
| The command times out | It waited for input, or ran long | Add non-interactive flags, narrow the work, or run it in the background and poll (scripting skill) |
| Empty output | A wrong path or filter | Check the path exists and the filter matches; widen, then narrow |
| A one-line edit made a huge diff, left stray `\'` or `\"`, or blanked a page | Quotes in an inline `sed` were escaped into the file | Restore the file, redo the edit by writing it, then check the diff and `grep -nF "\\'" <file>` |
