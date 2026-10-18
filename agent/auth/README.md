# agent/auth/

Access tokens, and nothing else.

**Belongs here:** tokens from the VM's metadata server for the agent's service account, and, on
Workspace roles, tokens for the agent's own Google account through domain-wide delegation.
**Doesn't:** keys. No service-account key is ever created, stored or read.

This package imports nothing else from `agent/`.

## Files

| File | Does |
|---|---|
| `metadata-token.mjs` | Tokens for the VM's service account, from the metadata server |
| `dwd-token.mjs` | Tokens for the agent's Workspace account, through domain-wide delegation |
| `workspace-scopes.mjs` | The scopes those tokens carry: the full list an admin grants in the Admin console, and the subset each API asks for |
| `command-signature.mjs` | Signing the dashboard's commands to the VM, and the check the control service runs on each |
