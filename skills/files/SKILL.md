# Skill: Files

## When to use

Whenever a request involves a file: a person shared one with you (in chat, as a link, in Cloud
Storage, in a git repository or in Google Drive), the work needs a document read, converted or
produced, or the result should reach the person as a file they can open: Word, PDF, Excel, CSV,
PowerPoint, HTML, Markdown, an image.

## Where files are

| What | Where |
|---|---|
| Files a person shared | Not on this host yet. The mission's context lists each under "Files shared with this request", with the exact `file-get` command that fetches it |
| The mission's inbox | `<mission tree>/missions/<mission id>/inbox/`. `file-get` puts everything it fetches here |
| Your work | Anywhere in the mission tree. Office files, PDFs, images and archives in the tree are never committed, so they never reach anyone by themselves |
| What goes out | The bucket, never a directory. `file-share` uploads a file as a download on the mission, and your reply carries it as an attachment |

Your mission id is the last part of the mission tree's path: the tree named in your instruction is
`.../missions/<mission id>/`.

## The workflow: get, read, work, make, check, share

1. **Get** each shared file: `file-get --mission <mission id> <source>`. It prints the local `path`.
2. **Read** it: `file-read <path>`. Narrow a long file with `--pages`, `--sheet` or `--slides`.
3. **Work**: write what you produce as Markdown (or HTML, CSV, JSON) in the mission tree, and convert
   what needs converting with `file-convert`.
4. **Make** the deliverable: `file-make docx --from md --in report.md --out report.docx`.
5. **Check** it before anyone sees it: read it back with `file-read`, or render a page
   (`file-convert report.pdf png --pages 1`) and look at it with the viewImage tool.
6. **Share** it: `file-share --mission <mission id> report.docx`. In your answer, name each file you
   shared. A file you did not share does not reach the person.

## Commands

Every command prints its result to stdout (JSON for all but `file-read`), and the reason for a failure
to stderr. Exit code 0 is success, 1 a failure, 2 a mistake in the command (fix the arguments; do not
repeat it unchanged).

### file-get: bring a file in

`file-get --mission <mission id> <source> [--name <name>] [--kind upload|gcs|http|git|drive] [--export <format>] [--branch <branch or tag>] [--token-secret <secret id>]`

| Source | Example |
|---|---|
| A file shared in chat | `files/in/u-1760000000000-1a2b3c4d/report.pdf`, exactly as the "Files shared with this request" block lists it (or the same path after `gs://<bucket>/`) |
| A Cloud Storage object | `gs://<bucket>/<object>`, in any bucket the agent may read |
| A link | `https://example.com/q3.xlsx`. Redirects are followed; the name comes from the server or the URL |
| A git repository | `https://github.com/<owner>/<repo>`, any URL ending in `.git`, or `git@<host>:<owner>/<repo>.git`. Cloned shallow (the latest commit) into the inbox |
| A Google Drive file | A `docs.google.com` or `drive.google.com` link, or a file id |

It prints `{ "path", "name", "type", "size", "sha256", "source" }`; a git clone prints the
directory as `path` and its `commit`. `type` is the detected format (`pdf`, `docx`, `xlsx`, `png`...),
from the file's bytes, not its name.

- `--name` saves it under another name. Fetching the same bytes under the same name again reuses the
  file; different bytes under a name already taken get `name-2.ext`.
- `--kind` says what the source is when the guess would be wrong, such as a GitHub page you want as a
  page (`--kind http`) rather than a clone.
- `--export` picks what a Google Doc, Sheet or Slides file becomes. Docs: `docx` (the default), `pdf`,
  `md`, `txt`. Sheets: `xlsx` (the default), `csv`, `pdf`. Slides: `pptx` (the default), `pdf`, `txt`.
  A stored Drive file (a PDF, an upload) is fetched as it is.
- `--branch` clones that branch or tag. `--token-secret <secret id>` clones a private repository with
  a token kept in Secret Manager; the token never appears in the command, the record or the clone.
- A Drive folder is not a file: list it with `drive-find --folder <link>` (the drive skill), then fetch
  the files you need one by one.

### file-read: read a file as text

`file-read <path> [--pages <1-3,5>] [--sheet <name or number>] [--slides <2,4>] [--format md|text] [--max <chars>]`

| File | What you get |
|---|---|
| PDF | The text layer, page by page (`<!-- page N -->` markers), columns kept with spaces. `--pages` picks pages |
| Word (.docx, .doc), OpenDocument text, RTF | Markdown with headings, lists and tables. Images are left out; tracked changes show accepted |
| Excel (.xlsx, .xls), OpenDocument spreadsheet, CSV, TSV | Each sheet as a Markdown table (`--format text`: as CSV). `--sheet` picks one sheet by name or number |
| PowerPoint (.pptx, .ppt), OpenDocument presentation | Each slide's title, text, tables, picture descriptions and speaker notes. `--slides` picks slides |
| HTML | Markdown of the page's content |
| Markdown, text, JSON | As they are |
| ZIP | The list of files inside |
| An image | Its type and size in pixels. To see it, use the viewImage tool (PNG, JPEG, WebP), after `file-convert <path> png` for any other type |

