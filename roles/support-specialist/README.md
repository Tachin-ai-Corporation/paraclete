# roles/support-specialist/

Focused specialist for shared support inbox triage on a 15-minute cadence: reads the organization's Policy & Procedures Google Doc, answers policy-authorized standard categories automatically, posts all other requests with proposed replies into a Google Chat review space for natural conversational human approval or edits, executes threaded Gmail replies from the shared support address, and logs SOC 2 requests and responses in a Google Sheet.

**Installed:** yes, on `--role support-specialist`, layered over [`roles/generic/`](../generic/).

## Contents

| File | Purpose |
|---|---|
| `role.json` | Declares `workspace: true`, the `support-triage` skill, no extra GCP roles, no extra system packages |
| `prompts/cortex.md` | Rules for auto-response boundaries, colloquial Chat review, SOC 2 logging, and untrusted mail |
| `prompts/motor.md` | Rules for ledger checks, live policy reads, `--from` alias replies, and duplicate-free SOC 2 Sheet logging |
| `prompts/cerebellum.md` | Verification checks for policy basis, Chat review before custom sends, and Sheet logging |
| `processes/p-support-triage.json` | Active playbook describing the scheduled inbox pass and Chat thread review flow |
| `responsibilities.json` | `r-support-triage` (`*/15 * * * *`, `min_spacing_minutes: 15`, `singleton: true`, shipped `enabled: false` until configured) |
| `memory.md` | Starter working memory listing the five configuration slots to populate after install |
| `skills/support-triage/` | `support-ledger`, `support-propose`, `gmail-reply`, and `support-preflight` commands plus `SKILL.md` |

## Gmail send scope and shared support address

Standard Workspace roles request `gmail.readonly` only (`WORKSPACE_SCOPES` in [`agent/auth/workspace-scopes.mjs`](../../agent/auth/workspace-scopes.mjs)). The `support-specialist` role is in `MAIL_SEND_ROLES`, so the dashboard's Workspace setup wizard and `workspace_check` include `https://www.googleapis.com/auth/gmail.send` and `https://www.googleapis.com/auth/gmail.settings.sharing` (`11` scopes total) and inspect verified `Send-As` aliases. An admin can provision shared group aliases (`support@example.com`) directly from **Settings -> Workspace** without ever signing in as the agent.

- `gmail-search` and `gmail-get` still authenticate with `gmail.readonly`.
- Only `gmail-reply` requests `gmail.send` (`POST /gmail/v1/users/me/messages/send`), requires a `Message-ID` ledger check so the same inbound email is never replied to twice unless `--allow-followup` is passed, and records `auto_replied` / `approved_as_is` / `edited_before_send` outcomes for `support-ledger stats`.
- `support-preflight` checks intake search, `Send-As` verification, Policy Doc readability, agent-owned SOC 2 Sheet access (with `--init-soc2-sheet` to create one owned by the agent), and Chat space reachability; `support-propose --dry-run` lets reviewers preview proposals in Chat before enabling auto-replies.
- Outbound replies stay inside the customer's Gmail thread (`In-Reply-To`, `References`, `threadId`) and use `--from "<address>"` so Google Workspace's verified **Send mail as** alias (e.g. a Google Group support address) appears as the sender.
- Review proposals and conversational status replies in Google Chat still go through the [mouth service](../../agent/services/mouth/README.md).
