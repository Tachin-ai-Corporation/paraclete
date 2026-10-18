# Skill: Google Drive

## When to use

When a request points at Google Drive: a `docs.google.com` or `drive.google.com` link, a file or folder
someone says they shared with you, or a result they want saved to Drive.

## The rule: Drive is where files come from and go to, never where you work

- **Read** a Drive file by bringing a copy into the mission: `drive-get` for a stored file (PDF, Word,
  Excel, PowerPoint, image, CSV), `drive-export` for a Google Doc, Sheet or Slides file. The copy lands
  in the mission's inbox. Read and change the copy there with the files skill.
- **Hand back** results as new files. Every result goes to the person as a download from the mission
  (the files skill's `file-share`). When they want it in Drive too, `drive-put` saves it as a new
  Drive file and prints its link.
- **Never edit, move, rename, trash or delete anyone's Drive file**, even one shared with you as
  Editor, and even when asked to "update the doc". Make the new version, deliver it as a new file, and
  say so: "Here is the revised plan as a new file; the original is unchanged."

## Who you are on Drive

`drive-find --whoami` prints the address you act as. It is one of two:

| | A service account (most roles) | Your own Workspace account (Workspace roles) |
|---|---|---|
| Address | `paraclete-agent@<project>.iam.gserviceaccount.com` | Your Google address in the organization |
| How people share with you | In Drive: Share, add your address. Viewer is enough to read | The same, like sharing with a colleague |
| Where you can create files | Only inside a shared drive you are a member of: a service account has no Drive storage of its own | Your own My Drive, or a folder shared with you as Editor |

When you cannot see a file someone mentioned, it has not been shared with you. Tell them the exact
address to share it with.

Some organizations block sharing with addresses outside their domain, and that blocks sharing with a
service account too. If someone says Drive refused your address, there are three ways out: they put the
file in a shared drive you are a member of; a Workspace admin allows sharing with your address; or the
instance is installed with a Workspace role, which gives you an account inside the organization. A
dashboard admin can run the Drive check in Settings to see what you can reach.

## Commands

Every command takes a Drive link (a Docs, Sheets or Slides link, a `drive.google.com` file or folder
link, an `open?id=` link) or a bare file id. Your mission id is the last part of your mission tree's
path. `--json` prints the result as JSON instead of lines.

- `drive-find [<words>] [--name <words>] [--type <type>] [--folder <link or id>] [--drive <shared drive id>] [--shared-with-me] [--limit <n>] [--json]`
  lists the files you can see, newest first (by relevance when you give words): each one's name, type,
  id, modified date, owner and link. `<words>` searches names and content, `--name` names only.
  `<type>` is `doc`, `sheet`, `slides`, `folder`, `pdf`, `docx`, `xlsx`, `pptx`, `csv` or a MIME type.
  `--folder` lists one folder's files; `--drive` searches one shared drive; `--shared-with-me` only
  files shared with you directly. At most 25 by default (`--limit` up to 200); it says when more match.
- `drive-find --whoami` prints the address you act as on Drive, and how people share with it.
- `drive-find --drives` lists the shared drives you are a member of, and whether you can add files to
  each.
- `drive-get <link or id> --mission <mission id>` downloads a stored file into the mission's inbox,
  `<mission tree>/missions/<mission id>/inbox/`, under its Drive name. `--out <path>` saves it to a
  path on the VM instead (a path ending in `/` is a directory). Prints the path, type, size and
  sha256. A Google Doc, Sheet or Slides file has no stored bytes and is refused, with the
  `drive-export` command to use instead. Fetching the same file again replaces the earlier copy.
- `drive-export <link or id> --format <format> --mission <mission id>` exports a Google Doc, Sheet or
  Slides file into the mission's inbox as `<name>.<format>` (`--out <path>` works as for `drive-get`).
  The formats: a Doc to `docx`, `pdf`, `md` or `txt`; a Sheet to `xlsx`, `csv` (the first sheet only)
  or `pdf`; Slides to `pptx`, `pdf` or `txt`. Google exports at most 10 MB per file.
- `drive-put --mission <mission id> <path> [--folder <link or id>] [--name <name>] [--convert] [--json]`
  creates a new Drive file from a file of yours and prints its id and link. A relative `<path>` starts
  from the mission tree. Without `--folder`, it goes to the Drive output folder a dashboard admin set
  in Settings. `--name` names it (default: the file's name). `--convert` makes it a Google file: a
  `.docx`, `.md`, `.txt` or `.html` becomes a Doc, an `.xlsx` or `.csv` a Sheet, a `.pptx` Slides. It
  only ever creates: putting a file of the same name again makes a second file and leaves the first
  alone.

## Procedures

### Read a Google Doc, Sheet or Slides file

1. `drive-export <link> --format md --mission <mission id>` for a Doc; `--format xlsx` for a Sheet
   (every sheet); `--format pptx` or `txt` for Slides.
2. Read the printed path with the files skill: `file-read <path>`.
3. Quote what you use from it as coming from that file, by name.

### Read a PDF or office file stored in Drive

1. `drive-get <link> --mission <mission id>`.
2. `file-read <path>`.

### Find a file someone mentioned without a link

1. `drive-find "<words from its name or content>"`, or `--name` when you know part of the name.
2. Several matches: pick by owner and date, or ask which one they meant. None: it is not shared with
   you; tell them your address (`drive-find --whoami`).

### Hand a result back in Drive

1. Make the file in the mission tree with the files skill.
2. Share it as a download (`file-share`), as for every result.
3. If the person wants it in Drive: `drive-put --mission <mission id> <path>` (with `--folder <link>`
   when they named a folder, `--convert` when they want a Google Doc, Sheet or Slides file).
4. Give them the printed link, and say it is a new file.

## Error recovery

| Symptom | Cause | What to do |
|---|---|---|
| `Drive has no file ... that <address> can see` or `is not allowed to read` | The file is not shared with you, or the link is wrong | Ask the person to share it with your address (Viewer is enough), or to check the link |
| `turned off downloading` | Its owner stopped viewers from downloading, printing and copying it | You cannot read it. Ask the owner to give you Editor access or to allow downloads |
| `is a Google Doc ... Export it instead` | `drive-get` on a Google file | Run the `drive-export` command it prints, with a format it lists |
| `exports to ..., not ...` | That format does not fit that kind of file | Use one of the formats listed |
| `Google exports at most 10 MB` | The export is too large | Try `pdf`; for a Sheet, `csv` holds only the first sheet; otherwise ask the owner for a smaller part |
| `more than the ... MB a download may be` | The file is over the download limit | Tell the person; ask for a smaller file or the part you need |
| `no Drive output folder is set` or `has no Drive storage of its own` | As a service account you can create files only in a shared drive | Pass `--folder` with a folder in a shared drive you can add files to (`drive-find --drives`), or ask a dashboard admin to set the output folder. The download still reaches the person |
| `is not allowed to create a file in folder` | You are not an Editor there (Content manager in a shared drive) | Ask the folder's owner for Editor access, or the shared drive's manager to make you a Content manager |
| `The organization's Drive policy does not allow` | An admin's policy | Tell the person; there is no way around it from here |
| `Drive API is turned off`, `lacks the Drive scope`, `Cannot get a Drive token` | The instance's Drive access is not set up | Report the message to the person and ask a dashboard admin to run the Drive check in Settings. Don't retry in a loop |
| `Drive is limiting requests` | Too many requests in a short time | Wait a minute, then retry once |
