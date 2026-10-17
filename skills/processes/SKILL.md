# Skill: Process Playbooks

## When to use

When you capture, read, update, discuss or retire a process playbook: a remembered name, one-line
description and narrative of how a kind of work is done well. Use it when:

- a mission went well and its pattern is worth keeping ("this is how we do X");
- someone asks what processes you have: list them, and tell them about any one;
- someone tells you how something should be done ("for releases, always ..."): fold it into the
  playbook;
- you want to see how a kind of work was done before, to inform your own plan.

A process is **not** a list of steps you execute. It is guidance that you recall into your own
checkpoint plan and adapt. Playbooks come from two places: the ones installed with your role, and the
ones you wrote, which are stored in Firestore. A playbook you write with the same id as an installed
one takes its place.

## Commands

- `process-ops list` lists every active playbook, installed and your own: id, name, whether it has a
  narrative, description.
- `process-ops get <id>` prints one playbook in full, narrative included, installed or your own. The
  argument is the id itself.
- `process-ops write <id> --name "<name>" --description "<one line>" --narrative "<prose>" [--tags a,b] [--project <projectId>]`
  creates or updates a playbook. It changes only the fields you pass, and records who changed it and
  when.
- `process-ops write <id> --name "<name>" --description "<one line>" --stdin` takes the narrative from
  stdin. Use it, through the runCommand tool's `stdin` field, whenever the narrative holds apostrophes,
  quotes or newlines.
- `process-ops retire <id>` marks a playbook you wrote as deprecated, so it is no longer recalled. It
  refuses an installed playbook you have not written over: installed playbooks change only with a
  release. Retiring your own version of an installed playbook brings the installed one back. To change
  how an installed playbook reads for you, write your own version with its id; your first write starts
  from the installed fields.

Ids are lowercase with dashes, by convention starting `p-` (`p-investigate`).

## A good playbook

- **name:** a short handle, such as `Investigation` or `Plan and Build`.
- **description:** one line: what kind of work this is, and when it applies.
- **narrative:** prose: the shape that works, the order, what to watch for, what not to do. No tool
  syntax (that lives in skills) and no rigid list of steps: the reader adapts it to their own
  checkpoints.
- Keep it lean and honest. Capture what actually worked, refine rather than pile on, and retire what is
  stale.

## Procedures

### Capture a pattern that worked

After work that went well:
`process-ops write <id> --name "<name>" --description "<one line>" --stdin`, with the narrative on stdin.
Verify with `process-ops get <id>`.

### Discuss what you have

`process-ops list`, then `process-ops get <id>` to read any one and explain it.

### Take feedback

When someone says how something should be done: `process-ops get <id>` for the relevant playbook, fold
the feedback into a tighter narrative, and `process-ops write <id> ... --stdin` it back. Verify with
`process-ops get <id>`.

## Error recovery

| Symptom | Cause | What to do |
|---|---|---|
| `write failed` | A malformed field or a bad id | Check that the id is lowercase with dashes and the narrative is not empty, then retry |
| The narrative came out mangled, with stray `\'` | A narrative with quotes passed as a shell argument | Use `--stdin` and pass the narrative through the tool's `stdin` field |
| `get` reports no such playbook | A wrong id | `process-ops list` shows the ids |

## Safety

- Every mission recalls from these playbooks: refine and deduplicate, don't overwrite carelessly, and
  retire a stale playbook rather than leave it to mislead.
- A playbook holds no secrets and no tool syntax: it is a narrative of how work is done well.
