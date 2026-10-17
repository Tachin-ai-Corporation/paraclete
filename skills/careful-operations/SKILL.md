# Skill: Careful Operations

## When to use

Before you act on an unfamiliar or irreversible target (deleting data, editing live state, changing a
cloud resource) when you don't yet know exactly where the thing lives, how far it reaches, or the safe
procedure. "There is no command for that" is a reason to investigate, not to refuse. This skill is the
method; the raw capability comes from the system-shell and scripting skills and the `gcloud` command,
and anything irreversible goes through a dry run first.

## The method

1. **Find the authority; don't guess.** Where a thing lives is defined by the code or tool that writes
   it, not always by documentation, which can be stale. To find a storage path, a setting or a
   resource's real name, read what produces it, and trust that over any description of it.
2. **Probe read-only first.** Confirm the target and its whole footprint with reads that change nothing
   (a query, a `GET`, a listing, a `describe`) before any change. Count what you would touch, and find
   the neighbors you must not touch.
3. **Dry run first.** When a tool offers one (`--dry-run`, a preview, a plan), run it and read the exact
   footprint before applying. When the step is irreversible, the footprint goes to a person for
   approval before you apply it: if the plan has no approval gate before the step, stop and return
   FAILURE saying the step needs approval, with the footprint. A hand-written destructive command with
   no dry run is the last resort, never the first.
4. **Verify by re-deriving, not assuming.** After acting, query the live state again to prove the
   result (the resource is gone, the count is zero, the setting reads back) instead of trusting the
   command's exit code.
5. **Keep the scope tight.** Change exactly what is in scope and leave the rest: outside resources (Drive
   files, DNS records), playbooks or files other work also uses, and anything not explicitly named are
   out of scope. Over-reach is how a capable engineer does damage.

## Error recovery

| Situation | What to do |
|---|---|
| The documented location returns nothing | Don't conclude "nothing there": the documentation may be stale. Read what writes the thing (step 1) |
| A tool refuses, or a guard trips | The guard protects something. Read its message; never force past it without understanding what it protects |
| The blast radius is unclear | Stay read-only, or in dry-run mode, and widen the probe until the footprint is fully known |

## Example

"Delete project X entirely": read how work and artifacts are tied to a project (by `project_id`, and a
repository named after it) → list what would go (the project record, its missions, its repository's
refs and bundles) and count it → show that footprint and get approval → delete → query again to prove
nothing remains, and that other projects are untouched.
