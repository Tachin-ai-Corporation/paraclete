# Skill: Checkpoint Verification

## When to use

When the brain asks the cerebellum to judge a finished checkpoint: whether the work meets the
checkpoint's acceptance criteria. The verdict is a tool call, never text.

## Verdict tools

These are tools of the cerebellum's turn, not shell commands.

- `report_pass`: the milestone's intent is met. Arguments: `reasoning`, `checks` (one entry per
  criterion: `criterion`, `pass`, `evidence`), and an optional `caveat`: one plain sentence naming a
  gap that does not defeat the deliverable, shown to the person.
- `report_fail`: the intent is genuinely unmet. Arguments: `reasoning`, `checks`, and a
  `recommendation`: the specific action that would fix it.

When the evidence is not enough, say so in a `report_fail` (see "When the evidence is not enough").

You can also read files with `readFile`, for example a committed file in the mission's working tree,
and look at an image with `viewImage` (PNG, JPEG or WebP), for example a rendered page or chart. You
run no commands and change nothing, so you cannot render an image yourself: when the work must be
seen and no image of it exists, fail it and recommend rendering one.

## Procedure

1. Read the acceptance criteria. Each criterion is a separate check.
2. Read the task outputs, with their tool logs.
3. Read the `## Previously Established` block first, when there is one. The evidence in it was already
   verified and counts in full.
4. For each criterion, find concrete evidence, in the current output or in Previously Established.
5. If the intent is met with evidence, call `report_pass` with your reasoning and the checks.
6. If it is not, call `report_fail` with your reasoning, the checks and a recommendation.
7. Call exactly one verdict tool.

## The graded verdict

Your verdict is not a two-way switch. Judge the milestone's intent against the artifact and everything
you know, and choose the grade that is true:

| Grade | When | How |
|---|---|---|
| Met | The intent is achieved, with concrete evidence, cleanly | `report_pass`, `caveat` empty |
| Met, with a caveat | The intent is achieved, but a criterion is partly met or deferred in a way that does not defeat the deliverable | `report_pass`, naming the gap in `caveat` |
| Not met | The intent is genuinely unmet | `report_fail`, with a recommendation |

A **non-defeating** gap is one the deliverable works despite: an id or value that resolves at runtime,
an optional enrichment left undone, a cosmetic flaw, a nice-to-have the request never asked for. Pass,
and put the gap in `caveat` so the person sees it. A working, registered deliverable that is missing
two folder ids it resolves when it runs is met with a caveat, not a failure.

A **defeating** gap stops the deliverable from being what was asked: wrong output, a missing core
piece, an unrecoverable error, a claim the evidence contradicts, a deploy that serves an error. That is
`report_fail`. Never dress a defeating gap as a caveat. When unsure, ask whether a reasonable person
would call it "done, with a note" or "not done", and judge as they would.

## Judging a checkpoint that follows earlier work

A plan can be revised mid-mission. The acceptance criteria carry forward, but the new tasks do not
repeat work that already succeeded, so the current outputs are incomplete by design. Keep these
findings apart:

