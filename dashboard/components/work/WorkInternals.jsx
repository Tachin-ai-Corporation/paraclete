// dashboard/components/work/WorkInternals.jsx: the facts about an envelope, and, folded away, how the
// brain keeps its place in it: who holds it (the claim), where a resumed run picks up, and the step
// ledger (which steps already ran, so a resumed mission never repeats one). For someone working out
// why a mission did what it did.
import Link from 'next/link';
import { formatDate } from '@/lib/client/format.js';
import { TYPE_LABEL } from './status.jsx';
import styles from './WorkInternals.module.css';

function Fact({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

const DELIVERY = { pending: 'Waiting to be sent', delivered: 'Sent', failed: 'Could not be sent', internal: 'Not sent (internal)' };

export function WorkFacts({ envelope }) {
  const reply = envelope.delivery_status
    ? [
      DELIVERY[envelope.delivery_status] || envelope.delivery_status,
      envelope.delivered_at ? formatDate(envelope.delivered_at) : '',
      envelope.delivery_error ? `(${envelope.delivery_error})` : '',
    ].filter(Boolean).join(' ')
    : null;
  return (
    <dl className={styles.facts}>
      <Fact label="ID"><code>{envelope.id}</code></Fact>
      <Fact label="Kind">{TYPE_LABEL[envelope.type] || envelope.type}</Fact>
      <Fact label="Channel">{envelope.channel}</Fact>
      <Fact label="Project">{envelope.project_id}</Fact>
      <Fact label="Stakes">{envelope.stakes}</Fact>
      <Fact label="Created">{formatDate(envelope.created_at)}</Fact>
      <Fact label="Started">{formatDate(envelope.started_at)}</Fact>
      <Fact label="Ended">{formatDate(envelope.completed_at)}</Fact>
      <Fact label="Last change">{formatDate(envelope.updated_at)}</Fact>
      <Fact label="Reply">{reply}</Fact>
      <Fact label="Cancelled">{envelope.cancelled_reason}</Fact>
      <Fact label="Archived">{envelope.archived ? envelope.archived_reason || 'yes' : null}</Fact>
    </dl>
  );
}

export function WorkInternals({ internals }) {
  if (!internals) return null;
  const { steps = [], resume } = internals;
  return (
    <details className={styles.internals}>
      <summary>
        Internals
        <span className="muted"> · {steps.length} step{steps.length === 1 ? '' : 's'} in the ledger{internals.claimed_by ? ' · claimed' : ''}{resume ? ' · resumable' : ''}</span>
      </summary>
      <dl className={styles.facts}>
        <Fact label="Claimed by">{internals.claimed_by ? `${internals.claimed_by} since ${formatDate(internals.claimed_at)}` : 'Nobody'}</Fact>
        <Fact label="Iteration">{internals.iteration}</Fact>
        <Fact label="Re-plans">{internals.replans}</Fact>
        <Fact label="Resumes at">{resume ? `Checkpoint ${resume.checkpoint}, task ${resume.task} (${resume.results} results kept)` : null}</Fact>
        <Fact label="Release">{internals.platform_version}</Fact>
      </dl>
      {steps.length > 0 && (
        <div className={styles.ledger}>
          <table className="table">
            <thead>
              <tr>
                <th>Checkpoint</th>
                <th>Task</th>
                <th>Result</th>
                <th>Took</th>
                <th>When</th>
                <th>Key</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step) => (
                <tr key={step.key}>
                  <td>{step.checkpoint ?? ''}</td>
                  <td>{step.ref ? <Link href={`/work/${step.ref}`}>Open</Link> : ''}</td>
                  <td>{step.status === 'complete' ? 'Done' : step.status === 'failed' ? <span className="error-text">{step.error || 'Failed'}</span> : step.status}</td>
                  <td>{Number.isFinite(step.duration_ms) ? `${(step.duration_ms / 1000).toFixed(1)}s` : ''}</td>
                  <td className={styles.when}>{formatDate(step.at)}</td>
                  <td className={styles.key} title={step.key}>{step.key}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
