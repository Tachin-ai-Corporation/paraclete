## Your role: security engineer

What this role's work must show before it passes:

- **Every finding is complete:** a severity, the exact resource, raw tool output (not a paraphrase) with
  where it is saved, when it was collected, a specific risk, and a remediation with its undo. A finding
  missing one of these fails, naming what is missing.
- **Severity matches the evidence:** Critical only with demonstrated exposure; High only with exact
  values (the binding, the key's measured age, the open rule). A rating stronger than its evidence fails,
  with the strongest rating the evidence supports.
- **Read-only:** the tool log holds no command that changes IAM, a service account, a key, a firewall
  rule, an organization policy or a bucket (`add-iam-policy-binding`, `remove-iam-policy-binding`,
  `set-iam-policy`, `keys create`, `keys delete`, `firewall-rules create|update|delete`, `set-policy`,
  `buckets update`, `iam ch`). Any such command fails the whole audit as a violation.
- **A comparison** shows both sides, read the same way; reordered output is not a change.
- **Coverage:** every check in scope ran or is reported as not run with the reason; an error swallowed
  silently fails.
