'use client';
// dashboard/components/work/WorkDetail.jsx: one piece of work on its own page (/work/:id): a mission,
// or one of its checkpoints or tasks. At the top, what it is waiting for, if anything: an approval
// (decided right here), a question or a blocker (answered in chat, which is how the agent takes
// answers), or a timer. Then the request and its result, the plan with the verifier's verdict on
// each checkpoint, the messages the agent sent, its approval gates, its step history, and the facts
// and internals. Reads GET /api/work/:id, every few seconds while the work is open and once a minute
// after it ended.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePoll } from '@/lib/client/use-poll.js';
import { formatDate, timeAgo } from '@/lib/client/format.js';
import { AsyncState } from '@/components/ui/AsyncState.jsx';
import { Markdown } from '@/components/ui/Markdown.jsx';
import { ApprovalCard, Decision } from '@/components/approvals/ApprovalCard.jsx';
import { ExpandableText, TurnOutput } from './ExpandableText.jsx';
import { TaskList, VerdictCard, WorkPlan } from './WorkPlan.jsx';
import { WorkHistory } from './WorkHistory.jsx';
import { WorkFacts, WorkInternals } from './WorkInternals.jsx';
import { OrganName, StatusBadge, TYPE_LABEL, requesterText } from './status.jsx';
import styles from './WorkDetail.module.css';

const OPEN_POLL_MS = 5_000;
const SETTLED_POLL_MS = 60_000;

/** The chat is where the agent takes answers: the brain matches a reply to the mission that asked. */
function AnswerInChat({ action }) {
  return (
    <div className={styles.answer}>
      <Link href="/" className="btn btn-primary btn-sm">{action}</Link>
      <span className="muted">
        The agent takes answers in chat: reply in your conversation with it, and it matches your answer
        to this work.
      </span>
    </div>
  );
}

function Waiting({ waiting, onDecided }) {
  if (!waiting) return null;
  if (waiting.kind === 'approval') {
    const approval = waiting.approval;
    return (
      <section className={styles.waiting}>
        <h2>Waiting for an approval</h2>
        {!approval ? (
          <p className="muted">
            It is paused at an approval gate. Decide it on its mission&apos;s page or under <Link href="/approvals">Approvals</Link>.
          </p>
        ) : approval.status === 'pending' ? (
          <ApprovalCard approval={approval} onDecided={onDecided} showMission={false} />
        ) : (
          <Decision approval={approval} />
        )}
      </section>
    );
  }
  if (waiting.kind === 'question') {
    return (
      <section className={styles.waiting}>
        <h2>The agent has a question</h2>
        <ExpandableText value={waiting.text} markdown collapsedChars={2000} />
        <p className="muted">Asked {timeAgo(waiting.since)}.</p>
        <AnswerInChat action="Answer in chat" />
      </section>
    );
  }
  if (waiting.kind === 'blocked') {
    return (
      <section className={styles.waiting}>
        <h2>Blocked{waiting.blocker_type ? ` (${waiting.blocker_type})` : ''}</h2>
        <ExpandableText value={waiting.text} markdown collapsedChars={2000} />
        <p className="muted">Since {formatDate(waiting.since)}.</p>
        <AnswerInChat action="Reply in chat" />
      </section>
    );
  }
  if (waiting.kind === 'timer') {
    return (
      <section className={styles.waiting}>
        <h2>Paused</h2>
        <p>
          {waiting.until
            ? <>It resumes on its own at <strong>{formatDate(waiting.until)}</strong>.</>
            : 'It is paused with no time set to resume; the agent cancels such a pause after a while.'}
        </p>
        {waiting.then && <p className="muted">Then: {waiting.then}</p>}
      </section>
    );
  }
  if (waiting.kind === 'review') {
    return (
      <section className={styles.waiting}>
        <h2>Needs a person to review it</h2>
        <ExpandableText value={waiting.text} markdown />
        <AnswerInChat action="Reply in chat" />
      </section>
    );
  }
  return null;
}

