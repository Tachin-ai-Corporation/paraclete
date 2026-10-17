// dashboard/components/chat/Presence.jsx: the missions this conversation started that are not
// finished yet, in a strip above the composer: what each is, where it stands, and a link to its full
// record on the Work page (and to Approvals when one waits for a person's approval). Read from
// /api/chat/presence.

import Link from 'next/link';
import { formatDate, timeAgo } from '@/lib/client/format.js';
import styles from './Presence.module.css';

const LABELS = {
  pending: 'Starting',
  planned: 'Planned',
  queued: 'Queued',
  active: 'Working',
  waiting: 'Waiting',
  awaiting_approval: 'Needs approval',
  needs_input: 'Needs your answer',
  needs_review: 'Needs review',
  blocked: 'Blocked',
};

const BADGES = {
  active: 'badge-info',
  awaiting_approval: 'badge-warn',
  needs_input: 'badge-warn',
  needs_review: 'badge-warn',
  blocked: 'badge-danger',
};

const TONES = { awaiting_approval: 'warn', needs_input: 'warn', needs_review: 'warn', blocked: 'danger' };

/** One line on where a mission stands. */
function detailOf(mission) {
  switch (mission.status) {
    case 'blocked':
      return mission.blocker || 'It cannot go on without help.';
    case 'needs_input':
      return 'Answer its question in the chat to let it go on.';
    case 'awaiting_approval':
      return 'Its next step waits for someone to approve it.';
    case 'needs_review':
      return 'Its work could not be checked automatically; someone should look.';
    case 'waiting':
      return mission.waiting_until ? `Picks up again ${formatDate(mission.waiting_until)}` : 'Waiting to pick up again.';
    case 'pending':
    case 'planned':
    case 'queued':
      return 'Starts shortly.';
    default:
      break;
  }
  const { progress } = mission;
  if (progress?.current) return `Step ${Math.min(progress.done + 1, progress.total)} of ${progress.total}: ${progress.current}`;
  if (progress) return `${progress.done} of ${progress.total} steps done`;
  return mission.started_at ? `Started ${timeAgo(mission.started_at)}` : '';
}

/**
 * @param {{missions: Array<object>}} props
 */
export function Presence({ missions }) {
  if (!missions?.length) return null;
  return (
    <ul className={styles.strip} aria-label="Work in progress">
      {missions.map((mission) => (
        <li key={mission.id} className={styles.item}>
          <span className={styles.marker} aria-hidden="true">
            {mission.status === 'active'
              ? <span className={styles.spinner} />
              : <span className={styles.dot} data-tone={TONES[mission.status] || 'neutral'} />}
          </span>
          <div className={styles.text}>
            <Link href={`/work/${encodeURIComponent(mission.id)}`} className={styles.title} title={mission.title}>
              {mission.title}
            </Link>
            <span className={styles.detail}>{detailOf(mission)}</span>
          </div>
          <span className={`badge ${BADGES[mission.status] || 'badge-neutral'}`}>{LABELS[mission.status] || mission.status}</span>
          {mission.status === 'awaiting_approval' && (
            <Link href="/approvals" className="btn btn-sm">Review</Link>
          )}
        </li>
      ))}
    </ul>
  );
}
