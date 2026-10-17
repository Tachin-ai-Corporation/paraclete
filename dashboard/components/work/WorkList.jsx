'use client';
// dashboard/components/work/WorkList.jsx: the agent's missions, newest first (/work). Views by what
// the work is doing or ended as: everything, running, waiting (on a person or a timer), done, and
// failed or stopped, with counts for the open ones. Each row says who asked, when, and, for work that
// waits, what it waits for. Quick chat replies are missions too, hidden unless asked for. Reads
// GET /api/work and pages back with "Show older".
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api.js';
import { usePoll } from '@/lib/client/use-poll.js';
import { formatDate, timeAgo } from '@/lib/client/format.js';
import { AsyncState } from '@/components/ui/AsyncState.jsx';
import { Tabs, useHashTab } from '@/components/ui/Tabs.jsx';
import { StatusBadge, requesterText } from './status.jsx';
import styles from './WorkList.module.css';

const VIEWS = ['all', 'active', 'waiting', 'done', 'failed'];
const OPEN_VIEWS = new Set(['all', 'active', 'waiting']);

const EMPTY = {
  all: 'No missions yet. Ask the agent for something in chat and it shows up here.',
  active: 'Nothing is running right now.',
  waiting: 'Nothing is waiting on anyone.',
  done: 'No finished missions yet.',
  failed: 'Nothing has failed or been stopped.',
};

function tabLabel(view, counts) {
  const n = counts?.[view];
  const base = { all: 'All', active: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed or stopped' }[view];
  return n ? `${base} (${n})` : base;
}

/** One line of the agent's Markdown as plain text: emphasis and code marks dropped. */
const plainLine = (text) => String(text || '').replace(/\*\*|`/g, '').replace(/^#+\s*/, '');

function MissionRow({ mission }) {
  const waitText = mission.view === 'waiting'
    ? plainLine(mission.waiting_for) || (mission.wait_resume_at ? `Resumes ${formatDate(mission.wait_resume_at)}` : '')
    : '';
  const ended = mission.completed_at || (mission.view === 'done' || mission.view === 'failed' ? mission.updated_at : null);
  return (
    <tr>
      <td className={styles.titleCell}>
        <Link href={`/work/${mission.id}`} className={styles.title}>{mission.title}</Link>
        {waitText && <div className={styles.wait}>{waitText}</div>}
        {!waitText && mission.view === 'failed' && mission.error && <div className={styles.error}>{mission.error}</div>}
        {mission.needs_review && <div className={styles.wait}>A verification could not judge it; worth a look.</div>}
      </td>
      <td><StatusBadge outcome={mission.outcome} archived={mission.archived} /></td>
      <td className={styles.who}>{mission.requested_by ? requesterText(mission.requested_by) : <span className="muted">Not recorded</span>}</td>
      <td className={styles.when} title={formatDate(mission.created_at)}>{timeAgo(mission.created_at)}</td>
      <td className={styles.when} title={formatDate(ended)}>{ended ? timeAgo(ended) : ''}</td>
    </tr>
  );
}

export function WorkList() {
  const [view, setView] = useHashTab(VIEWS, 'all');
  const [replies, setReplies] = useState(false);
  const path = `/api/work?view=${view}${replies ? '&replies=1' : ''}`;
  const { data, error, loading } = usePoll(path, OPEN_VIEWS.has(view) ? 10_000 : 30_000);

  // Older pages, fetched on request and kept while the first page refreshes.
  const [older, setOlder] = useState({ path, missions: [], next: undefined });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(null);
  useEffect(() => {
    setOlder({ path, missions: [], next: undefined });
    setOlderError(null);
  }, [path]);

  const pages = older.path === path ? older : { missions: [], next: undefined };
  const seen = new Set();
  const missions = [...(data?.missions || []), ...pages.missions].filter((m) => !seen.has(m.id) && seen.add(m.id));
  const next = pages.next === undefined ? data?.next : pages.next;

  async function showOlder() {
    if (!next) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await api(`${path}&before=${encodeURIComponent(next)}`);
      setOlder((current) => (current.path === path
        ? { path, missions: [...current.missions, ...page.missions], next: page.next }
        : current));
    } catch (err) {
      setOlderError(err.message);
    } finally {
      setLoadingOlder(false);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Work</h1>
          <p>What the agent has been asked to do, and how it went.</p>
        </div>
        <label className={styles.toggle}>
          <input type="checkbox" checked={replies} onChange={(e) => setReplies(e.target.checked)} />
          Show quick chat replies
        </label>
      </div>
      <Tabs tabs={VIEWS.map((key) => ({ key, label: tabLabel(key, data?.counts) }))} active={view} onSelect={setView} />
      {view !== 'waiting' && data?.counts?.waiting > 0 && (
        <p className={styles.banner}>
          {data.counts.waiting === 1 ? '1 mission is' : `${data.counts.waiting} missions are`} waiting.{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setView('waiting')}>See what they wait for</button>
        </p>
      )}
      <AsyncState loading={loading && !data} error={error} empty={Boolean(data) && missions.length === 0} emptyText={EMPTY[view]}>
        {missions.length > 0 && (
          <div className={styles.tableWrap}>
            <table className="table">
              <thead>
                <tr>
                  <th>Mission</th>
                  <th>Status</th>
                  <th>For</th>
                  <th>Asked</th>
                  <th>Ended</th>
                </tr>
              </thead>
              <tbody>
                {missions.map((mission) => <MissionRow key={mission.id} mission={mission} />)}
              </tbody>
            </table>
          </div>
        )}
        {next && (
          <div className={styles.more}>
            <button type="button" className="btn btn-sm" disabled={loadingOlder} onClick={showOlder}>
              {loadingOlder ? 'Loading…' : 'Show older'}
            </button>
            {olderError && <span className="error-text">{olderError}</span>}
          </div>
        )}
      </AsyncState>
    </div>
  );
}
