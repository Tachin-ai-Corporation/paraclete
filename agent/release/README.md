# agent/release/

What a release is, for everything that names one: the dashboard (which release is newer than the
installed one), the maintainers' `dev/release.mjs`, the VM's release record and the brain.

A release is a git tag in the commit version format, `vYYYY.MM.DD.N.N`, published as a GitHub
release with notes once its tests passed (`.github/workflows/release.yml`). Versions order by date,
then the day's index, then its subindex.

| File | Job |
|---|---|
| `versions.mjs` | Parses and orders versions; reads GitHub's release list; the GitHub URLs for a repository's releases and a tag's commit |

Pure: no network, no files, no configuration. Callers fetch and pass GitHub's JSON in. The format is
also `config/contracts.json`'s `versioning.canonical_regex`; a test keeps the two equal.
