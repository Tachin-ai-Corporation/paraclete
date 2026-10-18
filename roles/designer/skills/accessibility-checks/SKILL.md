# Skill: Accessibility Checks

## When to use

Before you deliver any design (slides, a document, a PDF, a web page, a chart, an image with text in
it), and whenever someone asks whether something is accessible. Accessibility is part of done: a
deliverable that fails the floor below is not finished.

## The floor

Based on WCAG 2.2 level AA, the standard most organizations hold their materials to.

| Check | Passes when |
|---|---|
| Text contrast | At least 4.5:1; at least 3:1 for large text (24px or 18pt and up, or 18.66px or 14pt bold) |
| Non-text contrast | At least 3:1 for icons, input borders, focus indicators, and chart lines and marks against what is next to them |
| Color is never the only signal | Status, required fields and chart series also differ by a label, a shape, a pattern or text |
| Text size | Slides: body text 18pt or more. Documents: 11pt or more. Web: body 16px. Nothing below 9pt or 12px |
| Alternative text | Every meaningful image, chart or icon has alt text that says what it shows or means; a decorative one is marked decorative (empty alt text) |
| Structure | Documents use real headings in order (no skipped level), real lists, and tables with a header row; every slide has its own title |
| Reading order | The content reads in a sensible order: screen readers follow the order of a slide's objects and a page's markup, not the layout |
| Links | Link text says where it goes ("the Q3 report"), never "click here" |
| PDFs | Tagged, with a text layer, a title and embedded fonts |
| Web pages | The language declared (`<html lang="en">`), a visible focus on every control, usable by keyboard alone, targets at least 24 by 24 pixels, no horizontal scroll at 320 pixels wide, motion that honors reduced-motion settings |
| Flashing | Nothing flashes more than three times a second |

## The command

`contrast-check <foreground> <background> [<foreground> <background> ...] [--require aa|aa-large|aaa|aaa-large|non-text] [--json]`

`contrast-check --pairs <file.json> [--require <level>] [--json]`

- Computes the WCAG contrast ratio of each pair and whether it passes each level: `aa` (4.5, text),
  `aa-large` (3, large text), `aaa` (7), `aaa-large` (4.5), `non-text` (3).
- Colors: `#rgb`, `#rrggbb`, `rgb(r, g, b)` or `srgb(r, g, b)` with 0-255 channels, `black`, `white`.
  Quote colors that start with `#`, or leave the `#` out: unquoted, the shell reads `#` as the start of
  a comment. A Google Slides or Docs color given as 0-1 fractions is converted first: multiply each by
  255 and round.
- `--pairs` reads a JSON list of `{ "foreground", "background", "label" }`, for checking a whole
  palette or every pair in a deliverable at once.
- `--require <level>` exits 1 when any pair falls below that level; otherwise it exits 0. Exit 2 is a
  mistake in the command or a color it cannot read.
- The ratio is printed truncated, never rounded up: 4.49 fails 4.5. Never round a ratio yourself.

```bash
contrast-check '#767676' '#ffffff' 1f2937 f9fafb --require aa
```

## Checks by medium

Render what you check and look at it with the viewImage tool: a contrast problem, cut-off text or a
crowded slide is often plain to see. Keep renders in `<mission tree>/missions/<mission id>/renders`.

### Slides (Google Slides or PowerPoint)

1. Get it as a `.pptx`: `drive-export <link> --format pptx --mission <mission id>` for a Google Slides
   deck, `file-get` for a file.
2. **Titles, text and alt text:** `file-read deck.pptx` shows each slide's title, text, picture
   descriptions and speaker notes. A picture with no description is missing alt text; a slide with no
   title, or the same title as another, is a finding.
3. **The XML, for sizes, colors and reading order:** `unzip -o -q deck.pptx -d deck`, then for slide N:
   - font sizes: `grep -o 'sz="[0-9]*"' deck/ppt/slides/slideN.xml | sort | uniq -c` (hundredths of a
     point: `1800` is 18pt; text with no `sz` takes its size from the layout or master);
   - colors: `grep -o 'srgbClr val="[0-9A-Fa-f]\{6\}"' deck/ppt/slides/slideN.xml`; a `schemeClr`
     color comes from `deck/ppt/theme/theme1.xml`;
   - objects in reading order, with their alt text: `grep -o '<p:cNvPr [^>]*>' deck/ppt/slides/slideN.xml`
     (the order listed is the order a screen reader reads; `descr` is the alt text).
