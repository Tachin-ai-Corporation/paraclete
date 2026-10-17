'use client';
// dashboard/components/library/ProcessesTab.jsx: the agent's process playbooks: how a kind of work has
// gone well before, which the agent recalls into its own plans (never run as fixed steps). The list
// and one playbook's narrative and earlier versions come from the `processes` collection
// (GET /api/library/processes). That collection holds the playbooks the agent wrote or changed; a
// role's installed playbooks that nobody changed are files on the VM and are not in it. Read-only.

import { AsyncState } from '@/components/ui/AsyncState.jsx';
import { Markdown } from '@/components/ui/Markdown.jsx';
import { usePoll } from '@/lib/client/use-poll.js';
import { formatDate, timeAgo } from '@/lib/client/format.js';
import { Disclosure } from '@/components/agent/Disclosure.jsx';
import styles from './Library.module.css';

const statusBadge = (status) => (status === 'active' ? 'badge-ok' : 'badge-neutral');

function ProcessList({ onSelect }) {
  const { data, error, loading, refresh } = usePoll('/api/library/processes', 0);
  const processes = data?.processes || [];
  return (
    <section className="stack">
      <div className={styles.introRow}>
        <p className="muted">
          Playbooks for kinds of work: how that work has gone well before. The agent recalls them into its plans; they
          are never run as fixed steps. Listed here are the playbooks stored for this instance, the ones the agent
          wrote or changed. Its role’s installed playbooks that nobody changed are not stored, so they do not appear.
        </p>
        <button type="button" className="btn btn-sm" onClick={() => refresh()}>Refresh</button>
      </div>
      <AsyncState loading={loading && !data} error={error} empty={Boolean(data) && processes.length === 0} emptyText="No playbooks are stored yet.">
        {processes.length > 0 && (
          <div className={styles.tableWrap}>
            <table className="table">
              <thead>
                <tr>
                  <th>Playbook</th>
                  <th>What it is for</th>
                  <th>Status</th>
                  <th>Changed</th>
                </tr>
              </thead>
              <tbody>
                {processes.map((p) => (
                  <tr key={p.id}>
                    <td className={styles.mainCell}>
                      <button type="button" className={styles.open} onClick={() => onSelect(p.id)}>{p.name}</button>
                      <code className={styles.id}>{p.id}</code>
                    </td>
                    <td className={styles.preview}>{p.description || <span className="muted">no description</span>}</td>
                    <td><span className={`badge ${statusBadge(p.status)}`}>{p.status}</span></td>
                    <td>
                      {p.updated_at ? <div title={formatDate(p.updated_at)}>{timeAgo(p.updated_at)}</div> : <span className="muted">—</span>}
                      {p.updated_by && <div className="muted">{`by ${p.updated_by}`}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.limited && <p className="muted">Only the first playbooks were read.</p>}
      </AsyncState>
    </section>
  );
}

function ProcessDetail({ id, onBack }) {
  const { data: p, error, loading } = usePoll(`/api/library/processes/${encodeURIComponent(id)}`, 0);
  return (
    <section className="stack">
      <div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>Back to playbooks</button>
      </div>
      <AsyncState loading={loading && !p} error={error}>
        {p && (
          <>
            <div className={styles.detailHead}>
              <div className="row">
                <h2>{p.name}</h2>
                <span className={`badge ${statusBadge(p.status)}`}>{p.status}</span>
                {p.version !== null && <span className="badge badge-plain">{`v${p.version}`}</span>}
              </div>
              <code className={styles.id}>{p.id}</code>
              {p.description && <p>{p.description}</p>}
            </div>
            <dl className={styles.facts}>
              <dt>Changed</dt>
              <dd>{p.updated_at ? `${formatDate(p.updated_at)}${p.updated_by ? ` by ${p.updated_by}` : ''}` : <span className="muted">—</span>}</dd>
              <dt>First stored</dt>
              <dd>{p.created_at ? formatDate(p.created_at) : <span className="muted">—</span>}</dd>
              {p.scope?.project_id && (
                <>
                  <dt>Project</dt>
                  <dd><code>{p.scope.project_id}</code></dd>
                </>
              )}
              {p.scope?.tags?.length > 0 && (
                <>
                  <dt>Tags</dt>
                  <dd className={styles.chips}>{p.scope.tags.map((tag) => <span key={tag} className={styles.chip}>{tag}</span>)}</dd>
                </>
              )}
              {p.intent_keywords.length > 0 && (
                <>
                  <dt>Matches requests about</dt>
                  <dd className={styles.chips}>{p.intent_keywords.map((k) => <span key={k} className={styles.chip}>{k}</span>)}</dd>
                </>
              )}
            </dl>
            <div className="card">
              <h3 className={styles.cardTitle}>Narrative</h3>
              {p.narrative.trim() ? <Markdown>{p.narrative}</Markdown> : <p className="muted">This playbook has no narrative yet.</p>}
            </div>
            <div>
              <h3 className={styles.cardTitle}>Earlier versions</h3>
              {p.revisions.length === 0 ? (
                <p className="muted">No earlier versions are recorded.</p>
              ) : (
                p.revisions.map((r) => (
                  <Disclosure
                    key={r.id}
                    title={r.revision !== null ? `Revision ${r.revision}` : r.id}
                    meta={<span>{[r.updated_by, r.updated_at ? formatDate(r.updated_at) : null].filter(Boolean).join(' · ')}</span>}
                  >
                    {(r.name || r.description) && <p><strong>{r.name}</strong>{r.name && r.description ? ': ' : ''}{r.description}</p>}
                    {r.narrative ? <Markdown>{r.narrative}</Markdown> : <p className="muted">No narrative in this version.</p>}
                  </Disclosure>
                ))
              )}
            </div>
          </>
        )}
      </AsyncState>
    </section>
  );
}

export function ProcessesTab({ selected, onSelect }) {
  if (selected) return <ProcessDetail id={selected} onBack={() => onSelect(null)} />;
  return <ProcessList onSelect={onSelect} />;
}
