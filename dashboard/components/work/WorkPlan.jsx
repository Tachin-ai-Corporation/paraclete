'use client';
// dashboard/components/work/WorkPlan.jsx: a mission's plan as the dashboard shows it. One card per
// checkpoint, in order: what it must achieve, the verifier's verdict on it (with its caveats or its
// reasons), and its tasks, each with the organ that ran it and its output folded. A checkpoint tried
// more than once shows its latest attempt, with the earlier ones folded below; one not started yet
// shows the tasks it is planned to run. Also the task list used on a checkpoint's own page.
import Link from 'next/link';
import { formatDate } from '@/lib/client/format.js';
import { TurnOutput } from './ExpandableText.jsx';
import { OrganName, StatusBadge, VERDICT, VerdictBadge, duration } from './status.jsx';
import styles from './WorkPlan.module.css';

/** The verifier's verdict, its meaning, and what it said. */
export function VerdictCard({ verdict }) {
  if (!verdict) return null;
  const meaning = (VERDICT[verdict.verdict] || VERDICT.none)[2];
  const tone = (VERDICT[verdict.verdict] || VERDICT.none)[1];
  return (
    <div className={`${styles.verdict} ${styles[`tone_${tone}`] || ''}`}>
      <div className={styles.verdictHead}>
        <VerdictBadge verdict={verdict.verdict} />
        <span className="muted">{meaning}</span>
      </div>
      {verdict.caveats?.length > 0 && (
        <ul className={styles.caveats}>
          {verdict.caveats.map((caveat, i) => <li key={i}>{caveat}</li>)}
        </ul>
      )}
      {verdict.summary && !verdict.caveats?.length && <p className={styles.verdictText}>{verdict.summary}</p>}
    </div>
  );
}

/** One task: a folded row that opens to its instruction, output and error. */
export function TaskRow({ task }) {
  const took = duration(task.started_at, task.completed_at);
  return (
    <details className={styles.task} open={task.outcome === 'failed' || undefined}>
      <summary className={styles.taskHead}>
        <span className={styles.taskNum}>{task.step ? `Task ${task.step}` : 'Task'}</span>
        <span className={styles.organ}><OrganName organ={task.organ} /></span>
        <span className={styles.taskTitle}>{task.title}</span>
        <span className={styles.taskMeta}>
          {took && <span className="muted">{took}</span>}
          <StatusBadge outcome={task.outcome} archived={task.archived} />
        </span>
      </summary>
      <div className={styles.taskBody}>
        {task.instruction && task.instruction !== task.title && <p className={styles.instruction}>{task.instruction}</p>}
        {task.output ? <TurnOutput value={task.output} fullHref={`/work/${task.id}`} /> : <p className="muted">No output yet.</p>}
        {task.error && task.outcome !== 'complete' && task.error !== task.output?.text && <p className="error-text">{task.error}</p>}
        <div className={styles.taskFoot}>
          <span className="muted">{formatDate(task.started_at || task.created_at)}</span>
          <Link href={`/work/${task.id}`}>Open task</Link>
        </div>
      </div>
    </details>
  );
}

function Attempt({ attempt }) {
  return (
    <div className="stack">
      <VerdictCard verdict={attempt.verdict} />
      {attempt.tasks.length > 0
        ? <div className={styles.tasks}>{attempt.tasks.map((task) => <TaskRow key={task.id} task={task} />)}</div>
        : attempt.outcome === 'awaiting_approval' && <p className="muted">Paused at its approval gate; the tasks after it run once it is approved.</p>}
    </div>
  );
}

function CheckpointCard({ entry }) {
  const attempts = entry.attempts;
  const latest = attempts[attempts.length - 1] || null;
  const earlier = attempts.slice(0, -1).reverse();
  const outcome = latest ? latest.outcome : entry.spine_status === 'complete' ? 'complete' : 'pending';
  return (
    <section className={`card ${styles.checkpoint}`}>
      <header className={styles.cpHead}>
        <div className={styles.cpTitle}>
          <span className={styles.cpNum}>Checkpoint {entry.n}{entry.total ? ` of ${entry.total}` : ''}</span>
          <h3>{entry.outcome || latest?.title || `Checkpoint ${entry.n}`}</h3>
        </div>
        <div className="row">
          {attempts.length > 1 && <span className="muted">attempt {attempts.length}</span>}
          <StatusBadge outcome={outcome} archived={latest?.archived} />
          {latest && <Link href={`/work/${latest.id}`} className={styles.open}>Open</Link>}
        </div>
      </header>
      {entry.accept_criteria && (
        <p className={styles.criteria}><span className={styles.criteriaLabel}>Done when</span> {entry.accept_criteria}</p>
      )}
      {latest ? (
        <Attempt attempt={latest} />
      ) : (
        <div>
          <p className="muted">Not started.</p>
          {entry.planned_tasks.length > 0 && (
            <ol className={styles.planned}>
              {entry.planned_tasks.map((task, i) => (
                <li key={i}>
                  {task.gate ? <span className="badge badge-warn badge-plain">Approval gate</span> : <OrganName organ={task.organ} />}{' '}
                  <span className="muted">{task.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {earlier.map((attempt, i) => (
        <details key={attempt.id} className={styles.earlier}>
          <summary>
            Earlier attempt {attempts.length - 1 - i}: <VerdictBadge verdict={attempt.verdict.verdict} />
          </summary>
          <Attempt attempt={attempt} />
        </details>
      ))}
    </section>
  );
}

/** The plan of a mission: `plan` from GET /api/work/:id. */
export function WorkPlan({ plan }) {
  if (!plan || plan.length === 0) return <p className="muted">This mission has no checkpoint plan: it was answered without one, or it has not been planned yet.</p>;
  return <div className="stack">{plan.map((entry) => <CheckpointCard key={entry.n} entry={entry} />)}</div>;
}

/** A checkpoint's tasks, on the checkpoint's own page. */
export function TaskList({ tasks }) {
  if (!tasks || tasks.length === 0) return <p className="muted">No tasks have run yet.</p>;
  return <div className={styles.tasks}>{tasks.map((task) => <TaskRow key={task.id} task={task} />)}</div>;
}
