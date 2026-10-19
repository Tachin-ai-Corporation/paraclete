'use client';
// dashboard/components/settings/SystemTab.jsx: Settings, System. The agent's VM as its control service
// reports it (the `status` command): each service's systemd state and heartbeat, the model gateway, the
// installed release and the host, and the Google Chat channel as the ears and the mouth report it. The
// dashboard's own build sits beside the agent's release, since one upgrade moves both. Every user can
// look; admins can restart a service (`restart_service`). Above it, the version card (UpdateCard.jsx):
// the newer releases and, for admins, installing one.
import { useState } from 'react';
import { useCommand } from '@/lib/client/use-command.js';
import { formatBytes, formatDate, timeAgo } from '@/lib/client/format.js';
import { AsyncState } from '@/components/ui/AsyncState.jsx';
import { ConfirmButton } from './ConfirmButton.jsx';
import { Notice } from './Notice.jsx';
import { UpdateCard } from './UpdateCard.jsx';
import { chatChannelView } from './chat-channel.js';
import { compareBuilds, formatDuration, serviceHealth, SERVICE_ORDER, shortCommit } from './service-health.js';
import styles from './Settings.module.css';

function restartedText(service, command) {
  if (command.status === 'done') {
    if (command.result?.restarting) return { kind: 'ok', text: 'The control service is restarting. Check again in a few seconds.' };
    return { kind: 'ok', text: `Restarted ${service}.` };
  }
  if (command.status === 'failed') return { kind: 'error', text: command.error || `${service} could not be restarted` };
  return { kind: 'warn', text: `The restart of ${service} was asked for, but the agent has not answered yet; its VM may be down or restarting.` };
}

export function SystemTab({ me }) {
  const isAdmin = me.user.role === 'admin';
  const status = useCommand('status', { auto: true });
  const restart = useCommand('restart_service');
  const [notice, setNotice] = useState(null);
  const [restarting, setRestarting] = useState(null);

  async function restartService(service) {
    setNotice(null);
    setRestarting(service);
    const command = await restart.run({ service });
    setRestarting(null);
    // Without a command the request itself failed, and restart.error says why.
    if (command) setNotice(restartedText(service, command));
    status.run();
  }

  const result = status.result;
  const statusError = status.error;

  return (
    <div>
      <UpdateCard me={me} />
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <h2>System</h2>
            <p>
              {result ? `Reported by the agent's VM ${timeAgo(result.checked_at)}.` : 'Asking the agent\'s VM; it answers within a few seconds.'}
            </p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => status.run()} disabled={status.running}>
            {status.running ? 'Checking…' : 'Refresh'}
          </button>
        </div>
        <Notice notice={notice} onDismiss={() => setNotice(null)} />
        {restart.error && !notice && <Notice notice={{ kind: 'error', text: restart.error }} />}
        <AsyncState loading={!result && status.running} error={!result ? statusError : null}>
          {result && (
            <div className="stack">
              <Versions release={result.release} dashboard={me.dashboard} />
              <Services
                services={result.services}
                isAdmin={isAdmin}
                busy={Boolean(restarting) || restart.running}
                restarting={restarting}
                onRestart={restartService}
              />
              <ChatChannel
                ears={result.services?.ears?.heartbeat?.gchat}
                mouth={result.services?.mouth?.heartbeat?.gchat}
              />
              <div className={styles.grid}>
                <Gateway gateway={result.gateway} />
                <Host host={result.host} control={result.control} />
              </div>
            </div>
          )}
        </AsyncState>
      </section>
    </div>
  );
}

function Versions({ release, dashboard }) {
  const builds = compareBuilds(release, dashboard);
  return (
    <div className={`card ${styles.panel}`}>
      <h2 className={styles.panelTitle}>Release</h2>
      <dl className={styles.facts}>
        <dt>Agent</dt>
        <dd>
          {release ? (
            <>
              {release.version || release.ref || 'unversioned'}
              {release.commit && <span className="muted"> · commit {shortCommit(release.commit)}</span>}
              {release.installed_at && <span className="muted"> · installed {formatDate(release.installed_at)}</span>}
            </>
          ) : (
            <span className="muted">No release record on the VM</span>
          )}
        </dd>
        <dt>Dashboard</dt>
        <dd>
          {dashboard?.release || dashboard?.commit ? (
            <>
              {dashboard.release || 'unversioned'}
              {dashboard.commit && <span className="muted"> · commit {shortCommit(dashboard.commit)}</span>}
            </>
          ) : (
            <span className="muted">Not recorded in this build</span>
          )}
        </dd>
        {release?.repo && (
          <>
            <dt>From</dt>
            <dd>{release.repo}</dd>
          </>
        )}
      </dl>
      {builds === 'different' && (
        <p className={`${styles.small} ${styles.footnote}`}>
          <span className="badge badge-warn">Different builds</span>{' '}
          The agent and the dashboard run different commits. An upgrade moves both to the same release.
        </p>
      )}
    </div>
  );
}

function Heartbeat({ heartbeat }) {
  if (!heartbeat) return <span className="muted" title="This service is checked another way">—</span>;
  if (heartbeat.error) return <span className="badge badge-warn" title={heartbeat.error}>unreadable</span>;
  const age = Number.isFinite(heartbeat.age_sec) ? `${formatDuration(heartbeat.age_sec)} ago` : 'no time';
  return heartbeat.stale ? <span className="badge badge-warn">stale, {age}</span> : <span className="muted">{age}</span>;
}

