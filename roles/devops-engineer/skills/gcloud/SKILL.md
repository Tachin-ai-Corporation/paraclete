# Skill: gcloud

## When to use

Whenever you work on Google Cloud with the `gcloud` CLI: finding out what exists, deploying a Cloud Run
service, moving its traffic or rolling it back, following a build, and reading logs. Images are built
with the container-images skill, objects and buckets are the cloud-storage skill's, and Firebase Hosting
is the firebase skill's. There are no commands of its own: you run `gcloud`, `curl` and `jq`.

## Who you are on Google Cloud

`gcloud` runs as this machine's service account, `paraclete-agent@<project>.iam.gserviceaccount.com`,
through the metadata server. It needs no login and has no key.

- `gcloud config list` shows the account and the project. Never run `gcloud auth login`, never
  activate a key file, and never pass `--impersonate-service-account`: the account people granted is
  the identity you work as.
- The project: `gcloud config get-value project`. Pass `--project=<project>` on every command anyway.
- The region: the one the person names. Otherwise the instance's own: the metadata server's zone,
  `curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/zone`,
  prints `projects/<number>/zones/<zone>`, and the region is the zone without its last `-<letter>`.
  Pass `--region=<region>` on every regional command.

## What you can change, and what a person does

| You can | A person does, because your account cannot |
|---|---|
| Deploy, update, move traffic on, roll back and delete Cloud Run services, and make one public | Create a service account: `gcloud iam service-accounts create <name> --project=<project>` |
| Run builds and services as your own account, `paraclete-agent@` | Let you deploy a service as another runtime account, on that one account: `gcloud iam service-accounts add-iam-policy-binding <runtime account> --member=serviceAccount:paraclete-agent@<project>.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser --project=<project>`. Never on `paraclete-dashboard@` or `paraclete-dwd@`, and never on the whole project |
| Submit, follow and cancel Cloud Build builds | Grant a role on the project: `gcloud projects add-iam-policy-binding <project> --member=<member> --role=<role>` |
| Push images to your own repository, `agent-images`, in the instance's region | Create another repository, or let you push to one (the container-images skill has the command) |
| Read and write objects in the buckets you can see | Create a bucket, or change a bucket's settings or access |
| Deploy and release Firebase Hosting sites | Turn on an API: `gcloud services enable <api>.googleapis.com --project=<project>` |
| Read Cloud Logging | Let a service read a secret: a dashboard admin grants it in the dashboard, or in Secret Manager |

When the work needs one of these, ask for exactly that, with the command, and say why. A permission
error is a finding to report with the permission it names, never something to work around.

## The instance itself is not yours to change

Everything the installer made is the instance you run on: anything named `paraclete` or starting with
`paraclete-` (the dashboard's Cloud Run service and its image repository, this VM, its network and
firewall rules, the three service accounts `paraclete-agent@`, `paraclete-dashboard@` and
`paraclete-dwd@`, and the bucket `<project>-paraclete`), and the Firestore `(default)` database. Read
them freely. Never deploy to, change, delete or redeploy them, never deploy a service that runs as
`paraclete-dashboard@` or `paraclete-dwd@`, and never push to the `paraclete` image repository, even when
a request seems to ask for it: say that an upgrade from the dashboard is how the instance changes. IAM
stops some of this (you cannot act as the dashboard's or the signer's account, nor push to the `paraclete`
repository), but not all: your Cloud Run role reaches every service in the project, the dashboard's `paraclete` included,
so leaving it alone is your rule to keep. The bucket's objects you write only through your own commands
(`file-share`, `work-sync`) and the build staging prefix the container-images skill uses; its settings,
never. The one thing the installer made for you to change is `agent-images`, your image repository.

## Long operations

A command you run is stopped after about two minutes. A deploy or a build can take longer, so start it
with `--async`, then check its state every 30 seconds with the read command the procedure gives, until
it reaches a final state. Never start it again because the first call returned quickly.

