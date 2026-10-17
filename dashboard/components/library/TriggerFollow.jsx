'use client';
// dashboard/components/library/TriggerFollow.jsx: follows one "run now" until the brain has handled
// it. The run_responsibility command only queues a trigger (responsibility_triggers/{trigger_id});
// the brain's scheduler claims it within a few seconds and records whether it fired the
// responsibility, skipped it (one already running, say) or failed. Read through
// GET /api/library/triggers/:id.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api.js';

const POLL_MS = 2000;
const GIVE_UP_MS = 120_000;

export function TriggerFollow({ triggerId }) {
  const [trigger, setTrigger] = useState(null);
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    let alive = true;
    const deadline = Date.now() + GIVE_UP_MS;
    (async () => {
      while (alive) {
        try {
          const current = await api(`/api/library/triggers/${encodeURIComponent(triggerId)}`);
          if (!alive) return;
          setTrigger(current);
          if (current.finished) return;
        } catch (err) {
          if (alive) setProblem(err.message);
          return;
        }
        if (Date.now() > deadline) {
          if (alive) setProblem('The brain has not picked it up yet. It may be busy with another mission, or stopped.');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    })();
    return () => {
      alive = false;
    };
  }, [triggerId]);

  if (problem) return <span className="error-text">{problem}</span>;
  if (!trigger || trigger.status === 'pending') return <span className="muted">Waiting for the brain to pick it up…</span>;
  if (trigger.status === 'firing') return <span className="muted">The brain is starting it…</span>;
  if (trigger.status === 'fired') {
    return (
      <span>
        <span className="badge badge-ok">started</span> Its mission is on the <Link href="/work">Work</Link> page.
      </span>
    );
  }
  if (trigger.status === 'skipped') return <span><span className="badge badge-warn">skipped</span> {trigger.detail || ''}</span>;
  return <span><span className="badge badge-danger">not started</span> {trigger.detail || ''}</span>;
}
