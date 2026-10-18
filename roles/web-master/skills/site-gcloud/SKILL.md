# Skill: gcloud for a Website

## When to use

When a site's problem or question reaches past Hosting into Google Cloud: a path that a rewrite sends to
a Cloud Run service, that service's state and logs, or the project and identity you work as. Everything
here reads; your access to Cloud Run and logs is read-only. Deploying or changing a backend is not this
role's work: report what you found and what the fix needs. There are no commands of its own.

## Who you are

- `gcloud` and `firebase` run as this machine's service account,
  `paraclete-agent@<project>.iam.gserviceaccount.com`. Never log in or use a key file.
- The project: `gcloud config get-value project`; pass `--project=<project>` on every command.
- A token for a Google REST API (Firebase Hosting's releases and custom domains): `$(gcloud auth print-access-token)`,
  inside the command that uses it, never printed or saved.

## The backends behind a site

A `firebase.json` rewrite such as `{ "source": "/api/**", "run": { "serviceId": "api", "region": "us-central1" } }`
sends those paths to the Cloud Run service `api` in that region. Hosting calls it without credentials, so
it must allow unauthenticated calls.

| What | Command |
|---|---|
| The project's services | `gcloud run services list --project=<project>` |
| One service's state, URL and traffic | `gcloud run services describe <service> --region=<region> --project=<project> --format='yaml(status.url,status.conditions,status.traffic,status.latestReadyRevisionName)'` |
| Whether Hosting may call it | `gcloud run services get-iam-policy <service> --region=<region> --project=<project>` shows `allUsers` with `roles/run.invoker` |
| Its revisions | `gcloud run revisions list --service=<service> --region=<region> --project=<project>` |
| What it answers directly | `curl -sS -D- -o /dev/null <service url>/<path>` |

## Its logs

`gcloud logging read` takes a Cloud Logging filter: single-quote the whole filter, double-quote values
inside it, and bound the time with `--freshness=1h` (or `6h`, `1d`), never with date arithmetic.

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="<service>" AND severity>=ERROR' \
  --project=<project> --freshness=1d --limit=50 --format='table(timestamp,severity,textPayload)'
```

Requests that failed: replace the severity term with `httpRequest.status>=400` and use
`--format='table(timestamp,httpRequest.status,httpRequest.requestUrl)'`. A log line written as JSON is in
`jsonPayload`: read it with `--format=json`.

## Procedure: a rewrite that serves an error

1. Find the rewrite that matches the path in the deployed `firebase.json`, and its service and region.
2. Describe the service: is it ready, and is its newest revision the one serving?
3. Fetch the service's own URL with the same path. If it fails there too, the fault is the service: read
   its logs around the time of the failure.
4. If it answers directly but not through the site, check that `allUsers` may invoke it, and that the
   rewrite's service id and region match exactly.
5. Report the failing hop with its evidence, and what fixing it needs (a change to the service is for
   whoever runs it).

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `PERMISSION_DENIED` | The service is in another project, or the command changes something | Your access reads this project only; report what was refused |
| `NOT_FOUND` | Wrong name or region | List the services and use the region shown |
| `... API has not been used ... or it is disabled` | The API is off in the project | Report it; a person turns it on |

## Safety

Read only: never deploy, update, delete or change access on a Cloud Run service, and never touch anything
named `paraclete` or starting with `paraclete-`, which is the instance you run on.
