'use client';
// dashboard/components/settings/Notice.jsx: a message above a list in Settings: the outcome of an action
// (added, removed, failed), kept until the next action or until dismissed, or a standing warning about
// the list itself (no dismiss button).
import styles from './Settings.module.css';

/**
 * @param {{notice: {kind: 'ok'|'warn'|'error', text: string}|null, onDismiss?: () => void}} props
 */
export function Notice({ notice, onDismiss }) {
  if (!notice) return null;
  return (
    <div className={`${styles.notice} ${styles[`notice-${notice.kind}`] || ''}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <span className={notice.kind === 'error' ? 'error-text' : undefined}>{notice.text}</span>
      {onDismiss && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}
