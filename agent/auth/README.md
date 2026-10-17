# agent/auth/

Access tokens, and nothing else.

**Belongs here:** tokens from the VM's metadata server for the agent's service account, and, on
Workspace roles, tokens for the agent's own Google account through domain-wide delegation.
**Doesn't:** keys. No service-account key is ever created, stored or read.

This package imports nothing else from `agent/`.

**Status:** empty. Arrives in build plan phase 2.
