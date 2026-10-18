'use client';
// dashboard/components/settings/workspace/WorkspaceTab.jsx: Settings, Workspace, shown only on a role
// whose role.json sets `workspace`. The agent acts as a Google user of the organization through
// domain-wide delegation, which Google lets only an admin grant, by hand, in the Admin console. For
// an admin this tab walks through it in five steps, each with its state:
//   1. create the agent's user (a link to the Admin console's Users page, a suggested address), then
//      enter its address;
//   2. grant domain-wide delegation: the signer's client ID and the scope list, each with a copy
//      button, and a link to the Admin console's page for them (GET /api/workspace/setup);
//   3. set up Google Chat: the project's Chat app record, which Google requires even of a user's
//      token (a link to the Cloud console page; agent/auth/workspace-scopes.mjs chatAppPage), and a
//      first direct message to the agent, before which Chat lists no conversations for a new user;
//   4. Test: the workspace_check command, which runs on the VM as the agent and reports each API with
//      the one thing to change when it failed;
//   5. Save: the set_workspace_account command, once a test of that address passed (or, after a
//      warning, when only APIs other than Drive failed: workspace-wizard.js saveDecision).
// Once an account is recorded it shows that account, its last test, and Test again, Change and Remove.
// Members see the state only. SettingsView.jsx reads GET /api/workspace and passes it in.

import { useState } from 'react';
import { usePoll } from '@/lib/client/use-poll.js';
import { useCommand } from '@/lib/client/use-command.js';
import { timeAgo } from '@/lib/client/format.js';
import { CopyButton } from '../CopyButton.jsx';
import { ConfirmButton } from '../ConfirmButton.jsx';
import { Notice } from '../Notice.jsx';
import { accountSummary, checkAddress, saveDecision, stepStates } from './workspace-wizard.js';
import settingsStyles from '../Settings.module.css';
import styles from './WorkspaceTab.module.css';

const STEP_BADGES = {
  done: { badge: 'badge-ok', label: 'Done' },
  problem: { badge: 'badge-danger', label: 'Needs attention' },
  todo: { badge: 'badge-neutral', label: 'To do' },
};
const SUMMARY_BADGES = {
  done: { badge: 'badge-ok', label: 'Set up' },
  problem: { badge: 'badge-danger', label: 'Needs attention' },
  todo: { badge: 'badge-warn', label: 'Not yet' },
};