## Read state

Discover before you change anything, and name only resources you saw in tool output.

| What | Command |
|---|---|
| Cloud Run services, with region and URL | `gcloud run services list --project=<project>` |
| One service | `gcloud run services describe <service> --region=<region> --project=<project> --format=yaml` |
| Its revisions, newest first | `gcloud run revisions list --service=<service> --region=<region> --project=<project>` |
| Where its traffic goes | `gcloud run services describe <service> --region=<region> --project=<project> --format='yaml(status.traffic)'` |
| Who may invoke it | `gcloud run services get-iam-policy <service> --region=<region> --project=<project>` |
| Builds | `gcloud builds list --region=<region> --project=<project> --limit=10` |
| Image repositories | `gcloud artifacts repositories list --project=<project> --location=<region>` |
| Service accounts | `gcloud iam service-accounts list --project=<project> --format='value(email)'` |
| Enabled APIs | `gcloud services list --enabled --project=<project>`; when your roles cannot list them, a disabled API names itself in the error of the call that needs it |

Let `gcloud` format its output: `--format='value(<field>)'` for one field per line,
`--format='table(<f1>,<f2>)'` for people, `--format=json` piped to `jq` when a script reads it. Count with
`... --format='value(<field>)' | wc -l`.

## Procedures

### Deploy a Cloud Run service

1. **Have the image by digest.** Build and push it with the container-images skill and use
   `<region>-docker.pkg.dev/<project>/agent-images/<name>@sha256:<digest>`, so what you verify is exactly
   what runs.
