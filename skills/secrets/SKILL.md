# Skill: Secrets

## When to use

When a task needs an API key, a token or a password that someone stored in the project's Secret
Manager. The agent can read only the secrets an admin granted it access to.

## Commands

- `secret-read --name <secret-id> [--version latest]` prints the secret's value to stdout and nothing
  else: no newline, no label. `--version` is `latest` (the default) or a version number.

`--name` is the full Secret Manager secret id, exactly as stored: letters, digits, `-` and `_`. Nothing
is added to it. If you don't know the exact id, ask the person who stored the secret.

## Rules

- **Never print, echo, log or save a secret's value**: not to a file, not to your output, not to an
  environment variable that outlives the command, not into a script.
- Use a secret only inside the command that needs it, through command substitution:

  ```bash
  TOKEN=$(secret-read --name api-token) && curl -sf -H "Authorization: Bearer $TOKEN" https://api.example.com/items
  ```

- A command's output can echo a secret back (a verbose `curl -v`, an error that repeats the request).
  Keep such output out of your result.

## Procedures

### Use a secret in an API call

1. Find the secret's exact id.
2. Build the command with inline command substitution, as above.
3. Verify the call succeeded from its result, without showing the token.

### Check that a secret is readable

1. `secret-read --name <secret-id> > /dev/null`
2. Exit code 0 means the agent can read it.

## Error recovery

| Symptom | Cause | What to do |
|---|---|---|
| `Secret '<id>' (version <v>) not found` | A wrong or partial id | Ask the person who stored it for the exact secret id |
| `Access denied to secret '<id>'` | The agent was not granted access to it | Ask a dashboard admin to grant the agent access to that secret (the Secret Accessor role on that secret) |
| `invalid secret name` | The id has characters Secret Manager does not allow | Use the id exactly as it appears in Secret Manager |