function External({ href, children }) {
  return <a className="btn btn-sm" href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

/** An API's outcome: it works, it waits on a first message (Chat), or it failed. */
function ApiBadge({ entry }) {
  if (entry.ok && entry.pending) return <span className="badge badge-warn">Waiting for a first message</span>;
  return <span className={`badge ${entry.ok ? 'badge-ok' : 'badge-danger'}`}>{entry.ok ? 'Works' : 'Failed'}</span>;
}

/**
 * What one check found, API by API. Admins see Google's error and the fix; members the outcome, and
 * the note of an API that waits on a first message, which anyone can act on.
 */
function CheckResults({ check, isAdmin }) {
  if (!check) return null;
  return (
    <div className={styles.results}>
      <p className="muted">
        {check.ready ? 'Every API answered' : 'Not every API answered'} for <strong>{check.account}</strong>
        {check.checked_at && `, tested ${timeAgo(check.checked_at)}`}
        {check.checked_by && ` by ${check.checked_by}`}.
      </p>
      <div className={settingsStyles.tableWrap}>
        <table className={`table ${styles.apiTable}`}>
          <tbody>
            {check.apis.map((entry) => (
              <tr key={entry.api}>
                <td className={settingsStyles.nowrap}>{entry.name}</td>
                <td className={settingsStyles.nowrap}>
                  <ApiBadge entry={entry} />
                </td>
                {(isAdmin || entry.note) && (
                  <td>
                    {entry.note && <p>{entry.note}</p>}
                    {isAdmin && entry.fix && <p>{entry.fix}</p>}
                    {isAdmin && entry.error && <p className={`muted ${settingsStyles.small}`}>Google said: {entry.error}</p>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Step({ number, title, state, children }) {
  const badge = state ? STEP_BADGES[state] : null;
  return (
    <li className={`card ${styles.step}`}>
      <div className={styles.stepHead}>
        <span className={styles.stepNumber}>{number}</span>
        <h3>{title}</h3>
        {badge && <span className={`badge ${badge.badge}`}>{badge.label}</span>}
      </div>
      <div className={styles.stepBody}>{children}</div>
    </li>
  );
}

function Summary({ workspace }) {
  const summary = accountSummary(workspace);
  const badge = SUMMARY_BADGES[summary.state];
  return (
    <p className={styles.summary}>
      {badge && <span className={`badge ${badge.badge}`}>{badge.label}</span>}
      <span>{summary.detail}</span>
    </p>
  );
}

function MemberView({ workspace }) {
  const account = workspace.account;
  const check = workspace.last_check?.account === account?.account ? workspace.last_check : null;
  return (
    <div className="stack">
      <Summary workspace={workspace} />
      {account && (
        <dl className={`card ${settingsStyles.facts}`}>
          <dt>Account</dt><dd>{account.account}</dd>
          <dt>Recorded</dt><dd>{[account.recorded_by, timeAgo(account.recorded_at)].filter(Boolean).join(', ') || 'unknown'}</dd>
        </dl>
      )}
      {check && <div className="card"><CheckResults check={check} isAdmin={false} /></div>}
      <p className="muted">Only a dashboard admin can set up or change the agent's Workspace account.</p>
    </div>
  );
}

/** The recorded account, its last test, and what an admin can do with it. */
function Recorded({ workspace, check, onChange, onRemove, busy }) {
  const { account } = workspace;
  const latest = check.result?.account === account.account ? check.result : workspace.last_check?.account === account.account ? workspace.last_check : null;
  return (
    <section className="card stack">
      <div className={styles.recordedHead}>
        <div>
          <h3>The agent's account</h3>
          <div className={settingsStyles.address}>
            <code>{account.account}</code>
            <CopyButton text={account.account} label="Copy address" />
          </div>
          <p className="muted">
            Delegated through {account.signer || workspace.signer}
            {account.recorded_by && `; recorded by ${account.recorded_by}`}
            {account.recorded_at && ` ${timeAgo(account.recorded_at)}`}.
          </p>
        </div>
        <div className="row">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => check.run({ account: account.account })}>
            {check.running ? 'Testing…' : 'Test again'}
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onChange}>Change</button>
          <ConfirmButton
            label="Remove"
            confirmLabel={`Remove ${account.account}`}
            prompt="The agent loses Chat and the Workspace skills, Drive goes back to its service account, and its services restart."
            disabled={busy}
            onConfirm={onRemove}
          />
        </div>
      </div>
      {check.error && !check.running && <p className="error-text">The test did not finish: {check.error}</p>}
      <CheckResults check={latest} isAdmin />
    </section>
  );
}

function Wizard({ workspace, setup, setupError, check, save, onSave, onCancel, busy }) {
  const [typed, setTyped] = useState('');
  const { account, error: addressError } = checkAddress(typed);
  const latest = check.result || workspace.last_check || null;
  const forTyped = latest && account && latest.account === account ? latest : null;
  const states = stepStates({ account, setup, check: latest });
  const decision = saveDecision(forTyped, account);
  const links = setup?.links || {};

  return (
    <ol className={styles.steps}>
      <Step number={1} title="Create the agent's user" state={states.user}>
        <p>
          In the Google Admin console, open Directory, Users and choose Add new user. Give it a license that includes
          Google Chat, Drive, Docs, Sheets, Slides, Calendar and Gmail. Then enter its address here.
        </p>
        <div className="row">
          {links.users && <External href={links.users}>Open Users in the Admin console</External>}
          {setup?.suggested_account && (
            <span className={styles.suggestion}>
              Suggested: <code>{setup.suggested_account}</code>
              <CopyButton text={setup.suggested_account} />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTyped(setup.suggested_account)}>Use it</button>
            </span>
          )}
        </div>
        <label className="label" htmlFor="workspace-account">The agent's address</label>
        <input
          id="workspace-account"
          className={`input ${styles.address}`}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="agent@example.com"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        {addressError && <p className="error-text">{addressError}</p>}
      </Step>

      <Step number={2} title="Grant domain-wide delegation" state={states.delegation}>
        <p>
          In the Admin console, open Security, Access and data control, API controls, Manage domain-wide delegation, and
          choose Add new. Enter this client ID and these scopes, then Authorize. A new entry can take a few minutes to apply.
        </p>
        {setupError && <p className="error-text">The setup details could not be read: {setupError.message}</p>}
        {!setup && !setupError && <p className="muted">Loading…</p>}
        {setup && (
          <dl className={settingsStyles.facts}>
            <dt>Client ID</dt>
            <dd>
              {setup.client_id ? (
                <span className={styles.copyLine}><code>{setup.client_id}</code><CopyButton text={setup.client_id} /></span>
              ) : (
                <span className="error-text">{setup.client_id_error}</span>
              )}
              <span className={`muted ${settingsStyles.sub}`}>of {setup.signer}</span>
            </dd>
            <dt>OAuth scopes</dt>
            <dd>
              <span className={styles.copyLine}>
                <code className={styles.scopes}>{setup.scopes_text}</code>
                <CopyButton text={setup.scopes_text} />
              </span>
              <span className={`muted ${settingsStyles.sub}`}>
                {setup.apis.map((api) => `${api.name}: ${api.scopes.join(', ')}`).join(' · ')}
              </span>
            </dd>
          </dl>
        )}
        {links.delegation && <External href={links.delegation}>Open domain-wide delegation</External>}
      </Step>

      <Step number={3} title="Set up Google Chat" state={states.chat}>
        <p>
          Google requires a Chat app record of this Google Cloud project before Chat answers the agent. In the Cloud console,
          open the Chat API's Configuration page, enter an app name and a description, turn Interactive features
          off, and Save. Nobody sees this record: the agent is a person in Chat, not an app.
        </p>
        {links.chat_app && <External href={links.chat_app}>Open the Chat API configuration</External>}
        <p>
          Then send the agent a direct message in Google Chat, from your own account. Chat lists a new user's
          conversations only once someone has written to it; the agent reads messages from up to an hour before it
          first comes online, so this first one is answered too.
        </p>
      </Step>

      <Step number={4} title="Test" state={states.test}>
        <p>Asks Google, as the agent, for a token for each API, and makes one read-only call with each. Nothing is changed.</p>
        <button type="button" className="btn btn-sm" disabled={!account || busy} onClick={() => check.run({ account })}>
          {check.running ? 'Testing…' : 'Test'}
        </button>
        {check.error && !check.running && <p className="error-text">The test did not finish: {check.error}</p>}
        {latest && account && latest.account !== account && (
          <p className="muted">The last test was for {latest.account}. Test {account} before saving it.</p>
        )}
        <CheckResults check={forTyped} isAdmin />
      </Step>

      <Step number={5} title="Save">
        <p>
          Records {account || 'the address'} as the agent's account on its VM. Its services restart, which takes a few
          seconds; from then on it uses Chat, Drive and the Workspace skills as that user.
        </p>
        {!decision.allowed && <p className="muted">{decision.reason}</p>}
        {decision.allowed && decision.confirm && <p className={styles.warning}>{decision.warning}</p>}
        <div className="row">
          {decision.allowed && !decision.confirm && (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onSave(account)}>
              {save.running ? 'Saving…' : `Save ${account}`}
            </button>
          )}
          {decision.allowed && decision.confirm && (
            <ConfirmButton label="Save anyway" confirmLabel={`Save ${account} anyway`} danger={false} disabled={busy} onConfirm={() => onSave(account)} />
          )}
          {onCancel && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>}
        </div>
      </Step>
    </ol>
  );
}

function AdminView({ workspace, refresh }) {
  const { data: setup, error: setupError } = usePoll('/api/workspace/setup', 0);
  const check = useCommand('workspace_check');
  const save = useCommand('set_workspace_account');
  const [changing, setChanging] = useState(false);
  const [notice, setNotice] = useState(null);
  const busy = check.running || save.running;

  const runCheck = {
    ...check,
    run: async (params) => {
      setNotice(null);
      const done = await check.run(params);
      await refresh();
      return done;
    },
  };

  async function record(account) {
    setNotice(null);
    const done = await save.run({ account });
    await refresh();
    if (done?.status === 'done') {
      setChanging(false);
      setNotice({ kind: 'ok', text: done.result?.message || (account ? `Saved ${account}.` : 'Removed.') });
    } else {
      setNotice({ kind: 'error', text: `Not saved: ${done?.error || save.error || 'the agent did not answer'}` });
    }
  }

  const showWizard = !workspace.account || changing;
  return (
    <div className="stack">
      <Summary workspace={workspace} />
      <Notice notice={notice} onDismiss={() => setNotice(null)} />
      {!showWizard && (
        <Recorded workspace={workspace} check={runCheck} busy={busy} onChange={() => setChanging(true)} onRemove={() => record(null)} />
      )}
      {showWizard && (
        <Wizard
          workspace={workspace}
          setup={setup}
          setupError={setupError}
          check={runCheck}
          save={save}
          busy={busy}
          onSave={record}
          onCancel={workspace.account ? () => setChanging(false) : null}
        />
      )}
    </div>
  );
}

/**
 * @param {object}   props
 * @param {object}   props.workspace  GET /api/workspace
 * @param {Function} props.refresh    reads it again
 * @param {boolean}  props.isAdmin
 */
export function WorkspaceTab({ workspace, refresh, isAdmin }) {
  return (
    <section className={settingsStyles.section}>
      <div className={settingsStyles.sectionHeader}>
        <div>
          <h2>Google Workspace account</h2>
          {workspace.needed && (
            <p>
              On this role the agent is a user of your organization: it reads and posts in Google Chat, and works in Drive,
              Docs, Sheets, Slides, Calendar and Gmail as that user. Google lets only a Workspace admin allow that, by hand,
              in the Admin console.
            </p>
          )}
        </div>
      </div>
      {!workspace.needed && <p className="card muted">The {workspace.role} role has no Workspace account, so there is nothing to set up.</p>}
      {workspace.needed && (isAdmin ? <AdminView workspace={workspace} refresh={refresh} /> : <MemberView workspace={workspace} />)}
    </section>
  );
}