The first line says what the file is and what was selected, such as
`[report.pdf: PDF, 12 pages; pages 1-3]`. Closing lines in brackets say what was cut and what the
reading leaves out. Output stops at 40000 characters unless `--max` says otherwise: read a long file in
parts with `--pages`, `--sheet` or `--slides` rather than raising `--max` far.

Selections are 1-based: `3`, `1-3`, `2,4,7-9`, `5-` (to the end).

### file-convert: change a file's format

`file-convert <path> <format> [--out <path>] [--pages <1-3,5>] [--sheet <name or number>] [--max-side <px>] [--size <width>x<height>]`

`file-convert --merge <a.pdf> <b.pdf> [<more.pdf> ...] [--out <path>]` merges PDFs in that order.

`file-convert --list` prints every conversion.

| From | To |
|---|---|
| docx | pdf, html, md, txt, png |
| doc, odt, rtf | docx, pdf, html, md, txt, png |
| md | docx, pdf, html, txt, pptx, png |
| html | docx, pdf, png, md, txt |
| xlsx | csv, pdf, png |
| xls, ods | xlsx, csv, pdf, png |
| csv | xlsx, pdf |
| tsv | xlsx, csv |
| pptx | pdf, png |
| ppt, odp | pptx, pdf, png |
| pdf | md, txt, docx, png, pdf (with `--pages`: those pages only) |
| png, jpg, webp | png, jpg, webp, pdf (the same format with `--max-side`: a smaller copy) |
| gif, svg, bmp, tiff | png, jpg, webp, pdf |

It prints `{ "from", "to", "outputs": [{ "path", "name", "type", "size" }], "notes" }`. Read the
notes: they say what the conversion lost.

- Without `--out`, the result goes next to the source with the new extension. `--out` names the file,
  or a directory to put it in.
- **To PNG**, a PDF, document, workbook or presentation becomes one image per page or slide:
  `<name>-1.png`, `<name>-2.png`... next to the source, or in the directory `--out` names. `--pages`
  picks which pages or slides. This is how you look at a page or a slide: render it, then open the PNG
  with the viewImage tool.
- **An image too large for the viewImage tool**: `file-convert <path> jpg --max-side 2000` makes a
  smaller JPEG (the longest side at most 2000 pixels; any value up to 8000). `--max-side` works for
  any PNG, JPEG or WebP output, and PDF pages too.
- A workbook to CSV makes one file per sheet (`<name>-<sheet>.csv`) unless `--sheet` picks one.
- HTML to PNG is a screenshot of the first 1280 x 1600 pixels; `--size 1600x900` changes the window.
- A PDF's pages into a new PDF: `file-convert big.pdf pdf --pages 3-7 --out chapter.pdf`.

### file-make: build a file from what you wrote

`file-make <format> --from md|html|csv|json (--in <path> | --stdin) --out <name> [--title <title>] [--reference-doc <file>]`

| From | Makes |
|---|---|
| md | docx, pdf, html, pptx |
| html | pdf, png, docx |
| csv | xlsx |
| json | xlsx, csv |

It prints `{ "path", "name", "type", "size", "notes" }`.

- Write long or quoted source to a file and pass `--in`, or pass it in the runCommand tool's `stdin`
  field with `--stdin`. Never inline a document in the command.
