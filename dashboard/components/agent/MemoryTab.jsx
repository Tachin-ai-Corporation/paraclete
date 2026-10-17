'use client';
// dashboard/components/agent/MemoryTab.jsx: the Agent page's Memory tab. The memory files the agent
// keeps on its VM (the `workspace` command's `memory`: working memory, Deep Truths, the last
// consolidation report), and its Core Memory from Firestore. Read-only: only the agent's memory organ
// and its memory commands change either.

import { formatBytes, timeAgo } from '@/lib/client/format.js';
import { CoreMemoryPanel } from './CoreMemoryPanel.jsx';
import { Disclosure } from './Disclosure.jsx';
import { FileText, cutNote } from './FileText.jsx';
import { VmView } from './VmView.jsx';
import styles from './Agent.module.css';

const MEMORY_FILES = [
  { name: 'MEMORY.md', label: 'Working memory', about: 'Short, current context the agent carries into every turn' },
  { name: 'DEEP_TRUTHS.md', label: 'Deep Truths', about: 'The few principles confirmed across many sessions' },
  { name: 'consolidation_report.md', label: 'Consolidation report', about: 'What the last consolidation pass changed, and why' },
];

function MemoryFiles({ files }) {
  if (files.length === 0) return <p className="muted">The agent has no memory files yet.</p>;
  const rank = (file) => {
    const i = MEMORY_FILES.findIndex((m) => m.name === file.name);
    return i === -1 ? MEMORY_FILES.length : i;
  };
  const ordered = [...files].sort((a, b) => (rank(a) - rank(b)) || a.name.localeCompare(b.name));
  return (
    <div>
      {ordered.map((file) => {
        const known = MEMORY_FILES.find((m) => m.name === file.name);
        return (
          <Disclosure
            key={file.name}
            defaultOpen={file.name === 'MEMORY.md'}
            title={known ? `${known.label} · ${file.name}` : file.name}
            meta={(
              <>
                {known && <span>{known.about}</span>}
                {file.size_bytes != null && <span>{formatBytes(file.size_bytes)}</span>}
                {file.modified_at && <span>{`changed ${timeAgo(file.modified_at)}`}</span>}
                {cutNote(file) && <span className="badge badge-warn">cut</span>}
              </>
            )}
          >
            <FileText file={file} />
          </Disclosure>
        );
      })}
    </div>
  );
}

export function MemoryTab({ workspace }) {
  return (
    <div className="stack">
      <section>
        <div className={styles.sectionHead}>
          <h2>Memory files</h2>
          <p className="muted">The files the agent keeps on its VM. Only its memory organ changes them.</p>
        </div>
        <VmView command={workspace}>{(result) => <MemoryFiles files={result.memory || []} />}</VmView>
      </section>
      <section>
        <div className={styles.sectionHead}>
          <h2>Core Memory</h2>
          <p className="muted">Durable facts the agent has learned. It writes a changed fact as a new entry that supersedes the old one, and retires facts that stop being true.</p>
        </div>
        <CoreMemoryPanel />
      </section>
    </div>
  );
}
