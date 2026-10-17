'use client';
// dashboard/components/settings/UsersTab.jsx: Settings, Users (admins only). Lists who can use the
// dashboard, adds and removes people, and changes their role. A person needs two things to get in: the
// IAP grant that lets them through Google sign-in, and a user record that says what they may do. Adding
// and removing change both (lib/server/user-admin.mjs); the list shows where only one side exists, so
// an admin can fix it.
import { useState } from 'react';
import { api } from '@/lib/client/api.js';
import { usePoll } from '@/lib/client/use-poll.js';
import { timeAgo, formatDate } from '@/lib/client/format.js';
import { AsyncState } from '@/components/ui/AsyncState.jsx';
import { ConfirmButton } from './ConfirmButton.jsx';
import { Notice } from './Notice.jsx';
import styles from './Settings.module.css';

const userPath = (email) => `/api/users/${encodeURIComponent(email)}`;
const roleName = (role) => (role === 'admin' ? 'an admin' : 'a member');

function removedText(result) {
  const { email } = result.user;
  if (result.access === 'revoke_failed') {
    return {
      kind: 'warn',
      text: `Removed ${email}, but their Google sign-in access could not be taken away (${result.access_error}). They no longer have a user record, so they see "No access". Revoke the grant under Access without a user once it can be.`,
    };
  }
  return { kind: 'ok', text: result.access === 'revoked' ? `Removed ${email} and their sign-in access.` : `Removed ${email}.` };
}

