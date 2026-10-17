'use client';
// dashboard/components/agent/EffortPanel.jsx: the effort setting. Each level scales every organ's
// sampling temperature; it never changes which checks run or what the verifier demands. Admins choose
// a level (PATCH /api/settings/effort); members see it. Beside the stored level, it shows the level
// the brain reported in its last heartbeat (the `status` command), since the brain reads the setting
// again only about once a minute.

import { useState } from 'react';
import { api } from '@/lib/client/api.js';
import { usePoll } from '@/lib/client/use-poll.js';
import { timeAgo } from '@/lib/client/format.js';
import { AsyncState } from '@/components/ui/AsyncState.jsx';
import styles from './Agent.module.css';

const HINTS = {
  low: 'Steady and conservative: the most repeatable plans and answers.',
  medium: 'The default balance: every organ samples at its own temperature.',
  high: 'More exploratory: wider plans and more varied approaches.',
  max: 'The widest exploration, for open-ended problems.',
};

function BrainRunning({ status, stored }) {
  if (status.running && !status.result) return <p className="muted">Checking the level the brain runs at…</p>;
  const heartbeat = status.result?.services?.brain?.heartbeat;
  if (!heartbeat?.effort) return null;
  const pending = heartbeat.effort !== stored;
  return (
    <p className="muted">
      The brain reported running at <strong>{heartbeat.effort}</strong>
      {heartbeat.beat_at ? ` ${timeAgo(heartbeat.beat_at)}` : ''}
      {heartbeat.stale ? '; its heartbeat is stale, so the brain may be stopped' : ''}
      {pending && !heartbeat.stale ? '; it moves to the new level within about a minute' : ''}.
    </p>
  );
}

export function EffortPanel({ isAdmin, status }) {
  const { data, error, loading, refresh } = usePoll('/api/settings/effort', 0);
  const [saving, setSaving] = useState(null);
  const [saveError, setSaveError] = useState(null);

  async function choose(level) {
    if (!isAdmin || saving || level === data?.effort) return;
    setSaving(level);
    setSaveError(null);
    try {
      await api('/api/settings/effort', { method: 'PATCH', body: { effort: level } });
      await refresh();
      status.run();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="card">
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Effort</h2>
        <span className="muted">How widely the organs explore. It scales each organ’s sampling temperature and never changes which checks run.</span>
      </div>
      <AsyncState loading={loading && !data} error={error}>
        {data && (
          <>
            <div className={styles.segmented} role="radiogroup" aria-label="Effort">
              {data.levels.map((level) => (
                <button
                  key={level.id}
                  type="button"
                  role="radio"
                  aria-checked={level.id === data.effort}
                  className={styles.segment}
                  disabled={!isAdmin || Boolean(saving)}
                  onClick={() => choose(level.id)}
                >
                  <span>{saving === level.id ? 'Saving…' : level.id}</span>
                  <span className={styles.segmentScale}>{`× ${level.scale}`}</span>
                </button>
              ))}
            </div>
            <p className={styles.hint}>{HINTS[data.effort] || ''}</p>
            {data.unknown && (
              <p className="error-text">
                {`The stored value '${data.stored}' is not a level, so the brain runs at ${data.effort}. Choose a level to replace it.`}
              </p>
            )}
            {saveError && <p className="error-text">{saveError}</p>}
            <p className="muted">
              {data.updated_by
                ? `Set by ${data.updated_by} ${timeAgo(data.updated_at)}.`
                : `Never changed: ${data.default} is the default.`}
              {' '}A change reaches the brain within about a minute, without a restart.
              {!isAdmin && ' Only a dashboard admin can change it.'}
            </p>
            <BrainRunning status={status} stored={data.effort} />
          </>
        )}
      </AsyncState>
    </section>
  );
}
