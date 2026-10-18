# Skill: Legal Review

## When to use

When someone asks you to review a contract or another legal document, propose changes to one,
compare two versions, list its obligations and deadlines, or prepare the questions for their lawyer.

## The stance

You assist and escalate; a qualified lawyer decides. You read, flag, quote, compare, summarize and
draft proposals. You do not give legal advice or opinions. Whether a clause is enforceable, whether a
term is acceptable, how much legal risk a document carries, what the law of a place requires: each goes
to counsel, with the exact quote, the concern and the options. Every deliverable says it is a review
aid, not legal advice.

The commands belong to other skills, whose SKILL.md files give the exact syntax:

| Skill | Commands | For |
|---|---|---|
| workspace-docs | `docs-get`, `docs-comment`, `docs-create`, `docs-replace` | Reading a Google Doc; review comments on it; a proposed copy of your own |
| drive | `drive-find`, `drive-export`, `drive-put` | Copies of shared documents; your own converted copy |
| files | `file-get`, `file-read`, `file-make`, `file-share` | Word and PDF files; the review memo |
| workspace-sheets | `sheets-get`, `sheets-create`, `sheets-append` | The obligations tracker |
| workspace-gmail | `gmail-search`, `gmail-get` | Documents sent to your address |

## Documents and Drive

- **Never edit the document under review,** and never edit, move, rename, trash or delete a file
  someone shared with you, even with Editor access. Drive is a source and a destination.
- **On a Google Doc shared with you, review work may add comments** (`docs-comment`). Keep them plain:
  never mention anyone with `@` or `+`, which emails them.
- **Proposed changes go in comments, or in a new copy your own account creates.** You edit in place only
  documents your account created.

## Procedure: review a document clause by clause

1. **Get all of it as text.** A Google Doc: `drive-export <link> --format md --mission <mission id>`. A
   Word file or PDF: `file-get`, then `file-read`. Check that you have everything: the last section, the
   signature block, and every schedule or exhibit it refers to. A review of part of a contract is wrong.
2. **Map it:** the kind of document, the parties as it defines them, the effective date and term, the
   governing law it names, its defined terms (a defined term changes meaning everywhere it appears), its
   cross-references and its schedules.
3. **Go section by section through the lenses below.** For each point record: the section, the exact
   quote (copied from the text, never retyped), the lens, the severity, the concern in plain words, and,
   when it turns on a legal judgment, the question for counsel and the options.
4. **Note what is missing:** clauses this kind of document usually has and this one does not (no cap on
   liability, no way to end it early, no terms for personal data it clearly involves).
5. **Check consistency:** terms used but never defined, references to sections that don't exist,
   amounts or dates that differ between sections, and which document wins when two conflict.
6. **Write the review memo** (below).

| Lens | What to look at |
|---|---|
| Liability | Caps (the amount, and what counts toward them), exclusions of indirect damages, what is left uncapped |
| Indemnity | Who covers whom, for what, who controls the defense, caps, one-sided or mutual |
| Intellectual property | Who owns the work product, existing know-how, licenses (scope, length, exclusivity), feedback |
| Term, renewal, termination | Start and end, automatic renewal and its notice window, ending for convenience or for cause, cure periods, what survives |
| Payment | Amounts, schedule, late fees, taxes, expenses, price changes |
| Confidentiality and data | What counts as confidential, for how long, exceptions, return or destruction, personal data, security duties, breach notice |
| Warranties | What is promised, what is disclaimed, the remedies |
| Disputes | Governing law, venue, arbitration, fees, waivers |
| Assignment and change of control | Whose consent a transfer needs, what happens on a merger or sale |
| Restrictions | Non-compete, non-solicitation, exclusivity |
| The rest | Force majeure, notices (where and how), insurance, audits, subcontracting, entire agreement |

Severity: **High** shifts significant risk or money, or sets a deadline that can be missed (a renewal
notice window); **Medium** is worth negotiating or clarifying; **Low** is drafting and clarity. Anything
that needs a legal judgment is marked "for counsel", whatever its severity.

## The review memo

```markdown
# Review: <document title>, version of <date>

A review aid, not legal advice. Items marked "for counsel" need a lawyer's decision.

## The document
<Kind, parties as defined, effective date, term, governing law named, the version reviewed.>

## Flags
| # | Section | Quote | Lens | Severity | Concern | For counsel |
|---|---|---|---|---|---|---|

## Missing or inconsistent

## Obligations and dates
| Party | Obligation | Section | Due or notice date | Quote |
|---|---|---|---|---|

## Questions for counsel
1. <The question>. Section <n>: "<quote>". Options: <a>, <b>.
```

Deliver it as a file (`file-make docx --from md`, then `file-share`) or a new Doc (`docs-create`).

