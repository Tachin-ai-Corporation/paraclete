# roles/web-master/

An agent that looks after the organization's websites on Firebase Hosting: it changes pages and copy,
shows every change on a preview link first, releases to the live site only after approval, connects custom
domains, and audits a site to propose the few improvements that matter most.

| Part | Web Master |
|---|---|
| Purpose | Page and copy changes, previews and releases, rollbacks, custom domains, site reviews, and diagnosing a site that serves badly |
| Channel | Dashboard chat |
| Skills | The base skills, plus `firebase-hosting`, `custom-domains`, `site-audit` and `site-gcloud` (below) |
| Organ prompts | Appends for the cortex (decides each step), the motor (executes) and the cerebellum (verifies): a deploy passes only on a live 2xx of the whole page; preview first, live after approval of what was seen; match the work to the ask; propose, never impose; hierarchy and the site's design first, with real copy; discover before naming; investigate a symptom first |
| Responsibilities | None: the agent knows no site at install. A weekly check of a site is one request away (`responsibility-manage create`) |
| Processes | `p-site-change` and `p-site-review`, on top of generic's (`p-deploy-verify`, `p-release`, `p-investigate` and the rest) |
| GCP roles | The generic base set, plus the three below |
| APIs | Firebase Hosting and Firebase Management, turned on by the installer |
| Workspace | No |

## What it adds to generic

| Skill | For | Runs |
|---|---|---|
| `firebase-hosting` | The road from source to live: a page edit checked by rendering it at phone and desktop widths, a preview channel, release of the approved version by cloning it, verification of the whole page, rollback through the releases API, and walking a broken URL back to its origin | `firebase`, `curl`, `file-convert`, `chromium` |
| `custom-domains` | Registering a domain with a site through the Hosting API, handing a person the exact DNS records, and checking until it serves over HTTPS | `curl`, `jq`, `dig`, `openssl` |
| `site-audit` | Reviewing a site as a visitor sees it (screenshots, Lighthouse, links, previews for search and social), ranking findings, and a short proposal with the first one on a preview link | `chromium`, `lighthouse`, `curl` |
| `site-gcloud` | Read-only: the Cloud Run services behind a site's rewrites, their state and logs, and a token for Firebase's REST APIs | `gcloud` |

None has commands of its own. Editing and committing a site's source uses the base `system-shell`,
`git-repos` and `git-artifacts` skills; files fetched from Drive use the base `drive` skill. Code work on a
site is the page-edit procedure in `firebase-hosting`; a full coding workflow (tests, pull requests) is the
Software Engineer role's.

## GCP roles

Granted on the project to `paraclete-agent@` by the installer, on top of the generic base set:

| Role | Why |
|---|---|
| `roles/firebasehosting.admin` | Hosting sites, preview channels, deploys, releases and rollbacks, and custom domains through the `customDomains` API |
| `roles/run.viewer` | Read the Cloud Run services a site's rewrites send traffic to, when it serves badly |
| `roles/logging.viewer` | Read those services' logs |

Not granted: deploying or changing backends (the DevOps Engineer role's work), IAM, and DNS, which stays
with whoever hosts the domain.

## What it needs at install

- **Firebase on the project:** `firebase projects:addfirebase <project>` by someone with Firebase Admin,
  once. The installer turns on the Firebase Hosting and Firebase Management APIs (`apis` in `role.json`),
  which alone does not add Firebase to a project. Sites in another project need Firebase, these APIs
  and these grants in that project.
- **The sites it looks after:** project, site id, source, live URLs and design system. The agent asks on
  its first request and keeps them in each site's project context.
- **For custom domains:** someone who can add records at the domain's DNS provider.

## Setup packages

| Kind | Packages | For |
|---|---|---|
| Debian | `bind9-dnsutils` (`dig`), `openssl` | A domain's records, and a site's TLS certificate |
| npm | `firebase-tools@15.32.1` | The Firebase CLI, pinned (published 2026-09-30) |
| npm | `lighthouse@13.5.0` | Performance, accessibility, best-practice and SEO audits, run with the generic role's Chromium (published 2026-09-18; needs Node 22.19 or later) |

`gcloud` is not listed: Debian 12's Compute Engine image has the Google Cloud CLI. To move a pin, choose a
release at least two weeks old, in its own commit, and check a preview deploy and a Lighthouse run with it.

## Package files

| File | Holds |
|---|---|
| `role.json` | The role record: no Workspace, the four skills, the three GCP roles, the two APIs, the packages above |
| `prompts/cortex.md`, `prompts/motor.md`, `prompts/cerebellum.md` | The role's domain rules, appended to those organs' base prompts |
| `skills/firebase-hosting/`, `skills/custom-domains/`, `skills/site-audit/`, `skills/site-gcloud/` | The skills above: `SKILL.md` and `skill.json` each |
| `responsibilities.json` | Empty |
| `processes/p-site-change.json` | Source, render check, preview, approval, release, live verification |
| `processes/p-site-review.json` | Review as a visitor, rank, a few proposals, the first on a preview link |
| `memory.md` | The agent's first working memory |
