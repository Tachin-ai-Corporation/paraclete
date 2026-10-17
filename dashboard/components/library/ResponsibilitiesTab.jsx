'use client';
// dashboard/components/library/ResponsibilitiesTab.jsx: the work the agent owns on a schedule or an
// event (the `responsibilities` command: the installed defaults with the agent's own store applied,
// exactly what the scheduler runs). Admins switch one on or off (set_responsibility_enabled, a new
// revision in the store that survives upgrades; locked upkeep refuses) and run one now
// (run_responsibility, then the trigger is followed until the brain starts it). Members read.

import { Fragment, useState } from 'react';
import { useCommand } from '@/lib/client/use-command.js';
import { formatDate } from '@/lib/client/format.js';
import { VmView } from '@/components/agent/VmView.jsx';
import { TriggerFollow } from './TriggerFollow.jsx';
import styles from './Library.module.css';

/** "in 5 min", "in 3 h", "in 2 d" for a time ahead. */
function timeUntil(value, now = Date.now()) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.round((at - now) / 1000);
  if (seconds < 60) return 'within a minute';
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `in ${Math.round(seconds / 3600)} h`;
  return `in ${Math.round(seconds / 86_400)} d`;
}

function spacing(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

const eventOf = (schedule) => /^on (.+)$/.exec(schedule || '')?.[1] || null;

function origin(r) {
  const rev = r.revision ? ` · rev ${r.revision}` : '';
  if (r.origin === 'agent') return { label: `agent’s own${rev}`, title: r.source };
  if (r.origin === 'override') return { label: `changed${rev}`, title: r.source };
  return { label: 'installed', title: r.source };
}

function Schedule({ r }) {
  const event = eventOf(r.schedule);
  return (
    <>
      {event ? <span>On <code>{event}</code></span> : r.schedule ? <code>{r.schedule}</code> : <span className="muted">none</span>}
      {!event && r.schedule && <div className="muted">{r.timezone}</div>}
      {r.min_spacing_minutes > 0 && <div className="muted">{`at least ${spacing(r.min_spacing_minutes)} apart`}</div>}
    </>
  );
}

function NextRun({ r }) {
  if (!r.enabled) return <span className="muted">off</span>;
  if (eventOf(r.schedule)) return <span className="muted">on its event</span>;
  if (!r.next_fire) return <span className="muted" title="No run falls within the next week">not this week</span>;
  return (
    <>
      <div>{timeUntil(r.next_fire)}</div>
      <div className="muted">{formatDate(r.next_fire)}</div>
    </>
  );
}

function List({ data, isAdmin, list }) {
  const toggle = useCommand('set_responsibility_enabled');
  const runNow = useCommand('run_responsibility');
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const rows = data.responsibilities || [];
  const columns = isAdmin ? 5 : 4;

  async function switchOne(r) {
    setBusy(`${r.id}:switch`);
    setNotice(null);
    const done = await toggle.run({ id: r.id, enabled: !r.enabled });
    setBusy(null);
    if (done?.status === 'done') {
      setNotice({ id: r.id, text: done.result?.message || '' });
      list.run();
    }
  }

  async function runOne(r) {
    if (!window.confirm(`Run “${r.name}” now? The brain starts it as a new mission.`)) return;
    setBusy(`${r.id}:run`);
    setNotice(null);
    const done = await runNow.run({ id: r.id });
    setBusy(null);
    if (done?.status === 'done') setNotice({ id: r.id, text: done.result?.message || '', triggerId: done.result?.trigger_id });
  }

  return (
    <div className="stack">
      {data.store_error && (
        <p className="error-text">{`The agent’s own changes could not be read, so these are the installed defaults alone: ${data.store_error}`}</p>
      )}
      {(data.issues || []).length > 0 && (
        <div className="card">
          <p><strong>Stored changes the scheduler ignores</strong></p>
          <ul className={styles.issues}>
            {data.issues.map((issue) => <li key={issue.id}><code>{issue.id}</code> <span className="muted">{issue.reason}</span></li>)}
          </ul>
        </div>
      )}
      {toggle.error && <p className="error-text">{`Not switched: ${toggle.error}`}</p>}
      {runNow.error && <p className="error-text">{`Not run: ${runNow.error}`}</p>}
      {rows.length === 0 ? (
        <p className="muted">The agent has no responsibilities.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className="table">
            <thead>
              <tr>
                <th>Responsibility</th>
                <th>Schedule</th>
                <th>Next run</th>
                <th>State</th>
                {isAdmin && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const from = origin(r);
                return (
                  <Fragment key={r.id}>
                    <tr>
                      <td className={styles.mainCell}>
                        <div className={styles.name}>{r.name}</div>
                        <code className={styles.id}>{r.id}</code>
                        {r.instruction && <p className={styles.preview}>{r.instruction}</p>}
                        {r.has_process && (
                          <p className="muted">{r.process_steps > 0 ? `Follows a process of ${r.process_steps} steps` : 'Follows a playbook'}</p>
                        )}
                      </td>
                      <td><Schedule r={r} /></td>
                      <td><NextRun r={r} /></td>
                      <td>
                        <div className={styles.badges}>
                          <span className={`badge ${r.enabled ? 'badge-ok' : 'badge-neutral'}`}>{r.enabled ? 'on' : 'off'}</span>
                          <span className="badge badge-plain" title={from.title}>{from.label}</span>
                          {r.locked && <span className="badge badge-plain" title="Upkeep the agent depends on: it changes only with a release">locked</span>}
                          {r.triggerable && <span className="badge badge-plain" title="The agent may offer to run it when asked">on request</span>}
                        </div>
                      </td>
                      {isAdmin && (
                        <td className={styles.actions}>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={Boolean(busy) || r.locked}
                            title={r.locked ? 'Locked upkeep changes only with a release' : ''}
                            onClick={() => switchOne(r)}
                          >
                            {busy === `${r.id}:switch` ? 'Switching…' : r.enabled ? 'Turn off' : 'Turn on'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={Boolean(busy) || !r.enabled}
                            title={r.enabled ? '' : 'Turn it on to run it'}
                            onClick={() => runOne(r)}
                          >
                            {busy === `${r.id}:run` ? 'Queuing…' : 'Run now'}
                          </button>
                        </td>
                      )}
                    </tr>
                    {notice?.id === r.id && (
                      <tr className={styles.noticeRow}>
                        <td colSpan={columns}>
                          <div className="row">
                            <span>{notice.text}</span>
                            {notice.triggerId && <TriggerFollow triggerId={notice.triggerId} />}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ResponsibilitiesTab({ list, isAdmin }) {
  return (
    <section>
      <p className={`muted ${styles.intro}`}>
        Work the agent owns and starts by itself, on a schedule or when something happens. A change made here is
        stored as a new revision and survives upgrades.
      </p>
      <VmView command={list}>{(data) => <List data={data} isAdmin={isAdmin} list={list} />}</VmView>
    </section>
  );
}
