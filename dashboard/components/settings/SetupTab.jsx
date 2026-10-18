'use client';
// dashboard/components/settings/SetupTab.jsx: Settings, Setup. A checklist of what this instance needs,
// each item with its state and what to do about it (setup-checklist.js). It gathers the agent's install
// record (GET /api/agent), the VM's own report (the `status` command), the server's counts (GET
// /api/setup) and the agent's address (GET /api/me, passed in). The Drive item also holds Test Drive
// (the `drive_check` command, run only when an admin asks: it writes a small file to the output folder)
// and the output folder setting (DriveCard.jsx); its state follows the check's result. Every user sees
// it; the advice names the admin when only an admin can act.
import { usePoll } from '@/lib/client/use-poll.js';
import { useCommand } from '@/lib/client/use-command.js';
import { DriveCard } from './DriveCard.jsx';
import { setupChecklist, STATES } from './setup-checklist.js';
import styles from './Settings.module.css';

export function SetupTab({ me }) {
  const isAdmin = me.user.role === 'admin';
  const { data: agent, error: agentError } = usePoll('/api/agent', 30_000);
  const { data: setup, error: setupError } = usePoll('/api/setup', 0);
  const status = useCommand('status', { auto: true });
  const driveCheck = useCommand('drive_check');
  const { items, required } = setupChecklist({
    agent,
    status: status.result,
    statusError: status.result ? null : status.error,
    setup,
    agentAccount: me.dashboard?.agentAccount,
    drive: { result: driveCheck.result, error: driveCheck.result ? null : driveCheck.error, running: driveCheck.running },
    isAdmin,
  });

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>Setup</h2>
          <p className={styles.summary}>
            {required.done === required.total
              ? 'Everything this instance needs is in place.'
              : `${required.done} of ${required.total} required steps are done.`}
          </p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => status.run()} disabled={status.running}>
          {status.running ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {agentError && <p className="error-text">The agent's install record could not be read: {agentError.message}</p>}
      {setupError && <p className="error-text">{setupError.message}</p>}
      <ul className={`card ${styles.checklist}`}>
        {items.map((item) => {
          const state = STATES[item.state];
          return (
            <li key={item.key} className={styles.checkItem}>
              <div>
                <span className={`badge ${state.badge}`}>{state.label}</span>
              </div>
              <div>
                <h3>{item.title}</h3>
                {item.detail && <p>{item.detail}</p>}
                {item.action && <p className={styles.checkAction}>{item.action}</p>}
                {item.key === 'drive' && <DriveCard address={item.address} isAdmin={isAdmin} check={driveCheck} />}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
