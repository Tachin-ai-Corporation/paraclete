# Harvested bench items

Bench items harvested from the lab's canary and admitted by review. Each is one JSON file named
`<id>.json`. `dev/harness2/harvested-items.mjs` reads them into the organ benches
(`dev/harness2/bench.mjs` BENCHES), beside the items written by hand in `bench-items.mjs`. They are the
referee's: no lane changes them. Nothing here is installed.

What does not belong here: candidates nobody has reviewed. The scenario runner
(`node dev/harness2/cli.mjs scenarios`) writes those to `.local/canary/harvested/` in the checkout it
runs from, or beside the state file it was given.

## Admitting a candidate

A candidate is a recall the canary got wrong while the facts were in its memory
(`dev/harness2/scenario-harvest.mjs`, `memh-<run>.json`), or wrong work one of its checkpoints passed
(`dev/harness2/verification-harvest.mjs`, `cbh-<run>-defect.json`). Before admitting one:

1. **Check that it is scrubbed.** The harvester replaces project ids, email and IP addresses, Cloud Run
   URLs, GitHub owners and the private denylist's names. Read the whole file for anything else that
   names a real organization, person or system: past work and Core Memory are copied as the canary
   stored them.
2. **Check that it is fair.** The memory bench's tests require every value an item checks to reach the
   organ's candidates (`tests/dev/harness2/bench.test.mjs`). If one does not, the miss happened
   before the organ chose, and the item is a bug report for recall's code, not a bench item. A
   cerebellum item is fair when its rows show the defect its `flaw` names and its criteria rule it
   out, so a careful verifier reading only them would fail it. If the criteria allow the wrong work,
   the miss was the plan's, not the verifier's.
3. **Write a cerebellum item's clean twin.** The bench takes its cerebellum items in pairs, one
   checkpoint with two outcomes: copy the defective item to `cbh-<run>-clean.json`, set `expect` to
   `pass`, drop `flaw`, and put the rows right with the one change that removes the defect (the right
   count, time, rate or total). A verifier that passes everything then scores half on the pair.
4. **Move the files here and raise `BENCH_VERSION`** (`dev/harness2/bench.mjs`) to the version its
   `bench` field names. The loader refuses an item whose version is newer than the bench's. A new
   item changes what the bench measures, so the loop measures its baselines again at the new version
   at once. Update the tests that pin the version and the item counts in the same commit.
5. **Open a pull request** for the user's review, as for any referee change.

An item is retired as a written one is, by naming it in `RETIRED_BENCH_ITEMS`. It is never deleted:
results recorded at the version it entered still name it.
