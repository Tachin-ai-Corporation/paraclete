# Skill: Site Audit

## When to use

When a person asks you to review or improve a site ("what would you change", "make it better", "take a
look"), or an open request invites more than its literal words. It ends in a short, ranked proposal, with
the strongest idea built on a preview channel so the person can see it. A narrow request (change this
word, fix this link) is not an audit: do it and stop. There are no commands of its own: you run `curl`,
`lighthouse`, `chromium` and the files skill's `file-convert`, and read the site's source.

An audit reads and proposes. Nothing reaches the live site from it; a proposal the person picks becomes
a change of its own (the firebase-hosting skill).

## Tools

- **The page as served:** `curl -sSL -o /tmp/page.html -w '%{http_code} %{size_download} %{time_total}s\n' <url>`.
- **The page as seen:** screenshots at a phone's and a desktop's width, opened with the viewImage tool:

  ```bash
  chromium --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=390,844 --screenshot=<renders>/mobile.png <url>
  chromium --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=1280,900 --screenshot=<renders>/desktop.png <url>
  ```

  Keep renders in the mission's `missions/<mission id>/renders/`, so the verifier can see them too.
- **Lighthouse** measures performance, accessibility, best practices and SEO in one run (about a minute):

  ```bash
  CHROME_PATH=/usr/bin/chromium lighthouse <url> --quiet \
    --chrome-flags="--headless=new --no-sandbox --disable-gpu" \
    --only-categories=performance,accessibility,best-practices,seo \
    --output=json --output-path=<renders>/lighthouse-mobile.json
  ```

  It tests as a phone by default; add `--preset=desktop` (and another output path) for a desktop run. Read
  it with `jq`: the scores, `jq '.categories | map_values(.score)' <file>`; what failed,
  `jq -r '.audits[] | select(.score != null and .score < 0.9) | [.id, .title, (.displayValue // "")] | @tsv' <file>`.
  Scores move a few points between runs: compare like with like, and cite the audits, not only the score.

## The method

1. **Fix the target.** The live URLs and the site's source, from the project's context or the person;
   never guess them. Read the site's design system first (colors, type, spacing, voice) and the
   person's goal for the site: every proposal serves that goal inside that system.
2. **Look at it as a visitor does:** both screenshots, then the page served.
3. **Walk the dimensions** that fit the site, recording findings with evidence (the element, the line,
   the measured number, the rule):
   - **Message and hierarchy:** within five seconds, does a visitor know what this is and what to do?
     Is the most important thing the most prominent, and the main call to action obvious?
   - **Design consistency:** type, color, spacing and components on the site's own system; nothing
     off-brand or orphaned.
   - **Mobile:** at 390 pixels wide, no sideways scroll, no overlap, tap targets large enough, nothing
     important hidden.
   - **Accessibility:** Lighthouse's accessibility audits (contrast, alt text, labels, heading order),
     plus a look at focus and reading order. Report by impact.
   - **Performance and weight:** Lighthouse's metrics and its largest opportunities; images far larger
     than they show.
   - **Search and social preview:** a `<title>`, a `<meta name="description">`, Open Graph tags
     (`og:title`, `og:description`, `og:image`), and whether they still match the page. A description
     that contradicts the current headline is a real defect.
   - **Links and assets:** every internal link and asset answers. List them with
     `grep -oE '(href|src)="[^"#]+"' /tmp/page.html | sort -u`, resolve relative ones against the URL, and
     fetch each with `curl -sS -o /dev/null -w '%{http_code}' <link>`; report every 4xx and 5xx.
   - **Content:** typos, stale dates or prices, leftover placeholder text, a voice that drifts.
4. **Rank** the findings by how much each helps the visitor or the site's goal, against its effort and
   its risk of breaking something. Keep the few that matter most: three strong ones beat twenty nitpicks.
5. **Build the first one on a preview channel** (the firebase-hosting skill), when the site is one you
   deploy; otherwise render it locally and share the image.
6. **Propose.**

## The proposal

> **Proposed improvements for `<site>`** (preview of the first: `<preview url>`)
>
> 1. **High impact, small change.** *What is wrong, with its evidence* → *the change* → *why it matters*
> 2. ...
>
> Nothing here is on the live site. Say which to make, and I will release it after you have seen it.

Keep each item to its finding, its change, its reason and a rough size. Record the person's choices, what
they took and what they declined, in the site's project context, so the next proposal fits better.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| The URL does not answer | Wrong URL, or the site is down | Confirm the URL; if it is down, that is finding number one, and the firebase-hosting skill diagnoses it |
| A screenshot is blank or half drawn | Scripts had not run yet, or a script is broken | Retry once; if a section stays blank, it is a finding: confirm it against the source |
| Lighthouse fails to start Chrome | A missing flag or path | Use the exact command above, with `CHROME_PATH=/usr/bin/chromium` and `--no-sandbox` |
| Lighthouse is stopped before it ends | The two-minute command limit, on a slow page | Run it in the background with its output in a file, and check the file |
| The list of findings keeps growing | Auditing every pixel | Rank and cut to the few that move the site's goal |

## Safety

- Read and propose; never apply an unrequested change to the live site. The person chooses.
- Stay inside the site's design system unless the person invites something bolder.
- Fetch politely: one pass over the site's own links, never a crawl of other sites or a load test.
