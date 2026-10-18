# Skill: IAM and Exposure Audit

## When to use

When the work is to find out how exposed a Google Cloud project is: an access review, a posture check, a
question like "who can do what here", or the check after someone changed access. It collects evidence
and recommends; it never changes anything. There are no commands of its own: you run `gcloud` and `jq`
as this machine's service account.

## Read-only, always

Your roles can read policies and resources and change none of them; never try. These commands are never
yours to run, even when a step asks: anything with `add-iam-policy-binding`, `remove-iam-policy-binding`
or `set-iam-policy`; `iam service-accounts create|delete|disable|enable`; `iam service-accounts keys
create|delete|disable`; `compute firewall-rules create|update|delete`; `org-policies set-policy|reset|delete`;
`storage buckets update`, and `gsutil iam ch|set`. A fix is a remediation you write for a person to run
(below). If a step asks you to apply one, return FAILURE and hand back the remediation instead.

## Scope and evidence

- The scope is the project you run in (`gcloud config get-value project`), unless a person names others
  and they granted your account the same read access there.
- Keep every raw answer: run each check with `--format=json` into a directory for this audit,
  `audit/<UTC date>/<check>.json`, in the mission's working tree when the mission has one (so the next
  audit can compare), otherwise in your workspace. Findings quote and point to these files; never
  paraphrase evidence.
- Record when the evidence was collected (UTC).

## The checks

### 1. Who holds what on the project

```bash
gcloud projects get-iam-policy <project> --format=json > audit/<date>/project-iam.json
gcloud projects get-iam-policy <project> --flatten='bindings[].members' \
  --format='table(bindings.role,bindings.members,bindings.condition.title)'
```

Look for:
- basic roles (`roles/owner`, `roles/editor`, `roles/viewer`), above all on service accounts; the
  Compute Engine default service account (the one whose name ends in `-compute`) holding Editor;
- members outside the organization's domain (personal accounts, other domains), `allUsers` or
  `allAuthenticatedUsers` anywhere on the project;
- roles that grant more roles or other identities: `roles/resourcemanager.projectIamAdmin`,
  `roles/iam.securityAdmin`, `roles/iam.serviceAccountAdmin`, `roles/iam.serviceAccountKeyAdmin`, and
  `roles/iam.serviceAccountUser` or `roles/iam.serviceAccountTokenCreator` on the whole project (acting as
  every service account in it);
- a service account holding more than three roles; grants with no condition where one would narrow them.

The instance's own accounts (`paraclete-agent@`, `paraclete-dashboard@`, `paraclete-dwd@`) hold grants the
installer and the instance's role made. List them in their own section; flag one only when it holds a
basic role, which the installer never grants.

### 2. Who can act as each service account

```bash
for sa in $(gcloud iam service-accounts list --project=<project> --format='value(email)'); do
  echo "== $sa"; gcloud iam service-accounts get-iam-policy "$sa" --format=json
done > audit/<date>/account-iam.txt
```

Any member holding `roles/iam.serviceAccountUser`, `serviceAccountTokenCreator` or
`workloadIdentityUser` on an account can act with that account's roles: report each with what the
account itself holds.

### 3. User-managed keys

```bash
for sa in $(gcloud iam service-accounts list --project=<project> --format='value(email)'); do
  gcloud iam service-accounts keys list --iam-account="$sa" --managed-by=user --format=json \
    | jq -c --arg sa "$sa" '.[] | {account: $sa, key: (.name | split("/") | last), created: .validAfterTime, expires: .validBeforeTime, disabled}'
done > audit/<date>/user-keys.jsonl
```

Every user-managed key is a credential that can leak: list each. One older than 90 days (by its
`created` time, measured, never guessed) is a finding. Give a key's id shortened to its first eight
characters in reports.

### 4. What everyone can reach

With the Cloud Asset API on:

```bash
gcloud asset search-all-iam-policies --scope=projects/<project> \
  --query='memberTypes:(allUsers OR allAuthenticatedUsers)' --format=json > audit/<date>/public-bindings.json
```

Each result is a resource anyone (or any Google account) may reach, and the role they get. Without the
API (`... API has not been used ... or it is disabled`), check the usual places one by one: each bucket
(`gcloud storage buckets get-iam-policy gs://<bucket> --format=json`) and each Cloud Run service
(`gcloud run services get-iam-policy <service> --region=<region> --format=json`), and say in the report
that the search could not run.

A public Cloud Run service or bucket may be intended (a website): report it as public, and ask whether
it is meant to be before rating it.

### 5. What the internet can connect to