- Markdown is GitHub Markdown: headings, lists, tables, links, code, images by relative path (from
  the `--in` file's directory, or the working directory with `--stdin`).
- **PDF and HTML** get a clean default style: readable type, ruled tables, A4 pages with margins.
- **PowerPoint**: give each slide a `#` heading (or use `#` for section titles and `##` for the
  slides under them); a line with `---` also starts a new slide. Keep each slide short.
- `--title` sets the document's title: a title line in Word, a title slide in PowerPoint, the page
  title in HTML and PDF, the sheet name in a one-sheet workbook. Leave it out when your Markdown starts
  with its own heading.
- `--reference-doc` takes a `.docx` (for Word) or `.pptx` (for PowerPoint) and gives the output its
  styles: fonts, colors, heading styles, slide masters. Use the organization's own template when they
  gave you one.
- **Excel** from CSV: the first row is the header, in bold and frozen; plain numbers become numbers,
  everything else stays text (an id like `007` stays `007`). Columns are sized to fit.
- **Excel** from JSON: an array of objects (their keys are the columns), an array of arrays (the first
  is the header), or an object whose values are such arrays (one sheet per key). A string starting
  with `=` is a formula, like `"=SUM(B2:B9)"`.
- JSON to CSV takes one table.

### file-share: hand a file back

`file-share --mission <mission id> <path> [--name <name>] [--drive [<folder link or id>]]`

Uploads the file as a download on the mission and records it. The dashboard lists it on the mission,
and your reply to the person carries it as an attachment. It prints
`{ "name", "size", "gcs_path", "file_id", "drive" }`.

- `--mission` may be left out when the file is inside the mission tree.
- `--name` gives the download another name (`--name "Q3 report.docx"`). Sharing the same name again
  replaces the earlier download: the latest wins.
- `--drive` also saves the file to Google Drive, in the folder given or else in the output folder a
  dashboard admin set. It is always a new Drive file: nothing already in Drive is changed or
  replaced. `drive` in the result then holds its `file_id` and `link`; give the person the link.
- It refuses credentials, the instance's own configuration and files over the instance's share cap
  (files.max_mb). Share a large result in parts, or compress it
  (`python3 -m zipfile -c result.zip <files>`).
- Your reply carries up to 20 shared files as attachments, the ones you shared first; the mission's
  downloads list shows them all.

## Drive: a source and a destination, never a workspace

- **Read** a Drive file by fetching a copy (`file-get <drive link>`, or the drive skill's `drive-get`
  and `drive-export`), and work on the copy in the inbox.
- **Hand back** results as new files: a download with `file-share`, and a new Drive file as well with
  `file-share --drive` (or the drive skill's `drive-put`).
- **Never edit, move, rename, trash or delete a file someone shared with you**, even when you have
  Editor access, and even when asked to "update the doc". Make the new version, share it as a new
  file, and say so: "Here is the revised plan as a new file; the original is unchanged."

## What is lossy

| Conversion | What is lost |
|---|---|
| PDF to text, Markdown or Word | Everything but the text: layout, images, tables (they come out as aligned text) and fonts. A PDF to Word is a text-level rebuild, not a copy |
| A scanned PDF | It has no text layer: reading gives nothing. Render the pages to PNG and look at them |
| Word to Markdown, text or HTML | Images, headers, footers and comments |
| Word, Excel or PowerPoint to PDF or PNG | Rendered by LibreOffice: fonts missing on this host are substituted, so line breaks can shift |
| Excel to CSV, and reading Excel | Values only, as last calculated and saved: no formulas, formatting or charts. A formula no program ever calculated reads as empty |
| CSV to Excel | Types are guessed: plain numbers become numbers, all else text |
| Markdown to PowerPoint | pandoc's plain design, unless `--reference-doc` gives one |
| Reading PowerPoint | Text only: layout, styling and the pictures themselves are not read (render the slide to see it) |
| To JPEG | Transparency becomes white |
| GIF, TIFF | Only the first frame or page converts |
| HTML to PNG | Only the first screen (see `--size`) |

## Limits

- A download (`file-get`) is capped by the instance's download cap (files.fetch_max_mb); the error
  says the size.
- A shared file (`file-share`) is capped by files.max_mb.
- One conversion may run for files.tool_timeout_seconds. A conversion that runs out of time is not a
  failed file: try fewer pages, one sheet, or a smaller file.
- `file-read` prints at most 40000 characters unless `--max` raises it.

## Error recovery

| Symptom | Cause | What to do |
|---|---|---|
| `there is no running mission '<id>'` | The id is wrong | Use the last part of the mission tree's path |
| `HTTP 403` or `HTTP 404` from `file-get` on a link | The site refuses automated downloads, or the file moved | Find another source; don't retry in a loop |
| `may not read gs://...` | The agent's account has no access to that bucket | Ask the person to share the object, or the bucket with the agent's service account |
| A Drive error naming an address | The file is not shared with you | Tell the person the exact address to share it with (`drive-find --whoami`) |
| `cloning ... failed` | A private repository, or a wrong URL | For a private one, `--token-secret <secret id>` with a token a dashboard admin stored |
| `cannot convert X to Y` | That conversion does not exist | Use one it lists, or convert in two steps (for example to PDF, then PNG) |
| `... is not installed on this host` | The file toolchain is missing on the VM | Report it: it is an installation problem you cannot fix |
| `did not finish within N seconds` | A big file or many pages | Narrow it: `--pages`, `--sheet`, or split the PDF first |
| Empty text from a PDF | A scanned PDF | `file-convert <pdf> png --pages 1-3`, then look at the pages with viewImage |
| `not shared: ... is a credential` | The path is a key or the instance's configuration | Never share it |
| `no Drive output folder is set` | A service account can create Drive files only in a shared drive | Pass `--drive <folder in a shared drive>`, or share without `--drive`: the download still reaches the person |