function sinceText(since) {
  if (!since) return '';
  return Number.isFinite(Date.parse(since)) ? timeAgo(since) : since;
}

function Services({ services, isAdmin, busy, restarting, onRestart }) {
  return (
    <div className={`card ${styles.panel}`}>
      <h2 className={styles.panelTitle}>Services</h2>
      <div className={styles.tableWrap}>
        <table className={`table ${styles.list}`}>
          <thead>
            <tr>
              <th>Service</th>
              <th>State</th>
              <th>Since</th>
              <th>Restarts</th>
              <th>Heartbeat</th>
              {isAdmin && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {SERVICE_ORDER.map((name) => {
              const entry = services?.[name];
              const health = serviceHealth(entry);
              return (
                <tr key={name}>
                  <td>
                    {name}
                    {entry?.unit && <span className={styles.sub}>{entry.unit}</span>}
                  </td>
                  <td>
                    <span className={`badge badge-${health.level}`} title={health.detail}>{health.label}</span>
                    {health.detail && !health.healthy && <span className={styles.sub}>{health.detail}</span>}
                  </td>
                  <td className={styles.nowrap} title={entry?.since || ''}>{sinceText(entry?.since)}</td>
                  <td>{entry?.restarts ?? ''}</td>
                  <td><Heartbeat heartbeat={entry?.heartbeat} /></td>
                  {isAdmin && (
                    <td className={styles.actions}>
                      {restarting === name ? (
                        <span className="muted">Restarting…</span>
                      ) : (
                        <ConfirmButton
                          label="Restart"
                          prompt={`Restart ${name}?`}
                          confirmLabel="Restart"
                          danger={false}
                          disabled={busy}
                          onConfirm={() => onRestart(name)}
                        />
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChatChannel({ ears, mouth }) {
  const view = chatChannelView(ears, mouth);
  return (
    <div className={`card ${styles.panel}`}>
      <h2 className={styles.panelTitle}>
        Google Chat <span className={`badge badge-${view.badge.level}`}>{view.badge.label}</span>
      </h2>
      <p className={`muted ${styles.small}`}>{view.summary}</p>
      {view.error && <p className={`error-text ${styles.small}`}>{view.error}</p>}
      {view.facts.length > 0 && (
        <dl className={styles.facts}>
          {view.facts.map((fact) => (
            <FactRow
              key={fact.label}
              label={fact.label}
              value={fact.at ? <span title={fact.at}>{timeAgo(fact.at)}</span> : fact.value}
            />
          ))}
        </dl>
      )}
    </div>
  );
}

function Gateway({ gateway }) {
  const g = gateway || {};
  const badge = g.ready ? ['badge-ok', 'ready'] : g.reachable ? ['badge-danger', 'not ready'] : ['badge-danger', 'not answering'];
  const providers = Object.entries(g.providers || {});
  const models = Object.entries(g.models || {});
  return (
    <div className={`card ${styles.panel}`}>
      <h2 className={styles.panelTitle}>
        Model gateway <span className={`badge ${badge[0]}`}>{badge[1]}</span>
      </h2>
      {g.error && <p className={`error-text ${styles.small}`}>{g.error}</p>}
      <dl className={styles.facts}>
        {models.map(([tier, model]) => (
          <FactRow key={tier} label={tier} value={model} />
        ))}
        {providers.map(([provider, info]) => (
          <FactRow
            key={provider}
            label={provider}
            value={info?.available ? `available${info.location ? ` in ${info.location}` : ''}` : 'off'}
          />
        ))}
        {g.uptime_sec != null && <FactRow label="Up for" value={formatDuration(g.uptime_sec)} />}
        {g.requests != null && <FactRow label="Requests" value={String(g.requests)} />}
        {g.sessions != null && <FactRow label="Open sessions" value={String(g.sessions)} />}
      </dl>
    </div>
  );
}

function Host({ host, control }) {
  const h = host || {};
  const total = Number(h.memory_total_bytes);
  const free = Number(h.memory_free_bytes);
  const memory = Number.isFinite(total) && Number.isFinite(free) && total > 0
    ? `${formatBytes(total - free)} used of ${formatBytes(total)} (${Math.round(((total - free) / total) * 100)}%)`
    : '';
  const load = Array.isArray(h.load_avg) ? h.load_avg.map((n) => Number(n).toFixed(2)).join(' / ') : '';
  return (
    <div className={`card ${styles.panel}`}>
      <h2 className={styles.panelTitle}>Host</h2>
      <dl className={styles.facts}>
        <FactRow label="Name" value={h.hostname} />
        <FactRow label="Up for" value={formatDuration(h.uptime_sec)} />
        <FactRow label="Load (1, 5, 15 min)" value={load} />
        <FactRow label="Memory" value={memory} />
        {control && <FactRow label="Control" value={`pid ${control.pid}, up ${formatDuration(control.uptime_sec)}`} />}
      </dl>
    </div>
  );
}

function FactRow({ label, value }) {
  if (!value) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