/** Statuses whose output is the question or blocker the waiting panel already shows. */
const OUTPUT_IS_THE_ASK = new Set(['needs_input', 'blocked']);

function Result({ envelope }) {
  // A checkpoint's output only counts its tasks; its verdict says how it went.
  if (envelope.type === 'C') return null;
  const isMission = envelope.type === 'M' || envelope.type === 'R';
  const output = OUTPUT_IS_THE_ASK.has(envelope.status) ? null : envelope.output;
  const error = envelope.error && envelope.outcome !== 'complete' && envelope.error !== output?.text ? envelope.error : null;
  if (!output && !error && !envelope.needs_review) return null;
  return (
    <section className={`card ${styles.section}`}>
      <h2>{isMission ? 'Result' : 'Output'}</h2>
      {envelope.needs_review && (
        <p className={styles.note}>
          A verification could not judge this, so a person should look at it{envelope.review_reason ? `: ${envelope.review_reason}` : '.'}
        </p>
      )}
      {output && (isMission
        ? <ExpandableText value={output} markdown collapsedChars={4000} />
        : <TurnOutput value={output} />)}
      {error && (
        <div>
          <h3 className={styles.subhead}>Why it did not finish</h3>
          <p className="error-text">{error}</p>
        </div>
      )}
    </section>
  );
}

