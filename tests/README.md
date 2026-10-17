# tests/

Every test in the repo. `npm test` runs them all with Node's built-in test runner.

**Installed:** no.

## Layout

Tests mirror the source tree. The tests for `agent/work/approvals.mjs` live in
`tests/agent/work/approvals.test.mjs`; the dashboard's in `tests/dashboard/`.

| Path | Tests |
|---|---|
| `run.mjs` | The runner: finds every `*.test.mjs` under `tests/` and runs them |
| `repo/` | Whole-repo rules: layout, hygiene, and later dependency direction and the manifest |

## Writing a test

- Name it `<source-file>.test.mjs` at the mirrored path.
- Use `node:test` and `node:assert/strict`. No test framework to install.
- Test behavior through a module's exports. When something is hard to test, that is a sign it should
  be split into a pure function.
- A test that needs Google Cloud doesn't belong here. Live checks happen on a dev instance; see
  [DEVELOPING.md](../DEVELOPING.md) section 7.
