'use client';
// dashboard/components/agent/FileText.jsx: one file from the VM's workspace view (a memory file or an
// organ prompt) as Markdown, with every cut marked. The control service bounds each file and the
// whole answer to stay under Firestore's document limit (agent/services/control/introspection.mjs):
// a long file arrives cut, and once the answer's budget is spent later files arrive without content.

import { Markdown } from '@/components/ui/Markdown.jsx';
import { formatBytes } from '@/lib/client/format.js';

/**
 * Says how much of a file is shown, or null when all of it is.
 *
 * @param {{content: string|null, truncated: boolean, size_bytes?: number}} file
 * @returns {string|null}
 */
export function cutNote(file) {
  const size = formatBytes(file.size_bytes);
  if (file.content === null && file.truncated) return `Not shown: the view reached its size limit before this file${size ? ` (${size})` : ''}.`;
  if (file.content === null) return 'This file could not be read.';
  if (file.truncated) return `Cut: only the start of this file${size ? ` (${size})` : ''} is shown.`;
  return null;
}

/**
 * @param {{file: {content: string|null, truncated: boolean, size_bytes?: number}}} props
 */
export function FileText({ file }) {
  const note = cutNote(file);
  return (
    <>
      {file.content !== null && (file.content.trim() ? <Markdown>{file.content}</Markdown> : <p className="muted">This file is empty.</p>)}
      {note && <p className="muted">{note}</p>}
    </>
  );
}
