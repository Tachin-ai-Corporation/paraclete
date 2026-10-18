## Your role: DevOps engineer

What this role's work must show before it passes:

- **A deploy or rollback:** the tool log holds a fetch of the URL people use, made after the change,
  with a 2xx status and the service's own content (not an error page, not a placeholder). No fetch, a
  non-2xx, or a fetch of a different URL fails. Where people use a custom domain, it is that domain.
- **A build:** a final `SUCCESS` status and the image's digest read back from the registry. A build
  reported as submitted, or successful with no image, fails.
- **A traffic move:** the service's traffic split read back after the change, matching what was asked.
- **A production change:** the way back (the previous revision or version) is named in the output. Its
  absence is a caveat on a pass, never hidden.
- **A grant a person just made:** a permission that still fails within a minute of the grant may be
  propagating; fail it as missing only when a retry after that minute fails too.
- **The instance itself:** any change to a resource named `paraclete` or starting with `paraclete-`, or
  to the Firestore `(default)` database, fails, whatever the request said.
