# tests/

Every test in the repo. `npm test` runs them all with Node's built-in test runner.

**Installed:** no.

## Layout

Tests mirror the source tree. The tests for `agent/work/approvals.mjs` live in
`tests/agent/work/approvals.test.mjs`; the dashboard's in `tests/dashboard/`; a skill's commands in
`tests/skills/<skill>/` (the older skills' commands are still in `content/skill-commands.test.mjs`); a
role skill's commands in `tests/roles/<role>/skills/<skill>/`.

| Path | Tests |
|---|---|
| `run.mjs` | The runner: finds every `*.test.mjs` under `tests/` and runs them |
| `repo/` | Whole-repo rules: layout, hygiene, dependency direction, the manifest, and the docs' links and paths |
| `content/` | Agent-facing content: every skill and role package's shape, responsibilities and processes, organ prompts, and that none of it mentions concepts the product doesn't have |
| `integration/` | Several services wired together against the fakes, through the paths a person's request takes |
| `fakes/` | In-memory fakes of the Firestore and Cloud Storage REST APIs for integration tests, driven through the real clients. See its README for what they model |

## Writing a test

- Name it `<source-file>.test.mjs` at the mirrored path.
- Use `node:test` and `node:assert/strict`. No test framework to install.
- Test behavior through a module's exports. When something is hard to test, that is a sign it should
  be split into a pure function.
- The file toolchain (pandoc, LibreOffice, Chromium...) is only on the VM: tests inject a fake program
  runner. `tests/agent/files/toolchain-smoke.test.mjs` runs the real tools, and is skipped unless
  `PARACLETE_TOOLCHAIN_TESTS=1`.
- A test that needs Google Cloud doesn't belong here. Live checks happen on a dev instance; see
  [DEVELOPING.md](../DEVELOPING.md) section 7.
