// dashboard/components/chat/Attachments.jsx: the files a message carries, as chips with the file's
// type, name and size. A file the agent handed back (under files/out/) or a person uploaded (under
// files/in/) links to /api/files/download, which redirects to a short-lived signed URL that downloads
// it straight from the instance's bucket; any other file is listed without a link. While a message is
// still being sent its files are not downloadable yet.

import { formatBytes } from '@/lib/client/format.js';
import styles from './Attachments.module.css';

const downloadUrl = (gcsPath) => `/api/files/download?path=${encodeURIComponent(gcsPath)}`;

/** The file's extension as a short label, e.g. "DOCX". */
function kindOf(name) {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ''));
  return match ? match[1].toUpperCase() : 'FILE';
}

/**
 * @param {{files?: Array<{name: string, size: number, gcsPath: string, downloadable: boolean}>}} props
 */
export function Attachments({ files }) {
  if (!Array.isArray(files) || files.length === 0) return null;
  return (
    <ul className={styles.list} aria-label="Files">
      {files.map((file, index) => {
        const label = (
          <>
            <span className={styles.kind} aria-hidden="true">{kindOf(file.name)}</span>
            <span className={styles.name}>{file.name}</span>
            {file.size > 0 && <span className={styles.size}>{formatBytes(file.size)}</span>}
          </>
        );
        return (
          <li key={`${file.gcsPath || file.name}-${index}`}>
            {file.downloadable ? (
              <a className={styles.chip} href={downloadUrl(file.gcsPath)} download={file.name} title={`Download ${file.name}`}>
                {label}
                <span className={styles.action}>Download</span>
              </a>
            ) : (
              <span className={`${styles.chip} ${styles.unavailable}`} title="This file cannot be downloaded from the chat">
                {label}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
