// dashboard/components/work/WorkHistory.jsx: an envelope's step history (work/{id}/history), oldest
// first: each status change, when, by which service or organ, and what happened in its own words.
import { formatDate } from '@/lib/client/format.js';
import { OrganName, statusLabel } from './status.jsx';
import styles from './WorkHistory.module.css';

export function WorkHistory({ entries, truncated = false }) {
  if (!entries || entries.length === 0) return <p className="muted">No history recorded.</p>;
  return (
    <div className={styles.wrap}>
      {truncated && <p className="muted">Only the latest {entries.length} steps are shown.</p>}
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Change</th>
            <th>By</th>
            <th>What happened</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className={styles.when}>{formatDate(entry.at)}</td>
              <td className={styles.change}>
                {entry.from ? `${statusLabel(entry.from)} → ${statusLabel(entry.to)}` : `Created: ${statusLabel(entry.to)}`}
              </td>
              <td className={styles.by}><OrganName organ={entry.by} /></td>
              <td className={styles.detail}>{entry.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