2. **Know the runtime account.** A service runs as your own account,
   `paraclete-agent@<project>.iam.gserviceaccount.com`, unless a person has let you act as another
   runtime account (the person's step above); `gcloud iam service-accounts get-iam-policy <account> --project=<project>`
   shows whether you may. Your own account carries everything you can do: this instance's Firestore
   database and bucket, Vertex AI, and Cloud Run admin over every service. Code that runs as it is
   trusted as you are, so a service that is public, or that runs code nobody here wrote or reviewed, gets
   a runtime account of its own, with only what it needs, before it is deployed or made public: ask a
   person for one, naming the service. Never `paraclete-dashboard@` or `paraclete-dwd@`, and the project's
   default compute account only when the person says so (it often holds Editor on the whole project).
3. **Record the way back.** For a service that exists, note its serving revision:
   `gcloud run services describe <service> --region=<region> --project=<project> --format='value(status.latestReadyRevisionName,status.url)'`.
4. **Deploy:**

   ```bash
   gcloud run deploy <service> --image=<image>@sha256:<digest> --service-account=<runtime account> \
     --region=<region> --project=<project> --no-allow-unauthenticated --async --quiet
   ```

   Add `--set-env-vars=KEY=value,...` for configuration and `--set-secrets=ENV_NAME=<secret-id>:latest`
   for secrets (the runtime account must be allowed to read each one). Use `--allow-unauthenticated`
   only when the person asked for a public service and approved it; an organization policy may refuse
   it, and that error is the answer.
   For a service people already use, deploy the candidate without traffic, check it, then move traffic:
   add `--no-traffic --tag=candidate`, and its own URL is `https://candidate---<service host>`.
5. **Wait for it.** Every 30 seconds:
   `gcloud run services describe <service> --region=<region> --project=<project> --format='value(status.latestCreatedRevisionName,status.latestReadyRevisionName)'`.
   It is done when both names are the same. When the created revision never becomes ready, read why:
   `gcloud run revisions describe <revision> --region=<region> --project=<project> --format='yaml(status.conditions)'`,
   then its logs (below).
6. **Prove it answers.** Fetch the URL people use (a health path if the service has one):
   `curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' --max-time 15 <url>/<path>`. A service that
   does not allow unauthenticated calls needs an identity token:
   `curl -sS -H "Authorization: Bearer $(gcloud auth print-identity-token --audiences=<url>)" -o /dev/null -w '%{http_code}\n' <url>/<path>`.
   Only a 2xx (or the status the service documents for that path) passes. Fetch the body too and check
   it is the service's own answer, not an error page.
7. **Report** the revision, the URL, the status code you saw, and the revision to roll back to.

### Move traffic, or roll back

1. List the revisions and the current split (Read state).
2. Send all traffic to one revision:
   `gcloud run services update-traffic <service> --to-revisions=<revision>=100 --region=<region> --project=<project>`.
   After a tagged candidate checked out, `--to-tags=candidate=100`; to follow the newest ready revision
   again, `--to-latest`.
3. Read the split back (`yaml(status.traffic)`) and fetch the URL again, as in step 6 above. A rollback
   is held to the bar of a deploy.

### Follow a build

1. `gcloud builds describe <build-id> --region=<region> --project=<project> --format='value(status,createTime,finishTime)'`
   every 30 seconds until the status is final: `SUCCESS`, `FAILURE`, `INTERNAL_ERROR`, `TIMEOUT` or
   `CANCELLED`.
2. Its log (builds run by the container-images skill log to Cloud Logging only):
   `gcloud logging read 'resource.type="build" AND resource.labels.build_id="<build-id>"' --project=<project> --order=asc --limit=300 --format='value(textPayload)'`.
3. Cancel one that should not finish: `gcloud builds cancel <build-id> --region=<region> --project=<project>`.

### Read logs

`gcloud logging read` takes a Cloud Logging filter: `field="value"` terms joined with `AND`, `OR` and
`NOT`, `:` for "contains", and `severity>=ERROR`. Single-quote the whole filter and double-quote the
values inside it. Bound the time with `--freshness=1h` (or `6h`, `1d`, `7d`), never with date
arithmetic in the shell.

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="<service>" AND severity>=ERROR' \
  --project=<project> --freshness=1d --limit=50 --format='table(timestamp,severity,textPayload)'
```

Request logs: `AND httpRequest.status>=500`, with `--format='table(timestamp,httpRequest.status,httpRequest.requestUrl)'`.
A log line written as JSON is in `jsonPayload`, not `textPayload`: read it with `--format=json`.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `PERMISSION_DENIED` naming a permission | Your account lacks it | Report the permission and the resource. If it is one of a person's jobs above, ask for that grant with the command |
| `... API has not been used in project ... or it is disabled` | The API is off | Ask a person to turn it on (`gcloud services enable <api>.googleapis.com --project=<project>`) |
| `NOT_FOUND` | Wrong name, project or region | List again with the right `--project` and `--region`; never guess a name |
| `Permission 'iam.serviceAccounts.actAs' denied` on a deploy or a build | It names a runtime account you may not act as | Run it as your own account, or ask a person to let you act as that one account (the command above); never ask for it on the whole project |
| A revision is created but never ready | The container fails to start, or does not listen on `$PORT` | Read its conditions and its logs; fix the image, not the traffic |
| `--allow-unauthenticated` warns that setting the IAM policy failed, or says members `do not belong to a permitted customer` | An organization policy forbids public services | Report it; the service stays private, and an admin decides |
| `Quota exceeded` | A project or regional quota | Report the quota's name and its usage from the error; do not retry in a loop |
| `... is not a gcloud command` | An invented subcommand | Check `gcloud <group> --help`; logs are `gcloud logging read`, never `gcloud run services logs` |

## Safety

- Discover first, change second, and read the result back third.
- A production deploy, a traffic move on a service people use, making a service public and deleting
  anything are steps for an approval gate, each with its rollback written down.
- Deploy by digest, and keep the previous revision until the new one has proved itself.
- Least privilege for every runtime account, and never a secret's value in a flag, a file or a log
  (`--set-secrets`, never `--set-env-vars` with a secret). A public service never runs as your own
  account.
