'use client';
// dashboard/components/agent/CoreMemoryPanel.jsx: the agent's Core Memory (GET /api/memory/core), one
// status at a time, searched and filtered in the browser: Firestore has no text search. Entries come
// most valuable first (importance x confidence, the agent's own order), or newest first.

import { useMemo, useState } from 'react';
import { usePoll } from '@/lib/client/use-poll.js';
import { formatDate, timeAgo } from '@/lib/client/format.js';
import { AsyncState } from '@/components/ui/AsyncState.jsx';
import styles from './Agent.module.css';

const STATUSES = [
  { id: 'active', label: 'Active' },
  { id: 'superseded', label: 'Superseded' },
  { id: 'retired', label: 'Retired' },
  { id: 'all', label: 'Every status' },
];

const STATUS_BADGE = { active: 'badge-ok', superseded: 'badge-neutral', retired: 'badge-neutral' };

const instant = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : -Infinity;
};
const number = (value) => (typeof value === 'number' ? value.toFixed(2).replace(/\.?0+$/, '') : '—');

/** Every search term must appear in the entry's fact, tags, category, source or id. */
function matches(entry, terms) {
  if (!terms.length) return true;
  const haystack = [entry.fact, entry.category, entry.source, entry.sourceDetail, entry.id, ...entry.tags].join(' ').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function Entry({ entry }) {
  return (
    <li className={styles.memoryEntry}>
      <p className={styles.fact}>{entry.fact || <span className="muted">(no text)</span>}</p>
      <div className={styles.entryMeta}>
        {entry.category && <span className="badge badge-plain">{entry.category}</span>}
        {entry.status && entry.status !== 'active' && <span className={`badge ${STATUS_BADGE[entry.status] || 'badge-neutral'}`}>{entry.status}</span>}
        <span title="importance × confidence">{`value ${number(entry.value)}`}</span>
        <span>{`importance ${number(entry.importance)}`}</span>
        <span>{`confidence ${number(entry.confidence)}`}</span>
        {entry.source && <span title={entry.sourceDetail || ''}>{`from ${entry.source}`}</span>}
        {entry.createdAt && <span title={formatDate(entry.createdAt)}>{`learned ${timeAgo(entry.createdAt)}`}</span>}
        {typeof entry.recallCount === 'number' && <span>{`recalled ${entry.recallCount} ${entry.recallCount === 1 ? 'time' : 'times'}`}</span>}
        <code className={styles.entryId}>{entry.id}</code>
      </div>
      {entry.tags.length > 0 && (
        <div className={styles.chips}>
          {entry.tags.map((tag) => <span key={tag} className={styles.chip}>{tag}</span>)}
        </div>
      )}
      {entry.supersededBy && <p className="muted">{`Replaced by ${entry.supersededBy}.`}</p>}
      {entry.supersedes && <p className="muted">{`Replaces ${entry.supersedes}.`}</p>}
      {entry.status === 'retired' && (
        <p className="muted">{`Retired${entry.retiredAt ? ` ${formatDate(entry.retiredAt)}` : ''}${entry.retireReason ? `: ${entry.retireReason}` : '.'}`}</p>
      )}
    </li>
  );
}

export function CoreMemoryPanel() {
  const [status, setStatus] = useState('active');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [order, setOrder] = useState('value');
  const { data, error, loading, refresh } = usePoll(`/api/memory/core?status=${status}`, 0);

  const shown = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = (data?.entries || []).filter((e) => (!category || e.category === category) && matches(e, terms));
    if (order === 'newest') return [...list].sort((a, b) => instant(b.createdAt) - instant(a.createdAt));
    return list;
  }, [data, category, search, order]);

  const total = data?.entries?.length ?? 0;

  return (
    <div className="stack">
      <div className={styles.filters}>
        <input
          className={`input ${styles.search}`}
          type="search"
          placeholder="Search facts, tags, sources"
          aria-label="Search Core Memory"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select className="select" aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value)}>
          {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <select className="select" aria-label="Category" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">Every category</option>
          {(data?.categories || []).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="select" aria-label="Order" value={order} onChange={(event) => setOrder(event.target.value)}>
          <option value="value">Most valuable first</option>
          <option value="newest">Newest first</option>
        </select>
        <button type="button" className="btn btn-sm" onClick={() => refresh()}>Refresh</button>
      </div>
      <AsyncState loading={loading && !data} error={error} empty={Boolean(data) && total === 0} emptyText="No entries with this status.">
        {data && total > 0 && (
          <>
            <p className="muted">
              {shown.length === total ? `${total} ${total === 1 ? 'entry' : 'entries'}` : `${shown.length} of ${total} entries match`}
              {data.limited ? `. Only the first ${data.limit} were read; narrow by status to see the rest.` : ''}
            </p>
            {shown.length > 0 ? (
              <ul className={styles.memoryList}>
                {shown.map((entry) => <Entry key={entry.id} entry={entry} />)}
              </ul>
            ) : (
              <p className="muted">Nothing matches. A filtered view is not an empty memory: clear the search or the category to see every entry.</p>
            )}
          </>
        )}
      </AsyncState>
    </div>
  );
}
