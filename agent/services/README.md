# agent/services/

The long-running services on the VM. Each is its own process and systemd unit. They share nothing in
memory: they talk through Firestore, and the brain reaches the gateway over loopback HTTP.

| Service | Job |
|---|---|
| brain | The mission loop: reads intake, plans checkpoints, runs tasks, verifies, finalizes, runs the scheduler and the archival sweep |
| ears | Inbound: dashboard chat and file drops, plus Google Chat on Workspace roles. Serves several channels at once |
| mouth | The only way out: replies, deliveries, status notes and attachments, to every channel |
| control | The dashboard's bridge to the VM: status, skills, config, responsibilities, model switch, upgrades, restarts |
| gateway | Runs organ turns: reads the contracts, builds `agent/gateway/`, listens on loopback |

## Layout

```
agent/services/
  service-runtime.mjs        what every service starts from: contracts, instance, logger, Firestore, paths;
                             and what services read alike: the admin settings, the skill directories
  <service>/
    main.mjs                 the entry point: createServiceRuntime(), wire the libraries, start loops
    paraclete-<service>.service   its systemd unit
    *.mjs                    the service's own modules (one concern each)
    *.md                     prompts only this service sends to the utility model
```

## Rules

- **Services read configuration; libraries don't.** `main.mjs` calls `createServiceRuntime()`, which
  loads `config/contracts.json` and `/etc/paraclete/instance.json`, and passes values down. Anything a
  service does that can be a pure function belongs in a library package, where it can be tested alone.
- **Services never import each other.** Code two services share goes in `service-runtime.mjs` or a
  library package.
- **Paths.** Installed code and prompts live under the install root (`/opt/paraclete`), read-only to the
  agent. Everything the agent writes lives under the data root (`/var/lib/paraclete`); its layout is
  `dataPaths()` in [config/instance.mjs](../../config/instance.mjs). The gateway's token is
  `/etc/paraclete/gateway-token`.
- **Logs** are one JSON object per line on stdout (`createLogger`), kept by journald.
- **Units** run as the `paraclete` user with `ProtectSystem=strict`, `ReadOnlyPaths=/opt/paraclete
  /etc/paraclete`, `ReadWritePaths=/var/lib/paraclete`, `PrivateTmp=yes`, `NoNewPrivileges=yes`,
  `Restart=always`, and `ExecStart=/usr/bin/node /opt/paraclete/agent/services/<service>/main.mjs`.
  The installer (build plan phase 5) creates the user and directories and enables the units.
- **Control is the one exception:** it runs as root, because restarting services and running an
  upgrade need it. It does only a closed set of actions, calls `systemctl`, `systemd-run` and
  `journalctl` with argument lists (never a shell), and accepts only allowlisted units and strictly
  checked refs. See [control/README.md](control/README.md).
- **Heartbeats.** A service that polls rewrites `services/<service>/health.json` under the data root
  after each poll; control reports a heartbeat older than a minute as stale.

## Status

All five services are in place (build plan phase 4). The installer enables their units in phase 5.
