'use client';
// dashboard/components/approvals/ApprovalCard.jsx: one approval gate as a person decides it: what the
// agent wants to do once it is approved, who the mission is for and when it asked, an optional reason,
// and Approve and Reject. Any dashboard user may decide. The decision goes to POST /api/approvals/:id;
// the agent's poller picks it up within seconds and resumes or stops the mission. A gate that was
// decided, or whose mission moved on, shows that instead of the buttons. Used on the approvals page and
// on a waiting mission's page.
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/client/api.js';
import { formatDate, timeAgo } from '@/lib/client/format.js';
import { StatusBadge } from '@/components/work/status.jsx';
import styles from './ApprovalCard.module.css';

const DECIDED = { approved: ['Approved', 'badge-ok'], rejected: ['Rejected', 'badge-danger'] };

/** A decided gate: who decided, when, why, and whether the agent has acted on it yet. */
export function Decision({ approval }) {
  const [label, badge] = DECIDED[approval.status] || [approval.status, 'badge-neutral'];
  return (
    <div className={styles.decision}>
      <span className={`badge ${badge}`}>{label}</span>
      <span>
        by <strong>{approval.resolved_by || 'someone'}</strong>{' '}
        <span className="muted" title={formatDate(approval.resolved_at)}>{timeAgo(approval.resolved_at)}</span>
      </span>
      {approval.reason && <span className={styles.reason}>“{approval.reason}”</span>}
      <span className="muted">
        {approval.acted_on ? 'The agent has acted on it.' : 'The agent picks it up within a few seconds.'}
      </span>
    </div>
  );
}

/**
 * @param {object}   props
 * @param {object}   props.approval     from GET /api/approvals or GET /api/work/:id
 * @param {Function} [props.onDecided]  called after a decision is sent (or refused), to refresh
 * @param {boolean}  [props.showMission] link the mission (off on the mission's own page)
 */
export function ApprovalCard({ approval, onDecided, showMission = true }) {
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(null);
  const [error, setError] = useState(null);
  const [decided, setDecided] = useState(null);
  // A fresh read of a decided gate wins over the answer to this card's own decision (it says whether
  // the agent has acted on it since).
  const shown = approval.status !== 'pending' ? approval : decided || approval;
  const pending = shown.status === 'pending';

  async function decide(decision) {
    setSending(decision);
    setError(null);
    try {
      const result = await api(`/api/approvals/${encodeURIComponent(approval.id)}`, {
        method: 'POST',
        body: { decision, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      });
      setDecided(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(null);
      onDecided?.();
    }
  }

  return (
    <article className={`card ${styles.card} ${pending && approval.live ? styles.live : ''}`}>
      <header className={styles.head}>
        <h3 className={styles.title}>{shown.title || 'Approval needed'}</h3>
        <span className="muted" title={formatDate(shown.requested_at)}>asked {timeAgo(shown.requested_at)}</span>
      </header>
      {shown.description && <p className={styles.description}>{shown.description}</p>}
      <dl className={styles.facts}>
        {showMission && shown.mission_id && (
          <>
            <dt>Mission</dt>
            <dd>
              <Link href={`/work/${shown.mission_id}`}>{shown.mission?.title || shown.mission_id}</Link>
              {shown.mission?.status && <> <StatusBadge outcome={shown.mission.status} /></>}
            </dd>
          </>
        )}
        <dt>For</dt>
        <dd>{shown.requested_by || 'Scheduled work (no one asked in the moment)'}</dd>
        {shown.checkpoint && (
          <>
            <dt>Where</dt>
            <dd>Checkpoint {shown.checkpoint}{shown.task ? `, step ${shown.task}` : ''}{shown.project ? ` · ${shown.project}` : ''}</dd>
          </>
        )}
      </dl>

      {!pending ? (
        <Decision approval={shown} />
      ) : !approval.live ? (
        <p className="muted">No longer needed: {approval.stale_reason || 'its mission moved on'}.</p>
      ) : (
        <div className={styles.decide}>
          <label className="label" htmlFor={`reason-${approval.id}`}>Reason (optional)</label>
          <input
            id={`reason-${approval.id}`}
            className="input"
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Shown with your decision; a rejection's reason is recorded as why the mission stopped"
          />
          <div className={styles.buttons}>
            <button type="button" className="btn btn-primary" disabled={Boolean(sending)} onClick={() => decide('approved')}>
              {sending === 'approved' ? 'Approving…' : 'Approve'}
            </button>
            <button type="button" className="btn btn-danger" disabled={Boolean(sending)} onClick={() => decide('rejected')}>
              {sending === 'rejected' ? 'Rejecting…' : 'Reject and stop the mission'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </article>
  );
}