4. **Render** with `file-convert deck.pptx png --out <renders>` and look at each slide. To measure a
   color where text sits on an image or a gradient, sample the rendered pixels:
   `convert slide-3.png -crop 1x1+<x>+<y> -depth 8 txt:-` prints the pixel's `#RRGGBB`. Sample the
   background right beside the text and the solid middle of a thick letter (a letter's edges are
   blended), and check the lightest background point against the text.
5. `contrast-check` every text color against its background, and every chart mark against its
   neighbor.

### Documents (Google Docs or Word)

1. Get it twice: as Markdown for structure (`drive-export --format md`, or `file-read doc.docx`), and as
   a `.docx` for the details (`drive-export --format docx`, or `file-get`).
2. **Headings:** in the Markdown, the headings (`#`, `##`, `###`) go in order with no level skipped.
   A line in bold that acts as a heading but is not one is a finding.
3. **Alt text:** `unzip -p doc.docx word/document.xml | grep -o '<wp:docPr [^>]*>'` lists each image
   with its `descr`.
4. **Colors and sizes:** `grep -o 'w:color w:val="[0-9A-Fa-f]\{6\}"'` for text colors and
   `grep -o 'w:fill="[0-9A-Fa-f]\{6\}"'` for shading in `word/document.xml`; `w:sz w:val="22"` is in
   half-points (22 is 11pt). Check colored text against the page or its shading.
5. **Links and tables:** link text in the Markdown says where it goes; every table's first row labels
   its columns.

### PDFs

1. `pdfinfo file.pdf`: `Tagged: yes` and a `Title`. `Tagged: no` is a finding.
2. `file-read file.pdf` returns text: it has a text layer. Nothing back means a scan, which a screen
   reader cannot read.
3. `pdffonts file.pdf`: every font `emb yes`.
4. Render pages (`file-convert file.pdf png --pages 1-3 --out <renders>`) and check contrast as for
   slides.

### Web pages

1. Render at three widths, `file-convert page.html png --size 320x2400 --out <renders>`, then
   `768x2400` and `1440x2400`, and look at each. At 320 pixels nothing may be cut off or need sideways
   scrolling.
2. **Markup:** `<html lang>`; one `<h1>` and headings in order; an `alt` on every `<img>`; a `<label>`
   for every input; text in every button; `<main>` and `<nav>` landmarks.
3. **CSS:** a visible focus style (`:focus-visible`) on everything interactive; animation wrapped in
   `@media (prefers-reduced-motion: no-preference)` or switched off under `reduce`; the color pairs from
   its tokens through `contrast-check --pairs`.
4. Keyboard use and screen-reader output cannot be tried from here. Report them as not checked, never as
   passed.

### Charts and images with text

Series told apart by more than color (labels, markers, patterns); marks at 3:1 against the background
and text at 4.5:1; alt text or a caption that states the chart's point, and the numbers as a table
nearby when the chart is complex.

## Reporting

```markdown
| # | Where | Check | Found | Severity | Fix |
|---|---|---|---|---|---|
| 1 | Slide 4, subtitle | Text contrast | #9ca3af on #ffffff, 2.53:1 | Blocker | #6b7280 (4.83:1) |
```

Severity: **Blocker** when some people cannot use the content at all (text under 3:1, a meaningful image
with no alt text, a scanned PDF); **Serious** when it fails the floor; **Minor** for good practice beyond
it. Close with the counts, whether the deliverable meets the floor, and what you could not check.

## Fixing

- **Your own files:** fix, re-check, and deliver only once the checks pass. To fix contrast, keep the
  hue and change the lightness until `contrast-check` passes, then re-check every other pair that uses
  that color.
- **Files someone else owns:** never edit them, even with Editor access. Report the findings with exact
  fixes (the replacement color and its ratio, the alt text to add), or, when asked, deliver a corrected
  new version your account creates.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `cannot read ... as a color` | A color form it does not take (a name, `hsl()`, 0-1 fractions) | Convert it to hex first |
| A slide's text has no `sz` or color in its XML | It inherits from the layout or master | Read `deck/ppt/slideLayouts/` and `deck/ppt/slideMasters/`, or measure from the render |
| Sampled colors vary across a letter | Anti-aliased edges | Sample the middle of a thick stroke, or a large heading in the same color |
| `pdfinfo` is missing a line | An old or unusual PDF | Report what it printed; don't infer a pass |
