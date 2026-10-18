# Skill: Firebase Hosting

## When to use

When a website on Firebase Hosting changes, or misbehaves: a page or its copy edited, a change shown on a
preview link, a release to the live site, a rollback, a URL that serves the wrong thing. Custom domains
are the custom-domains skill's; reviewing a whole site is the site-audit skill's. There are no commands of
its own: you run the `firebase` CLI, `curl`, `jq` and the files skill's `file-convert`.

## The CLI on this machine

- `firebase` authenticates as this machine's service account by itself: never `firebase login`, never
  `--token`. Pass `--project <project>` on every command and `--non-interactive` where it could ask.
- **Never run `firebase init`.** It only asks questions; with nobody to answer, it hangs. Write
  `firebase.json` yourself.
- `firebase` reads `firebase.json` from the current directory, and each command starts in your
  workspace: `cd <site dir> && firebase ...` in one command.
- A project can hold several sites, and a site's id is often not the project's. Find it:
  `firebase hosting:sites:list --project <project>`. Deploy commands have no `--site` flag: the site is
  `"site"` in `firebase.json`, and without it a deploy goes to the project's default site.

```json
{
  "hosting": {
    "site": "<site>",
    "public": "public",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"]
  }
}
```

When the project is not a Firebase project yet (`hosting:sites:list` says so), a person adds Firebase to
it; your account cannot.

## Where the site comes from

Deploy only the site's reviewed source: its repository (cloned with the git-repos skill, or the mission's
working tree when the site is a project of yours), or the files the person named (a Drive folder fetched
with the drive skill). Never deploy scratch files from your workspace. The project's context should name
the site id, the project, the source and the live URLs; when it does not, find them, confirm them with the
person, and have them recorded there.

A deploy replaces everything the channel served. Before any deploy, check the directory holds the whole
site: `test -s <public>/index.html`, and `find <public> -type f | wc -l` against the source. A fetch that
failed or came back empty is fetched again, never deployed.

## Procedures

### Change a page

1. Read the page whole, and the site's styles and components, before editing: the change matches what is
   there (its colors, type, spacing, voice).
2. Edit the real file in place, surgically (the system-shell skill: no inline `sed` over text with
   quotes). Write real copy, never placeholder text.
3. Check the structure: as many `<style>` as `</style>`, as many `<script>` as `</script>`, and `<head>`,
   `</head>`, `<body>`, `</body>` present and in order.
4. Render it and look, at a phone's width and a desktop's:
   `file-convert <public>/<page>.html png --size 390x844 --out <mission tree>/missions/<mission id>/renders/mobile.png`,
   the same with `--size 1280x900` for desktop (the files skill), then open each with the viewImage tool.
   Your change shows; nothing else went blank, overflowed or shows stray characters. A page whose
   styles or scripts load from its own server is rendered from the preview channel instead (step 2 of
   the next procedure).
5. Commit the change to the site's source (the git-repos or git-artifacts skill).

### Show it on a preview channel, then release it

1. Deploy to a preview channel:
   `cd <site dir> && firebase hosting:channel:deploy <channel> --expires 7d --project <project> --json`.
   Its JSON carries the preview `url`. Preview channels are yours to use: deploy to them freely.
2. Verify the preview (Verify a URL, below), and render it at both widths:
   `chromium --headless=new --no-sandbox --disable-gpu --window-size=390,844 --screenshot=<png> <url>`.
3. Give the person the preview link, verbatim, and wait for their approval. A step that deploys a
   preview never also releases to live.
4. After approval, release the exact version they saw:
   `firebase hosting:clone <site>:<channel> <site>:live --project <project>`.
5. Verify live, on the site's default URL and on each custom domain.

### Verify a URL

A 200 alone proves little: a page can answer and be blank, half-shipped, or the Firebase placeholder.

1. `curl -sS -o /tmp/page.html -w '%{http_code} %{size_download}\n' --max-time 15 <url>`: a 2xx, and a
   size close to the source file's.
2. `grep -c '<a phrase from near the end of the page>' /tmp/page.html`: the page arrived whole.
3. `grep -nF "\\'" /tmp/page.html` prints nothing: no quotes escaped into the markup by an edit.
4. For a site with more pages or images, fetch two of them as well.
5. Report the URL, the status, the size and what you checked.

### Roll back the live site

1. The live channel's recent releases, newest first:

   ```bash
   curl -sS -H "Authorization: Bearer $(gcloud auth print-access-token)" \
     "https://firebasehosting.googleapis.com/v1beta1/sites/<site>/channels/live/releases?pageSize=5" \
     | jq -r '.releases[] | [.releaseTime, .version.name, (.message // "")] | @tsv'
   ```

2. Release the last good version again (after approval, unless the person asked for this rollback):
   `firebase hosting:clone <site>@<version-id> <site>:live --project <project>`, where the version id is
   the last part of `sites/<site>/versions/<version-id>`.
3. Verify live.

### Diagnose a URL that does not serve what it should

Walk the request from the visitor back to the origin, discovering each name as you go:

1. **Reproduce:** `curl -sS -D- -o /dev/null <url>`. A 404 from Hosting, a 404 or 5xx from a backend,
   and an old page answering 200 are different faults.
2. **Read the configuration** in the deployed source's `firebase.json`: does a `redirects` or `rewrites`
   entry match the path? Static paths serve from `public`; a `run` rewrite sends the path to a Cloud Run
   service (the site-gcloud skill reads its state and logs).
3. **Find the first hop that lacks the content:** missing from `public` means it never shipped; present
   in the backend's answer but not through Hosting means the rewrite; right everywhere but old means the
   CDN's cache (minutes), or a release that did not happen (read the releases).
4. Report the failing hop with its evidence. A fix is a change like any other: preview, approval,
   release.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `Not in a Firebase project directory` | No `firebase.json` in the current directory | `cd <site dir> && ...` in the same command |
| `unknown option '--site'` | Deploys take the site from `firebase.json` | Put `"site"` in the `hosting` object |
| A command hangs until it is stopped | `init`, or a prompt without `--non-interactive` | Never `init`; add `--non-interactive` |
| `Failed to authenticate` | The machine's credentials did not answer | Check with `gcloud auth print-access-token > /dev/null`, then try again; never log in |
| Deploy reports 0 files | `public` points at the wrong directory | Fix it, relative to `firebase.json` |
| The URL serves the Firebase welcome page or `Site Not Found` | A placeholder, or nothing, went to that site | Check the site id and the deployed directory; deploy the real source |
| A preview channel suddenly serves nothing | An empty directory was deployed over it | Fetch the source again, check it, deploy again |

## Safety

- Preview channels are free; a release to `live`, by clone or by `firebase deploy`, waits for the
  person's approval of what they saw, and you write down the version to roll back to first.
- Never deploy to a site you did not identify by id in this mission.
- `firebase hosting:disable`, deleting a site or channel that people use, and removing a domain take a
  site offline: only with an approval that names them.
