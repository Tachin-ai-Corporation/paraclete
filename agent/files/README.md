# agent/files/

Files the agent works on: fetching them from wherever they were shared, reading them as text,
converting between formats, and making new ones, with the toolchain the bootstrap installs on the VM
(pandoc, LibreOffice, Chromium, poppler, qpdf, ImageMagick and a few Python libraries), plus the
`files` records of what goes out. The `files` skill's commands (`skills/files/`) are thin wrappers
over this package; the artifact export (`work/artifacts.mjs`) and the brain's completion use its
outgoing records.

**Installed:** yes.

**May import:** `storage`, `providers`, `auth` (see [agent/README.md](../README.md)). It reads no
configuration itself: callers pass the `files` values from `config/contracts.json`.

**Doesn't belong here:** naming and moving bytes in the bucket (`storage/file-store.mjs`), Drive API
calls (`providers/drive.mjs`), and deciding which files a mission hands back (the agent, through
`file-share`, and the artifact export).

## Files

| File | Does |
|---|---|
| `formats.mjs` | What a file is: format ids, MIME types and names, detected from the bytes (looking inside ZIPs for Office and OpenDocument), then `file --mime-type` |
| `zip.mjs` | Lists and inflates the entries of a ZIP container, with Node's zlib |
| `runner.mjs` | Runs the toolchain's programs: argument arrays, a time limit, output caps, a private LibreOffice or Chromium profile per run, and readable `ToolError`s |
| `mission-paths.mjs` | A mission's tree and inbox (`<tree>/missions/<id>/inbox/`), the mission a path belongs to, free file names |
| `sources.mjs` | Fetching into the inbox: chat uploads, Cloud Storage objects, http(s) links, git repositories and Drive files |
| `shared-files.mjs` | The block telling an organ which files a person shared and the exact `file-get` command for each; upload ids from object paths |
| `readers.mjs` | A file as text or Markdown: PDF, Word, OpenDocument, RTF, spreadsheets, presentations, HTML, text; page, sheet and slide selection; the cut and what is left out, said |
| `sheets.mjs` | Spreadsheets as rows (openpyxl, LibreOffice for .xls and .ods, CSV directly), rendered as Markdown tables or CSV, and rows written to a new .xlsx |
| `slides.mjs` | A presentation's slide titles, text, tables, picture descriptions and notes, read from the .pptx XML |
| `images.mjs` | An image's size in pixels from its header |
| `csv.mjs` | CSV and TSV parsing and writing |
| `html-print.mjs` | Markdown as a styled HTML page, and HTML printed to PDF or screenshotted to PNG with Chromium |
| `converters.mjs` | The conversion table and every conversion, PDF merge and page extraction |
| `makers.mjs` | New files from source the agent wrote: Markdown, HTML, CSV and JSON into Word, PDF, HTML, PowerPoint, PNG, Excel and CSV |
| `outgoing.mjs` | The `files` records of outgoing files: their ids and shape, writing and listing them, and a reply's attachments |