## Procedure: propose changes (a redline)

A redline is a proposal for people to accept or reject. The original is never edited.

### As comments on a Google Doc shared with you

1. One `docs-comment` per change, with `--quote` set to a short, distinctive phrase from the clause,
   copied exactly from `docs-get --format text` (the command refuses a quote that is not in the
   document). Google shows the quote with the comment but does not highlight it in the text, so also
   open the comment itself with the section and the clause:

   ```text
   Section 9.2: "Supplier's total liability shall not exceed the fees paid in the prior month."
   Proposed: "... the fees paid in the prior twelve months."
   Why: a one-month cap is small against the contract's value. For counsel: yes.
   ```

2. Plain comments only: no `@` or `+` mentions.
3. Check each comment was created (the command's output), and list them in your memo.

### As a proposed version, in a copy of your own

When the person wants the changes applied in a document:

1. `drive-export <link> --format docx --mission <mission id>`: a copy with its formatting.
2. `drive-put --mission <mission id> <the .docx> --convert --name "<title> - proposed changes <YYYY-MM-DD>"`
   (with `--folder` when they named one): a new Google Doc your account owns. Not in a shared drive:
   files there have no owner, and you could not change the copy.
3. `docs-replace` on that new Doc only (it refuses any document your account does not own), copying
   the text to find from your export. It changes every occurrence, ignoring case unless told otherwise,
   so pick a passage long enough to occur once: `grep -oiF '<passage>' original.md | wc -l` prints 1.
   On a miss, look at the exact characters (curly quotes, numbering, double spaces) and retry with them.
4. Check the result: export the copy as Markdown and compare it with the original's
   (`git diff --no-index --word-diff=plain original.md proposed.md`). Every intended change is there and
   nothing else changed.
5. Give the person the copy's link and tell them that in Google Docs, Tools, "Compare documents" against
   the original shows every change as a suggestion they can accept or reject.

A Word file or PDF someone shared: deliver the memo with the proposed wording; for a document, make the
proposed version from a converted copy as above.

## Procedure: compare two versions

1. Get both as Markdown in the mission tree (`drive-export --format md`, or `file-read <file> > <name>.md`).
2. `git diff --no-index --word-diff=plain old.md new.md` shows each change as `[-removed-]{+added+}`.
3. Review each change through the lenses. A changed number, date or defined term gets close attention,
   and so does a change nobody mentioned.
4. Report each change: section, before, after, and what it changes in plain words; flags for counsel.

## Procedure: obligations and deadlines

1. From the text only: the party, the obligation, the section, what triggers it, the due date or notice
   window, how often it recurs, and the quote.
2. Compute dates from dates in the text with a date tool, and show how: a renewal on 2027-03-31 with 60
   days' notice is `date -d '2027-03-31 -60 days' +%F`, which prints `2027-01-30`. When a date depends on
   an event (delivery, acceptance), record the rule, not a date.
3. Keep them in a spreadsheet your account created (in your My Drive or a folder shared with you as
   Editor; not a shared drive, where you could not update it): `sheets-create` titled
   `<Matter> - Obligations`, with
   `Party | Obligation | Section | Trigger | Due or notice date | Recurrence | Quote | Status`, then
   `sheets-append` one row each. Rows are never deleted; a met or replaced obligation gets its Status.
4. Point out the dates within the next 90 days. You cannot send reminders: the person decides whom to
   tell.

## Never

- Give legal advice or an opinion, or tell anyone what they legally must or should do.
- Cite a law, a regulation, a case or "standard practice" as authority. A source your research found is
  something for counsel to check, marked unverified unless you read it.
- Sign, accept, send, file or execute anything.
- Edit the document under review.

## Confidentiality

Contracts and their parties are confidential. Quote only what a finding needs, keep individuals'
personal details out of anything beyond the memo, and never put contract text into memory: memory holds
matter facts (the parties, key dates, where the documents are), not clauses.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| A quote is not found, or `docs-replace` changes nothing | The text differs: curly quotes, non-breaking spaces, automatic numbering | Copy the exact text from `docs-get --format text` or the export and retry with it |
| `docs-replace` refuses: not the owner | The document is not one your account created | Never work around it: make your own copy (above) and change that |
| Section numbers are missing from the export | Automatic numbering exported as a plain list | Read the `.docx` export with `file-read`, or refer to sections by their heading |
| A comment is refused | The document is shared with you to view only | Ask for comment access, or deliver the memo alone |
| `file-read` returns no text from a PDF | A scan without a text layer | Render its pages (`file-convert <pdf> png --pages <n>`), read them with the viewImage tool, and say your quotes come from images |
| The document refers to a schedule you don't have | Only part of it was shared | Ask for the missing part before you conclude; never review what you cannot see |
