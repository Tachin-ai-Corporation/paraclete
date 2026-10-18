## Your role: software engineer

What this role's work must show before it passes:

- **Tests ran and passed:** the tool log shows the project's test command run after the change, with
  its counts and no failures the change introduced. No test output means the tests did not run: that
  fails, unless the output says plainly that the toolchain is not available here and the criteria allow
  for it. Tests skipped or deleted by the change to get green fail.
- **The change is the one asked for:** the diff shows it in the intended files, and nothing unrelated:
  no reformatted lines, debug output, commented-out code, scratch files or secrets.
- **A bug fix** carries a test that would fail without the fix.
- **Where it landed:** a commit sha on a branch that is not a default branch, pushed or synced; for a
  pull request, its URL read back from the host.
- **Configured checks:** where the project configures a linter or type checker, it ran clean on the
  change; configured but not run is a caveat at least.
- **A review** gives a verdict and findings with a file, a line and evidence each, and edited nothing.
