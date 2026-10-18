# Skill: Design System

## When to use

When work needs a visual system or has to follow one: a brand or style guide, design tokens, a
component sheet; a deck, document or page in the organization's style; or a check that several
deliverables look like one family.

The commands belong to other skills, whose SKILL.md files give the exact syntax:

| Skill | Commands | For |
|---|---|---|
| workspace-slides | `slides-get`, `slides-create` | Reading a deck's structure and styles; a new Google Slides deck |
| workspace-docs | `docs-get`, `docs-create` | Reading a brand guide; a new Google Doc |
| drive | `drive-find`, `drive-export`, `drive-put` | Brand assets shared with you; a finished file saved as a new Drive file |
| files | `file-get`, `file-read`, `file-make`, `file-convert`, `file-share` | Making .pptx, .docx, .pdf and .html files, and rendering them to look at |
| accessibility-checks | `contrast-check` | The contrast of every color pair |

## Find the system before you design

1. Working memory and the project's context may name a brand guide, a palette or a template.
2. Look for one shared with you: `drive-find "brand guide"`, `"style guide"`, `"template"`, with
   `--type doc` or `--type slides`. Or ask.
3. A deck or document people call on-brand shows the system in use: read its colors and fonts (the
   accessibility-checks skill shows how to read them from the file).
4. With nothing found, propose a minimal system (below) and say it is a proposal. Never invent brand
   values silently, and never present a proposal as the organization's brand.

Record where the system lives in the project's context, so later work finds it without searching.

## A minimal system

- **Palette:** one or two primary colors, one or two secondary, one accent, three to five neutrals
  (text, muted text, borders, surfaces, background), and status colors (success, warning, error) for an
  interface. For each: hex, RGB, what it is for, and the pairs it may be used in, with their ratios from
  `contrast-check --pairs`. A pair below 4.5:1 is marked "not for text".
- **Type:** a heading family and a body family, two at most, available where they will be used:
  Google Fonts for Docs and Slides; for files made here, the fonts this machine has (DejaVu, Liberation,
  Carlito, Caladea). A scale with a steady ratio (1.25 or more) for title, three heading levels, body and
  caption, each with its weight and line height (body 1.4 to 1.6, headings 1.1 to 1.25).
- **Spacing:** one scale on a base of 4 or 8 (4, 8, 12, 16, 24, 32, 48, 64). Every margin and gap is a
  step on it.
- **Shape and depth:** one corner radius, one or two shadow levels.
- **Components,** when the system serves an interface: buttons, inputs, cards, tables and alerts, each
  with its states (default, hover, focus, active, disabled, error), a table of its properties, and a
  do and a don't.
- **Imagery:** one icon style, and how photos and illustrations are treated.

Every choice carries its reason: "dark blue, because the primary needs 7:1 on white for small text", not
"it looks good".

## Tokens

Tokens hold each value once. Write them as CSS custom properties for web work and as `tokens.json` for
everything else, from the same list:

```css
:root {
  --color-text: #1f2937;
  --color-surface: #ffffff;
  --color-primary: #1d4ed8;
  --font-body: "Liberation Sans", Arial, sans-serif;
  --space-2: 8px;
  --radius: 6px;
}
```

Arithmetic on a token needs `calc()`: `calc(var(--space-2) * 2)`. Written as `var(--space-2) * 2` it
is invalid CSS, which browsers ignore without a word.

## The guide

A design system guide is a document: a one-page overview showing the system in use, then one section
per part (palette, type, spacing, components, imagery) with exact values in tables, the reason behind
each choice, and do and don't pairs for the rules people get wrong. Deliver it as a new Google Doc
(`docs-create`) or as a file (`file-make docx --from md`, or `pdf`), with `tokens.json` and `tokens.css`
beside it.

## Design a presentation

1. **The audience and the one message.** Slides suit presenting; a document suits reading. Say so when
   the request picked the wrong one.
2. **The outline first:** one idea per slide, each title stating the point ("Costs fell 12% after the
   move", not "Costs"), in the order of the story. For a substantial deck, get the outline approved
   before the visual work.
3. **Then the visuals, from the system:** the same few layouts, consistent margins, text at 18pt or
   more, one accent color for emphasis, and charts whose titles state their point.
4. **Speaker notes** say what the presenter adds, not what the slide already shows.
5. **Make it:** a Google Slides deck with `slides-create` (the workspace-slides skill says what it can
   build), or a `.pptx` with `file-make pptx --from md`, with `--reference-doc <template.pptx>` when the
   system has a template. `drive-put --convert` turns a `.pptx` into a Slides deck when people want it in
   Drive.
6. **Look at it:** `file-convert deck.pptx png --out <renders>` and view every slide. Run the
   accessibility checks, fix, and render again.

## Design a document

Structure first: real headings, short paragraphs, lists, and tables with a header row. Then the
system's type and colors (`file-make docx --from md --reference-doc <template.docx>`), a render of the
first pages to look at, and the accessibility checks.

## Audit several deliverables for consistency

1. Get each deliverable as a file.
2. Read their colors and fonts: from a `.pptx`, `grep -o 'srgbClr val="[0-9A-Fa-f]\{6\}"'` and
   `grep -o 'typeface="[^"]*"'` in its slide XML; from a `.docx`, `w:color`, `w:fill` and `w:ascii` in
   `word/document.xml`; from HTML and CSS, `grep -oiE '#[0-9a-f]{6}\b|#[0-9a-f]{3}\b'` and the
   `font-family` declarations; from a render when the file does not say.
3. Compare each value with the system: hex for hex, family for family, size against the scale, and
   names and terms used the same way everywhere.
4. Report every difference: where (file, slide or page, element), what was expected, what was found,
   how much it matters, and the fix.

## Files people shared

Brand assets, templates and decks people share are sources. Read copies of them; never edit, move,
rename, trash or delete them, even with Editor access. A revised deck or document is a new file your
account creates: you edit in place only files your own account created. Keep the source (Markdown, HTML,
tokens) beside every export.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| A font is replaced in the render or in Google Slides | It is not a Google Font, or not on this machine | Choose an available family for the system, or a metric twin (Carlito for Calibri, Caladea for Cambria), and say so |
| A made `.pptx` lost its layout | It was made from Markdown without a template | Pass a `--reference-doc` that carries the system's layouts, or build the deck in Google Slides |
| A color in the render differs from the file | A theme color, transparency, or a layer on top | Read the theme, or measure the rendered pixel (the accessibility-checks skill) |