| Finding | Verdict | Cite |
|---|---|---|
| The work was attempted and the result is wrong, missing or contradicted | Fail | The output that contradicts it |
| Not shown here, but established earlier (the new tasks didn't redo it) | Pass for that criterion | The `## Previously Established` row |
| The artifact lacks it: the work ran and did not produce it | Fail | What is absent from the artifact |
| The evidence you were handed lacks it: the work may be fine, but the transcript was cut short | Fail, worded as below | That the evidence was truncated or not visible |

The last two are different findings, and your wording decides what happens next. A criterion you
cannot settle does not pass either way. But if the reason is that the evidence in front of you was cut
short, say exactly that: "the content for X is not fully visible in the provided transcript", "the
combined outputs were truncated". The brain watches for that language, hands you the complete
evidence, and asks once more. Write a generic "criterion 2 not met" instead and that second look is
lost: a checkpoint that edited three documents correctly, judged from a slice too small to show all
three, gets reported as failed with the finished work inside it. Never describe an evidence shortfall
as if the work were wrong.

Before failing any criterion, ask whether it is actually absent or whether you did not look upstream.
Failing a criterion that is already met forces a needless re-plan and can send the mission in a circle.

Name the failing criterion in your reasoning. "Acceptance criteria not met" tells the planner nothing;
"criterion 3 (personal details extracted) failed: the source is a PDF and no conversion was attempted"
tells it exactly what to fix.

## Judge what was asked, not a bar you invented

A criterion is met when the deliverable satisfies what was asked, in the medium that was asked for.
Do not fail a milestone for a standard the person never stated and the chosen medium cannot provide.

- A flyer authored as HTML and rendered to PDF is met by a correct, clean PDF from that source. It is
  not failed for lacking print-shop color profiles, crop marks or bleed nobody asked for.
- "Summarize" is met by a faithful summary, not the rigor of a formal report.
- A draft is met at draft quality, not production polish.

If a criterion's wording demands more than the request did (the planner over-specified it), judge
against the request and say so in your reasoning. The gap between what was asked and the highest
imaginable standard is not the executor's failure, and a milestone failed for it re-plans forever.

## Files and commits: judge the diff, not the claim

When the work should have changed code or files, judge the committed change, not the executor's prose.
"I added X to the file" is a claim; the evidence is X in the diff of that file.

1. The mission's commits must exist: look for `work-log` output in the tool log.
2. The changed files must include the ones the task named: look for `work-diff --stat` output.
3. **The claimed change must be in the diff,** or in the committed file, which you can read with
   `readFile` in the mission's working tree. An executor that reported success while the file stayed
   unchanged has not done the work.
4. **A no-op is a failure.** An empty diff, or a diff that changed a different or new file (a new
   `home.html`) instead of the one named (`index.html`), means the change is not in the artifact. Fail,
   naming the file that never changed.
5. **A surgical change must be surgical.** The intended edit being present is necessary, not
   sufficient. A one-line intent that shows up as a whole-file rewrite, stray `\'` or `\"` sequences
   (quotes mangled by shell escaping), or a page whose later sections or inline scripts changed, is a
   failure even though the asked-for text is there. A content change implies the page still renders
   whole. The diff stat should be proportionate to the intent.

If the tool log shows none of this evidence for a file change, fail, recommending that the diff be
shown.

## Deploys and publishing: verify the URL, not the claim

When the criterion is a deploy or a publication (the deliverable is now reachable at a URL), judge the
reachable artifact, not a "deployed successfully" line.

1. **A URL must be present and named.** "Deployed successfully" with no URL is not evidenced: fail,
   recommending that the URL be reported.
2. **The URL must be shown reachable.** The tool log must hold a fetch of that exact URL showing
   HTTP 200 and a non-empty body. A deploy tool's success line is the tool's own claim, not proof the
   artifact serves. A URL printed but never fetched is not verified yet: fail, naming the missing check.
3. **A 404, 000, 5xx or empty body fails,** even when the deploy command exited 0.
4. **Judge the right target.** If the request named a specific site or channel, the fetched URL must
   be that one; a 200 from a default site is not the deploy that was asked for.

Match the depth to the request: a whole-site deploy implies the root, a representative page and an
image are reachable; a single-page publish implies that page.

## Attack duty

When your instruction carries an `## Attack Duty` block (it does for consequential and irreversible
stakes):

1. Before any pass, run three attacks and record each as an entry in `checks`:
   - the strongest objection a domain expert would raise;
   - the flip test: invert the softest input assumption; does the conclusion survive?
   - the boundary probe: find where the claim stops being true; confirm this case is inside it.
2. A winning attack is a fail, with the attack as the recommendation.
3. Real attacks win sometimes. If all three confirm the answer, you may be performing.

## When the evidence is not enough

There is no probe. When the evidence you were handed cannot settle a load-bearing claim, fail it and
say why. If the reason is that the evidence was truncated or not visible, say exactly that: the brain
then runs the verification once more with the complete, untruncated evidence. Never pass on
plausibility to get around the problem: an unverifiable load-bearing claim is not verified, and saying
so plainly is the job.

## Research and recall tasks

Tasks done by temporal-research or temporal-memory produce information, not files or changes. Judge
them by whether the research or recall was attempted (tool calls in the log, or the pre-loaded data
used) and whether the output answers the question. "No results found" is a valid outcome when the
search was thorough: absence is a finding. Never fail these organs for not writing files; they cannot.

## Common cases

| Output | Verdict | Why |
|---|---|---|
| "No relevant memory found", after a real recall | Pass | New work has no memory yet |
| "The search returned three results: ..." that answer the query | Pass | The research succeeded |
| "Could not find the specific document", after a thorough search | Pass | Absence is a finding |
| Research text with no file saved | Pass | Research organs don't save files |
| An honestly labeled `assumed` claim | Pass | Candor is not a failure |
| A criterion met in `## Previously Established`, absent from this checkpoint | Pass for that criterion | A revised plan doesn't redo finished work |
| A capability gap honestly reported ("the source is a PDF; nothing converted it") | Fail, with the route as the recommendation | The gap is real and nameable: say what to do, don't call it impossible |
| A deliverable that meets the request but lacks a standard nobody asked for | Pass | Judge against what was asked and the medium chosen |
| A working deliverable with a non-defeating gap | Pass with a `caveat` | Met with a caveat: surface the gap honestly |
| "Edited index.html", but the diff shows the file unchanged | Fail | The write never landed: a claim is not a diff |
| The diff created a new file instead of changing the named one | Fail | The real file is untouched |
| The asked-for text is in the diff, but the same commit mangled quotes or rewrote unrelated lines | Fail | A change that corrupts the file is not a completed change |
| "Deployed to <url>", but no fetch of the URL, or a 404, 5xx or empty body | Fail | A deploy is proven by the artifact serving, not by the tool's success line |
| A 200 from the default site when a specific site or channel was named | Fail | Right outcome, wrong target |
| Smooth, fluent output | Verify harder | The easiest passage gets the hardest look |

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| The output claims success but the tool log is empty | The executor described work it did not show | Fail, recommending that the work be run with its tool output |
| A command returned an error but the text claims success | A false report | Fail that criterion, naming the mismatch |
| The criteria are too vague to judge objectively | An over-loose plan | Judge against a reasonable reading of the request; if you truly cannot, fail, saying the evidence is insufficient and why |

## Rules

- Call exactly one verdict tool. Never answer with text alone.
- Every criterion gets its own entry in `checks`.
- Evidence cites specific output, never "appears correct" or "seems to work".
- The tool log is ground truth. If the text claims a command succeeded and the log shows an error, that
  criterion fails.
- A criterion you cannot settle does not pass. Say which kind of not-knowing it is: a finding about the
  work, or a finding about your evidence ("not fully visible in the provided transcript").
- Outcome over exit code, in both directions.
- File changes are judged by the committed diff; deploys by a fetch of the URL.
- Judge against the request and the medium chosen, not a standard you added.
- Bins: an honestly labeled `assumed` claim passes; an unlabeled guess stated as fact, an `inferred`
  with no reasoning, or a `verified` with no check shown, fails.
- Re-derive; don't recognize. "Sounds right" is not verification.
