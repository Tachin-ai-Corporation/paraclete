'use client';
// dashboard/components/library/ProjectsTab.jsx: the agent's projects, each a body of work with its own
// context: the projects as a tree (parent and child), and one project's goal, canon (facts every
// mission in it must hold to), context entries, linked playbooks, deploy target and the context its
// missions suggested. From the `projects` collection (GET /api/library/projects). Read-only.

import { useMemo, useState } from 'react';
import { AsyncState } from '@/components/ui/AsyncState.jsx';
import { usePoll } from '@/lib/client/use-poll.js';
import { formatDate, timeAgo } from '@/lib/client/format.js';
import { ValueTree } from '@/components/agent/ValueTree.jsx';
import styles from './Library.module.css';

const STATUS_BADGE = { active: 'badge-ok', paused: 'badge-warn', complete: 'badge-info', archived: 'badge-neutral' };
const statusBadge = (status) => `badge ${STATUS_BADGE[status] || 'badge-neutral'}`;

/** The projects in tree order: each parent followed by its children, with their depth. */
function asTree(projects) {
  const ids = new Set(projects.map((p) => p.id));
  const children = new Map();
  for (const p of projects) {
    const parent = p.parent_id && ids.has(p.parent_id) && p.parent_id !== p.id ? p.parent_id : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(p);
  }
  const out = [];
  const seen = new Set();
  const walk = (parent, depth) => {
    for (const p of children.get(parent) || []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ project: p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  // A parent cycle has no root; list what it left out at the top level.
  for (const p of projects) if (!seen.has(p.id)) out.push({ project: p, depth: 0 });
  return out;
}

function ProjectList({ onSelect }) {
  const { data, error, loading, refresh } = usePoll('/api/library/projects', 0);
  const [showArchived, setShowArchived] = useState(false);
  const all = data?.projects || [];
  const archived = all.filter((p) => p.status === 'archived').length;
  const rows = useMemo(() => asTree(all.filter((p) => showArchived || p.status !== 'archived')), [all, showArchived]);

  return (
    <section className="stack">
      <div className={styles.introRow}>
        <p className="muted">
          Bodies of work the agent keeps context for. Every mission belongs to one; work that names none goes to the
          default project.
        </p>
        <div className="row">
          {archived > 0 && (
            <label className={styles.check}>
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
              {`Show archived (${archived})`}
            </label>
          )}
          <button type="button" className="btn btn-sm" onClick={() => refresh()}>Refresh</button>
        </div>
      </div>
      <AsyncState loading={loading && !data} error={error} empty={Boolean(data) && all.length === 0} emptyText="The agent has no projects yet.">
        {rows.length > 0 && (
          <div className={styles.tableWrap}>
            <table className="table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Goal</th>
                  <th>Status</th>
                  <th>Changed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ project: p, depth }) => (
                  <tr key={p.id}>
                    <td className={styles.mainCell} style={{ paddingLeft: `calc(var(--space-3) + ${depth} * var(--space-5))` }}>
                      <button type="button" className={styles.open} onClick={() => onSelect(p.id)}>{p.name}</button>
                      <code className={styles.id}>{p.id}</code>
                    </td>
                    <td className={styles.preview}>{p.goal || p.description || <span className="muted">—</span>}</td>
                    <td><span className={statusBadge(p.status)}>{p.status}</span></td>
                    <td>{p.updated_at ? <span title={formatDate(p.updated_at)}>{timeAgo(p.updated_at)}</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && rows.length === 0 && all.length > 0 && <p className="muted">Every project is archived.</p>}
        {data?.limited && <p className="muted">Only the first projects were read.</p>}
      </AsyncState>
    </section>
  );
}

function ProjectLink({ id, onSelect }) {
  return <button type="button" className={styles.open} onClick={() => onSelect(id)}>{id}</button>;
}

function ContextEntries({ entries }) {
  if (entries.length === 0) return <p className="muted">No context entries.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className="table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Kind</th>
            <th>Points to</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.key}>
              <td><code>{e.key}</code></td>
              <td>{e.kind || <span className="muted">—</span>}</td>
              <td className={styles.pointer}>
                {e.name && <div>{e.name}</div>}
                {e.url && <a href={e.url} target="_blank" rel="noreferrer noopener">{e.url}</a>}
                {e.ref && <div><code>{e.ref}</code></div>}
                {e.value !== null && <div className={styles.preview}>{e.value}</div>}
              </td>
              <td className={styles.preview}>
                {e.summary || ''}
                {e.updated_at && <div className="muted">{`${timeAgo(e.updated_at)}${e.updated_by ? ` by ${e.updated_by}` : ''}`}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Promotions({ promotions }) {
  if (promotions.length === 0) return <p className="muted">No suggestions.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className="table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Suggested entry</th>
            <th>From mission</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {promotions.map((s) => (
            <tr key={s.id}>
              <td><code>{s.key}</code></td>
              <td className={styles.preview}>
                <div>{[s.kind, s.name].filter(Boolean).join(': ') || <span className="muted">—</span>}</div>
                {s.summary && <div className="muted">{s.summary}</div>}
              </td>
              <td>
                {s.source_mission_id ? <code>{s.source_mission_id}</code> : <span className="muted">—</span>}
                {s.suggested_at && <div className="muted">{timeAgo(s.suggested_at)}</div>}
              </td>
              <td><span className={`badge ${s.status === 'pending' ? 'badge-warn' : 'badge-neutral'}`}>{s.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProjectDetail({ id, onSelect, onOpenProcess }) {
  const { data: p, error, loading } = usePoll(`/api/library/projects/${encodeURIComponent(id)}`, 0);
  return (
    <section className="stack">
      <div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelect(null)}>Back to projects</button>
      </div>
      <AsyncState loading={loading && !p} error={error}>
        {p && (
          <>
            <div className={styles.detailHead}>
              <div className="row">
                <h2>{p.name}</h2>
                <span className={statusBadge(p.status)}>{p.status}</span>
              </div>
              <code className={styles.id}>{p.id}</code>
              {p.description && <p>{p.description}</p>}
            </div>
            <dl className={styles.facts}>
              <dt>Goal</dt>
              <dd>{p.goal || <span className="muted">—</span>}</dd>
              {p.parent_id && (
                <>
                  <dt>Part of</dt>
                  <dd><ProjectLink id={p.parent_id} onSelect={onSelect} /></dd>
                </>
              )}
              {p.depends_on.length > 0 && (
                <>
                  <dt>Depends on</dt>
                  <dd className={styles.chips}>{p.depends_on.map((dep) => <ProjectLink key={dep} id={dep} onSelect={onSelect} />)}</dd>
                </>
              )}
              <dt>Created</dt>
              <dd>{p.created_at ? `${formatDate(p.created_at)}${p.created_by ? ` by ${p.created_by}` : ''}` : <span className="muted">—</span>}</dd>
              <dt>Changed</dt>
              <dd>{p.updated_at ? formatDate(p.updated_at) : <span className="muted">—</span>}</dd>
              {p.completed_at && (
                <>
                  <dt>Completed</dt>
                  <dd>{formatDate(p.completed_at)}</dd>
                </>
              )}
              <dt>Completes itself</dt>
              <dd>{p.auto_complete ? 'Yes, once its missions, sub-projects and dependencies are done' : 'No: it stays open until someone completes it'}</dd>
            </dl>

            <div className="card">
              <h3 className={styles.cardTitle}>Canon</h3>
              <p className="muted">Authoritative facts every mission in this project must hold to. Only its canon authority may change them.</p>
              {p.canon.entries.length === 0 ? (
                <p className="muted">No canon entries.</p>
              ) : (
                <ul className={styles.canon}>
                  {p.canon.entries.map((entry, i) => (
                    <li key={`${entry.key}-${i}`}>
                      <strong>{entry.key}</strong>
                      <p>{entry.text}</p>
                      {(entry.updated_by || entry.updated_at) && (
                        <p className="muted">{[entry.updated_by, entry.updated_at ? formatDate(entry.updated_at) : null].filter(Boolean).join(' · ')}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {p.canon.authority.length > 0 && <p className="muted">{`Canon authority: ${p.canon.authority.join(', ')}`}</p>}
            </div>

            <div>
              <h3 className={styles.cardTitle}>Context</h3>
              <p className={`muted ${styles.intro}`}>The durable resources and working conventions of this project, given to every mission in it.</p>
              <ContextEntries entries={p.context} />
            </div>

            <div>
              <h3 className={styles.cardTitle}>Playbooks</h3>
              {p.standard_processes.length === 0 ? (
                <p className="muted">No playbooks linked.</p>
              ) : (
                <div className={styles.chips}>
                  {p.standard_processes.map((pid) => (
                    <button key={pid} type="button" className={styles.open} onClick={() => onOpenProcess(pid)}>{pid}</button>
                  ))}
                </div>
              )}
            </div>

            {p.deploy && (
              <div className="card">
                <h3 className={styles.cardTitle}>Deploy target</h3>
                <ValueTree value={p.deploy} />
              </div>
            )}

            <div>
              <h3 className={styles.cardTitle}>Suggested context</h3>
              <p className={`muted ${styles.intro}`}>Context a finished mission offered to this project, for a person to accept.</p>
              <Promotions promotions={p.promotions} />
            </div>
          </>
        )}
      </AsyncState>
    </section>
  );
}

export function ProjectsTab({ selected, onSelect, onOpenProcess }) {
  if (selected) return <ProjectDetail key={selected} id={selected} onSelect={onSelect} onOpenProcess={onOpenProcess} />;
  return <ProjectList onSelect={onSelect} />;
}
