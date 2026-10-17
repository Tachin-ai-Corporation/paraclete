# dev/

Tools for developing this repo. Nothing here is product, and nothing here is ever installed on an
instance.

| File | Use |
|---|---|
| `instance.env.example` | Copy to `.local/instance.env` and fill in your dev instance |

## Coming with the install work (build plan phase 5)

| Command | Does |
|---|---|
| `dev/deploy <branch>` | Moves your dev instance, dashboard and VM, to a pushed branch through the release-upgrade path |
| `dev/status` | Shows the commit each half runs, service health and recent missions |
| `dev/logs <service>` | Tails a service's journal on the VM |
| `dev/query <collection> [filters]` | Reads Firestore. Read-only |
| `dev/trigger <responsibility-id>` | Runs a responsibility now |
| `dev/say "<request>"` | Sends the agent a chat message from your account |

How and when to use them: [DEVELOPING.md](../DEVELOPING.md) section 7.
