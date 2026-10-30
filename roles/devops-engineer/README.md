# roles/devops-engineer/

An agent that builds, ships and runs the organization's services on Google Cloud: container images built
by Cloud Build into Artifact Registry, Cloud Run services, Cloud Storage and Firebase Hosting. A deploy is
done only when the live service answers, and every production change keeps a way back.

| Part | DevOps Engineer |
|---|---|
| Purpose | Building images, deploying and rolling back Cloud Run services, moving files in Cloud Storage, releasing Firebase Hosting sites, and diagnosing what serves badly |
| Channel | Dashboard chat |
| Skills | The base skills, plus `gcloud`, `container-images`, `cloud-storage` and `firebase` (below) |
| Organ prompts | Appends for the cortex (decides each step), the motor (executes) and the cerebellum (verifies): a deploy passes only on a live 2xx; discover before naming; investigate a symptom before fixing it; every production change keeps a way back; approval before production, public access and deletion; the instance's own resources are never changed |
| Responsibilities | `r-cloud-run-review`: Mondays at 07:00 UTC, a read-only review of every Cloud Run service (below) |
| Processes | `p-rollback`, on top of generic's (`p-deploy-verify`, `p-release`, `p-investigate` and the rest) |
| GCP roles | The generic base set, plus the six project roles below, and two grants on single resources: acting as its own account, and pushing to its own image repository |
| APIs | Firebase Hosting and Firebase Management, turned on by the installer |
| Workspace | No |

## What it adds to generic

| Skill | For | Runs |
|---|---|---|
| `gcloud` | Discovery, Cloud Run deploys with a tagged candidate, traffic moves and rollbacks, following builds, Cloud Logging | `gcloud`, `curl` |
| `container-images` | Dockerfiles, built by Cloud Build as the agent's own account and pushed to its own Artifact Registry repository, `agent-images`; the image's digest for the deploy | `gcloud builds submit` |
| `cloud-storage` | Buckets and objects: listing, copying, rehearsed syncs, metadata | `gcloud storage` (`gsutil` also works) |
| `firebase` | Firebase Hosting: `firebase.json` without `init`, preview channels, promoting a reviewed version, rolling back through the releases API | `firebase`, `curl` |

None has commands of its own: each is a procedure over real CLIs. Long builds and deploys start with
`--async` and are polled, because a shell command is stopped after about two minutes.

**No Docker on the VM.** Membership of the `docker` group is root on the machine, which would let the
agent rewrite its own installed code; rootless Docker or Podman needs the setuid helpers `newuidmap` and
`newgidmap`, which the services' `NoNewPrivileges` blocks. Cloud Build builds the Dockerfile instead,
running as `paraclete-agent@` with the source staged under `builds/source/` in the instance's bucket (the
skill removes it after the build) and logs in Cloud Logging only, the pattern the dashboard's own build
uses.

## GCP roles

Granted on the project to `paraclete-agent@` by the installer, on top of the generic base set
(`role.json` `_gcp_roles_comment` repeats this):

| Role | Why |
|---|---|
| `roles/run.viewer` | Read every Cloud Run service, revision and job, the dashboard's included |
| `roles/cloudbuild.builds.editor` | Submit, read and cancel builds |
| `roles/logging.viewer` | Build logs (Cloud Logging only) and service logs |
| `roles/storage.objectUser` | Read and write objects in the project's buckets, without changing object ACLs (unlike `storage.objectAdmin`) or bucket settings |
| `roles/storage.bucketViewer` | See buckets and their settings; `gcloud builds submit` checks the staging bucket |
| `roles/firebasehosting.admin` | Hosting sites, preview channels, deploys, releases and rollbacks |

Granted on single resources, or on the project minus paraclete's own (`role.json` `resource_roles`):

| Role | On | Why |
|---|---|---|
| `roles/run.admin` | Every Cloud Run service and job but the dashboard's `paraclete` service and its update job (`project-except-paraclete`) | Deploy, update, roll back and delete Cloud Run services and jobs, and make a service public when asked: the invoker binding for `allUsers` needs `run.services.setIamPolicy`, which `run.developer` lacks |
| `roles/iam.serviceAccountUser` | `paraclete-agent@` itself (`agent-account`) | Act as its own account and no other: its builds run as it, and so do the services it deploys, unless an admin lets it use another runtime account (below) |
| `roles/artifactregistry.writer` | `agent-images` (`agent-repository`), a Docker repository the installer creates for this role in the instance's region | The only repository its builds push to: `<region>-docker.pkg.dev/<project>/agent-images/<name>` |

