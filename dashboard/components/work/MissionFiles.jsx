'use client';
// dashboard/components/work/MissionFiles.jsx: the Files section of a mission's page: every file the
// mission handed back, newest first, with its size, type, when it came and where from, a download
// link (/api/files/download, which redirects to a short-lived signed URL on the bucket) and its Drive
// link when the agent also saved it to Drive. Reads GET /api/work/:id/files, every few seconds while
// the mission runs and once a minute after it ended. A mission with no files says so only once it has
// finished; until then the section stays out of the way.

import { useEffect, useState } from 'react';
import { usePoll } from '@/lib/client/use-poll.js';
import { formatBytes, formatDate, timeAgo } from '@/lib/client/format.js';
import styles from './MissionFiles.module.css';

const OPEN_POLL_MS = 10_000;
const SETTLED_POLL_MS = 60_000;

const downloadUrl = (gcsPath) => `/api/files/download?path=${encodeURIComponent(gcsPath)}`;

/** How a record's source reads. */
const SOURCES = {
  'file-share': 'Shared by the agent',
  artifact: 'From its work',
  drive: 'From Drive',
  upload: 'Uploaded',
};

/** The file's extension as a short label, e.g. "DOCX". */
function kindOf(name) {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ''));
  return match ? match[1].toUpperCase() : 'FILE';
}

/**
 * @param {object}  props
 * @param {string}  props.id       the mission's id
 * @param {boolean} props.settled  the mission has finished
 */
export function MissionFiles({ id, settled }) {
  const { data, error } = usePoll(`/api/work/${encodeURIComponent(id)}/files`, settled ? SETTLED_POLL_MS : OPEN_POLL_MS);
  // Changing the poll interval starts the poll over; keep showing the last answer meanwhile.
  const [last, setLast] = useState(null);
  useEffect(() => {
    if (data) setLast(data);
  }, [data]);
  const files = (data || last)?.files;

  if (!files) {
    return error ? (
      <section className={styles.block}>
        <h2>Files</h2>
        <p className="error-text">Its files could not be read: {error.message}</p>
      </section>
    ) : null;
  }
  if (files.length === 0 && !settled) return null;

  return (
    <section className={styles.block}>
      <h2>Files</h2>
      {error && <p className="error-text">Could not refresh: {error.message}</p>}
      {files.length === 0 ? (
        <p className="muted">It handed back no files.</p>
      ) : (
        <ul className={`card ${styles.list}`}>
          {files.map((file) => (
            <li key={file.id} className={styles.file}>
              <span className={styles.kind} aria-hidden="true">{kindOf(file.name)}</span>
              <div className={styles.text}>
                {file.downloadable ? (
                  <a className={styles.name} href={downloadUrl(file.gcs_path)} download={file.name} title={`Download ${file.name}`}>{file.name}</a>
                ) : (
                  <span className={styles.name}>{file.name}</span>
                )}
                <span className={styles.meta}>
                  {[
                    formatBytes(file.size),
                    SOURCES[file.source] || null,
                    file.created_at ? timeAgo(file.created_at) : null,
                  ].filter(Boolean).join(' · ')}
                </span>
              </div>
              <div className={styles.actions}>
                {file.drive_link && (
                  <a className="btn btn-sm btn-ghost" href={file.drive_link} target="_blank" rel="noopener noreferrer">Open in Drive</a>
                )}
                {file.downloadable && (
                  <a className="btn btn-sm" href={downloadUrl(file.gcs_path)} download={file.name} title={formatDate(file.created_at)}>Download</a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
