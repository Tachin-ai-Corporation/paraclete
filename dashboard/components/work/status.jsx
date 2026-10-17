// dashboard/components/work/status.jsx: how work reads on the dashboard: the word and badge color for
// each envelope status (or what an archived envelope ended as), each verdict the verifier can give a
// checkpoint, each kind of envelope, who asked, and the plain job of each organ. Shared by the work
// and approvals views, so a status reads the same everywhere.

/** Status, or outcome, to [label, badge tone]. Outcomes come from the server (lib/server/work.mjs). */
export const STATUS = Object.freeze({
  pending: ['Not started', 'neutral'],
  planned: ['Planned', 'neutral'],
  queued: ['Queued', 'neutral'],
  active: ['Running', 'info'],
  waiting: ['Paused', 'warn'],
  awaiting_approval: ['Needs approval', 'warn'],
  needs_input: ['Has a question', 'warn'],
  needs_review: ['Needs a review', 'warn'],
  blocked: ['Blocked', 'warn'],
  complete: ['Done', 'ok'],
  failed: ['Failed', 'danger'],
  rejected: ['Rejected', 'danger'],
  timed_out: ['Timed out', 'danger'],
  cancelled: ['Cancelled', 'neutral'],
  unanswered: ['Expired unanswered', 'neutral'],
  archived: ['Archived', 'neutral'],
});

export function statusLabel(outcome) {
  return (STATUS[outcome] || [outcome || 'Unknown'])[0];
}

export function StatusBadge({ outcome, archived = false }) {
  const [label, tone] = STATUS[outcome] || [outcome || 'Unknown', 'neutral'];
  return (
    <span className={`badge badge-${tone}`} title={archived ? 'Archived after it ended' : undefined}>
      {label}
    </span>
  );
}

/** The verifier's verdict on a checkpoint: [label, badge tone, what it means]. */
export const VERDICT = Object.freeze({
  met: ['Met', 'ok', 'The verifier judged the milestone met.'],
  met_with_caveat: ['Met, with a caveat', 'warn', 'The milestone was met; the verifier noted something you should know.'],
  not_met: ['Not met', 'danger', 'The verifier judged the milestone not met.'],
  inconclusive: ['Could not be judged', 'warn', 'The verifier could not see enough evidence to judge it. The work was not judged wrong.'],
  not_judged: ['Not judged', 'danger', 'A task failed, so the milestone never reached the verifier.'],
  skipped: ['Skipped', 'neutral', 'No tasks were left to run, so there was nothing new to judge.'],
  pending: ['Not judged yet', 'neutral', 'The verifier judges the milestone once its tasks have run.'],
  none: ['No verdict', 'neutral', 'It ended before it was judged.'],
});

export function VerdictBadge({ verdict }) {
  const [label, tone, meaning] = VERDICT[verdict] || VERDICT.none;
  return <span className={`badge badge-${tone}`} title={meaning}>{label}</span>;
}

export const TYPE_LABEL = Object.freeze({ R: 'Request', M: 'Mission', C: 'Checkpoint', T: 'Task' });

/** Each organ's plain job, for a reader who does not know the brain's vocabulary. */
export const ORGANS = Object.freeze({
  motor: ['Motor', 'carries out tasks with tools'],
  'temporal-research': ['Research', 'looks things up in outside sources'],
  'temporal-memory': ['Memory', "reads and keeps the agent's memory"],
  cerebellum: ['Cerebellum', 'verifies each checkpoint'],
  cortex: ['Cortex', 'decides the next step'],
  prefrontal: ['Prefrontal', 'plans the checkpoints'],
  brain: ['Brain', 'the service that runs missions'],
  scheduler: ['Scheduler', 'fires scheduled work'],
});

export function OrganName({ organ }) {
  if (!organ) return null;
  const [name, job] = ORGANS[organ] || [organ, ''];
  return <span title={job ? `${name}: ${job}` : undefined}>{name}</span>;
}

/** Who asked, in words: a person, a schedule, or nobody recorded. */
export function requesterText(requestedBy) {
  if (!requestedBy) return 'Not recorded';
  if (requestedBy.kind === 'schedule') return `Scheduled: ${requestedBy.name}`;
  return requestedBy.name ? `${requestedBy.name} (${requestedBy.id})` : requestedBy.id;
}

/** "45s", "12m", "2h 5m" between two times; '' when either is missing. */
export function duration(start, end) {
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}
