# roles/security-engineer/

An agent that watches the security posture of the organization's Google Cloud project, read-only: who holds
which access, who can act as which service account, keys and their age, what is open to the internet or to
everyone, bucket protections, organization policies and recent access changes. It reports findings with
evidence and a remediation with its undo, and never changes what it audits.

| Part | Security Engineer |
|---|---|
| Purpose | Access reviews, posture audits, exposure checks, and a weekly look at what changed |
| Channel | Dashboard chat |
| Skills | The base skills, plus `iam-audit` (below) |
| Organ prompts | Appends for the cortex (decides each step), the motor (executes) and the cerebellum (verifies): security reviews never change what they audit, even with approval; findings carry proof; severity follows the evidence; least privilege is the measure; accepted risks stay visible; any changing command in the tool log fails the audit |
| Responsibilities | `r-security-review`: Mondays at 06:00 UTC, the read-only audit compared with last week's (below) |
| Processes | `p-security-audit`, on top of generic's (`p-audit`, `p-investigate` and the rest) |
| GCP roles | The generic base set, plus the four read-only roles below |
| APIs | Cloud Asset and Recommender, turned on by the installer |
| Workspace | No |

## What it adds to generic

| Skill | For | Runs |
|---|---|---|
| `iam-audit` | Nine checks, each saving its raw evidence: project access, who can act as each service account, user-managed keys and their age, bindings open to everyone (Cloud Asset search, or bucket by bucket and service by service), firewall rules open to the internet, bucket protections, organization policies in force, the week's access changes from the audit logs, and Google's IAM recommendations. Findings rated by evidence, with a remediation and its undo for a person to run, and a comparison with the previous audit | `gcloud`, `jq` |

It has no commands of its own. Its list of commands it never runs backs up what IAM already enforces: none
of its roles can change anything.

## GCP roles

Granted on the project to `paraclete-agent@` by the installer, on top of the generic base set. All four are
read-only:

| Role | Why |
|---|---|
| `roles/iam.securityReviewer` | Read every IAM policy (the project's, each service account's, each bucket's and service's); list service accounts, their keys, firewall rules, the organization policies set, IAM recommendations and log entries |
| `roles/cloudasset.viewer` | Search every IAM policy in the project at once: the one query that finds `allUsers` and `allAuthenticatedUsers` wherever they are |
| `roles/orgpolicy.policyViewer` | The effective value of an organization policy (`orgpolicy.policy.get`, which `iam.securityReviewer` lacks) |
| `roles/storage.bucketViewer` | Bucket settings such as public access prevention and uniform access (`storage.buckets.get`, which `iam.securityReviewer` lacks) |

Not granted: anything that changes a policy, an account, a key, a rule or a bucket. Remediations are for a
person, who runs them with their own access.

## What it needs at install

The installer turns on the two APIs the audit uses (`apis` in `role.json`): the **Cloud Asset API**, for
the project-wide search of public bindings, and the **Recommender API**, for Google's unused-role
recommendations. Turning an API on grants no access. On an instance installed before the installer did
this, the agent checks buckets and Cloud Run services one by one and skips the recommendations, saying
so, until a person re-runs `install/install.sh`.

A person tells the agent the organization's domain, the public resources that are intended, and any
accepted risks: the agent asks on its first audit.

## Setup packages

None beyond the generic role's: `gcloud` comes with Debian 12's Compute Engine image, and `jq` with the
generic role.

## Package files

| File | Holds |
|---|---|
| `role.json` | The role record: no Workspace, the `iam-audit` skill, the four GCP roles, the two APIs, no extra packages |
| `prompts/cortex.md`, `prompts/motor.md`, `prompts/cerebellum.md` | The role's domain rules, appended to those organs' base prompts |
| `skills/iam-audit/` | The skill above: `SKILL.md` and `skill.json` |
| `responsibilities.json` | `r-security-review` |
| `processes/p-security-audit.json` | Scope, collect raw evidence, compare, rate by evidence, remediations with their undo |
| `memory.md` | The agent's first working memory |

## The weekly review

`r-security-review` runs on Mondays at 06:00 UTC, following `p-security-audit` and the skill's checks. It
reads only, saves its evidence, compares with the previous week's report, and puts what changed first. Its
report ends with the inventory (members and roles, keys, public bindings, open firewall rules) the next
week's review compares against. It ships turned on because it is safe and useful from the first week. Its
report is a dashboard notice. To change its day or turn it off, ask the agent, or use the dashboard.