function Messages({ messages }) {
  if (!messages || messages.length === 0) return null;
  return (
    <section className={styles.block}>
      <h2>Messages it sent</h2>
      <div className="stack">
        {messages.map((message) => (
          <div key={message.id} className={`card ${styles.message}`}>
            <div className={styles.messageHead}>
              <span className={styles.messageKind}>{message.title}</span>
              <span className="muted" title={formatDate(message.created_at)}>
                {timeAgo(message.created_at)}
                {message.delivery_status === 'delivered' ? ' · delivered' : message.delivery_status === 'pending' ? ' · being sent' : message.delivery_status === 'failed' ? ' · could not be sent' : ''}
              </span>
            </div>
            <ExpandableText value={message.text} markdown collapsedChars={600} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Approvals({ approvals, waitingId }) {
  const shown = (approvals || []).filter((a) => a.id !== waitingId || a.status !== 'pending');
  if (shown.length === 0) return null;
  return (
    <section className={styles.block}>
      <h2>Approvals</h2>
      <div className="stack">
        {shown.map((approval) => (
          <div key={approval.id} className={`card ${styles.message}`}>
            <div className={styles.messageHead}>
              <span className={styles.messageKind}>{approval.title || 'Approval gate'}</span>
              <span className="muted">asked {timeAgo(approval.requested_at)}</span>
            </div>
            {approval.status === 'pending'
              ? <p className="muted">Not decided{approval.stale_reason ? `, and no longer needed: ${approval.stale_reason}` : ''}.</p>
              : <Decision approval={approval} />}
          </div>
        ))}
      </div>
    </section>
  );
}

function Children({ envelope, items }) {
  if (envelope.type === 'C') {
    return (
      <section className={styles.block}>
        <h2>Tasks</h2>
        <TaskList tasks={items} />
      </section>
    );
  }
  if (!items || items.length === 0) return null;
  return (
    <section className={styles.block}>
      <h2>{envelope.type === 'R' ? 'Missions' : 'Part of this'}</h2>
      <table className="table">
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td><Link href={`/work/${item.id}`}>{item.title}</Link></td>
              <td><StatusBadge outcome={item.outcome} archived={item.archived} /></td>
              <td className="muted">{formatDate(item.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Header({ envelope, parent }) {
  const kind = TYPE_LABEL[envelope.type] || 'Work';
  const where = envelope.type === 'C' && envelope.checkpoint
    ? ` ${envelope.checkpoint}${envelope.checkpoint_total ? ` of ${envelope.checkpoint_total}` : ''}`
    : envelope.type === 'T' && envelope.step ? ` ${envelope.step}` : '';
  return (
    <>
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link href="/work">Work</Link>
        {parent && (
          <>
            <span aria-hidden="true">/</span>
            <Link href={`/work/${parent.id}`}>{parent.title}</Link>
          </>
        )}
      </nav>
      <header className={styles.header}>
        <div className={styles.headText}>
          <div className={styles.kicker}>
            {kind}{where}
            {envelope.organ && <> · <OrganName organ={envelope.organ} /></>}
          </div>
          <h1>{envelope.title}</h1>
          <div className={styles.meta}>
            {envelope.type === 'M' && envelope.requested_by && <span>For {requesterText(envelope.requested_by)}</span>}
            <span title={formatDate(envelope.created_at)}>Created {timeAgo(envelope.created_at)}</span>
            {envelope.completed_at && <span title={formatDate(envelope.completed_at)}>Ended {timeAgo(envelope.completed_at)}</span>}
            {!envelope.completed_at && envelope.updated_at && <span title={formatDate(envelope.updated_at)}>Last change {timeAgo(envelope.updated_at)}</span>}
          </div>
        </div>
        <StatusBadge outcome={envelope.outcome} archived={envelope.archived} />
      </header>
    </>
  );
}

/** @param {{id: string}} props  the envelope id from the URL */
export function WorkDetail({ id }) {
  const [settled, setSettled] = useState(false);
  const { data, error, loading, refresh } = usePoll(`/api/work/${encodeURIComponent(id)}`, settled ? SETTLED_POLL_MS : OPEN_POLL_MS);
  // Changing the poll interval starts the poll over; keep showing the last answer meanwhile.
  const [last, setLast] = useState(null);
  useEffect(() => {
    if (!data) return;
    setLast(data);
    setSettled(Boolean(data.envelope?.settled));
  }, [data]);
  const view = data || last;

  if (!view) {
    return (
      <div className="page">
        <nav className={styles.crumbs}><Link href="/work">Work</Link></nav>
        <AsyncState loading={loading} error={error} />
      </div>
    );
  }

  const { envelope, parent } = view;
  const request = envelope.request || envelope.instruction;
  return (
    <div className="page">
      <Header envelope={envelope} parent={parent} />
      {error && <p className="error-text">Could not refresh: {error.message}</p>}
      <div className={styles.body}>
        <Waiting waiting={view.waiting} onDecided={refresh} />

        <section className={`card ${styles.section}`}>
          <h2>{envelope.type === 'M' ? 'What was asked' : 'Instruction'}</h2>
          {request ? <Markdown className={styles.request}>{request}</Markdown> : <p className="muted">Not recorded.</p>}
          {envelope.accept_criteria && (
            <p className={styles.criteria}><span className={styles.criteriaLabel}>Done when</span> {envelope.accept_criteria}</p>
          )}
          {envelope.milestone_caveats.length > 0 && (
            <div>
              <h3 className={styles.subhead}>Caveats from verification</h3>
              <ul className={styles.caveats}>{envelope.milestone_caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </div>
          )}
        </section>

        {view.verdict && (
          <section className={styles.block}>
            <h2>Verdict</h2>
            <VerdictCard verdict={view.verdict} />
          </section>
        )}

        <Result envelope={envelope} />

        {view.plan && (
          <section className={styles.block}>
            <h2>Plan</h2>
            <WorkPlan plan={view.plan} />
          </section>
        )}

        <Children envelope={envelope} items={view.children} />
        <Messages messages={view.messages} />
        <Approvals approvals={view.approvals} waitingId={view.waiting?.approval_id} />

        <section className={styles.block}>
          <h2>History</h2>
          <WorkHistory entries={view.history} truncated={view.history_truncated} />
        </section>

        <section className={`card ${styles.section}`}>
          <h2>Details</h2>
          <WorkFacts envelope={envelope} />
          <WorkInternals internals={envelope.internals} />
        </section>
      </div>
    </div>
  );
}