export function UsersTab({ me }) {
  const { data, error, loading, refresh } = usePoll('/api/users', 30_000);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [demotingSelf, setDemotingSelf] = useState(false);

  async function act(run, describe) {
    setBusy(true);
    setNotice(null);
    try {
      setNotice(describe(await run()));
      return true;
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
      return false;
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  const add = (address, asRole) => act(
    () => api('/api/users', { method: 'POST', body: { email: address, role: asRole } }),
    (result) => {
      setEmail('');
      const already = result.access === 'already_granted' ? ' They could already pass Google sign-in.' : '';
      return { kind: 'ok', text: `Added ${result.user.email} as ${roleName(result.user.role)}.${already}` };
    },
  );

  const changeRole = (address, nextRole) => act(
    () => api(userPath(address), { method: 'PATCH', body: { role: nextRole } }),
    (user) => ({ kind: 'ok', text: `${user.email} is now ${roleName(user.role)}.` }),
  );

  const remove = (address) => act(() => api(userPath(address), { method: 'DELETE' }), removedText);

  const grant = (address) => act(
    () => api(`${userPath(address)}/access`, { method: 'POST' }),
    () => ({ kind: 'ok', text: `${address} can pass Google sign-in now.` }),
  );

  const revoke = (address) => act(
    () => api(`${userPath(address)}/access`, { method: 'DELETE' }),
    () => ({ kind: 'ok', text: `${address} can no longer pass Google sign-in.` }),
  );

  function onRoleChange(user, nextRole) {
    if (user.email === me.email && nextRole === 'member') {
      setDemotingSelf(true);
      return;
    }
    changeRole(user.email, nextRole);
  }

  const users = data?.users || [];
  const access = data?.access;

  return (
    <div>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <h2>Users</h2>
            <p>
              Admins manage users, secrets, settings and upgrades. Members chat with the agent, follow and approve
              its work, and download its files. Adding someone lets them through Google sign-in and creates their
              user record; removing them takes both away.
            </p>
          </div>
        </div>

        <form
          className={`card ${styles.form}`}
          onSubmit={(event) => {
            event.preventDefault();
            add(email, role);
          }}
        >
          <div>
            <label className="label" htmlFor="new-user-email">Email</label>
            <input
              id="new-user-email"
              className="input"
              type="email"
              placeholder="colleague@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="new-user-role">Role</label>
            <select id="new-user-role" className="select" value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>
            Add user
          </button>
        </form>
      </section>

      <section className={styles.section}>
        <Notice notice={notice} onDismiss={() => setNotice(null)} />
        {access && !access.checked && (
          <Notice notice={{ kind: 'warn', text: `Who can pass Google sign-in could not be read: ${access.error}. Users are listed; their sign-in access shows as unknown.` }} />
        )}
        <AsyncState loading={loading} error={error} empty={!users.length} emptyText="No users.">
          <div className={styles.tableWrap}>
            <table className={`table ${styles.list}`}>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Sign-in access</th>
                  <th>Added</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <UserRow
                    key={user.email}
                    user={user}
                    isMe={user.email === me.email}
                    busy={busy}
                    demotingSelf={demotingSelf && user.email === me.email}
                    onRoleChange={onRoleChange}
                    onConfirmDemote={async () => {
                      setDemotingSelf(false);
                      // A member's dashboard has no Users or Secrets: load it afresh as one.
                      if (await changeRole(user.email, 'member')) window.location.reload();
                    }}
                    onCancelDemote={() => setDemotingSelf(false)}
                    onGrant={() => grant(user.email)}
                    onRemove={() => remove(user.email)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </AsyncState>
      </section>

      {access?.without_user?.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2>Access without a user</h2>
              <p>
                These people can pass Google sign-in (they were let through in the Cloud console, say) but have no
                user record, so they see "No access". Add them as a user, or revoke their access.
              </p>
            </div>
          </div>
          <div className={styles.tableWrap}>
            <table className={`table ${styles.list}`}>
              <tbody>
                {access.without_user.map((address) => (
                  <tr key={address}>
                    <td>{address}</td>
                    <td className={styles.actions}>
                      <span className={styles.confirm}>
                        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => add(address, 'member')}>
                          Add as member
                        </button>
                        <ConfirmButton
                          label="Revoke access"
                          prompt={`Stop ${address} passing sign-in?`}
                          confirmLabel="Revoke"
                          disabled={busy}
                          onConfirm={() => revoke(address)}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {access?.other_members?.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2>Other sign-in grants</h2>
              <p>
                Everyone in these groups, domains or accounts passes Google sign-in too. Each person still needs a
                user record to use the dashboard. They are managed in the Cloud console, under IAP.
              </p>
            </div>
          </div>
          <ul className="card">
            {access.other_members.map((member) => (
              <li key={member} className={styles.small}>
                <code>{member}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AccessBadge({ iap }) {
  if (iap === true) return <span className="badge badge-ok">Granted</span>;
  if (iap === false) return <span className="badge badge-warn">Not granted</span>;
  return <span className="badge badge-neutral">Unknown</span>;
}

function UserRow({ user, isMe, busy, demotingSelf, onRoleChange, onConfirmDemote, onCancelDemote, onGrant, onRemove }) {
  return (
    <>
      <tr>
        <td>
          {user.email}
          {isMe && <span className={styles.sub}>you</span>}
        </td>
        <td>
          <select
            className={`select ${styles.roleSelect}`}
            value={user.role}
            disabled={busy}
            aria-label={`Role of ${user.email}`}
            onChange={(event) => onRoleChange(user, event.target.value)}
          >
            <option value="admin">Admin</option>
            <option value="member">Member</option>
          </select>
        </td>
        <td>
          <span className={styles.confirm}>
            <AccessBadge iap={user.iap} />
            {user.iap === false && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={onGrant}>
                Grant
              </button>
            )}
          </span>
        </td>
        <td className={styles.nowrap} title={formatDate(user.added_at)}>
          {timeAgo(user.added_at)}
          {user.added_by && <span className={styles.sub}>by {user.added_by}</span>}
        </td>
        <td className={styles.actions}>
          {isMe ? (
            <span className="muted" title="Another admin can remove you">You</span>
          ) : (
            <ConfirmButton label="Remove" prompt={`Remove ${user.email}?`} confirmLabel="Remove" disabled={busy} onConfirm={onRemove} />
          )}
        </td>
      </tr>
      {demotingSelf && (
        <tr className={styles.inlineRow}>
          <td colSpan={5}>
            <div className={styles.inlineForm}>
              <span>Make yourself a member? You lose Users, Secrets and the other admin settings until another admin makes you an admin again.</span>
              <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={onConfirmDemote}>
                Make me a member
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={onCancelDemote}>
                Cancel
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