Act-as, Artifact Registry write and Cloud Run change are never granted on the whole project, to any
role. Project-wide, act-as would reach the dashboard's `paraclete-dashboard@`, whose signature the VM's
control service obeys, so the agent could deploy a service or a build running as that account and
command its own VM. Write would reach the dashboard's `paraclete` image repository. Cloud Run change
would reach the dashboard's service, and its update job, which runs as the dashboard's account. The
installer refuses a role that asks for any of them project-wide, and takes back one it finds there.

**What `run.admin` reaches.** It is granted on the project with the condition "not tagged
`paraclete=managed`". The installer binds that tag to the dashboard's `paraclete` service and its
update job (`install/lib/tags.sh`). So the agent can deploy, change and delete every other Cloud Run
service and job, and those it creates carry no tag. But IAM refuses it any change to those two: it can't
delete them, move their traffic, change their settings or who may reach them, or run the job. It holds
no tag permissions, so it cannot take the tag off. `run.viewer` still lets it read both. The rest of
the instance (its VM, network, accounts and bucket) is the agent's rule to leave alone, not IAM's: the
role's prompts and the `gcloud` skill forbid touching anything named `paraclete` or starting with
`paraclete-`.

An instance installed before this fence keeps the project-wide `run.admin` until an owner re-runs
`install/install.sh` on it: that run grants the fenced `run.admin`, takes back the project-wide one, and
tags the two resources.

**Not granted,** so a person does these when the work needs them, and the skills say exactly what to ask
for: creating service accounts, granting roles on the project, creating other Artifact Registry
repositories or buckets, changing bucket settings, and letting a runtime account read a secret. Cloud
Functions and Firestore rules and indexes are out of scope.

## What it needs at install

The installer turns on the Firebase Hosting and Firebase Management APIs (and Cloud Run, Cloud Build and
Artifact Registry, as for every instance), creates `agent-images` and makes the two grants above. A person
does the rest:

- **Firebase on the project,** for Hosting work: `firebase projects:addfirebase <project>` by someone
  with Firebase Admin, once. Turning the APIs on does not add Firebase to a project.
- **Runtime service accounts,** when a service should not run as the agent's own account. A service the
  agent deploys runs as `paraclete-agent@` and carries all of its access (the instance's Firestore
  database and bucket, Vertex AI, Cloud Run admin); the `gcloud` skill keeps public services off it. For
  those, an admin creates an account with only what the service needs and lets the agent act as that one
  account:

  ```
  gcloud iam service-accounts create <name> --project=<project>
  gcloud iam service-accounts add-iam-policy-binding <name>@<project>.iam.gserviceaccount.com \
    --member=serviceAccount:paraclete-agent@<project>.iam.gserviceaccount.com \
    --role=roles/iam.serviceAccountUser --project=<project>
  ```

  Never on `paraclete-dashboard@` or `paraclete-dwd@`, and never on the project. Uninstalling leaves such
  a grant behind, naming a deleted account; remove it with `remove-iam-policy-binding`.

## Setup packages

| Kind | Packages | For |
|---|---|---|
| Debian | `bind9-dnsutils` (`dig`), `openssl` | Checking a domain's records and a site's TLS certificate |
| npm | `firebase-tools@15.32.1` | The Firebase CLI, pinned (published 2026-09-30) |

`gcloud`, `gsutil` and `bq` are not listed: Debian 12's Compute Engine image has the Google Cloud CLI
installed (the `google-cloud-cli` package from Google's apt repository). To move `firebase-tools`, change
the pin to a release at least two weeks old, in its own commit, and check a preview deploy with it.

## Package files

| File | Holds |
|---|---|
| `role.json` | The role record: no Workspace, the four skills, the six GCP roles, the two single-resource grants, the two APIs, the packages above |
| `prompts/cortex.md`, `prompts/motor.md`, `prompts/cerebellum.md` | The role's domain rules, appended to those organs' base prompts |
| `skills/gcloud/`, `skills/container-images/`, `skills/cloud-storage/`, `skills/firebase/` | The skills above: `SKILL.md` and `skill.json` each |
| `responsibilities.json` | `r-cloud-run-review` |
| `processes/p-rollback.json` | Putting back the last version that worked, after approval, proved live |
| `memory.md` | The agent's first working memory |

## The weekly review

`r-cloud-run-review` runs on Mondays at 07:00 UTC. It reads every Cloud Run service's state, its traffic,
and its error and 5xx counts for the week from Cloud Logging, fetches only the services open to
unauthenticated callers, compares with the previous review, and changes nothing. It ships turned on
because it is safe and useful from the first week: an instance always has at least its own dashboard
service. Its report is a dashboard notice. To change its day or turn it off, ask the agent
(`responsibility-manage update` or `toggle`), or use the dashboard.
