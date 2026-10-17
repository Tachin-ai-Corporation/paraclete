'use client';
// dashboard/components/settings/SecretsTab.jsx: Settings, Secrets (admins only). The API keys, tokens and
// passwords the agent reads with `secret-read --name <name>`, kept in the project's Secret Manager
// (lib/server/secrets.mjs). A value is typed once, sent once, and never shown again: the list carries
// names, versions and whether the agent may read each one, never a value. A value field is cleared once
// the value is stored.
import { useState } from 'react';
import { api } from '@/lib/client/api.js';
import { usePoll } from '@/lib/client/use-poll.js';
import { formatDate, timeAgo } from '@/lib/client/format.js';
import { AsyncState } from '@/components/ui/AsyncState.jsx';
import { ConfirmButton } from './ConfirmButton.jsx';
import { CopyButton } from './CopyButton.jsx';
import { Notice } from './Notice.jsx';
import styles from './Settings.module.css';

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const secretPath = (name) => `/api/secrets/${encodeURIComponent(name)}`;

export function SecretsTab() {
  // Each listing asks Secret Manager about every secret, so it is read on demand, not polled.
  const { data, error, loading, refresh } = usePoll('/api/secrets', 0);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [replacing, setReplacing] = useState(null);

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

  const secrets = data?.secrets || [];

  return (
    <div>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <h2>Secrets</h2>
            <p>
              API keys, tokens and passwords the agent can use without seeing them in chat. The agent reads one by
              its exact name with <code>secret-read --name &lt;name&gt;</code>. A value is stored in this project's
              Secret Manager and never shown again, here or anywhere.
            </p>
          </div>
          <div className="row">
            <button type="button" className="btn btn-ghost" onClick={refresh} disabled={busy}>
              Refresh
            </button>
            {!creating && (
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                New secret
              </button>
            )}
          </div>
        </div>
        {creating && (
          <NewSecretForm
            busy={busy}
            onCancel={() => setCreating(false)}
            onCreate={async (input) => {
              const ok = await act(
                () => api('/api/secrets', { method: 'POST', body: input }),
                (secret) => ({ kind: 'ok', text: `Created ${secret.name}. The agent reads it with: secret-read --name ${secret.name}` }),
              );
              if (ok) setCreating(false);
              return ok;
            }}
          />
        )}
      </section>

      <section className={styles.section}>
        <Notice notice={notice} onDismiss={() => setNotice(null)} />
        <AsyncState loading={loading} error={error} empty={!secrets.length} emptyText="No secrets yet.">
          <div className={styles.tableWrap}>
            <table className={`table ${styles.list}`}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Value</th>
                  <th>Agent can read</th>
                  <th>Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {secrets.map((secret) => (
                  <SecretRow
                    key={secret.name}
                    secret={secret}
                    busy={busy}
                    replacing={replacing === secret.name}
                    onReplace={() => setReplacing(replacing === secret.name ? null : secret.name)}
                    onSaveValue={async (value) => {
                      const ok = await act(
                        () => api(`${secretPath(secret.name)}/versions`, { method: 'POST', body: { value } }),
                        (result) => ({ kind: 'ok', text: `${result.name} has a new value (version ${result.version}). The agent reads it from now on.` }),
                      );
                      if (ok) setReplacing(null);
                      return ok;
                    }}
                    onGrant={() => act(
                      () => api(`${secretPath(secret.name)}/access`, { method: 'POST' }),
                      () => ({ kind: 'ok', text: `The agent can read ${secret.name} again.` }),
                    )}
                    onDelete={() => act(
                      () => api(secretPath(secret.name), { method: 'DELETE' }),
                      () => ({ kind: 'ok', text: `Deleted ${secret.name}.` }),
                    )}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </AsyncState>
        <p className={`muted ${styles.small} ${styles.footnote}`}>
          The agent reads secrets as its service account. Secrets made elsewhere in Secret Manager don't show here;
          the agent can read one of those only once that account has the Secret Accessor role on it.
        </p>
        {data?.agent_account && (
          <div className={styles.address}>
            <code>{data.agent_account}</code>
            <CopyButton text={data.agent_account} />
          </div>
        )}
      </section>
    </div>
  );
}

function NewSecretForm({ busy, onCancel, onCreate }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [value, setValue] = useState('');
  const nameOk = NAME_PATTERN.test(name.trim());

  return (
    <form
      className={`card ${styles.form} ${styles.formWide}`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (await onCreate({ name: name.trim(), description, value })) {
          setName('');
          setDescription('');
          setValue('');
        }
      }}
    >
      <div>
        <label className="label" htmlFor="secret-name">Name</label>
        <input
          id="secret-name"
          className="input"
          placeholder="github-token"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
        {name && !nameOk && <span className={`error-text ${styles.small}`}>Letters, digits, - and _ only.</span>}
      </div>
      <div>
        <label className="label" htmlFor="secret-description">What it is for (optional)</label>
        <input
          id="secret-description"
          className="input"
          placeholder="Pushes to the docs repository"
          value={description}
          maxLength={500}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className={styles.full}>
        <label className="label" htmlFor="secret-value">Value</label>
        <input
          id="secret-value"
          className="input"
          type="password"
          placeholder="Pasted here once; never shown again"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          required
        />
      </div>
      <div className={`row ${styles.full}`}>
        <button type="submit" className="btn btn-primary" disabled={busy || !nameOk || !value}>
          Create
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AgentAccess({ secret, busy, onGrant }) {
  if (secret.agent_access === true) return <span className="badge badge-ok">Yes</span>;
  if (secret.agent_access === false) {
    return (
      <span className={styles.confirm}>
        <span className="badge badge-warn">No</span>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onGrant}>
          Grant
        </button>
      </span>
    );
  }
  return <span className="badge badge-neutral">Unknown</span>;
}

function SecretRow({ secret, busy, replacing, onReplace, onSaveValue, onGrant, onDelete }) {
  const [value, setValue] = useState('');
  return (
    <>
      <tr>
        <td>
          <code>{secret.name}</code>
          {secret.description && <span className={styles.sub}>{secret.description}</span>}
          {secret.problem && <span className={`error-text ${styles.small}`}>{secret.problem}</span>}
        </td>
        <td className={styles.nowrap} title={formatDate(secret.updated_at)}>
          {secret.version ? `Version ${secret.version}` : <span className="muted">No value</span>}
          {secret.version_state && secret.version_state !== 'ENABLED' && <span className={styles.sub}>{secret.version_state.toLowerCase()}</span>}
          {secret.updated_at && <span className={styles.sub}>{timeAgo(secret.updated_at)}</span>}
        </td>
        <td>
          <AgentAccess secret={secret} busy={busy} onGrant={onGrant} />
        </td>
        <td className={styles.nowrap} title={formatDate(secret.created_at)}>
          {timeAgo(secret.created_at)}
          {secret.created_by && <span className={styles.sub}>by {secret.created_by}</span>}
        </td>
        <td className={styles.actions}>
          <span className={styles.confirm}>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={onReplace}>
              {replacing ? 'Close' : 'Replace value'}
            </button>
            <ConfirmButton
              label="Delete"
              prompt={`Delete ${secret.name} and every version? The agent can no longer read it.`}
              confirmLabel="Delete"
              disabled={busy}
              onConfirm={onDelete}
            />
          </span>
        </td>
      </tr>
      {replacing && (
        <tr className={styles.inlineRow}>
          <td colSpan={5}>
            <form
              className={styles.inlineForm}
              onSubmit={async (event) => {
                event.preventDefault();
                if (await onSaveValue(value)) setValue('');
              }}
            >
              <label className="label" htmlFor={`replace-${secret.name}`}>New value for {secret.name}</label>
              <input
                id={`replace-${secret.name}`}
                className={`input ${styles.grow}`}
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                required
              />
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !value}>
                Save
              </button>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