```bash
gcloud compute firewall-rules list --project=<project> --format=json > audit/<date>/firewall.json
jq -r '.[] | select(.direction == "INGRESS" and (.disabled | not)
  and ((.sourceRanges // []) | map(. == "0.0.0.0/0" or . == "::/0") | any))
  | [.name, (.network | split("/") | last),
     ((.allowed // []) | map(.IPProtocol + ":" + ((.ports // ["all"]) | join(","))) | join(" ")),
     ((.targetTags // ["every instance"]) | join(","))] | @tsv' audit/<date>/firewall.json
```

SSH (22), RDP (3389), databases and "all ports" open to the internet are findings. The instance's own
`paraclete-allow-iap-ssh` admits only Google's IAP range, and `paraclete-deny-ingress` denies the rest:
both are expected.

### 6. Bucket protections

```bash
gcloud storage buckets list --project=<project> --raw --format=json \
  | jq -r '.[] | [.name, (.iamConfiguration.publicAccessPrevention // "inherited"),
      (.iamConfiguration.uniformBucketLevelAccess.enabled // false | tostring)] | @tsv'
```

A bucket without public access prevention `enforced`, or without uniform access, is weaker than it
could be; it is a finding when the bucket holds anything sensitive or is public (check 4).

### 7. Organization policies in force

`gcloud org-policies list --project=<project>` lists the policies set on the project or inherited. Read
the effective value of the ones that matter most:

```bash
for c in iam.disableServiceAccountKeyCreation iam.allowedPolicyMemberDomains storage.publicAccessPrevention \
         storage.uniformBucketLevelAccess compute.vmExternalIpAccess compute.requireOsLogin; do
  echo "== $c"; gcloud org-policies describe "$c" --project=<project> --effective --format=json
done > audit/<date>/org-policies.txt
```

A missing guard is context for the other findings (keys can be created; public members can be added),
rarely a finding alone.

### 8. Recent access changes

```bash
gcloud logging read 'protoPayload.methodName="SetIamPolicy" OR protoPayload.methodName:"CreateServiceAccountKey" OR protoPayload.methodName:"CreateServiceAccount"' \
  --project=<project> --freshness=7d --limit=200 --format=json > audit/<date>/iam-changes.json
```

Report who changed what and when (`protoPayload.authenticationInfo.principalEmail`,
`protoPayload.methodName`, `protoPayload.resourceName`, `timestamp`).

### 9. Google's own recommendations

With the Recommender API on:
`gcloud recommender recommendations list --project=<project> --location=global --recommender=google.iam.policy.Recommender --format=json`
lists roles Google saw unused for 90 days and would remove or shrink. Use them as evidence of excess,
never as a finding without the role and member they name.

## Findings

Each finding has all of these, or it is not a finding yet:

- **Severity,** no higher than the evidence: **Critical** only for exposure you demonstrated (a sensitive
  resource open to `allUsers`, a credential where anyone can read it, SSH open to the internet on a
  machine that answers); **High** for a verified violation with exact values (Editor on a service
  account, a key 400 days old, a project-wide `serviceAccountTokenCreator`); **Medium** for unnecessary
  access or a missing guard; **Low** for a best-practice gap; **Info** for context.
- **Resource and evidence:** the exact resource, the raw lines from the saved file, and the file's path.
- **Risk:** what someone could do with it, specifically.
- **Remediation,** written for a person to run, never run by you:

  ```
  Change: gcloud projects remove-iam-policy-binding <project> --member=<member> --role=<role>
  Undo:   gcloud projects add-iam-policy-binding <project> --member=<member> --role=<role>
  Risk:   what could stop working when this changes
  ```

Before reporting, check each finding against the exceptions people already accepted (the project's
context, or memory): annotate a match ("accepted on <date> by <person>"), never drop it, and flag an
exception older than 90 days for review.

## Comparing with the last audit

Compare the saved files with the previous audit's (the last `audit/<date>/` directory in the working
tree, or the previous run's output through `work-output-read`): new members and roles, removed ones, new
keys, new public bindings, new firewall rules. A difference is real only when both sides were read the
same way; reordered output is not a change. Without a previous audit, say this one is the baseline.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `Cloud Asset API has not been used ... or it is disabled` | Check 4's search needs it | Do the per-service checks instead; recommend a person turns it on (`gcloud services enable cloudasset.googleapis.com --project=<project>`) |
| `Recommender API ... disabled` | Check 9 needs it | Skip check 9 and say so |
| `PERMISSION_DENIED` on another project | Your account has no read access there | Report the project as not audited |
| An org-policy constraint "not found" | The name is wrong or the constraint is retired | `gcloud org-policies list --project=<project>` for what exists |

## Safety

- Never run a change, never create or download a key, and never print key material.
- Reports go to the people who asked, and name only what they need: shorten key ids, and leave out
  members' personal details beyond their address.
