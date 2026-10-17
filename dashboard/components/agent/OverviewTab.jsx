'use client';
// dashboard/components/agent/OverviewTab.jsx: the Agent page's first tab. The install state the VM's
// bootstrap recorded (GET /api/agent), and the persona: the identity prompt and each organ's prompt,
// the base every instance shares followed by what the role adds, exactly as the gateway joins them
// (from the `workspace` command's `prompts`). The agent cannot change any of it.

import { AsyncState } from '@/components/ui/AsyncState.jsx';
import { formatBytes, formatDate, timeAgo } from '@/lib/client/format.js';
import { Disclosure } from './Disclosure.jsx';
import { FileText, cutNote } from './FileText.jsx';
import { PERSONA_PARTS } from './organs.js';
import { VmView } from './VmView.jsx';
import styles from './Agent.module.css';

const STATUS_BADGE = { ready: 'badge-ok', failed: 'badge-danger' };

function InstallState({ agent, error, loading }) {
  return (
    <section className="card">
      <h2 className={styles.cardTitle}>Install</h2>
      <AsyncState loading={loading && !agent} error={error}>
        {agent && (
          <dl className={styles.facts}>
            <dt>Status</dt>
            <dd><span className={`badge ${STATUS_BADGE[agent.status] || 'badge-neutral'}`}>{agent.status}</span></dd>
            <dt>Role</dt>
            <dd>{agent.role}</dd>
            <dt>Release</dt>
            <dd>{agent.release || <span className="muted">none recorded</span>}</dd>
            <dt>Commit</dt>
            <dd>{agent.commit ? <code title={agent.commit}>{agent.commit.slice(0, 12)}</code> : <span className="muted">none recorded</span>}</dd>
            {agent.ready_at && (
              <>
                <dt>Ready since</dt>
                <dd>{formatDate(agent.ready_at)} <span className="muted">({timeAgo(agent.ready_at)})</span></dd>
              </>
            )}
            {agent.failed_at && (
              <>
                <dt>Failed</dt>
                <dd>{formatDate(agent.failed_at)}</dd>
              </>
            )}
            {agent.error && (
              <>
                <dt>Error</dt>
                <dd className="error-text">{agent.error}</dd>
              </>
            )}
          </dl>
        )}
      </AsyncState>
    </section>
  );
}

/**
 * The prompt files grouped by organ, base first, then the role's addition, in persona order. A
 * directory's README.md is about the directory, not a prompt any organ reads, so it is left out.
 */
function groupPrompts(prompts) {
  const byPart = new Map();
  for (const file of prompts) {
    if (/^readme\.md$/i.test(String(file.name || ''))) continue;
    const part = String(file.name || '').replace(/\.md$/, '');
    if (!byPart.has(part)) byPart.set(part, []);
    byPart.get(part).push(file);
  }
  const known = PERSONA_PARTS.filter((p) => byPart.has(p.id)).map((p) => ({ ...p, files: byPart.get(p.id) }));
  const other = [...byPart.keys()]
    .filter((id) => !PERSONA_PARTS.some((p) => p.id === id))
    .sort()
    .map((id) => ({ id, label: id, job: null, files: byPart.get(id) }));
  return [...known, ...other];
}

const sourceLabel = (source) => (source === 'base' ? 'base' : String(source || '').replace(/^role:/, 'role: '));

function Persona({ prompts }) {
  const parts = groupPrompts(prompts);
  if (parts.length === 0) return <p className="muted">The VM reported no prompt files.</p>;
  return (
    <div>
      {parts.map((part) => (
        <Disclosure
          key={part.id}
          defaultOpen={part.id === 'identity'}
          title={part.label}
          meta={(
            <>
              {part.job && <span>{part.job}</span>}
              {part.files.map((file) => (
                <span key={`${file.source}-${file.name}`} className={`badge badge-plain ${file.source === 'base' ? '' : 'badge-info'}`}>
                  {sourceLabel(file.source)}
                </span>
              ))}
              {part.files.some((file) => cutNote(file)) && <span className="badge badge-warn">cut</span>}
            </>
          )}
        >
          {part.files.map((file) => (
            <div key={`${file.source}-${file.name}`} className={styles.promptPart}>
              <p className={styles.partLabel}>
                {file.source === 'base' ? 'Base prompt' : `Added by the ${sourceLabel(file.source).replace('role: ', '')} role`}
                <span className="muted"> · {file.name}{file.size_bytes != null ? ` · ${formatBytes(file.size_bytes)}` : ''}</span>
              </p>
              <FileText file={file} />
            </div>
          ))}
        </Disclosure>
      ))}
    </div>
  );
}

export function OverviewTab({ agent, agentError, agentLoading, workspace }) {
  return (
    <div className="stack">
      <InstallState agent={agent} error={agentError} loading={agentLoading} />
      <section>
        <div className={styles.sectionHead}>
          <h2>Persona</h2>
          <p className="muted">
            Who the agent is and how each organ of its brain works: the base prompts every instance shares, then
            what its role adds. Installed with each release; the agent cannot change them.
          </p>
        </div>
        <VmView command={workspace}>{(result) => <Persona prompts={result.prompts || []} />}</VmView>
      </section>
    </div>
  );
}
