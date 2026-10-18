# Skill: Container Images

## When to use

When a service needs a container image: writing or checking its Dockerfile, building it, pushing it to
Artifact Registry, and handing its digest to a deploy (the gcloud skill deploys it). There are no
commands of its own: you run `gcloud`.

**This machine runs no Docker,** and you never install it: `docker` is not here, and running it would
need the machine's root. Cloud Build builds the image from your Dockerfile, on Google's machines, and
pushes it. Everything a local `docker build` would do happens there; its log tells you what happened.

## Before you build

1. **Your repository: `agent-images`,** in the instance's region (the gcloud skill, "Who you are on
   Google Cloud", says how to find it). The installer made it for this role, and it is the one repository
   your account can push to. Check it is there:
   `gcloud artifacts repositories describe agent-images --location=<region> --project=<project>`. Never
   push to the `paraclete` repository: it holds the instance's own dashboard images, and your account
   cannot write there. When the person wants images in another repository, a person lets your account
   push to that one repository alone:
   `gcloud artifacts repositories add-iam-policy-binding <repo> --location=<region> --member=serviceAccount:paraclete-agent@<project>.iam.gserviceaccount.com --role=roles/artifactregistry.writer --project=<project>`.
   Never ask for a registry role on the whole project.
2. **The image name and an immutable tag:** `<region>-docker.pkg.dev/<project>/agent-images/<name>:<tag>`,
   where `<name>` is the service's name and the tag is the source's commit (`git rev-parse --short=12 HEAD`)
   or a UTC timestamp (`date -u +%Y%m%d-%H%M%S`). Never deploy `latest`: a tag that moves cannot be rolled
   back to. A Cloud Run service in another region of the project can run an image from this one.
3. **The Dockerfile.** Read it whole when one exists. Check, and fix only with the person's agreement:
   - the base image is pinned to a version (`node:22.12-slim`, not `node:latest`);
   - the server listens on the port in `$PORT` (Cloud Run sets it, 8080 by default);
   - the final stage runs as a user other than root (`USER`), and installs only what the service needs
     at runtime (a multi-stage build keeps compilers out of it);
   - no secret, key or `.env` file is copied in: an image layer keeps it for good. Secrets come at
     runtime (the gcloud skill's `--set-secrets`).
4. **What gets uploaded.** `gcloud builds submit` uploads the source directory, minus what
   `.gcloudignore` lists (without one, it follows `.gitignore`). Make sure `.git/`, `node_modules/`,
   build output and any credential file stay out.

## Build and push

Builds run as your own account, `paraclete-agent@`, the one account you may act as, so they push with
your access (to `agent-images`) and log to Cloud Logging only. Write this build file in your workspace,
outside the source directory:

```yaml
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-t', '${_IMAGE}', '.']
images: ['${_IMAGE}']
options:
  logging: CLOUD_LOGGING_ONLY
```

Then submit it without waiting (a build takes minutes; a command you run is stopped after about two):

```bash
gcloud builds submit <source dir> --config=<build file> \
  --substitutions=_IMAGE=<region>-docker.pkg.dev/<project>/agent-images/<name>:<tag> \
  --service-account=projects/<project>/serviceAccounts/paraclete-agent@<project>.iam.gserviceaccount.com \
  --gcs-source-staging-dir=gs://<project>-paraclete/builds/source \
  --region=<region> --project=<project> --async --format='value(id)'
```

It prints the build's id, and on stderr the `gs://` object it uploaded the source to. The source is
staged in the instance's own bucket because your account can write there; note the object's name.

1. Follow the build to a final status (the gcloud skill, "Follow a build"). On `FAILURE`, read its log:
   the failing step and its error are near the end.
2. Get the image's digest, which is what you deploy:
   `gcloud artifacts docker images describe <region>-docker.pkg.dev/<project>/agent-images/<name>:<tag> --project=<project> --format='value(image_summary.digest)'`.
   A `SUCCESS` with no image in the repository is a failure: check the `images:` line and the tag.
3. Remove the staged source: `gcloud storage rm gs://<project>-paraclete/builds/source/<object>`.
4. Report the image with its tag and digest, and the build id.

To see what your repository holds: `gcloud artifacts docker images list <region>-docker.pkg.dev/<project>/agent-images --include-tags --project=<project> --limit=20`.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `uploadArtifacts` denied, or `name unknown` at push | The image names another repository, or another region than `agent-images`' | Use `<region>-docker.pkg.dev/<project>/agent-images/...` with the instance's region. If `describe` finds no `agent-images`, report it: a person re-running `install/install.sh` creates it again |
| `does not have permission to act as service account` | The build names an account other than yours, or your grant on your own account is missing | Use exactly `paraclete-agent@<project>.iam.gserviceaccount.com`; you may act as no other. Report a missing grant: a person re-running `install/install.sh` restores it |
| `... logs bucket ...` or a logging-option error at submit | The build file lacks `logging: CLOUD_LOGGING_ONLY` | Builds that run as a chosen account must log to Cloud Logging only; add it |
| `toomanyrequests` pulling a base image | Docker Hub's rate limit | Use the same image from `mirror.gcr.io/library/<image>:<tag>` |
| The build is slow or the upload is huge | The source directory carries `node_modules/`, `.git/` or build output | Fix `.gcloudignore` and submit again |
| `docker: command not found` | You tried to build here | Build with Cloud Build, as above |

## Safety

- An image never contains a secret. If one was copied in by mistake, the image must be deleted and the
  secret rotated: tell the person at once.
- Tags never move: build a new tag for every change, and keep the previous image until the new one has
  run in production.
- Delete an image only when a person asks, after listing exactly what would go.
