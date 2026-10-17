# agent/services/

The long-running services on the VM, each with its systemd unit next to its code.

| Service | Job |
|---|---|
| brain | The mission loop: reads intake, plans checkpoints, runs tasks, verifies, finalizes, runs the scheduler |
| ears | Inbound: dashboard chat and file drops, plus Google Chat on Workspace roles. Serves several channels at once |
| mouth | The only way out: replies, deliveries and attachments, to every channel |
| control | The dashboard's bridge to the VM: status, skills, config, responsibilities, model switch, upgrades, restarts |
| gateway | The model gateway's service unit; its code lives in `agent/gateway/` |

**Belongs here:** service entry points, their start scripts and units, and the code that wires
packages together.
**Doesn't:** reusable logic. Anything a service does that can be a pure function goes in `work/`,
`context/`, `storage/` or `providers/`, where it can be tested alone.

**Status:** empty. Arrives in build plan phase 4.
