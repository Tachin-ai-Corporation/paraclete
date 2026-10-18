# Skill: Firebase

## When to use

When the work deploys or inspects a site on Firebase Hosting: its sites and channels, `firebase.json`,
a preview deploy, a release to live, a promotion of a reviewed version, a rollback, or a path routed to
a Cloud Run service. There are no commands of its own: you run the `firebase` CLI, `curl` and `jq`.

Out of scope: Cloud Functions (your account cannot deploy them), and Firestore rules or indexes on this
project, whose `(default)` database is the instance's own.

## The CLI on this machine

- `firebase` authenticates as this machine's service account by itself. Never run `firebase login`, and
  never pass `--token`.
- Pass `--project <project>` on every command, and `--non-interactive` on anything that could ask a
  question. **Never run `firebase init`**: it only asks questions, and with nobody to answer it hangs
  until the command is stopped. Write `firebase.json` yourself (below).
- `firebase` reads `firebase.json` from the current directory, and each command you run starts in your
  workspace, so change directory in the same command: `cd <site dir> && firebase ...`. Commands that need
  the file fail with `Not in a Firebase project directory` without it.
- Firebase must be added to the project. The installer turns on the Firebase and Firebase Hosting APIs
  for you, but that alone does not make it a Firebase project: when
  `firebase hosting:sites:list --project <project>` says the project is not a Firebase project, a person
  adds Firebase to it (`firebase projects:addfirebase <project>`, which needs more access than yours);
  ask for that.

## Sites, channels and firebase.json

A project can hold several Hosting sites, and a site's id is often not the project's id. Each site has a
`live` channel (what its domains serve) and any number of preview channels, each with its own URL.

- `firebase hosting:sites:list --project <project>` lists the sites and their default URLs.
- `cd <site dir> && firebase hosting:channel:list --site <site> --project <project>` lists a site's
  channels, with their URLs and when they expire.

The `firebase.json` in the directory you deploy from names the site. Deploy commands have no `--site`
flag: without `"site"`, a deploy goes to the project's default site, which may be someone else's.

```json
{
  "hosting": {
    "site": "<site>",
    "public": "public",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"]
  }
}
```

`public` is the directory, relative to `firebase.json`, whose files are served. To send paths to a Cloud
Run service, add rewrites (the `run` key proxies; `destination` only serves a local file):

```json
"rewrites": [{ "source": "/api/**", "run": { "serviceId": "<service>", "region": "<region>" } }]
```

## Procedures

### Deploy to a preview channel, then to live

1. **Deploy from the reviewed source,** never from scratch files: a clone of the repository at the
   commit to ship, or the directory the person named. A deploy replaces everything the channel served,
   so first check the directory holds the whole site: `test -s <public>/index.html` and
   `find <public> -type f | wc -l`. An empty or half-fetched directory is never deployed: fetch it again.
2. **Preview:**
   `cd <site dir> && firebase hosting:channel:deploy <channel> --expires 7d --project <project> --json`.
   The JSON result carries the channel's `url`. Preview channels are yours to use freely.
3. **Verify the preview** as in "Verify a URL" below, and report its URL.
4. **Release to live** only after the person approved what they saw. Promote the exact version they
   reviewed rather than deploying again:
   `firebase hosting:clone <site>:<channel> <site>:live --project <project>`.
   (`cd <site dir> && firebase deploy --only hosting --project <project> --message "<what changed>" --non-interactive`
   also releases to live, but it ships whatever the directory holds now.)
5. **Verify live** the same way, on every domain the site serves.

### Roll back the live channel

1. List the recent releases of `live`, newest first, with their versions:

   ```bash
   curl -sS -H "Authorization: Bearer $(gcloud auth print-access-token)" \
     "https://firebasehosting.googleapis.com/v1beta1/sites/<site>/channels/live/releases?pageSize=5" \
     | jq -r '.releases[] | [.releaseTime, .version.name, (.message // "")] | @tsv'
   ```

   Each version is `sites/<site>/versions/<version-id>`.
2. Release the last good one again: `firebase hosting:clone <site>@<version-id> <site>:live --project <project>`.
3. Verify live, and report which version now serves.

### Verify a URL

A status line alone proves little: a page can answer 200 and be blank, or be the Firebase placeholder.

1. `curl -sS -o /tmp/page.html -w '%{http_code} %{size_download}\n' --max-time 15 <url>`: a 2xx, and a
   size close to the source file's.
2. `grep -c '<a phrase from the end of the page>' /tmp/page.html`: the page arrived whole.
3. For a site with more pages or images, fetch two of them as well. For a rewrite, fetch a path it
   routes and confirm the Cloud Run service answered.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `Not in a Firebase project directory` | No `firebase.json` in the current directory | `cd <site dir> && ...` in the same command |
| `unknown option '--site'` on a deploy | Deploys take the site from `firebase.json` | Put `"site"` in the `hosting` object |
| `Failed to authenticate, have you run firebase login?` | The CLI could not reach the machine's credentials | Run `gcloud auth print-access-token > /dev/null` to check the account works, then try again; never log in |
| A command hangs until it is stopped | An interactive prompt (`init`, or a missing `--non-interactive`) | Never run `init`; add `--non-interactive` |
| The URL serves `Site Not Found` or the default welcome page | Nothing, or a placeholder, was deployed to that site | Check the site id in `firebase.json` and the files in `public`, then deploy again |
| Deploy reports 0 files | `public` points at the wrong directory | Fix `public`, relative to `firebase.json` |
| A rewrite to Cloud Run answers 404 or 403 | Wrong service id or region, or the service refuses unauthenticated calls | Check the service with the gcloud skill; Hosting calls it without credentials |
| A new page still shows the old content | The CDN's cache | Wait a few minutes or check with a query string; never deploy again to bust it |

## Safety

- Preview channels are free to use. A release to `live`, by deploy or clone, is a step for an approval
  gate, with the version to roll back to written down.
- Never deploy over a site you did not identify by id in this mission.
- `firebase hosting:disable` and deleting a site take a site offline: only with an approval that names
  the site.
