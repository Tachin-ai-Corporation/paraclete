'use client';
// dashboard/components/chat/UploadChips.jsx: the files waiting to go with the next message, above the
// composer's box. Each chip shows the file's type, name and size; while it uploads, how far it has got;
// once uploaded, that it is ready; if it failed, why, with a way to try again. Any chip can be removed
// before the message is sent. The items come from use-uploads.js.

import { formatBytes } from '@/lib/client/format.js';
import { percent } from './upload-list.js';
import styles from './UploadChips.module.css';

/** The file's extension as a short label, e.g. "PDF". */
function kindOf(name) {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ''));
  return match ? match[1].toUpperCase() : 'FILE';
}

function Chip({ item, onRemove, onRetry, disabled }) {
  const progress = percent(item.loaded, item.size);
  const state = item.status === 'failed' ? styles.failed : item.status === 'done' ? styles.done : '';
  return (
    <li className={`${styles.chip} ${state}`}>
      <div className={styles.row}>
        <span className={styles.kind} aria-hidden="true">{kindOf(item.name)}</span>
        <span className={styles.name} title={item.name}>{item.name}</span>
        <span className={styles.status}>
          {item.status === 'uploading' && <span aria-live="polite">{`${progress}%`}</span>}
          {item.status === 'done' && formatBytes(item.size)}
          {item.status === 'failed' && 'Not uploaded'}
        </span>
        {item.status === 'failed' && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRetry(item.key)} disabled={disabled}>
            Try again
          </button>
        )}
        <button
          type="button"
          className={`btn btn-ghost btn-sm ${styles.remove}`}
          onClick={() => onRemove(item.key)}
          disabled={disabled}
          aria-label={`Remove ${item.name}`}
          title="Remove"
        >
          Remove
        </button>
      </div>
      {item.status === 'uploading' && (
        <div
          className={styles.bar}
          role="progressbar"
          aria-label={`Uploading ${item.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
      {item.status === 'failed' && item.error && <p className={`error-text ${styles.error}`} role="alert">{item.error}</p>}
    </li>
  );
}

/**
 * @param {object}   props
 * @param {object[]} props.items       from useUploads()
 * @param {(key: string) => void} props.onRemove
 * @param {(key: string) => void} props.onRetry
 * @param {boolean}  [props.disabled]  while the message is being sent
 */
export function UploadChips({ items, onRemove, onRetry, disabled = false }) {
  if (!items.length) return null;
  return (
    <ul className={styles.list} aria-label="Files to send">
      {items.map((item) => <Chip key={item.key} item={item} onRemove={onRemove} onRetry={onRetry} disabled={disabled} />)}
    </ul>
  );
}
