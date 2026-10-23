# Installing paraclete

This guide is for the owner of a Google Cloud project who wants a paraclete in it. It covers what you
need, the install, signing in and adding people, the setup a Workspace role asks for, updates,
Claude, removing paraclete, and what to do when a step fails. You need no programming: you paste a
few commands into Cloud Shell, Google's terminal in the browser, and do the rest in the dashboard.
Product words, such as [role](GLOSSARY.md#the-product) or [mission](GLOSSARY.md#work), mean what
the [glossary](GLOSSARY.md) says.

## What you need

| You need | Why | Checked by the installer |
|---|---|---|
| A Google Cloud project inside your organization | Google's sign-in in front of the dashboard (Identity-Aware Proxy, IAP) admits the people of the project's organization, and works only for a project inside one | Yes, step 1 |
| Billing turned on for the project | The agent's VM, its models and its storage are billed to the project | Yes, step 1 |
| Owner rights on the project, for the account you install with | The installer creates service accounts, grants access, and turns on Google APIs | Yes, step 1 |
| Google accounts in your organization for the people who will use it | They sign in to the dashboard with them | No |
| Gemini 4 (`gemini-4-argon`) open to the project on Vertex AI | It is the agent's main model | Yes, step 2 |
| For a Workspace role only: a Workspace admin, and a Workspace license for the agent's own user | The agent gets its own Google account, which only an admin can create and allow | No: the dashboard walks you through it after the install |

One project holds one paraclete.

## Install

### 1. Open Cloud Shell

Press this button (the [README](../README.md#install) has it too):

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/Tachin-ai-Corporation/paraclete&cloudshell_git_branch=main&cloudshell_workspace=.&cloudshell_open_in_editor=docs/INSTALL.md)

Cloud Shell opens in your browser with this repository cloned and this guide open in its editor.

Google opens a repository it does not own in a temporary Cloud Shell, without your credentials. So
first log in, with the account that owns the project:

```
gcloud auth login
```

Follow what it prints: a link to sign in with, and a code to paste back.

### 2. Run the installer

Replace `your-gcp-project` with your project's id:

```
install/install.sh --project your-gcp-project
```

It asks two questions. Press Enter to take the answer in brackets.

```
Roles: <the role ids, generic among them>
Which role should the agent have? [generic]:
What should the agent be called? [Paraclete]:
```

- **The role** is the agent's focus. `generic` is a general-purpose agent; every other role adds a
  focus and a few tools to it. The [roles table](../roles/README.md#roles) says what each adds and
  which are Workspace roles. An instance keeps the role it was installed with, so choose with care.
- **The name** is the agent's display name: 1 to 40 letters, digits, spaces or `. _ ' -`, starting
  with a letter or a digit.

Then it shows what it is about to do and asks once more:

```
paraclete will be installed into your-gcp-project:
  role        generic
  name        Paraclete
  release     <the newest release> (<its commit>)
  repository  <owner>/<name>
  region      us-central1, VM in us-central1-a
  bucket      gs://your-gcp-project-paraclete
  dashboard   Cloud Run service paraclete, behind Google sign-in (first admin: <your email>)
  updates     new releases install automatically, checked on */30 * * * * (UTC)
Go ahead? [y/N]:
```

Type `y`. From here it runs on its own. It installs the newest release of this repository.

Two options worth knowing:

| Add | To |
|---|---|
| `--region <region>` | Keep the data, the dashboard and the VM in another region than `us-central1` |
| `--dry-run` | See every command that would change something, and change nothing |
| `--no-auto-update` | Install new releases only when an admin presses Install (by default they install by themselves; see [Update to a new release](#update-to-a-new-release)) |

[install/README.md](../install/README.md#running-it) lists every option.

### 3. What the nine steps do

Each step starts with a line such as `[3/9] accounts: ...`. The lines that start with `+ ` are the
exact commands it runs on your project.

| Step | What it does |
|---|---|
| 1 check | Checks that you are logged in and hold an owner's permissions, that billing is on, that the project is inside an organization, and that the role and the release exist. Changes nothing |
| 2 apis | Turns on the Google APIs the agent and the dashboard use (more for a Workspace role), then asks the agent's main model for one word, to prove the project can use it |
| 3 accounts | Creates the agent's and the dashboard's service accounts (and, for a Workspace role, the one that signs the agent's Workspace access), and grants each what it needs |
| 4 firestore | Creates the database the agent and the dashboard keep their records in, protected against deletion, with the indexes its searches need |
| 5 bucket | Creates one storage bucket for files and the agent's work, closed to the public |
| 6 dashboard | Builds the dashboard with Cloud Build, runs it on Cloud Run behind Google sign-in, and makes you its first admin. Also creates the automatic-update job and the schedule that starts it every 30 minutes |
| 7 network | Sets up the VM's network so that nothing reaches the VM from outside except SSH through Google's IAP |
| 8 vm | Creates the agent's VM, which installs the release by itself when it starts |
| 9 wait | Waits until the agent reports that it is ready |

### 4. How long it takes

Most of the time goes into two waits: Cloud Build building the dashboard (step 6), and the VM's first
start (step 9), about 8 to 12 minutes while it installs the tools the agent works on files with. The
installer waits up to 20 minutes for the agent, printing a dot every 10 seconds.

If Cloud Shell closes before the end, what was done stays done. Open Cloud Shell and log in again as in
step 1, and run the same command: it finds what exists and does the rest.

### 5. When it finishes

```
Done. Paraclete runs on the VM paraclete in us-central1-a.
Dashboard: <the dashboard's address> (sign in as <your email>; add other people from the dashboard)
```

Keep the dashboard's address. Everything else happens there.

**Running the installer again** is always safe. It creates what is missing, changes only what
differs, and keeps the role, the name and the region the instance has. It installs the newest
release, so when a newer one exists it moves the dashboard to it and prints the commands that move the
VM. Updating from the dashboard (below) moves both for you.

## Sign in

Open the dashboard's address and sign in with your Google account. The installer made you the
dashboard's first admin. **Settings → Setup** lists what this instance needs and what is left to do.

## Add people

Every dashboard user is either an admin or a member:

| A dashboard user can | Admin | Member |
|---|---|---|
| Chat with the agent, hand it files, follow and approve its work, download its files | Yes | Yes |
| Manage users, secrets, settings, models and updates | Yes | No |

Every user sees all of the agent's work and every approval, whoever asked for it.

To add someone, open **Settings → Users**, enter the email of their Google account in your
organization, choose Member or Admin, and press **Add user**. That both lets them through Google
sign-in and creates their user record. Send them the dashboard's address.

- **Change a role** with the menu in their row.
- **Remove** someone with **Remove** in their row. It takes away both their sign-in and their record.
  You cannot remove yourself: another admin can. The last admin can be neither removed nor made a
  member.
- Someone who passes Google sign-in but has no user record sees **No access** and is asked to contact
  an admin. They are listed under **Access without a user**, where you can add them or revoke their
  access.

## Share Drive files with the agent

Every agent can read Google Drive files shared with it. **Settings → Setup** shows the address to share
with, with a copy button: the agent's service account, or on a Workspace role its own Google account
once that is set up. An admin can press **Test Drive** there to check what the agent reaches, and set
an **Output folder**, the Drive folder where the agent saves finished files. For the service account,
that folder must be in a shared drive the account belongs to.

The agent never edits, moves or deletes a Drive file shared with it: it downloads what it needs and
hands back new files ([skills/drive/SKILL.md](../skills/drive/SKILL.md)).

## Set up a Workspace role

On a Workspace role, the agent is a user of your organization: it reads and posts in Google Chat and
works in Drive, Docs, Sheets, Slides, Calendar and Gmail as that user. Google lets only a Workspace
admin allow this, by hand. A dashboard admin opens **Settings → Workspace**, which appears only on a
Workspace role, and walks through five steps. Steps 1 and 2 need a Workspace admin in the Google Admin
console, and step 3 someone who can change the project's settings in the Google Cloud console, such
as its owner.

| Step | Where | What you do |
|---|---|---|
| 1. Create the agent's user | Google Admin console | Directory, Users, Add new user. Give it a license that includes Google Chat, Drive, Docs, Sheets, Slides, Calendar and Gmail. Enter its address in the dashboard; it suggests one |
| 2. Grant domain-wide delegation | Google Admin console | Security, Access and data control, API controls, Manage domain-wide delegation, Add new. Paste the client ID and the scopes the dashboard shows (each has a copy button), then Authorize. A new entry can take a few minutes to apply |
| 3. Set up Google Chat | Google Cloud console, then Google Chat | Open the Chat API's configuration page (the dashboard links to it), enter an app name and a description, turn Interactive features off, and Save. Then add the agent's user to a Chat space and @mention it |
| 4. Test | Dashboard | Asks Google, as the agent, for access to each API, and makes one read-only call with each. Each API shows whether it works and, when it failed, what to change |
| 5. Save | Dashboard | Offered once a test of that address passed. When only APIs other than Drive failed, it offers **Save anyway**, after a warning. Records the address as the agent's account; its services restart, which takes a few seconds |

Until someone has written to the agent's new user in Chat, the test shows Chat as **Waiting for a
first message**; the agent also answers that first @mention. Reach the agent in Chat spaces, not in
direct messages: Chat refuses its replies in direct messages while its account has never signed in.

Anyone in a space the agent belongs to can ask it for work there, including outside members of a space
that admits them; **Settings → System** counts such spaces. Only dashboard users can approve work that
waits for an approval ([agent/services/brain/approval-replies.mjs](../agent/services/brain/approval-replies.mjs)).

Once saved, the tab shows the account with **Test again**, **Change** and **Remove**. Removing it takes
Chat and the Workspace skills away, and Drive goes back to the agent's service account.

## Update to a new release

**New releases install by themselves.** Every 30 minutes a scheduled job of the dashboard's checks for a
newer release and installs it exactly the way an admin's **Install** would (below):
- It waits while the agent is working on a mission, for at most 24 hours, so a running task isn't
  interrupted; after that it installs anyway, and the mission picks up where it was.
- It only moves forward, and an instance installed from a branch instead of a release is never moved.
- The version card says whether automatic updates are on and what the last check found. An admin turns
  them off or on there, with **Turn off** and **Turn on**.
- To install with them off, add `--no-auto-update` to the installer. An instance installed before
  automatic updates existed gets them the next time you run the installer.

**Settings → System** opens with a version card. It shows the release the agent and the dashboard run,
and the newer releases of this repository with their notes. The dashboard asks GitHub at most once an
hour; an admin's **Check now** asks again, at most every five minutes.

When a newer release exists, an admin presses **Install** beside it and confirms. The dashboard says:
"The agent restarts on it, then the dashboard is rebuilt and replaced: about ten minutes." Every user
sees the three steps as they run:

1. The agent moves to the release.
2. Cloud Build builds the dashboard at the same commit.
3. Cloud Run switches the dashboard to it. The page then reloads by itself.

- **If it fails,** the card says why. When the agent's own move fails, the dashboard stays as it was.
  When a later step fails, the card marks the instance **half installed** and offers
  **Finish installing**.
- **Updates only move forward.** To go back to an older release, run
  `install/install.sh --project your-gcp-project --ref <older version>` in Cloud Shell, then the command
  it prints to move the VM.
- An instance installed from a branch instead of a release is offered no updates.

## Turn on Claude

The agent runs on Google's Gemini models. Claude, Anthropic's model, is off until an admin turns it on.
When it is on, Claude Opus runs the parts of the agent that decide each step of a mission and that
plan, carry out and check its work; Gemini stays the fallback when a Claude call fails, and runs
everything else. Claude on Vertex AI is billed to the project.

Open **Settings → Models**. An admin sees three steps:

1. **Accept Anthropic's terms in Model Garden.** Each Claude model the agent can use has an **Open in
   Model Garden** link. A project owner enables the model there and accepts Anthropic's terms, once.
2. **Test.** Sends each model one short message from the agent's VM and shows which answered, and what
   to do about each one that did not. Each test costs a few tokens per model.
3. **Turn Claude on or off.** Turns Claude on with the newest model that answered a test in the last
   hour, or turns it off. The agent's model gateway restarts, which takes a few seconds.

Members see whether Claude is on, and with which model.

## Remove paraclete

Removing needs Cloud Shell and this repository again: press **Open in Cloud Shell** as in
[step 1](#1-open-cloud-shell), log in with `gcloud auth login`, then run:

```
install/uninstall.sh --project your-gcp-project
```

It first lists exactly what it will delete and what it keeps, then asks `Delete these? [y/N]:`. Add
`--dry-run` to see the list and the commands without changing anything.

| By default it deletes | It keeps |
|---|---|
| The agent's VM and its disk | The database, with the agent's chats, missions and memory |
| The firewall rules, and the network if the installer made one | The bucket and its files |
| The dashboard's Cloud Run service and its images | The repository of images the agent built, `agent-images`, when its role made one |
| The database's indexes and its expiry setting | The APIs the installer turned on |
| The service accounts, with their access to the project | |

`--purge` deletes the database, the bucket and `agent-images` too, with everything in them. That cannot
be undone, so it asks you to type the project id, even with `--yes`.

It does not touch what was made outside the installer: secrets added under **Settings → Secrets** stay
in Secret Manager, and a Workspace role's user, its domain-wide delegation entry and the Chat app
record stay until a Workspace admin and a project owner remove them.

## When a step fails

Most problems stop the installer with a line that starts with `error:` and names the problem. What it
did before that stays done, and running it again after the fix carries on from there.

| The installer says | What to do |
|---|---|
| `error: gcloud is not logged in. Run: gcloud auth login` | Run `gcloud auth login`, then the installer again |
| `error: no project given and gcloud has none configured. Pass --project <id>.` | Add `--project your-gcp-project` |
| `error: project <id> does not exist, or <account> cannot see it` | Check the project id, and that you logged in with an account that owns it |
| `error: <account> needs roles/owner on <project>. Missing: <permissions>` | Ask an owner of the project to make your account an owner too, or have them run the install |
| `error: billing is not enabled on <project>. Link a billing account: https://console.cloud.google.com/billing/linkedaccount?project=<project>` | Open the link and link a billing account to the project |
| `error: <project> is not inside a Google Cloud organization. The dashboard's Google sign-in (Identity-Aware Proxy) needs one: move the project into your Workspace's organization, then run this again.` | Do what it says |
| `error: there is no role '<id>'. Roles: <list>` | Answer with one of the roles it lists |
| `error: the agent's name must be 1 to 40 letters, digits, spaces or . _ ' - and start with a letter or digit` | Choose a name that fits |
| `error: the agent cannot use its model: <why>. Then run install/install.sh again; what it did so far stays. (<Google's answer>)` | Do what `<why>` says: ask for quota under IAM & Admin, Quotas; enable the model for the project in Model Garden; ask whoever runs your organization's policies; or, when it says the Vertex AI API is still turning on, wait a few minutes |
| `error: the (default) Firestore database of <project> is in <mode>. paraclete needs Native mode, and a database cannot change mode.` | The project already has a database of the other kind. Install into another project |
| `error: this command failed: <command>` | Google's own message, just above it, says why. When it names a policy of your organization, show it to whoever runs those policies. Then run the installer again |
| `warning: could not read the billing status of <project>; enabling the APIs will fail if billing is off` | Check that billing is on for the project. If it is, nothing |
| `warning: <model> did not answer (<Google's answer>); trying again in 12s` | Nothing yet: an API turned on moments ago can take a minute to answer. It tries six times before it stops |
| `warning: that failed; trying again in 10s (a new service account takes a moment to appear everywhere)` | Nothing: it tries again by itself |
| `the agent's install failed: <reason>` | The VM could not install the release. The installer prints the command that shows the VM's log, below `Read what happened on the VM:` |
| `the agent has not reported ready after 20 minutes` | The same: read the VM's log with the command it prints |

The VM tries its install again every time it starts, so after a failure on the VM you can restart it
with the command the installer prints:

```
gcloud compute instances reset paraclete --zone=<zone> --project=<project>
```

**Settings → Setup** in the dashboard also shows a failed install or update on the VM, with its reason.

## What it costs

Google bills the project for what paraclete uses. Neither the installer nor the plan names prices;
these are the parts that cost money:

| Part | What it is | When it costs |
|---|---|---|
| The agent's VM | An `e2-standard-2` machine with a 50 GB disk | All the time: it is always on |
| The dashboard | Cloud Run, one CPU and 1 GiB, at most three instances at once | While people use it: it scales to zero when nobody has it open |
| Models | Gemini on Vertex AI, and Claude when it is on | With use: every mission makes several model calls |
| Data | Firestore and one storage bucket | With use, and by what they hold. Files people upload are deleted after 30 days |
| Builds and images | Cloud Build builds the dashboard at the install and at each update; Artifact Registry keeps the images | With each build, and by what is stored |
| The agent's Workspace user | Workspace roles only | One Workspace license |

The VM's size is in `install/install.sh`, and the dashboard's size and the upload expiry are in
`config/contracts.json`.

## Where the details live

| For | Read |
|---|---|
| Every installer and uninstaller option, and what each step does exactly | [install/README.md](../install/README.md) |
| What each role adds | [roles/README.md](../roles/README.md) |
| How the dashboard signs people in, runs updates and turns on Claude | [dashboard/README.md](../dashboard/README.md) |
| What paraclete is, and why it is built this way | [plan/BUILD_PLAN.md](plan/BUILD_PLAN.md) |
