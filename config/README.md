# config/

`contracts.json`: the single source for every value used in more than one place. Model ids, ports,
timeouts, limits, collection names and feature switches live here and nowhere else.

**Installed:** yes. The agent's code reads it at startup; the dashboard reads the copy at its release.

## Rules

- If a value appears in two places, it belongs here, and both places read it from here.
- No secrets, project IDs or other organization-specific values. Those are injected at install or
  runtime.
- Every key is documented next to it, in a `_comment` field or in the schema.
- A change here is a product change: it ships in a release like code.

## Status

Empty. `contracts.json` arrives in build plan phase 4.
