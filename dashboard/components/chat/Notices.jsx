'use client';
// dashboard/components/chat/Notices.jsx: the agent's newest messages that belong to no conversation,
// such as the outcome of scheduled work nobody in particular asked for. Every user sees the same
// ones, newest first, in a small panel beside the chat; long ones are folded. Hidden while there are
// none. Read from /api/chat/notices.

import { useState } from 'react';
import { usePoll } from '@/lib/client/use-poll.js';
import { formatDate, timeAgo } from '@/lib/client/format.js';
import { Markdown } from '@/components/ui/Markdown.jsx';
import { Attachments } from './Attachments.jsx';
import styles from './Notices.module.css';

const POLL_MS = 60_000;
/** Longer than this, a notice starts folded. */
const FOLD_CHARS = 280;
const FOLD_LINES = 6;

function Notice({ notice }) {
  const [open, setOpen] = useState(false);
  const long = notice.text.length > FOLD_CHARS || notice.text.split('\n').length > FOLD_LINES;
  return (
    <li className={styles.notice}>
      <time className={styles.time} dateTime={notice.timestamp || undefined} title={formatDate(notice.timestamp)}>
        {timeAgo(notice.timestamp)}
      </time>
      <div className={`${styles.text} ${long && !open ? styles.clamped : ''}`}>
        <Markdown>{notice.text}</Markdown>
      </div>
      {long && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
      <Attachments files={notice.attachments} />
    </li>
  );
}

/**
 * @param {{agentName: string}} props
 */
export function Notices({ agentName }) {
  const { data, error } = usePoll('/api/chat/notices', POLL_MS);
  const notices = data?.notices || [];
  if (!error && notices.length === 0) return null;
  return (
    <aside className={styles.panel} aria-labelledby="notices-heading">
      <h2 id="notices-heading" className={styles.heading}>Notices from {agentName}</h2>
      {error && <p className="error-text">Notices could not be loaded: {error.message}</p>}
      <ul className={styles.list}>
        {notices.map((notice) => <Notice key={notice.id} notice={notice} />)}
      </ul>
    </aside>
  );
}
