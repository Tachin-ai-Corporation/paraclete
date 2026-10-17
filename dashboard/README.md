# dashboard/

The web dashboard: where people talk to the agent, follow and approve its work, download its files,
and manage the instance. Next.js, deployed to Cloud Run behind Identity-Aware Proxy (IAP).

**Installed:** yes, built into the dashboard image at the release being installed.

## What belongs here

- Pages, components and styles
- Server routes that read and write Firestore and the bucket for the signed-in user
- IAP sign-in verification and dashboard user management
- Release detection and the upgrade button

## What doesn't

- **Agent logic.** The dashboard never plans, decides or runs work. It talks to the agent only
  through Firestore and the bucket; agent behavior lives in `agent/`.
- **Calls to the VM.** There are none. Commands go through Firestore to the agent's control service.

## Status

Empty. Arrives in build plan phase 6.
