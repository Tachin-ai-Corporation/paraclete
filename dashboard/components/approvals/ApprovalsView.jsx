'use client';
// dashboard/components/approvals/ApprovalsView.jsx: the approvals page (/approvals). The gates waiting
// for a decision come first, each decided right on its card; then the gates nobody needs any more
// (their mission moved on without a decision); then the recent decisions: who approved or rejected,
// when, why, and whether the agent has acted on it yet. Reads GET /api/approvals every few seconds.
import Link from 'next/link';
import { usePoll } from '@/lib/client/use-poll.js';
import { formatDate, timeAgo } from '@/lib/client/format.js';
import { AsyncState } from '@/components/ui/AsyncState.jsx';
import { ApprovalCard } from './ApprovalCard.jsx';
import styles from './ApprovalsView.module.css';

const DECIDED = { approved: ['Approved', 'badge-ok'], rejected: ['Rejected', 'badge-danger'] };

export function ApprovalsView() {
  const { data, error, loading, refresh } = usePoll('/api/approvals', 5000);
  const live = (data?.pending || []).filter((a) => a.live);
  const stale = (data?.pending || []).filter((a) => !a.live);
  const resolved = data?.resolved || [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Approvals</h1>
          <p>Steps the agent will not take until someone says yes. Any dashboard user can decide.</p>
        </div>
      </div>
      <AsyncState loading={loading && !data} error={error}>
        {data && (
          <div className={styles.sections}>
            <section>
              <h2 className={styles.heading}>Waiting for a decision</h2>
              {live.length === 0
                ? <p className="muted">Nothing is waiting for a decision.</p>
                : <div className="stack">{live.map((approval) => <ApprovalCard key={approval.id} approval={approval} onDecided={refresh} />)}</div>}
            </section>

            {stale.length > 0 && (
              <section>
                <h2 className={styles.heading}>No longer needed</h2>
                <p className="muted">Their missions moved on without a decision, so nothing waits on these.</p>
                <ul className={styles.stale}>
                  {stale.map((approval) => (
                    <li key={approval.id}>
                      <span>{approval.title || 'Approval gate'}</span>
                      {approval.mission_id && <> · <Link href={`/work/${approval.mission_id}`}>{approval.mission?.title || 'its mission'}</Link></>}
                      <span className="muted"> · {approval.stale_reason} · asked {timeAgo(approval.requested_at)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h2 className={styles.heading}>Recently decided</h2>
              {resolved.length === 0 ? (
                <p className="muted">No decisions yet.</p>
              ) : (
                <div className={styles.tableWrap}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Decision</th>
                        <th>Gate</th>
                        <th>By</th>
                        <th>When</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resolved.map((approval) => {
                        const [label, badge] = DECIDED[approval.status] || [approval.status, 'badge-neutral'];
                        return (
                          <tr key={approval.id}>
                            <td>
                              <span className={`badge ${badge}`}>{label}</span>
                              {!approval.acted_on && <div className={styles.pendingAct}>being picked up</div>}
                            </td>
                            <td className={styles.gate}>
                              {approval.mission_id ? <Link href={`/work/${approval.mission_id}`}>{approval.title || 'Approval gate'}</Link> : approval.title}
                              {approval.requested_by && <div className="muted">for {approval.requested_by}</div>}
                            </td>
                            <td className={styles.by}>{approval.resolved_by}</td>
                            <td className={styles.when} title={formatDate(approval.resolved_at)}>{timeAgo(approval.resolved_at)}</td>
                            <td className={styles.reason}>{approval.reason || ''}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </AsyncState>
    </div>
  );
}
